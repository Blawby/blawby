/**
 * Memberships (#1907): an offering bought for a recurring price, with no
 * session to book. Stripe owns the agreement: Checkout in subscription mode on
 * the business's connected account takes the member's consent to recurring
 * payments and the first one; Stripe's subscription renews, retries a failed
 * card and cancels; its customer portal is where the member manages it. Blawby
 * keeps no subscription state. Each invoice Stripe reports paid is recorded as
 * a payment of the membership (`subject_type` membership, `subject_id` the
 * subscription), and the first opens the member's conversation with the
 * business. Everything else is read from Stripe when it is shown.
 */
import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { paymentsStripe, requireStripeCheckoutAcceptance } from '~/server/utils/stripe-connect'
import { connectedBuyerCustomer, type ConnectedBuyer } from '~/server/utils/billing-customer'
import { getProduct, organizationDefaultCurrency } from '~/server/utils/product-management'
import { hasSiteProductPage, presentationForProduct } from '~/utils/product-presentation'
import { requestInsertQueries } from '~/server/domain/requests'
import { recordPaidInvoice } from '~/server/domain/payments/installments'
import { formatBillingTerms, isMembershipProduct, membershipPrice, type Membership, type MembershipState } from '~/shared/memberships'
import { AmbiguousPriceError, formatMinorAmount, type PriceRecurringInterval } from '~/shared/prices'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'

const PRODUCT_KEY = 'blawby_product_id'

function fail(statusCode: number, code: string, message: string, field?: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, ...(field ? { field } : {}) } })
}

const text = (value: unknown, field: string, max: number, required: boolean): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (required && !trimmed) fail(400, 'VALIDATION_ERROR', `${field} is required`, field)
  if (trimmed.length > max) fail(400, 'VALIDATION_ERROR', `${field} is at most ${max} characters`, field)
  return trimmed || null
}

export interface MembershipCheckoutInput {
  organizationId: string
  buyer: ConnectedBuyer & { isAnonymous?: boolean | null }
  product_id: unknown; product_variant_id: unknown; location_id: unknown
  guest: { name: unknown; email: unknown; phone: unknown }
  idempotencyKey: unknown
  /** The business's own site, where Stripe returns the member. */
  siteOrigin: string
}

/**
 * Starts Stripe Checkout for one membership: the variant's recurring price at
 * this location, frozen into the subscription Stripe creates. Nothing is
 * written here; the membership exists once Stripe reports its first payment.
 */
export async function createMembershipCheckout(db: DbClient, env: CloudflareEnv, input: MembershipCheckoutInput): Promise<{ checkout_url: string }> {
  const key = text(input.idempotencyKey, 'idempotency_key', 200, true)!
  const productId = text(input.product_id, 'product_id', 100, true)!
  const variantId = text(input.product_variant_id, 'product_variant_id', 100, true)!
  const locationId = input.location_id === null || input.location_id === undefined ? null : text(input.location_id, 'location_id', 100, true)
  const guest = { name: text(input.guest.name, 'guest_name', 200, true)!, email: text(input.guest.email, 'guest_email', 254, true)!.toLowerCase(), phone: text(input.guest.phone, 'guest_phone', 40, false) }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(guest.email)) fail(400, 'VALIDATION_ERROR', 'Enter a valid email', 'guest_email')

  const product = await getProduct(db, input.organizationId, productId)
  if (!isMembershipProduct(product) || !product.active || !product.publications.some(publication => publication.published)) fail(404, 'MEMBERSHIP_NOT_FOUND', 'This membership is not offered')
  const variant = product.variants.find(candidate => candidate.id === variantId && candidate.active)
  if (!variant) fail(404, 'VARIANT_NOT_FOUND', 'Choose one of this membership’s options', 'product_variant_id')
  // A membership offered at locations is bought at one of them; one offered at none is bought without one.
  const offered = product.locations.filter(location => location.active && location.published).map(location => location.location_id)
  if (offered.length ? !locationId || !offered.includes(locationId) : locationId !== null) fail(422, 'LOCATION_REQUIRED', offered.length ? 'Choose where you are joining' : 'This membership is not offered at a location', 'location_id')
  const currency = await organizationDefaultCurrency(db, input.organizationId)
  const locationSlug = locationId ? (await queryFirst<{ slug: string }>(db, 'SELECT slug FROM business_locations WHERE organization_id = ? AND id = ?', [input.organizationId, locationId]))?.slug ?? null : null
  let price
  try { price = membershipPrice(variant.prices, { currency, location_id: locationId }) }
  catch (error) {
    if (error instanceof AmbiguousPriceError) fail(409, 'MEMBERSHIP_PRICE_AMBIGUOUS', 'This membership has more than one price at once; the business needs to keep one')
    throw error
  }
  if (!price || price.unit_amount <= 0) fail(409, 'MEMBERSHIP_PRICE_MISSING', 'This membership has no price here', 'product_variant_id')

  const acceptance = await requireStripeCheckoutAcceptance(db, env, input.organizationId)
  const { connected, stripe } = acceptance
  if (!connected.stripe_account_id) throw new Error('Checkout has no connected account')
  const stripeAccount = connected.stripe_account_id
  // A signed-in member's Customer at this business, so their memberships and cards are in one place; a guest's is made by Checkout.
  const customer = input.buyer.isAnonymous ? null : await connectedBuyerCustomer(db, stripe, input.buyer, stripeAccount, connected.livemode)
  const title = product.variants.filter(entry => entry.active).length > 1 ? `${product.name} (${variant.name})` : product.name
  const metadata = {
    [PRODUCT_KEY]: product.id, blawby_variant_id: variant.id, blawby_price_id: price.id, blawby_location_id: locationId ?? '',
    blawby_buyer_user_id: input.buyer.id, blawby_guest_name: guest.name, blawby_guest_email: guest.email, blawby_guest_phone: guest.phone ?? '',
    blawby_title: title, blawby_terms: formatBillingTerms(formatMinorAmount(price.unit_amount, price.currency), price),
  }
  const productPath = hasSiteProductPage(product.kind) ? presentationForProduct(product).productPath(locationSlug ?? '', product.slug) : product.page?.path ?? '/'
  const session = await stripe.checkout.sessions.create({
    mode: 'subscription',
    // Stripe Tax locates a returning member from the address Checkout collects, saved to their Customer.
    ...(customer ? { customer: customer.customerId, ...(acceptance.automaticTax ? { customer_update: { address: 'auto' as const, name: 'auto' as const } } : {}) } : { customer_email: guest.email }),
    client_reference_id: input.buyer.id,
    line_items: [{ quantity: 1, price_data: {
      currency: price.currency.toLowerCase(), unit_amount: price.unit_amount,
      recurring: { interval: price.recurring_interval!, interval_count: price.recurring_interval_count! },
      product_data: { name: title, ...(product.tax_code ? { tax_code: product.tax_code } : {}), metadata: { [PRODUCT_KEY]: product.id } },
      ...(price.tax_behavior === 'unspecified' ? {} : { tax_behavior: price.tax_behavior }),
    } }],
    // Which methods the member may use is the business's payment method configuration's to decide.
    payment_method_configuration: acceptance.methodConfigurationId,
    automatic_tax: { enabled: acceptance.automaticTax },
    // The member pays the price the business set, in its currency, as the page and the business's records state it; Stripe's Adaptive Pricing would show another currency's amount.
    adaptive_pricing: { enabled: false },
    subscription_data: { description: title, metadata },
    metadata,
    success_url: new URL(`/memberships/{CHECKOUT_SESSION_ID}`, input.siteOrigin).toString().replace('%7BCHECKOUT_SESSION_ID%7D', '{CHECKOUT_SESSION_ID}'),
    cancel_url: new URL(productPath, input.siteOrigin).toString(),
  }, { stripeAccount, idempotencyKey: `membership:${input.organizationId}:${input.buyer.id}:${key}` })
  if (!session.url || session.livemode !== connected.livemode) throw new Error('Stripe returned a Checkout Session outside the connected mode')
  return { checkout_url: session.url }
}

/** The member's words for what their subscription is doing. */
function membershipState(subscription: Stripe.Subscription): MembershipState {
  if (subscription.status === 'canceled' || subscription.status === 'incomplete_expired') return 'ended'
  if (subscription.status === 'past_due' || subscription.status === 'unpaid') return 'payment_failed'
  if (subscription.status === 'incomplete') return 'incomplete'
  return subscription.cancel_at_period_end || subscription.cancel_at ? 'cancelling' : 'active'
}

const iso = (seconds: number | null | undefined) => typeof seconds === 'number' ? new Date(seconds * 1000).toISOString() : null

type MembershipPaymentRow = { id: string; organization_id: string; subject_id: string; stripe_account_id: string; livemode: number; buyer_user_id: string | null
  currency: string; amount: number; refunded_amount: number; receipt_url: string | null; created_at: string; price_snapshot_json: string }

/** One membership as Stripe has it now, with the payments Blawby recorded for it. */
function presentMembership(subscription: Stripe.Subscription, rows: MembershipPaymentRow[]): Membership {
  const item = subscription.items.data[0]
  const price = item?.price
  if (!item || !price?.recurring || subscription.items.data.length !== 1) throw new Error(`Membership ${subscription.id} is not one recurring price`)
  const metadata = subscription.metadata ?? {}
  const first = rows[rows.length - 1]
  if (!first) throw new Error(`Membership ${subscription.id} has no recorded payment`)
  const snapshot = JSON.parse(first.price_snapshot_json) as { title?: unknown; product_id?: unknown }
  return {
    id: subscription.id, organization_id: first.organization_id,
    product_id: typeof snapshot.product_id === 'string' ? snapshot.product_id : null,
    title: typeof snapshot.title === 'string' ? snapshot.title : subscription.description ?? '',
    member_name: metadata.blawby_guest_name || null, member_email: metadata.blawby_guest_email || null,
    state: membershipState(subscription), currency: price.currency.toUpperCase(), unit_amount: price.unit_amount ?? 0,
    terms: formatBillingTerms(formatMinorAmount(price.unit_amount ?? 0, price.currency.toUpperCase() as CurrencyCode), { recurring_interval: price.recurring.interval as PriceRecurringInterval, recurring_interval_count: price.recurring.interval_count }),
    started_at: iso(subscription.start_date)!, current_period_end: subscription.status === 'canceled' ? null : iso(item.current_period_end),
    ended_at: iso(subscription.ended_at),
    payments: rows.map(row => {
      const paid = JSON.parse(row.price_snapshot_json) as { membership?: { period_start?: string | null; period_end?: string | null } }
      return { id: row.id, amount: row.amount, created_at: row.created_at, period_start: paid.membership?.period_start ?? null, period_end: paid.membership?.period_end ?? null, receipt_url: row.receipt_url, refunded_amount: row.refunded_amount }
    }),
  }
}

const PAYMENT_COLUMNS = 'id, organization_id, subject_id, stripe_account_id, livemode, buyer_user_id, currency, amount, refunded_amount, receipt_url, created_at, price_snapshot_json'

/** Reads each membership's subscription from Stripe; rows are its recorded payments, newest first. */
async function readMemberships(env: CloudflareEnv, rows: MembershipPaymentRow[]): Promise<Membership[]> {
  const bySubscription = new Map<string, MembershipPaymentRow[]>()
  for (const row of rows) bySubscription.set(row.subject_id, [...bySubscription.get(row.subject_id) ?? [], row])
  return Promise.all([...bySubscription.values()].map(async payments => {
    const { subject_id: id, stripe_account_id: stripeAccount, livemode } = payments[0]!
    const subscription = await paymentsStripe(env, Boolean(livemode)).subscriptions.retrieve(id, {}, { stripeAccount })
    return presentMembership(subscription, payments)
  }))
}

/** The signed-in member's memberships at every business, as Stripe has them now. */
export async function buyerMemberships(db: DbClient, env: CloudflareEnv, userId: string): Promise<Array<Membership & { organization_name: string }>> {
  const rows = await queryAll<MembershipPaymentRow & { organization_name: string }>(db, `SELECT ${PAYMENT_COLUMNS.split(', ').map(column => `p.${column}`).join(', ')}, o.name AS organization_name
    FROM payments p JOIN organization o ON o.id = p.organization_id WHERE p.buyer_user_id = ? AND p.subject_type = 'membership' ORDER BY p.created_at DESC, p.id DESC LIMIT 500`, [userId])
  const names = new Map(rows.map(row => [row.subject_id, row.organization_name]))
  return (await readMemberships(env, rows)).map(membership => ({ ...membership, organization_name: names.get(membership.id)! }))
}

/** A business's members, optionally of one offering, as Stripe has them now. */
export async function organizationMemberships(db: DbClient, env: CloudflareEnv, organizationId: string, productId: string | null): Promise<Membership[]> {
  const rows = await queryAll<MembershipPaymentRow>(db, `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE organization_id = ? AND subject_type = 'membership'
      AND subject_id IN (SELECT subject_id FROM payments WHERE organization_id = ? AND subject_type = 'membership' ${productId ? "AND json_extract(price_snapshot_json, '$.product_id') = ?" : ''})
    ORDER BY created_at DESC, id DESC LIMIT 2000`, [organizationId, organizationId, ...(productId ? [productId] : [])])
  return readMemberships(env, rows)
}

async function membershipRow(db: DbClient, where: { organizationId: string } | { buyerUserId: string }, subscriptionId: string): Promise<MembershipPaymentRow> {
  const row = 'organizationId' in where
    ? await queryFirst<MembershipPaymentRow>(db, `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE organization_id = ? AND subject_type = 'membership' AND subject_id = ? ORDER BY created_at LIMIT 1`, [where.organizationId, subscriptionId])
    : await queryFirst<MembershipPaymentRow>(db, `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE buyer_user_id = ? AND subject_type = 'membership' AND subject_id = ? ORDER BY created_at LIMIT 1`, [where.buyerUserId, subscriptionId])
  if (!row) fail(404, 'MEMBERSHIP_NOT_FOUND', 'That membership was not found')
  return row
}

/** Stripe's customer portal for the member at this business: cards, invoices and cancelling, in Stripe's own pages. */
export async function membershipPortal(db: DbClient, env: CloudflareEnv, buyerUserId: string, subscriptionId: string, returnUrl: string): Promise<{ url: string }> {
  const row = await membershipRow(db, { buyerUserId }, subscriptionId)
  const stripe = paymentsStripe(env, Boolean(row.livemode))
  const account = { stripeAccount: row.stripe_account_id }
  const subscription = await stripe.subscriptions.retrieve(subscriptionId, {}, account)
  const customer = typeof subscription.customer === 'string' ? subscription.customer : subscription.customer.id
  const configuration = await portalConfiguration(stripe, row.stripe_account_id)
  const session = await stripe.billingPortal.sessions.create({ customer, configuration, return_url: returnUrl }, account)
  return { url: session.url }
}

/**
 * The portal settings Blawby asks of a business's account: update the card,
 * see invoices, cancel at the end of the period. Stripe keeps them on the
 * account; the one tagged for memberships is used, or created once.
 */
async function portalConfiguration(stripe: Stripe, stripeAccount: string): Promise<string> {
  for await (const configuration of stripe.billingPortal.configurations.list({ active: true, limit: 100 }, { stripeAccount })) {
    if (configuration.metadata?.blawby === 'memberships') return configuration.id
  }
  const created = await stripe.billingPortal.configurations.create({
    metadata: { blawby: 'memberships' },
    features: {
      payment_method_update: { enabled: true }, invoice_history: { enabled: true },
      customer_update: { enabled: true, allowed_updates: ['email', 'name', 'address', 'phone'] },
      subscription_cancel: { enabled: true, mode: 'at_period_end', cancellation_reason: { enabled: true, options: ['too_expensive', 'unused', 'switched_service', 'other'] } },
    },
  }, { stripeAccount, idempotencyKey: `membership-portal:${stripeAccount}` })
  return created.id
}

/**
 * The business ends a membership. `at_period_end` stops future payments and
 * keeps access to the end of what was paid; `now` ends access too, with no
 * refund (a refund is the payment's own action).
 */
export async function cancelMembership(db: DbClient, env: CloudflareEnv, organizationId: string, subscriptionId: string, when: unknown): Promise<Membership> {
  if (when !== 'at_period_end' && when !== 'now') fail(400, 'VALIDATION_ERROR', 'when must be at_period_end or now', 'when')
  const row = await membershipRow(db, { organizationId }, subscriptionId)
  const stripe = paymentsStripe(env, Boolean(row.livemode))
  const account = { stripeAccount: row.stripe_account_id }
  if (when === 'now') await stripe.subscriptions.cancel(subscriptionId, {}, { ...account, idempotencyKey: `membership-cancel:${subscriptionId}` })
  else await stripe.subscriptions.update(subscriptionId, { cancel_at_period_end: true }, account)
  const [membership] = await organizationMembershipRead(db, env, organizationId, subscriptionId)
  return membership!
}

async function organizationMembershipRead(db: DbClient, env: CloudflareEnv, organizationId: string, subscriptionId: string) {
  const rows = await queryAll<MembershipPaymentRow>(db, `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE organization_id = ? AND subject_type = 'membership' AND subject_id = ? ORDER BY created_at DESC, id DESC`, [organizationId, subscriptionId])
  return readMemberships(env, rows)
}

/** One membership of this business, as Stripe has it now. */
export async function readOrganizationMembership(db: DbClient, env: CloudflareEnv, organizationId: string, subscriptionId: string): Promise<Membership> {
  const [membership] = await organizationMembershipRead(db, env, organizationId, subscriptionId)
  if (!membership) fail(404, 'MEMBERSHIP_NOT_FOUND', 'That membership was not found')
  return membership
}

/** Where Stripe returns a member after Checkout: the membership it started, once Stripe has recorded its first payment. */
export async function membershipCheckoutReturn(db: DbClient, env: CloudflareEnv, organizationId: string, buyerUserId: string | null, sessionId: string) {
  if (!/^cs_[A-Za-z0-9_]+$/u.test(sessionId)) fail(404, 'MEMBERSHIP_NOT_FOUND', 'That membership was not found')
  // A Checkout Session's ID names its mode; the business's account in that mode holds it.
  const livemode = sessionId.startsWith('cs_live_')
  const connected = await queryFirst<{ stripe_account_id: string; livemode: number }>(db, 'SELECT stripe_account_id, livemode FROM stripe_connected_accounts WHERE organization_id = ? AND livemode = ? AND stripe_account_id IS NOT NULL', [organizationId, Number(livemode)])
  if (!connected) fail(404, 'MEMBERSHIP_NOT_FOUND', 'That membership was not found')
  const stripe = paymentsStripe(env, Boolean(connected.livemode))
  const session = await stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: connected.stripe_account_id })
  // Stripe hands the session ID only to whoever paid, so it shows that payer their confirmation, as Stripe's own
  // success page does. Managing the membership stays with the account that holds it: the identity that started
  // the session, or the account it later joined.
  if (session.mode !== 'subscription' || session.metadata?.blawby_product_id === undefined) fail(404, 'MEMBERSHIP_NOT_FOUND', 'That membership was not found')
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : session.subscription?.id ?? null
  const owned = buyerUserId !== null && (session.client_reference_id === buyerUserId
    || Boolean(subscriptionId !== null && await queryFirst(db, "SELECT 1 FROM payments WHERE organization_id = ? AND subject_type = 'membership' AND subject_id = ? AND buyer_user_id = ?", [organizationId, subscriptionId, buyerUserId])))
  if (session.status !== 'complete' || !subscriptionId) return { state: 'open' as const, membership: null, owned }
  const rows = await queryAll<MembershipPaymentRow>(db, `SELECT ${PAYMENT_COLUMNS} FROM payments WHERE organization_id = ? AND subject_type = 'membership' AND subject_id = ? ORDER BY created_at DESC, id DESC`, [organizationId, subscriptionId])
  // Stripe tells Blawby the first payment separately; until then the member is told it is on its way.
  if (!rows.length) return { state: 'processing' as const, membership: null, owned }
  const [membership] = await readMemberships(env, rows)
  return { state: 'paid' as const, membership: membership!, owned }
}

/**
 * An invoice Stripe collected for a membership: a payment of it, and with the
 * first, the member's conversation with the business, opened in the same batch.
 */
export async function recordMembershipPayment(db: DbClient, stripe: Stripe, env: CloudflareEnv, organizationId: string, invoice: Stripe.Invoice, stripeAccount: string, livemode: boolean): Promise<void> {
  const details = invoice.parent?.subscription_details
  const metadata = details?.metadata ?? {}
  const subscriptionId = typeof details?.subscription === 'string' ? details.subscription : details?.subscription.id
  const productId = metadata[PRODUCT_KEY]
  if (!subscriptionId || !productId) throw new Error(`Invoice ${invoice.id} names no membership`)
  // A membership's first invoice is paid at Checkout; a free one (amount 0) moves no money and records nothing.
  if (invoice.amount_paid === 0) return
  const currency = invoice.currency.toUpperCase()
  if (!isCurrencyCode(currency)) throw new Error(`Invoice ${invoice.id} is in an unsupported currency`)
  const line = invoice.lines.data[0]
  if (!line || invoice.lines.data.length !== 1) throw new Error(`Membership invoice ${invoice.id} is not one period`)
  const period = { period_start: iso(line.period.start), period_end: iso(line.period.end) }
  const title = metadata.blawby_title
  if (!title || !metadata.blawby_terms) throw new Error(`Membership invoice ${invoice.id} names no offering or terms`)
  const buyerUserId = metadata.blawby_buyer_user_id || null
  const locationId = metadata.blawby_location_id || null
  const guest = { name: metadata.blawby_guest_name ?? '', email: metadata.blawby_guest_email ?? '', phone: metadata.blawby_guest_phone || null }
  if (!guest.name || !guest.email) throw new Error(`Membership ${subscriptionId} has no member contact`)
  const opening = `Joined ${title}: ${metadata.blawby_terms}.`
  // The first payment opens the member's conversation with the business and names it for every later one.
  const first = invoice.billing_reason === 'subscription_create'
  const conversationId = crypto.randomUUID()
  await recordPaidInvoice(db, stripe, env, invoice, {
    organizationId, stripeAccount, livemode: Number(livemode), subjectType: 'membership', subjectId: subscriptionId, buyerUserId, locationId, currency,
    snapshot: { title, product_id: productId, variant_id: metadata.blawby_variant_id ?? null, price_id: metadata.blawby_price_id ?? null, quantity: 1,
      membership: { subscription_id: subscriptionId, member_name: guest.name, ...period, ...(first ? { conversation_id: conversationId } : {}) } },
  }, paymentId => first ? requestInsertQueries({
    id: conversationId, kind: 'contact', organization_id: organizationId, location_id: locationId, booking_id: null, user_id: buyerUserId, created_at: new Date().toISOString(),
    payload: { guest, subject: title, consent_at: null, ip_hash: null, source: 'membership', answers: [] },
  }, { query: 'SELECT 1 FROM payments WHERE id = ?', params: [paymentId] } satisfies BatchQuery, { opening, note: null }) : [])
}
