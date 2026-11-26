import { HTTPError } from 'nitro'
import type { PDFDocument, PDFFont } from 'pdf-lib'
import { z } from 'zod'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { findMessageByDedupeKey, messageQueries, type ConversationRow, type MessageRow } from '~/server/domain/conversations'
import { createConversationGuestInvite } from '~/server/domain/conversation-participants'
import { createDeliveryReceipt, deliverGuestThreadEmail, isDeliverySent } from '~/server/domain/guest-threads/deliveries'
import { publishConversationEvent } from '~/server/cloudflare/guest-inbox-events'
import { renderNotificationEmail } from '~/server/emails/render'
import { guestThreadStatusMessage } from '~/server/notifications/guest-events'
import { organizationLogo } from '~/server/notifications/hero'
import type { CloudflareEnv } from '~/server/utils/auth'
import { readR2Object, type R2Visibility } from '~/server/utils/cloudflare-r2'
import { depositQuery, presentDeposit } from '~/server/domain/deposits'
import { getPlatformDomain, platformOrigin } from '~/server/utils/dashboard-notification-links'
import { getEmailDeliveryMode } from '~/server/utils/email-delivery'
import { buildMediaPlacementInsertQuery } from '~/server/utils/media-asset-manager'
import { sniffMediaMimeType } from '~/server/utils/media-mime'
import { sanitizeFilename, uploadResolvedMediaToAssetStore } from '~/server/utils/media-upload'
import { mediaLinks } from '~/server/utils/private-media'
import { AGREEMENT_EVENTS, agreementLabel, isAgreementField, type AgreementField, type AgreementSigner, type BookingAgreement } from '~/shared/agreements'
import { PLATFORM_MESSAGE_AUTHOR_KIND, guestConversationPath } from '~/shared/messages-contract'
import type { ProductKind } from '~/shared/product-details'

/** The largest PDF a business may store or send: the same ceiling as a photo. */
export const MAX_AGREEMENT_BYTES = 20 * 1024 * 1024

const signerSchema = z.object({ key: z.string().regex(/^(user:.+|email:[^\s@]+@[^\s@]+\.[^\s@]+)$/), name: z.string().trim().min(1).max(120), role: z.enum(['guest', 'host']) })
const sentSchema = z.object({ sha256: z.string().regex(/^[0-9a-f]{64}$/), signers: z.array(signerSchema).min(1), fields: z.array(z.custom<AgreementField>(isAgreementField)) })
const signedSchema = z.object({
  request_id: z.string().nullable(), signer_key: z.string(), typed_name: z.string(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  ip: z.string().nullable(), user_agent: z.string().nullable(),
})
const cancelledSchema = z.object({ request_id: z.string() })

/** The booking an agreement belongs to, as its reader already holds it. */
export interface AgreementBooking {
  conversationId: string
  organizationId: string
  bookingId: string
  productId: string
  productKind: ProductKind
  status: string
  endsAt: string
  /** The account that booked; it signs the listing's agreement under the booking's guest name. */
  bookingUserId: string | null
  guestName: string | null
  /** The business the host signs for. */
  organizationName: string
}

export interface AgreementViewer {
  userId: string
  /** A verified email matches a signer the business invited by email. */
  verifiedEmail: string | null
  canManage: boolean
  /** A guest on the booking, who reads its documents; a member who only works the booking does not. */
  guest: boolean
}

type StoredDocument = { kind: string; provider: string; file_name: string | null; r2_key: string | null; public_url: string | null }
type AgreementRecord = MessageRow & Partial<StoredDocument> & { asset_id: string | null }
type ListingDocument = StoredDocument & { asset_id: string }

/** A booking's documents are private to its conversation; the listing's own agreement is public, as guests read it before booking. */
const MESSAGE_DOCUMENT = { owner_type: 'message', slot: 'agreement' } as const
const LISTING_DOCUMENT = { owner_type: 'product', slot: 'agreement' } as const

/**
 * The booking an agreement read is for: its ID, and its organization as a SQL
 * value. A caller that batches the booking's own read passes the organization
 * its batch already resolved (`BATCH_VIEWER.organization`), so the agreement
 * rides in that same round trip.
 */
export interface AgreementTarget {
  booking: { sql: string; params: unknown[] }
  organization: { sql: string; params: unknown[] }
}

const BOOKING_CONVERSATION = (target: AgreementTarget) => ({
  sql: `(SELECT id FROM conversations WHERE booking_id = ${target.booking.sql} AND organization_id = ${target.organization.sql} AND kind = 'booking')`,
  params: [...target.booking.params, ...target.organization.params],
})

function recordsQuery(target: AgreementTarget): BatchQuery {
  const conversation = BOOKING_CONVERSATION(target)
  return {
    query: `SELECT m.*, ma.id AS asset_id, ma.kind, ma.provider, ma.file_name, ma.r2_key, ma.public_url
      FROM messages m
      LEFT JOIN media_placements mp ON mp.owner_type = 'message' AND mp.owner_id = m.id AND mp.slot = 'agreement' AND mp.status = 'active'
      LEFT JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
      WHERE m.conversation_id = ${conversation.sql} AND m.event_name IN (${AGREEMENT_EVENTS.map(() => '?').join(', ')})
      ORDER BY m.sequence`,
    params: [...conversation.params, ...AGREEMENT_EVENTS],
  }
}

function listingQuery(target: AgreementTarget): BatchQuery {
  return {
    query: `SELECT ma.id AS asset_id, ma.kind, ma.provider, ma.file_name, ma.r2_key, ma.public_url
      FROM bookings b JOIN media_placements mp ON mp.organization_id = b.organization_id AND mp.owner_type = 'product' AND mp.owner_id = b.product_id AND mp.slot = 'agreement' AND mp.status = 'active'
      JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id AND ma.status = 'active'
      WHERE b.id = ${target.booking.sql} AND b.organization_id = ${target.organization.sql}`,
    params: [...target.booking.params, ...target.organization.params],
  }
}

function bookingQuery(target: AgreementTarget): BatchQuery {
  return {
    query: `SELECT c.id AS conversation_id, b.id AS booking_id, b.organization_id, b.product_id, p.kind, b.status, b.ends_at, b.user_id, COALESCE(json_extract(c.payload_json, '$.guest.name'), u.name) AS guest_name,
        (SELECT name FROM organization WHERE id = b.organization_id) AS organization_name,
        EXISTS (SELECT 1 FROM media_placements tp JOIN media_assets ta ON ta.id = tp.asset_id AND ta.organization_id = tp.organization_id AND ta.status = 'active'
                 WHERE tp.organization_id = b.organization_id AND tp.owner_type = 'product' AND tp.owner_id = b.product_id AND tp.slot = 'agreement_template' AND tp.status = 'active') AS has_template
      FROM bookings b JOIN products p ON p.id = b.product_id AND p.organization_id = b.organization_id
      JOIN conversations c ON c.booking_id = b.id AND c.organization_id = b.organization_id AND c.kind = 'booking'
      LEFT JOIN user u ON u.id = b.user_id
     WHERE b.id = ${target.booking.sql} AND b.organization_id = ${target.organization.sql}`,
    params: [...target.booking.params, ...target.organization.params],
  }
}

function signersQuery(target: AgreementTarget): BatchQuery {
  const conversation = BOOKING_CONVERSATION(target)
  return {
    query: `SELECT p.user_id, u.name, u.isAnonymous AS anonymous, CASE WHEN u.emailVerified = 1 THEN lower(u.email) END AS email, json_extract(c.payload_json, '$.guest.name') AS booked_name, json_extract(c.payload_json, '$.guest.email') AS booked_email
      FROM conversation_participants p JOIN user u ON u.id = p.user_id JOIN conversations c ON c.id = p.conversation_id
     WHERE p.conversation_id = ${conversation.sql} AND p.role = 'guest' ORDER BY p.created_at`,
    params: conversation.params,
  }
}

/**
 * Everything an agreement reads, as statements for one batch: the booking, its
 * conversation's agreement messages with their documents, the listing's
 * agreement and, for the business, the guests it may ask to sign. A reader of
 * the booking appends these to its own batch.
 */
export function agreementQueries(target: AgreementTarget, withSigners = false): BatchQuery[] {
  // The booking's deposit is one of its agreed terms, so it rides in the same read.
  return [bookingQuery(target), recordsQuery(target), listingQuery(target), depositQuery(target), ...(withSigners ? [signersQuery(target)] : [])]
}

type SignerRow = { user_id: string; name: string | null; anonymous: number; email: string | null; booked_name: string | null; booked_email: string | null }

/** The batch results of `agreementQueries`, in their order. */
export function agreementFromResults(results: { results: unknown[] }[]) {
  const [bookingRows, records, listing, deposit, signers] = results
  const row = bookingRows?.results[0] as { conversation_id: string; booking_id: string; organization_id: string; product_id: string; kind: ProductKind; status: string; ends_at: string; user_id: string | null; guest_name: string | null; organization_name: string; has_template: number } | undefined
  if (!row) throw new HTTPError({ statusCode: 404, message: 'Booking not found', data: { code: 'BOOKING_NOT_FOUND', field: 'booking_id' } })
  const booking: AgreementBooking = {
    conversationId: row.conversation_id, organizationId: row.organization_id, bookingId: row.booking_id,
    productId: row.product_id, productKind: row.kind, status: row.status, endsAt: row.ends_at, bookingUserId: row.user_id, guestName: row.guest_name?.trim() || null, organizationName: row.organization_name,
  }
  return {
    booking,
    records: records!.results as AgreementRecord[],
    listing: (listing!.results[0] as ListingDocument | undefined) ?? null,
    signerRows: signers ? signers.results as SignerRow[] : null,
    deposit: presentDeposit(deposit!.results[0]),
    hasTemplate: row.has_template === 1,
  }
}

function conversationTarget(conversation: Pick<ConversationRow, 'organization_id' | 'booking_id' | 'kind'>): AgreementTarget {
  if (conversation.kind !== 'booking' || !conversation.booking_id) throw new HTTPError({ statusCode: 404, message: 'This conversation has no booking', data: { code: 'BOOKING_NOT_FOUND', field: 'conversation_id' } })
  return { booking: { sql: '?', params: [conversation.booking_id] }, organization: { sql: '?', params: [conversation.organization_id] } }
}

/** One D1 round trip for the agreement and its booking, for a write or a document read. */
async function readAgreement(db: DbClient, conversation: Pick<ConversationRow, 'organization_id' | 'booking_id' | 'kind'>, withSigners = false) {
  return agreementFromResults(await executeBatch(db, agreementQueries(conversationTarget(conversation), withSigners), { operation: 'Read booking agreement' }))
}

function payload(record: Pick<MessageRow, 'payload_json'>): unknown {
  return JSON.parse(record.payload_json)
}

function viewerSigns(signer: { key: string }, viewer: AgreementViewer | null, signers?: SignerRow[] | null, bookerUserId?: string | null): boolean {
  if (!viewer) return false
  if (signer.key === `user:${viewer.userId}`) return true
  if (viewer.verifiedEmail !== null && signer.key === `email:${viewer.verifiedEmail.toLowerCase()}`) return true
  if (signer.key.startsWith('email:') && viewer.userId === bookerUserId && signers?.some(row => row.user_id === viewer.userId && row.booked_email && signer.key === `email:${row.booked_email.trim().toLowerCase()}`)) return true
  return false
}

/** What the agreement is now: the current request and its signatures, or the listing's agreement and the booker's. */
interface AgreementState {
  request: AgreementRecord | null
  listing: ListingDocument | null
  listingSignature: AgreementRecord | null
  signers: (z.infer<typeof signerSchema> & { signature: AgreementRecord | null })[]
  fields: AgreementField[]
}

function agreementState(records: AgreementRecord[], listing: ListingDocument | null, booking: AgreementBooking, now: string, requestId?: string): AgreementState | null {
  const cancelled = new Set(records.filter(record => record.event_name === 'agreement.cancelled').map(record => cancelledSchema.parse(payload(record)).request_id))
  const requests = records.filter(record => record.event_name === 'agreement.stored' || record.event_name === 'agreement.sent')
  // The current request is the latest; a named one is read as it stands, whatever was sent after it.
  const latestRequest = (requestId ? requests.find(record => record.id === requestId) : requests.at(-1)) ?? null
  const request = latestRequest && !cancelled.has(latestRequest.id) ? latestRequest : null
  const signatures = records.filter(record => record.event_name === 'agreement.signed').map(record => ({ record, signed: signedSchema.parse(payload(record)) }))
  if (request) {
    if (!request.asset_id) throw new Error(`Agreement message ${request.id} has no document`)
    if (request.event_name === 'agreement.stored') return { request, listing: null, listingSignature: null, signers: [], fields: [] }
    const sent = sentSchema.parse(payload(request))
    return {
      request, listing: null, listingSignature: null, fields: sent.fields,
      signers: sent.signers.map(signer => ({ ...signer, signature: signatures.find(({ signed }) => signed.request_id === request.id && signed.signer_key === signer.key)?.record ?? null })),
    }
  }
  // The listing's agreement: the booker signs it, once, and that signature keeps the document it signed.
  const listingSignature = signatures.find(({ signed }) => signed.request_id === null)?.record ?? null
  if (listingSignature) {
    if (!listingSignature.asset_id) throw new Error(`Agreement signature ${listingSignature.id} has no document`)
    const signed = signedSchema.parse(payload(listingSignature))
    return { request: null, listing: null, listingSignature, fields: [], signers: [{ key: signed.signer_key, name: signed.typed_name, role: 'guest', signature: listingSignature }] }
  }
  // A stay on a home with no checkout time ends on a date: it is open through that day.
  const open = (booking.status === 'pending' || booking.status === 'confirmed') && (booking.endsAt.length === 10 ? booking.endsAt >= now.slice(0, 10) : booking.endsAt > now)
  // A booking with no guest named has no one to sign the listing's agreement.
  if (!listing || !open || !booking.bookingUserId || !booking.guestName) return null
  return { request: null, listing, listingSignature: null, fields: [], signers: [{ key: `user:${booking.bookingUserId}`, name: booking.guestName, role: 'guest', signature: null }] }
}

type AgreementLinkEnv = Parameters<typeof mediaLinks>[0]

/** A stored document's link for this reader, made by the one media link maker. */
async function documentLink(env: AgreementLinkEnv, document: { asset_id: string | null } & Partial<StoredDocument>, placement: typeof MESSAGE_DOCUMENT | typeof LISTING_DOCUMENT): Promise<string> {
  if (!document.asset_id || !document.kind || !document.provider) throw new Error('An agreement document has no stored file')
  return (await mediaLinks(env, { id: document.asset_id, kind: document.kind, provider: document.provider, cloudflare_image_id: null, public_url: document.public_url ?? null, thumbnail_url: null }, placement)).url
}

async function presentAgreement(env: AgreementLinkEnv, state: AgreementState, booking: AgreementBooking, viewer: AgreementViewer | null, signersRows?: SignerRow[] | null): Promise<BookingAgreement> {
  const signers: AgreementSigner[] = state.signers.map(signer => ({ key: signer.key, name: signer.name, role: signer.role, signed_at: signer.signature?.occurred_at ?? null,
    signed_name: signer.signature ? signedSchema.parse(payload(signer.signature)).typed_name : null }))
  const complete = signers.length > 0 && signers.every(signer => signer.signed_at !== null)
  const own = state.signers.find(signer => viewerSigns(signer, viewer, signersRows, booking.bookingUserId)) ?? null
  const guestsSigned = signers.every(signer => signer.role === 'host' || signer.signed_at !== null)
  const document = state.request ?? state.listingSignature
  const base = { label: agreementLabel(booking.productKind), fields: state.fields, viewer_signer_key: own?.key ?? null, can_manage: viewer?.canManage === true,
    document_id: document?.id ?? state.listing!.asset_id }
  if (state.request?.event_name === 'agreement.stored') {
    const url = await documentLink(env, state.request, MESSAGE_DOCUMENT)
    return { ...base, source: 'booking', file_name: state.request.file_name ?? 'Agreement.pdf', url, signed_url: url, status: 'stored', completed_at: state.request.occurred_at, signers, can_sign: false }
  }
  const completedAt = complete ? signers.map(signer => signer.signed_at!).sort().at(-1)! : null
  if (document) {
    // The signature that completed the document carries the signed copy stored with it; a listing's one signature is that signature.
    const signedCopy = complete ? state.signers.map(signer => signer.signature).find(signature => signature?.asset_id) : null
    if (complete && !signedCopy) throw new Error(`The signed ${base.label.toLowerCase()} ${document.id} has no signed copy`)
    return {
      ...base, source: state.request ? 'booking' : 'listing', file_name: document.file_name ?? 'Agreement.pdf',
      url: await documentLink(env, document, MESSAGE_DOCUMENT),
      signed_url: signedCopy ? await documentLink(env, signedCopy, MESSAGE_DOCUMENT) : null,
      status: complete ? 'signed' : 'signing', completed_at: completedAt, signers,
      can_sign: own !== null && own.signature === null && (own.role === 'guest' || guestsSigned),
    }
  }
  const listing = state.listing!
  return {
    ...base, source: 'listing', file_name: listing.file_name ?? 'Agreement.pdf', url: await documentLink(env, listing, LISTING_DOCUMENT), signed_url: null,
    status: 'signing', completed_at: null, signers, can_sign: own !== null,
  }
}

/** The booking's agreement as this viewer reads it, from `agreementFromResults`, or null when it has none. */
export async function presentBookingAgreement(env: AgreementLinkEnv, read: Pick<ReturnType<typeof agreementFromResults>, 'booking' | 'records' | 'listing' | 'signerRows'>, viewer: AgreementViewer | null): Promise<BookingAgreement | null> {
  // A booking's documents are read by its guests and by the business that may change them, not by a member who only works the booking.
  if (!viewer || (!viewer.guest && !viewer.canManage && read.booking.bookingUserId !== viewer.userId)) return null
  const state = agreementState(read.records, read.listing, read.booking, new Date().toISOString())
  return state ? await presentAgreement(env, state, read.booking, viewer, read.signerRows) : null
}

/** The agreement as a booking read presents it, from the rows its batch read with `agreementQueries`. */
export async function bookingAgreementFromRows(env: AgreementLinkEnv, rows: { results: unknown[] }[], reader: AgreementViewer, actor: AgreementActor | null) {
  const read = agreementFromResults(rows)
  // The person who booked is the guest on their own booking, whatever they are in the business: they sign it, they do not send it.
  const viewer = { ...reader, canManage: reader.canManage && read.booking.bookingUserId !== reader.userId }
  return {
    agreement: await presentBookingAgreement(env, read, viewer),
    deposit: read.deposit,
    ...(viewer.canManage && read.signerRows && actor ? { agreement_signers: availableSigners(read.signerRows, actor), agreement_template: read.hasTemplate } : {}),
  }
}

/** The agreement, and for the business who it may ask to sign, in one D1 round trip. */
export async function readBookingAgreement(env: AgreementLinkEnv & { DB: DbClient }, conversation: Pick<ConversationRow, 'id' | 'organization_id' | 'booking_id' | 'kind'>, viewer: AgreementViewer, actor: AgreementActor) {
  const read = await readAgreement(env.DB, conversation, viewer.canManage)
  return { agreement: await presentBookingAgreement(env, read, viewer), deposit: read.deposit, available_signers: read.signerRows ? availableSigners(read.signerRows, actor) : null }
}

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

async function documentBytes(env: CloudflareEnv, r2Key: string | null | undefined, label: string, visibility: R2Visibility): Promise<Uint8Array<ArrayBuffer>> {
  if (!r2Key) throw new Error(`The ${label} has no stored file`)
  const bytes = await readR2Object(env, r2Key, visibility)
  if (!bytes) throw new Error(`The ${label} file is missing from storage`)
  return bytes
}

/** A PDF the business uploaded: its bytes, a stored name and its page count. */
async function readUploadedPdf(file: File): Promise<{ bytes: Uint8Array<ArrayBuffer>; filename: string; pages: number }> {
  if (file.size > MAX_AGREEMENT_BYTES) throw new HTTPError({ statusCode: 413, message: 'The PDF is larger than 20 MB', data: { code: 'UPLOAD_TOO_LARGE', field: 'file' } })
  const bytes = new Uint8Array(await file.arrayBuffer())
  if (sniffMediaMimeType(bytes) !== 'application/pdf') throw new HTTPError({ statusCode: 415, message: 'Upload a PDF', data: { code: 'UNSUPPORTED_MEDIA_TYPE', field: 'file' } })
  const { PDFDocument } = await import('pdf-lib')
  const pdf = await PDFDocument.load(bytes).catch((cause: unknown) => {
    throw new HTTPError({ statusCode: 422, message: 'This PDF could not be read. Encrypted PDFs cannot be signed here.', data: { code: 'INVALID_PDF', field: 'file' }, cause })
  })
  const name = sanitizeFilename(file.name)
  return { bytes, filename: name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`, pages: pdf.getPageCount() }
}

function joinNames(names: string[]): string {
  return names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

export interface AgreementActor { userId: string; name: string }

/** A signed copy the business keeps on the booking. */
export async function storeAgreement(env: CloudflareEnv, conversation: ConversationRow, actor: AgreementActor, file: File) {
  const { booking } = await readAgreement(env.DB, conversation)
  const pdf = await readUploadedPdf(file)
  const label = agreementLabel(booking.productKind).toLowerCase()
  const writer = messageQueries({ conversationId: conversation.id, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: actor.userId, eventName: 'agreement.stored', body: `Added the signed ${label}`, payload: { sha256: await sha256(pdf.bytes) } })
  await storeMessageDocument(env, conversation, actor.userId, { bytes: pdf.bytes, filename: pdf.filename, source: 'uploaded' }, writer)
  await publishConversationEvent(env, env.DB, { conversationId: conversation.id, type: 'MESSAGE_CREATE' })
}

/** A PDF placed on the agreement message written in the same batch: the file, its asset and the message commit together or not at all. */
async function storeMessageDocument(env: CloudflareEnv, conversation: ConversationRow, userId: string, file: { bytes: Uint8Array<ArrayBuffer>; filename: string; source: 'uploaded' | 'generated' }, writer: ReturnType<typeof messageQueries>) {
  await uploadResolvedMediaToAssetStore({
    db: env.DB, env, organizationId: conversation.organization_id, userId, source: file.source, kind: 'file', contentType: 'application/pdf',
    buffer: file.bytes, filename: file.filename, placement: MESSAGE_DOCUMENT,
    queries: assetId => [...writer.queries, buildMediaPlacementInsertQuery({ organizationId: conversation.organization_id, ownerType: 'message', ownerId: writer.id, slot: 'agreement', assetId, sortOrder: 0 })],
  })
}

export interface SendAgreementInput {
  file: File
  signers: { key: string; name: string; role: 'guest' | 'host' }[]
  fields: AgreementField[]
}

/** The business sends a document for its guests, and itself last, to sign; each guest is emailed a link to it. */
export async function sendAgreement(env: CloudflareEnv, conversation: ConversationRow, actor: AgreementActor, input: SendAgreementInput) {
  const { booking, signerRows } = await readAgreement(env.DB, conversation, true)
  const pdf = await readUploadedPdf(input.file)
  // An emailed signer is keyed by the lowercase address, the form a verified account's email is compared in when it signs.
  const signerKey = (key: string) => key.startsWith('email:') ? key.toLowerCase() : key
  const signers = z.array(signerSchema).min(1).parse(input.signers).map(signer => ({ ...signer, key: signerKey(signer.key) }))
  const fields = input.fields.map(field => isAgreementField(field) ? { ...field, signer_key: signerKey(field.signer_key) } : field)
  if (new Set(signers.map(signer => signer.key)).size !== signers.length) throw new HTTPError({ statusCode: 422, message: 'Each signer appears once', data: { code: 'DUPLICATE_SIGNER', field: 'signers' } })
  if (!signers.some(signer => signer.role === 'guest')) throw new HTTPError({ statusCode: 422, message: 'Add at least one guest to sign', data: { code: 'NO_GUEST_SIGNER', field: 'signers' } })
  const hosts = signers.filter(signer => signer.role === 'host')
  // The business signs last, as one signer: the member who sends it.
  if (hosts.length !== 1 || hosts[0]!.key !== `user:${actor.userId}`) throw new HTTPError({ statusCode: 422, message: 'You sign for the business, once, after your guests', data: { code: 'INVALID_HOST_SIGNER', field: 'signers' } })
  // A guest signer with an account is a guest in this conversation; anyone else is invited by email.
  const seated = new Set(availableSigners(signerRows!, actor).filter(signer => signer.role === 'guest').map(signer => signer.key))
  if (signers.some(signer => signer.role === 'guest' && signer.key.startsWith('user:') && !seated.has(signer.key))) {
    throw new HTTPError({ statusCode: 422, message: 'A signer is not a guest on this booking', data: { code: 'SIGNER_NOT_GUEST', field: 'signers' } })
  }
  // A guest with an account signs once, as that account: a second place under their email could never be signed.
  const accountEmails = new Set(signerRows!.flatMap(row => !row.anonymous && row.email ? [`email:${row.email}`] : []))
  const twice = signers.find(signer => signer.role === 'guest' && accountEmails.has(signer.key))
  if (twice) throw new HTTPError({ statusCode: 422, message: `${twice.name} is already a guest on this booking. Choose them from the list.`, data: { code: 'SIGNER_HAS_ACCOUNT', field: 'signers' } })
  for (const field of fields) {
    if (!isAgreementField(field) || field.page > pdf.pages || !signers.some(signer => signer.key === field.signer_key)) {
      throw new HTTPError({ statusCode: 422, message: 'A field is off the document or names no signer', data: { code: 'INVALID_FIELD', field: 'fields' } })
    }
  }
  const unplaced = signers.find(signer => !fields.some(field => field.signer_key === signer.key && field.kind === 'signature'))
  if (unplaced) throw new HTTPError({ statusCode: 422, message: `Place a signature for ${unplaced.name}`, data: { code: 'SIGNATURE_UNPLACED', field: 'fields' } })
  const label = agreementLabel(booking.productKind).toLowerCase()
  const guests = signers.filter(signer => signer.role === 'guest')
  const writer = messageQueries({
    conversationId: conversation.id, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: actor.userId, eventName: 'agreement.sent',
    body: `Asked ${joinNames(guests.map(signer => signer.name))} to sign the ${label}`,
    payload: { sha256: await sha256(pdf.bytes), signers, fields },
  })
  await storeMessageDocument(env, conversation, actor.userId, { bytes: pdf.bytes, filename: pdf.filename, source: 'uploaded' }, writer)
  await publishConversationEvent(env, env.DB, { conversationId: conversation.id, type: 'MESSAGE_CREATE' })
  const sent = await findMessageByDedupeKey(env.DB, writer.dedupeKey)
  if (!sent) throw new Error('The agreement request was not saved')
  await emailSigners(env, conversation, booking, actor, sent, guests)
  return { messageId: sent.id }
}

async function emailSigners(env: CloudflareEnv, conversation: ConversationRow, booking: AgreementBooking, actor: AgreementActor, sent: MessageRow, guests: { key: string; name: string }[]) {
  // The business's name and every account signer's email, in one statement.
  const accounts = guests.filter(signer => signer.key.startsWith('user:')).map(signer => signer.key.slice(5))
  const read = await queryFirst<{ name: string; emails: string }>(env.DB,
    `SELECT o.name, (SELECT json_group_object(u.id, u.email) FROM user u WHERE u.id IN (SELECT value FROM json_each(?))) AS emails FROM organization o WHERE o.id = ?`,
    [JSON.stringify(accounts), conversation.organization_id])
  if (!read) throw new Error('The agreement has no organization')
  const organization = { name: read.name }
  const accountEmails = JSON.parse(read.emails) as Record<string, string | null>
  const label = agreementLabel(booking.productKind).toLowerCase()
  const logo = await organizationLogo(env.DB, conversation.organization_id)
  const origin = platformOrigin(env)
  // Each guest's email is its own attempt: one failing does not keep the others from theirs. Every failure is reported.
  const outcomes = await Promise.allSettled(guests.map(async signer => {
    const email = signer.key.startsWith('email:') ? signer.key.slice(6) : accountEmails[signer.key.slice(5)]
    if (!email) throw new HTTPError({ statusCode: 409, message: `${signer.name} has no email to send the ${label} to`, data: { code: 'SIGNER_EMAIL_MISSING', field: 'signers' } })
    let link: URL
    if (signer.key.startsWith('email:')) {
      const invite = await createConversationGuestInvite(env.DB, { organizationId: conversation.organization_id, userId: actor.userId }, { conversationId: conversation.id, email })
      link = new URL('/messages/invite', origin)
      link.searchParams.set('token', invite.token)
    } else {
      link = new URL(guestConversationPath('account', conversation.id), origin)
    }
    const delivery = await createDeliveryReceipt(env.DB, {
      subject: { messageId: sent.id }, channel: 'email', provider: getEmailDeliveryMode(env) === 'provider' ? 'resend' : 'log_only',
      purpose: 'status_update', idempotencyKey: `agreement-sent:${sent.id}:${signer.key}`,
    })
    const heading = `${organization.name} asked you to sign the ${label}`
    const delivered = await deliverGuestThreadEmail(env.DB, {
      delivery, env, to: email, fromName: organization.name, subject: heading, conversationId: conversation.id,
      email: await renderNotificationEmail(guestThreadStatusMessage({
        organizationName: organization.name, organizationLogoUrl: logo, heading,
        body: `${actor.name} sent you the ${label} for your booking. Read it and sign with your name.`,
        actionUrl: link.href, actionLabel: `Sign the ${label}`,
      }), { platformDomain: getPlatformDomain(env) }),
    })
    if (!isDeliverySent(delivered)) throw new HTTPError({ statusCode: 502, message: delivered.error || `The email to ${signer.name} was not confirmed`, data: { code: 'DELIVERY_INCOMPLETE', field: 'delivery', delivery_id: delivered.id } })
  }))
  const failed = outcomes.flatMap(outcome => outcome.status === 'rejected' ? [outcome.reason as unknown] : [])
  if (failed.length === 1) throw failed[0]
  if (failed.length) {
    const reason = failed.map(error => error instanceof Error ? error.message : String(error)).join(' ')
    throw new HTTPError({ statusCode: 502, message: `The ${label} was sent, but some emails were not: ${reason}`, data: { code: 'DELIVERY_INCOMPLETE', field: 'delivery' }, cause: new AggregateError(failed, reason) })
  }
}

/** The business withdraws the document it stored or sent; its record stays in the conversation. */
export async function cancelAgreement(env: CloudflareEnv, conversation: ConversationRow, actor: AgreementActor) {
  const { booking, records, listing } = await readAgreement(env.DB, conversation)
  const state = agreementState(records, listing, booking, new Date().toISOString())
  if (!state?.request) throw new HTTPError({ statusCode: 409, message: 'This booking has no document to cancel', data: { code: 'NO_AGREEMENT_REQUEST', field: 'request_id' } })
  if (state.signers.length && state.signers.every(signer => signer.signature)) throw new HTTPError({ statusCode: 409, message: 'Everyone signed this document', data: { code: 'AGREEMENT_SIGNED', field: 'request_id' } })
  const dedupeKey = `agreement-cancelled:${state.request.id}`
  const writer = messageQueries({
    conversationId: conversation.id, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: actor.userId, eventName: 'agreement.cancelled',
    body: `Withdrew the ${agreementLabel(booking.productKind).toLowerCase()}`, payload: { request_id: state.request.id }, dedupeKey,
    // A last signature that lands while this is being withdrawn completes the document instead.
    ...(state.signers.length ? { guard: { sql: `(SELECT COUNT(*) FROM messages signed WHERE signed.conversation_id = c.id AND signed.event_name = 'agreement.signed'
      AND json_extract(signed.payload_json, '$.request_id') = ?) < ?`, params: [state.request.id, state.signers.length] } } : {}),
  })
  await executeBatch(env.DB, writer.queries, { operation: 'Withdraw agreement' })
  if (!await findMessageByDedupeKey(env.DB, dedupeKey)) throw new HTTPError({ statusCode: 409, message: 'Everyone signed this document', data: { code: 'AGREEMENT_SIGNED', field: 'request_id' } })
  await publishConversationEvent(env, env.DB, { conversationId: conversation.id, type: 'MESSAGE_CREATE' })
}

export interface SignAgreementInput {
  /** The document the signer reviewed: the request's message, or the listing agreement's asset. */
  documentId: string
  typedName: string
  consent: boolean
  ip: string | null
  userAgent: string | null
}

/** The viewer signs: their consent, the name they typed and the exact document's fingerprint, as a message in the booking's conversation. */
export async function signAgreement(env: CloudflareEnv, conversation: ConversationRow, viewer: AgreementViewer, input: SignAgreementInput) {
  if (!input.consent) throw new HTTPError({ statusCode: 422, message: 'Agree to sign electronically', data: { code: 'CONSENT_REQUIRED', field: 'consent' } })
  const typedName = input.typedName.trim()
  // The signed PDF draws the name in a Noto font: Latin, Greek and Cyrillic, Thai, Korean, Japanese or Chinese.
  if (!SIGNABLE_NAME.test(typedName)) throw new HTTPError({ statusCode: 422, message: 'Type your name in Latin, Greek, Cyrillic, Thai, Korean, Japanese or Chinese letters', data: { code: 'NAME_SCRIPT_UNSUPPORTED', field: 'typed_name' } })
  if (typedName.length < 2 || typedName.length > 120) throw new HTTPError({ statusCode: 422, message: 'Type your full name', data: { code: 'NAME_REQUIRED', field: 'typed_name' } })
  const { booking, records, listing, signerRows } = await readAgreement(env.DB, conversation, true)
  const state = agreementState(records, listing, booking, new Date().toISOString())
  const agreement = state ? await presentAgreement(env, state, booking, viewer, signerRows) : null
  if (!state || !agreement?.can_sign || !agreement.viewer_signer_key) throw new HTTPError({ statusCode: 409, message: 'There is nothing for you to sign on this booking', data: { code: 'NOTHING_TO_SIGN', field: 'conversation_id' } })
  const signerKey = agreement.viewer_signer_key
  const document = state.request ?? state.listing!
  const label = agreement.label.toLowerCase()
  // A document sent or replaced after the signer opened theirs is not the one they read.
  if (agreement.document_id !== input.documentId) throw new HTTPError({ statusCode: 409, message: `The ${label} changed. Open it again to read and sign the current one.`, data: { code: 'AGREEMENT_CHANGED', field: 'document_id' } })
  const original = await documentBytes(env, document.r2_key, label, state.request ? 'private' : 'public')
  const fingerprint = await sha256(original)
  if (state.request && fingerprint !== sentSchema.parse(payload(state.request)).sha256) throw new Error(`The ${label} changed in storage after it was sent`)
  const requestId = state.request?.id ?? null
  const occurredAt = new Date().toISOString()
  const signed = { request_id: requestId, signer_key: signerKey, typed_name: typedName, sha256: fingerprint, ip: input.ip, user_agent: input.userAgent }
  const writer = messageQueries({
    conversationId: conversation.id, authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: viewer.userId, eventName: 'agreement.signed', body: `Signed the ${label}`,
    payload: signed, occurredAt,
    dedupeKey: `agreement-signed:${requestId ?? `listing:${booking.bookingId}`}:${signerKey}`,
    // The signature is written only while its request stands: not withdrawn, and nothing sent after it.
    ...(requestId ? { guard: { sql: `NOT EXISTS (SELECT 1 FROM messages later WHERE later.conversation_id = c.id AND (
        (later.event_name = 'agreement.cancelled' AND json_extract(later.payload_json, '$.request_id') = ?)
        OR (later.event_name IN ('agreement.sent', 'agreement.stored') AND later.sequence > (SELECT sequence FROM messages WHERE id = ?))))`, params: [requestId, requestId] } } : {}),
  })
  // The last signature completes the document: the signed copy is drawn now and stored with it, so it is
  // the same file every time it is opened. Signing is ordered (guests, then the business), so one signer completes it.
  const completes = state.signers.every(signer => signer.signature !== null || signer.key === signerKey)
  try {
    if (!completes) {
      await executeBatch(env.DB, writer.queries, { operation: 'Sign agreement' })
    } else {
      const signatures = state.signers.map(signer => {
        if (signer.key === signerKey) return { signer, signed, at: occurredAt }
        const earlier = signedSchema.parse(payload(signer.signature!))
        if (earlier.sha256 !== fingerprint) throw new Error(`The ${label} in storage is not the one ${signer.name} signed`)
        return { signer, signed: earlier, at: signer.signature!.occurred_at }
      })
      const copy = await renderSignedAgreement(env, {
        original, fingerprint, fields: state.fields, signatures, label: agreement.label, fileName: document.file_name ?? 'Agreement.pdf',
        organizationName: booking.organizationName, sentAt: state.request?.occurred_at ?? null, completedAt: occurredAt,
      })
      await storeMessageDocument(env, conversation, viewer.userId, { bytes: copy.bytes, filename: copy.fileName, source: 'generated' }, writer)
    }
  } catch (error) {
    if (!completes) throw error
    // A completing signature that wrote no message leaves its signed copy's placement without an owner, which fails the batch.
    // The same signature sent twice: the first stored it and its copy. A request withdrawn or replaced meanwhile: the document changed.
    const earlier = await findMessageByDedupeKey(env.DB, writer.dedupeKey)
    if (!earlier) {
      const current = agreementState((await readAgreement(env.DB, conversation)).records, listing, booking, new Date().toISOString())
      if (current?.request?.id === requestId) throw error
      throw new HTTPError({ statusCode: 409, message: `The ${label} changed. Open it again to read and sign the current one.`, data: { code: 'AGREEMENT_CHANGED', field: 'document_id' }, cause: error })
    }
    if (earlier.id === writer.id) throw error
  }
  if (!await findMessageByDedupeKey(env.DB, writer.dedupeKey)) throw new HTTPError({ statusCode: 409, message: `The ${label} changed. Open it again to read and sign the current one.`, data: { code: 'AGREEMENT_CHANGED', field: 'document_id' } })
  await publishConversationEvent(env, env.DB, { conversationId: conversation.id, type: 'MESSAGE_CREATE' })
}

const SIGNABLE_NAME = /^[\p{Script=Latin}\p{Script=Greek}\p{Script=Cyrillic}\p{Script=Thai}\p{Script=Hangul}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}\p{Script=Common}\p{Script=Inherited}]+$/u

const NOTO_FONT_FILES = {
  thai: 'NotoSansThai-Regular.ttf',
  kr: 'NotoSansKR-Regular.ttf',
  jp: 'NotoSansJP-Regular.ttf',
  sc: 'NotoSansSC-Regular.ttf',
  tc: 'NotoSansTC-Regular.ttf',
  latin: 'NotoSans-Regular.ttf',
} as const
type NotoFontKey = keyof typeof NOTO_FONT_FILES

const WIN_ANSI_REGEX = /^[\u0020-\u007E\u00A0-\u00FF\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]*$/

function isWinAnsi(text: string): boolean {
  return WIN_ANSI_REGEX.test(text)
}

/**
 * A Noto font from the Worker's static assets, read once per document and
 * never kept between requests: the CJK files are 9–18 MB and the isolate has 128 MB.
 */
async function loadFontAssetBytes(env: CloudflareEnv, fileName: string, loaded: Map<string, Uint8Array>): Promise<Uint8Array> {
  const held = loaded.get(fileName)
  if (held) return held
  if (!env.ASSETS) throw new Error('The Worker has no ASSETS binding to read signature fonts from')
  const response = await env.ASSETS.fetch(new Request(`http://assets/fonts/${fileName}`))
  if (!response.ok) throw new Error(`Could not load font asset ${fileName}: ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  loaded.set(fileName, bytes)
  return bytes
}

type AgreementTextRun = { text: string; font: PDFFont; width: number }

/** Per-document fonts and measured lines shared by templates, signatures and their record. */
export function agreementTextLayout(env: CloudflareEnv, pdf: PDFDocument) {
  const loaded = new Map<string, Uint8Array>()
  const embedded = new Map<NotoFontKey, { font: PDFFont; characters: Set<number> }>()
  const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' })
  const words = new Intl.Segmenter('und', { granularity: 'word' })
  const fontAt = async (key: NotoFontKey) => {
    let held = embedded.get(key)
    if (!held) {
      const font = await pdf.embedFont(await loadFontAssetBytes(env, NOTO_FONT_FILES[key], loaded))
      held = { font, characters: new Set(font.getCharacterSet()) }
      embedded.set(key, held)
    }
    return held
  }
  const runsFor = async (text: string, standard: PDFFont): Promise<AgreementTextRun[]> => {
    const runs: AgreementTextRun[] = []
    for (const { segment } of graphemes.segment(text)) {
      let font = standard
      if (!isWinAnsi(segment)) {
        const key: NotoFontKey = /\p{Script=Thai}/u.test(segment) ? 'thai'
          : /\p{Script=Hangul}/u.test(segment) ? 'kr'
            : /[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(segment) ? 'jp'
              : /[\p{Script=Han}\u3000-\u303f\uff00-\uffef]/u.test(segment) ? 'sc' : 'latin'
        let selected = await fontAt(key)
        const covers = () => [...segment].every(character => selected.characters.has(character.codePointAt(0)!))
        if (!covers() && key === 'sc') selected = await fontAt('tc')
        if (!covers()) throw new HTTPError({ statusCode: 422, message: 'This document contains a character its fonts cannot render.', data: { code: 'AGREEMENT_GLYPH_UNSUPPORTED', field: 'document' } })
        font = selected.font
      }
      const last = runs.at(-1)
      if (last?.font === font) last.text += segment
      else runs.push({ text: segment, font, width: 0 })
    }
    return runs
  }
  return async (text: string, standard: PDFFont, size: number, width = Infinity): Promise<AgreementTextRun[][]> => {
    const lines: AgreementTextRun[][] = []
    let line: AgreementTextRun[] = []
    const append = (left: AgreementTextRun[], right: AgreementTextRun[]) => {
      const next = left.map(run => ({ ...run }))
      for (const run of right) {
        const last = next.at(-1)
        if (last?.font === run.font) last.text += run.text
        else next.push({ ...run })
      }
      for (const run of next) run.width = run.font.widthOfTextAtSize(run.text, size)
      return next
    }
    const flush = () => {
      while (line.length && !line.at(-1)!.text.trim()) line.pop()
      if (line.length) {
        const last = line.at(-1)!
        last.text = last.text.trimEnd()
        last.width = last.font.widthOfTextAtSize(last.text, size)
        lines.push(line)
      }
      line = []
    }
    for (const { segment } of words.segment(text)) {
      const token = /\s/u.test(segment) && !segment.trim() ? ' ' : segment
      let parts = [await runsFor(token, standard)]
      if (append([], parts[0]!).reduce((sum, run) => sum + run.width, 0) > width) {
        parts = []
        for (const { segment: character } of graphemes.segment(token)) parts.push(await runsFor(character, standard))
      }
      for (const part of parts) {
        if (!line.length && part.every(run => !run.text.trim())) continue
        const next = append(line, part)
        if (line.length && next.reduce((sum, run) => sum + run.width, 0) > width) {
          flush()
          if (part.every(run => !run.text.trim())) continue
          line = append([], part)
        } else line = next
      }
    }
    flush()
    return lines
  }
}

interface SignedCopyInput {
  original: Uint8Array<ArrayBuffer>
  fingerprint: string
  fields: AgreementField[]
  signatures: { signer: { key: string; name: string; role: 'guest' | 'host' }; signed: z.infer<typeof signedSchema>; at: string }[]
  label: string
  fileName: string
  organizationName: string
  /** When the business sent it to sign; a listing's agreement was never sent. */
  sentAt: string | null
  completedAt: string
}

/** The document with every signature where it was placed and a closing page that records who signed, when and how. */
async function renderSignedAgreement(env: CloudflareEnv, input: SignedCopyInput): Promise<{ bytes: Uint8Array<ArrayBuffer>; fileName: string }> {
  const [{ PDFDocument, StandardFonts, rgb }, { default: fontkit }] = await Promise.all([import('pdf-lib'), import('@pdf-lib/fontkit')])
  const SIGNATURE_COLOR = rgb(0.09, 0.09, 0.11)
  const { original, fingerprint, signatures } = input
  // The signed document's dates are the signing's, not the moment it was drawn.
  const pdf = await PDFDocument.load(original, { updateMetadata: false })
  pdf.setModificationDate(new Date(input.completedAt))
  pdf.registerFontkit(fontkit)
  const [script, regular, bold] = await Promise.all([pdf.embedFont(StandardFonts.TimesRomanItalic), pdf.embedFont(StandardFonts.Helvetica), pdf.embedFont(StandardFonts.HelveticaBold)])

  const layout = agreementTextLayout(env, pdf)

  const day = (at: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(new Date(at))
  for (const field of input.fields) {
    const page = pdf.getPage(field.page - 1)
    // Fields were placed on the page as a viewer shows it: its crop box, which need not start at the origin.
    const { x: left, y: bottom, width, height } = page.getCropBox()
    const signature = signatures.find(({ signer }) => signer.key === field.signer_key)!
    const text = field.kind === 'signature' ? signature.signed.typed_name : day(signature.at)
    const defaultFont = field.kind === 'signature' ? script : regular
    const runs = (await layout(text, defaultFont, 1)).flat()
    const box = { x: left + field.x * width, y: bottom + height - (field.y + field.height) * height, w: field.width * width, h: field.height * height }
    // One line, shrunk to the field's width, so a long name never runs below it.
    const tallest = Math.min(box.h * (field.kind === 'signature' ? 0.8 : 0.6), field.kind === 'signature' ? 28 : 12)
    // Padding scales with the field, so even a hairline field keeps a positive width to fit the text into.
    const pad = Math.min(2, box.w * 0.05)
    const size = Math.min(tallest, (box.w - 2 * pad) / Math.max(runs.reduce((sum, run) => sum + run.width, 0), 0.01))
    let x = box.x + pad
    for (const run of runs) {
      page.drawText(run.text, { x, y: box.y + (box.h - size) / 2 + size * 0.2, size, font: run.font, color: SIGNATURE_COLOR })
      x += run.width * size
    }
  }
  // The signature record: what was signed, by whom, when and from where.
  let page = pdf.addPage([612, 792])
  let y = 740
  const line = async (text: string, size = 10, defaultFont = regular) => {
    for (const runs of await layout(text, defaultFont, size, 504)) {
      if (y - (size + 2) < 54) { page = pdf.addPage([612, 792]); y = 740 }
      let x = 54
      for (const run of runs) {
        page.drawText(run.text, { x, y, size, font: run.font, color: SIGNATURE_COLOR })
        x += run.width
      }
      y -= size + 2
    }
    y -= 6
  }
  await line('Signature record', 16, bold)
  await line(`${input.label} · ${input.fileName}`)
  await line(`Document fingerprint (SHA-256): ${fingerprint}`, 8)
  y -= 8
  for (const { signer, signed, at } of signatures) {
    await line(signer.role === 'host' ? `${signer.name}, for ${input.organizationName}` : `${signer.name} (guest)`, 11, bold)
    await line(`Signed as “${signed.typed_name}” on ${new Date(at).toUTCString()}`)
    await line(`Agreed to sign electronically. IP address ${signed.ip ?? 'not recorded'}.`, 9)
    y -= 6
  }
  if (input.sentAt) await line(`Sent ${new Date(input.sentAt).toUTCString()}. Completed ${new Date(input.completedAt).toUTCString()}.`, 9)
  await line('Signed through Blawby.', 9)
  return { bytes: new Uint8Array(await pdf.save({ updateFieldAppearances: false })), fileName: input.fileName.replace(/\.pdf$/i, '') + '-signed.pdf' }
}

/** Who the business may ask to sign: the booking's guests in its conversation, and the business's own signer last. */
function availableSigners(guests: SignerRow[], actor: AgreementActor): { key: string; name: string; role: 'guest' | 'host' }[] {
  // A guest with an account signs as it; one who booked without one is invited by the email they booked with.
  return [
    ...guests.flatMap(guest => {
      if (guest.anonymous) {
        const email = guest.booked_email?.trim().toLowerCase()
        return email && guest.booked_name?.trim() ? [{ key: `email:${email}`, name: guest.booked_name.trim(), role: 'guest' as const }] : []
      }
      return guest.name?.trim() ? [{ key: `user:${guest.user_id}`, name: guest.name.trim(), role: 'guest' as const }] : []
    }),
    { key: `user:${actor.userId}`, name: actor.name, role: 'host' as const },
  ]
}
