import { ChannexConnection, prepareChannexStatus } from '~/server/integrations/channex/channel-connection'
import { calendarPresentation } from '~/shared/dashboard-presentation'
import { listingGrantSql } from '~/server/domain/listing-access'
import { assignedOperationsRoles, roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import type { H3Event } from 'nitro'
import { HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { executeBatch, type BatchQuery } from '~/server/db'
import { agreementQueries, bookingAgreementFromRows } from '~/server/domain/agreements'
import { dashboardMemberQuery, dashboardOrgQueryParam, getDashboardMemberContext, readDashboardMemberResources, prepareOrganizationLocations } from '~/server/utils/dashboard-context'
import { readRequiredBody } from '~/server/utils/api-response'
import { assignedMemberSql, BATCH_VIEWER, memberAccessPrincipal, membershipBySlugQuery, roleAllows, withViewer } from '~/server/utils/member-access'
import { bookedRecordsInRange, type BookedRecordInRange } from '~/server/domain/product-bookings'
import { BOOKING_RECORDS_SQL, bookingDay, guestRequestMappingQuery, guestRequestQuery, requestActions, threadOperationalRecordFromRow, threadOperationalRecordQuery, validateGuestRequest, type BookedRecord } from '~/server/domain/requests'
import { guestReplyAccountQuery, guestReplyDestination, type GuestReplyAccount } from '~/server/domain/guest-threads/operations'
import { pendingStayChangesFromRows, pendingStayChangesQuery } from '~/server/domain/guest-threads/stay-change-requests'
import { calendarStays, canReleaseStayNights, dashboardStayEditQueries, prepareStayReservationHome, prepareStayHomesDocument, stayAccessFor, stayCalendarOf, stayCalendarQueries, stayDetailFrom, stayDetailQuery, stayDetailSelection, type StayHome, type StayNight, type StayReservationHome } from '~/server/domain/stays'
import { guestThreadChannelQuery, parseGuestThreadChannel, type GuestThreadChannelRow } from '~/server/domain/guest-threads/channel-messages'
import { sourceLocaleFromRows, sourceLocaleQuery } from '~/server/utils/localization'
import { placesCalendarOf, placesCalendarQueries, placesPresenceQuery, placesWindow } from '~/server/domain/places'
import { prepareStaffBookingDetails } from '~/server/utils/dashboard-booking-details'
import { isChannelManagedStay, stayGuestFirstName } from '~/shared/bookings'
import { messageListPage } from '~/server/domain/guest-message-schedule'
import { groupMediaPlacements, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import { productPhotosFromPlacements } from '~/server/utils/media-placement'
import { isValidCalendarDate, localDateAt } from '~/utils/timezone'
import { oncePerRequest } from '~/server/utils/request-scope'

export type BookingHome = StayReservationHome
export type TurnoverBookingHome = Pick<StayHome, 'name' | 'internal_name' | 'check_in_time' | 'check_in_end_time' | 'check_out_time' | 'check_in_method' | 'check_in_instructions'>
  & { image_url: string | null }

export function nightBooking<T extends { id: string }>({ id, ...record }: T) {
  return { ...record, booking_id: id, unit: 'nights' as const }
}

/** Released native decoders require both keys. No checkout or linked calendar owns nights now. */
export function dashboardCalendarNight(night: StayNight) {
  return { ...night, held_until: null, calendar: null }
}

async function dashboardBookingsContext(event: H3Event) {
  const context = await getDashboardMemberContext(event)
  const principal = memberAccessPrincipal(context.organization, { env: context.env, event })
  const access = await stayAccessFor(principal)
  return { ...context, principal, access }
}

function bookingPatchChangesStay(body: Record<string, unknown>) {
  return Object.keys(body).some(field => field !== 'version' && field !== 'private_notes')
}

export async function dashboardBookingContext(event: H3Event, action: 'read' | 'update' = 'read', readPatch?: true, record?: { orgSlug: string; bookingId: string }, preloaded?: D1Result[]) {
  const { env, db, session, userId, membership, organizationFrom } = await dashboardMemberQuery(event, record?.orgSlug)
  const bookingId = record?.bookingId ?? getRouterParam(event, 'booking_id')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  const patch = readPatch ? await readRequiredBody<Record<string, unknown>>(event).then(
    body => ({ body }), (error: unknown) => ({ error }),
  ) : null
  const patchBody = patch && 'body' in patch ? patch.body : undefined
  const changesStay = patchBody ? bookingPatchChangesStay(patchBody) : false
  const stayQueries = changesStay ? dashboardStayEditQueries({ query: BATCH_VIEWER.organization }, bookingId, patchBody?.check_in_date) : []
  const [memberResult, bookingResult, stayResult, homeResult] = preloaded ?? await executeBatch(db, [
    membership, withViewer(membership, bookingAccessQuery(bookingId)), ...stayQueries.map(query => withViewer(membership, query)),
  ], { operation: 'Read dashboard booking access' })
  const organization = organizationFrom(memberResult?.results[0])
  const principal = memberAccessPrincipal(organization, { env, event })
  const workspace = await stayAccessFor(principal)
  const booking = bookingResult?.results[0] as Pick<BookedRecord, 'unit' | 'status' | 'respond_by' | 'product_id' | 'location_id' | 'product_kind'>
    & { conversation_id: string; conversation_location_id: string | null; assigned: number; granted: number; operates: number } | undefined
  const hasReadAccess = booking?.granted || booking?.assigned || workspace.manage
  const hasUpdateAccess = booking?.operates || booking?.assigned || workspace.manage
  if (!booking || (action === 'read' ? !hasReadAccess : !hasUpdateAccess || (readPatch && !changesStay && !hasReadAccess))) {
    throw new HTTPError({ statusCode: 404, message: 'Booking not found' })
  }
  const access = !workspace.manage && booking.operates
    ? { ...workspace, manage: true as const, listingId: booking.product_id, operationalOnly: true }
    : workspace
  if (patch && 'error' in patch) throw patch.error
  const stayEdit = changesStay ? { current: stayResult?.results[0], home: homeResult?.results[0] } : undefined
  return { db, env, session, userId, organization, principal, access, bookingId, booking, patchBody, stayEdit }
}

function bookingAccessQuery(bookingId: string): BatchQuery {
  return {
    query: `SELECT b.id AS booking_id, b.organization_id, b.unit,
        ${BATCH_VIEWER.organizationWide} AS manages,
        ${roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ payments: ['read'] }))} AS can_read_payments, c.id AS conversation_id, c.location_id AS conversation_location_id, b.status, b.respond_by, b.product_id, b.location_id, b.product_kind,
        (${roleMatchesSql(BATCH_VIEWER.role!, assignedOperationsRoles)} AND ${assignedMemberSql('b', BATCH_VIEWER.user)}) AS assigned,
        ${listingGrantSql('b.organization_id', 'b.product_id', BATCH_VIEWER.member, 'details', BATCH_VIEWER.role)} AS granted,
        ${listingGrantSql('b.organization_id', 'b.product_id', BATCH_VIEWER.member, 'update', BATCH_VIEWER.role)} AS operates
      FROM ${BOOKING_RECORDS_SQL} b
      JOIN conversations c ON c.booking_id=b.id AND c.organization_id=b.organization_id AND c.kind='booking'
      WHERE b.organization_id = ${BATCH_VIEWER.organization} AND b.id = ?`,
    params: [bookingId],
  }
}

export function prepareDashboardBookingRead(membership: BatchQuery, bookingId: string) {
  const booking = bookingAccessQuery(bookingId)
  const access = withViewer(membership, booking)
  const timed = prepareStaffBookingDetails(bookingId, {
    query: `SELECT * FROM (${access.query}) target WHERE unit = 'slot' AND (manages = 1 OR assigned = 1 OR granted = 1)`,
    params: access.params,
  })
  // Only a readable, managed stay supplies an organization, conversation and home.
  const managed = `SELECT * FROM (${booking.query}) target
    WHERE unit = 'nights' AND (manages = 1 OR (operates = 1 AND (assigned = 1 OR granted = 1)))`
  const organizationId = { sql: '(SELECT organization_id FROM reservation)' }
  const conversationId = { sql: '(SELECT conversation_id FROM reservation)' }
  const home = prepareStayReservationHome({
    organizationId, productId: { sql: '(SELECT product_id FROM reservation)' }, showLocation: true, showArrival: true,
  })
  const stayQueries = [
    stayDetailSelection({ query: organizationId.sql }, bookingId, true),
    guestRequestQuery(conversationId, organizationId, 'booking'),
    guestRequestMappingQuery(conversationId, organizationId),
    guestThreadChannelQuery(conversationId, organizationId),
    guestReplyAccountQuery({ query: `SELECT user_id FROM conversations WHERE id = ${conversationId.sql} AND organization_id = ${organizationId.sql}` }),
    threadOperationalRecordQuery(conversationId),
    pendingStayChangesQuery({ bookingId, conversationId, organizationId, userId: { sql: BATCH_VIEWER.user } }),
    sourceLocaleQuery(organizationId),
    ...home.queries,
  ].map(query => withViewer(membership, {
    query: `WITH reservation AS (${managed}) ${query.query}`,
    params: [...booking.params ?? [], ...query.params ?? []],
  }))
  // The booking's agreement rides in the same round trip, for any booking the viewer may read.
  const readable = `SELECT * FROM (${booking.query}) target WHERE manages = 1 OR assigned = 1 OR granted = 1`
  const agreement = agreementQueries({ booking: { sql: '?', params: [bookingId] }, organization: { sql: '(SELECT organization_id FROM readable)', params: [] } }, true)
    .map(query => withViewer(membership, { query: `WITH readable AS (${readable}) ${query.query}`, params: [...booking.params ?? [], ...query.params ?? []] }))
  const queries = [access, ...timed.queries, ...stayQueries, ...agreement]
  return { queries, timed, home, stayOffset: 2 + timed.queries.length, agreementOffset: 1 + queries.length - agreement.length }
}

export function readDashboardBookingDocument(event: H3Event, record: { orgSlug: string; bookingId: string }, preloaded?: D1Result[]) {
  return oncePerRequest(event, `dashboard-reservation-data:${record.orgSlug}:${record.bookingId}`, () =>
    dashboardBookingDetails(event, record, preloaded))
}

export async function dashboardBookingDetails(event: H3Event, record?: { orgSlug: string; bookingId: string }, preloaded?: D1Result[]) {
  const { env, db, membership } = await dashboardMemberQuery(event, record?.orgSlug)
  const bookingId = record?.bookingId ?? getRouterParam(event, 'booking_id')
  if (!bookingId) throw new HTTPError({ statusCode: 400, message: 'Booking ID is required' })
  const plan = prepareDashboardBookingRead(membership, bookingId)
  const rows = preloaded ?? await executeBatch(db, [membership, ...plan.queries], { operation: 'Read the staff reservation' })
  const { access, organization, booking, session } = await dashboardBookingContext(event, 'read', undefined, record, rows)
  const viewer = { userId: session.user.id, verifiedEmail: session.user.emailVerified ? session.user.email : null, canManage: Boolean(access.manage || booking.operates || booking.assigned), guest: false }
  const agreementOf = () => bookingAgreementFromRows(env, rows.slice(plan.agreementOffset), viewer, { userId: session.user.id, name: session.user.name })
  if (booking.unit === 'slot') {
    const facts = rows.slice(2, plan.stayOffset)
    const canReadPayments = await roleAllows({ ...organization, permissions: { payments: ['read'] } })
    return { booking: { ...await plan.timed.read(db, env, facts, canReadPayments), ...await agreementOf() }, manage: access.manage }
  }
  if (!access.manage) {
    const [stayRows, houseRows, media] = await executeBatch(db, [
      stayDetailQuery(access, bookingId),
      { query: `SELECT p.name, c.internal_name, b.check_in_time, b.check_in_end_time, b.check_out_time,
        c.check_in_method, c.check_in_instructions
        FROM product_stay_configs c
        JOIN products p ON p.organization_id=c.organization_id AND p.id=c.product_id
        JOIN product_booking_configs b ON b.organization_id=c.organization_id AND b.product_id=c.product_id
        WHERE c.organization_id=? AND c.product_id=?`, params: [organization.id, booking.product_id] },
      mediaPlacementsQuery({ organizationId: organization.id, ownerType: 'product', owners: [booking.product_id] }),
    ], { operation: 'Read turnover reservation and home' })
    const stay = stayDetailFrom(access, stayRows!.results[0])
    const house = houseRows!.results[0] as Omit<TurnoverBookingHome, 'image_url'> | undefined
    const photos = productPhotosFromPlacements(groupMediaPlacements(media!.results, [booking.product_id]))
    if (!house) throw new Error('The booking has no home')
    const home = { ...house, image_url: mediaStillUrl(photos.get(booking.product_id)?.[0]) }
    return { booking: nightBooking(stay), manage: false as const, home }
  }
  const [stayRows, threadRows, mapping, channelRows, accountRows, operations, changes, locale, ...homeRows] = rows.slice(plan.stayOffset, plan.agreementOffset)
  const stay = stayDetailFrom(access, stayRows!.results[0])
  const home = plan.home.read(homeRows)
  const threadRow = threadRows!.results[0] as Record<string, unknown> | undefined
  if (!threadRow) throw new Error('The booking has no guest conversation')
  const thread = await validateGuestRequest(db, threadRow, Boolean(mapping!.results.length))
  if (thread.booking_id !== bookingId) throw new Error('The booking has no guest conversation')
  const channel = channelRows!.results[0] as GuestThreadChannelRow | undefined
  const account = (accountRows!.results[0] as GuestReplyAccount | undefined) ?? null
  const canMessageGuest = !thread.blocked_at && (await guestReplyDestination(db, thread, channel ? parseGuestThreadChannel(channel) : null, account)).channel !== null

  const channelOwned = isChannelManagedStay(stay)
  const releaseNights = canReleaseStayNights(stay)
  const operationalRecord = stay.request_status && !releaseNights ? threadOperationalRecordFromRow(operations!.results[0]) : null
  if (stay.request_status && !releaseNights && !operationalRecord) throw new Error('The conversation has no booking')
  const available_actions = releaseNights ? ['release_nights'] : operationalRecord ? requestActions(operationalRecord, new Date().toISOString())
    : stay.status === 'cancelled' || channelOwned ? [] : ['edit', 'cancel']
  const pending_changes = stay.channel === 'airbnb' && channelOwned && changes!.results.length
    ? pendingStayChangesFromRows(changes!.results, bookingId, sourceLocaleFromRows(organization.id, locale!.results).locale)
    : []
  return { booking: { ...nightBooking(stay), available_actions, pending_changes, ...await agreementOf() }, manage: true, home: { ...home, image_url: home.photo_urls[0] ?? null }, can_message_guest: canMessageGuest }
}

interface BookingListQuery { location_id?: unknown; unit?: unknown; from?: unknown; to?: unknown; product_id?: unknown; include_cancelled?: unknown }

function bookingListWindow(query: BookingListQuery) {
  const { unit, from, to, product_id: productId } = query
  if (unit !== undefined && unit !== 'slot' && unit !== 'nights') throw new HTTPError({ statusCode: 422, message: 'Invalid booking unit' })
  if (!isValidCalendarDate(from) || !isValidCalendarDate(to) || to <= from) {
    throw new HTTPError({ statusCode: 422, message: 'Choose calendar dates with to after from' })
  }
  if (productId !== undefined && (typeof productId !== 'string' || !productId)) throw new HTTPError({ statusCode: 422, message: 'Invalid product ID' })
  const locationId = query.location_id
  if (locationId !== undefined && (typeof locationId !== 'string' || !locationId.trim())) throw new HTTPError({ statusCode: 422, message: 'Choose a valid location', data: { code: 'INVALID_BOOKING_FILTER', field: 'location_id' } })
  return { unit, from, to, productId, locationId, includeCancelled: query.include_cancelled === 'true' }
}

type BookingWindow = ReturnType<typeof bookingListWindow>

/** A visit's booking as the bookings list and the host Calendar show it, from the one read of booked records. */
function timedBookings(records: BookedRecordInRange[], { productId, from, to }: BookingWindow) {
  return records.flatMap((record) => {
    const day = localDateAt(new Date(record.starts_at), record.timezone)
    if (record.unit !== 'slot' || day < from || day >= to || (productId && record.product_id !== productId)) return []
    const { id, unit, product_id, product_kind, product_name, location_title, guest_name, status, starts_at, ends_at, timezone } = record
    return [{ booking_id: id, unit, product_id, product_kind, name: product_name, location_title, guest_name, status, starts_at, ends_at, timezone }]
  })
}

export async function dashboardBookingList(event: H3Event, query: BookingListQuery) {
  const window = bookingListWindow(query)
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const locations = prepareOrganizationLocations(BATCH_VIEWER, true)
  const { env, organization, rows: [booked, ...placeRows] } = await readDashboardMemberResources(event, { slug }, [
    bookedRecordsInRange(BATCH_VIEWER, { ...window, cancelled: window.includeCancelled, includeAssignedStays: true, includePayments: true }),
    ...locations.queries,
  ])
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const records = (booked!.results as BookedRecordInRange[]).filter(record => !window.locationId || record.location_id === window.locationId)
  const stays = window.unit === 'slot' ? [] : calendarStays(records, access.manage, window, record => !window.productId || record.product_id === window.productId)
  return { bookings: [...(window.unit === 'nights' ? [] : timedBookings(records, window)), ...stays], manage: access.manage,
    locations: locations.read(placeRows, organization.id).locations }

}

/**
 * Bookings found by who made them or what was booked, across every date,
 * newest first (#2103): the web calendar's and the app's booking search. The
 * reader sees what the booked records already let them read in full.
 */
export async function dashboardBookingSearch(event: H3Event, query: { q?: unknown; limit?: unknown; offset?: unknown }) {
  const q = typeof query.q === 'string' ? query.q.trim() : ''
  if (!q || q.length > 200) throw new HTTPError({ statusCode: 422, message: 'Search for 1 to 200 characters', data: { code: 'INVALID_SEARCH', field: 'q' } })
  const limit = query.limit === undefined ? 20 : Number(query.limit)
  const offset = query.offset === undefined ? 0 : Number(query.offset)
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HTTPError({ statusCode: 422, message: 'limit must be 1 to 50', data: { code: 'INVALID_LIMIT', field: 'limit' } })
  if (!Number.isInteger(offset) || offset < 0) throw new HTTPError({ statusCode: 422, message: 'offset must be 0 or more', data: { code: 'INVALID_OFFSET', field: 'offset' } })
  const { db, organization, userId, access } = await dashboardBookingsContext(event)
  const [records] = await executeBatch(db, [withViewer(membershipBySlugQuery(organization.slug, userId),
    bookedRecordsInRange(BATCH_VIEWER, { search: { q, limit: limit + 1, offset }, cancelled: true, includeAssignedStays: true }))], { operation: 'Search bookings' })
  const { items, pagination } = messageListPage(records!.results as BookedRecordInRange[], { limit, offset })
  return {
    bookings: items.map(record => ({
      booking_id: record.id, unit: record.unit, status: record.status, product_id: record.product_id, product_kind: record.product_kind, product_name: record.product_name,
      location_title: record.location_title,
      // A member who looks after a home reads its guest by first name, as its turnover does.
      guest_name: record.unit === 'nights' && !access.manage ? stayGuestFirstName(record.guest_name) : record.guest_name,
      channel: record.channel, starts_at: record.starts_at, ends_at: record.ends_at, timezone: record.timezone,
      day: bookingDay(record.starts_at, record.timezone),
      conversation_id: record.viewer_seated ? record.conversation_id : null,
    })),
    pagination,
  }
}

/**
 * The host Calendar's places: one D1 round trip after the session, as
 * Messages reads its inbox. The batch's first statement is the membership,
 * read by the organization's slug, and every other statement names the
 * organization through that slug.
 */
async function dashboardPlacesCalendar(event: H3Event, window: BookingWindow, orgSlug?: string) {
  const slug = orgSlug ?? dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const days = placesWindow(window)
  const { env, organization, rows: [records, ...places] } = await readDashboardMemberResources(event, { slug }, [
    bookedRecordsInRange(BATCH_VIEWER, { ...window, cancelled: window.includeCancelled, includeCalendarGrants: true }),
    ...placesCalendarQueries({ query: BATCH_VIEWER.organization, params: [] }, { sql: BATCH_VIEWER.user }, days),
  ])
  const principal = memberAccessPrincipal(organization, { env, event })
  await stayAccessFor(principal)
  const calendar = await placesCalendarOf(principal, days, places)
  return { from: window.from, to: window.to, bookings: timedBookings(records!.results as BookedRecordInRange[], window), homes: [], places: calendar.places, manage: calendar.manage }
}

/** The calendar's records, optional full home context and Better Auth session share one batch. */
async function dashboardHomesCalendar(event: H3Event, window: BookingWindow, orgSlug?: string, includeHomes = false) {
  const slug = orgSlug ?? dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const queries = stayCalendarQueries({ from: window.from, to: window.to, productId: window.productId ?? null, cancelled: window.unit !== 'nights' && window.includeCancelled })
  const context = includeHomes ? prepareStayHomesDocument(null) : null
  const connection = includeHomes ? prepareChannexStatus({ sql: `CASE WHEN ${BATCH_VIEWER.organizationWide} = 1 THEN ${BATCH_VIEWER.organization} END` }) : null
  const unique: BatchQuery[] = [], byQuery = new Map<string, number>()
  const positions = [...queries, ...(context?.queries ?? []), ...(connection?.queries ?? [])].map(query => {
    const key = JSON.stringify([query.query, query.params])
    let index = byQuery.get(key)
    if (index === undefined) { index = unique.length; byQuery.set(key, index); unique.push(query) }
    return index
  })
  const { env, organization, userId, rows: results } = await readDashboardMemberResources(event, { slug }, unique)
  const rows = positions.map(index => results[index]!)
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const calendar = stayCalendarOf(rows.slice(0, queries.length), access.manage, window)
  if (window.productId && !calendar.homes.length) throw new HTTPError({ statusCode: 404, message: 'That place to stay is not in this organization', data: { code: 'HOME_NOT_FOUND' } })
  const airbnb = connection && access.manage && organization.vertical === 'lodging' && calendar.homes.length === 0
    ? await new ChannexConnection(env.DB, env, organization.id, userId).status(connection.read(rows.slice(queries.length + context!.queries.length))) : null
  const homes = calendar.homes.map(entry => ({ ...entry, nights: entry.nights.map(dashboardCalendarNight) }))
  return { from: window.from, to: window.to,
    bookings: window.unit === 'nights' ? calendar.stays : [...timedBookings((rows[3]!.results as BookedRecordInRange[]).filter(record => !window.locationId || record.location_id === window.locationId), window), ...calendar.stays],
    homes, places: [], manage: access.manage, presentation: calendarPresentation,
    ...(context ? { home_context: { homes: context.read(rows.slice(queries.length, queries.length + context.queries.length)), manage: access.manage, airbnb } } : {}),
  }
}

export async function dashboardBookingCalendar(event: H3Event, query: BookingListQuery & { include_homes?: unknown }, orgSlug?: string) {
  const window = bookingListWindow(query)
  if (query.include_homes !== undefined && query.include_homes !== 'true') throw new HTTPError({ statusCode: 400, message: 'include_homes must be true', data: { code: 'INVALID_CALENDAR_CONTEXT', field: 'include_homes' } })
  if (window.unit === 'slot') return dashboardPlacesCalendar(event, window, orgSlug)
  return dashboardHomesCalendar(event, window, orgSlug, query.include_homes === 'true')
}

export async function readCalendarPlacePresence(event: H3Event, orgSlug?: string) {
  const slug = orgSlug ?? dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Choose a workspace', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const preloaded = event.context.dashboardCalendarPresence as { slug: string; has_places: boolean } | undefined
  if (preloaded?.slug === slug) return { has_places: preloaded.has_places }
  const { env, organization, rows } = await readDashboardMemberResources(event, { slug }, [placesPresenceQuery({ query: BATCH_VIEWER.organization, params: [] }, { sql: BATCH_VIEWER.user })])
  await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const row = rows[0]!.results[0] as { has_places: number } | undefined
  if (!row) throw new Error('Calendar places could not be read')
  return { has_places: row.has_places === 1 }
}
