import type { EarningsPerformance, PayoutDetail, PayoutItem } from '~/shared/earnings-display'
import type Stripe from 'stripe'
import { HTTPError } from 'nitro'
import { executeBatch, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { ownerPicturesFromRows } from '~/server/notifications/hero'
import { mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { paymentsStripe, type StripeConnectedAccount } from '~/server/utils/stripe-connect'
import { currencyFractionDigits } from '~/shared/currencies'
import { addLocalDays, isValidCalendarDate } from '~/utils/timezone'
import type { CloudflareEnv } from '~/server/utils/auth'
import { roleAllows } from '~/server/utils/member-access'
import { authorizePayments, type FinancialPrincipal, type Payment, type VisiblePayment } from './index'
import { channelReservationAmountQuery, channelReservationAmounts } from '~/server/domain/stays'

/**
 * The Earnings screens as Airbnb draws them: a payment leads with the picture
 * of what was sold, a month has a total, and a payout lists what it carried.
 * Everything here is read from the payments the business already holds and
 * from Stripe; nothing is stored.
 */

interface PaymentPicture {
  title: string; image_url: string | null; name: string | null; starts_at: string | null; ends_at: string | null; timezone: string | null
  booking_id: string | null; buyer_name: string | null
}

type PaymentSubject = Omit<PaymentPicture, 'title' | 'image_url'> & { id: string; product_id: string | null }
const paymentBookingJoin = "LEFT JOIN bookings b ON p.subject_type = 'booking' AND b.id = p.subject_id AND b.organization_id = p.organization_id"

function paymentSnapshot(payment: Pick<Payment, 'id' | 'price_snapshot_json'>) {
  const snapshot: unknown = JSON.parse(payment.price_snapshot_json)
  if (!snapshot || typeof snapshot !== 'object' || !('title' in snapshot) || typeof snapshot.title !== 'string' || !snapshot.title.trim()) throw new Error(`Payment ${payment.id} has no immutable title`)
  return snapshot as { title: string; stay?: unknown }
}

/** The payment's immutable title, its subject's picture and dates, and the buyer when the list presents them: named by what they typed, never an anonymous account's "Anonymous". */
function preparePaymentPictures(organizationId: string, selection: { sql: string; params: unknown[] }, includeBuyer: boolean) {
  const subjects: BatchQuery = {
    query: `
    SELECT p.id, b.id AS booking_id, COALESCE(b.product_id, CASE WHEN p.subject_type = 'membership' THEN json_extract(p.price_snapshot_json, '$.product_id') END) AS product_id, pr.name, b.starts_at, b.ends_at, b.timezone,
      ${includeBuyer ? `COALESCE(json_extract(r.payload_json, '$.guest.name'), json_extract(bc.payload_json, '$.guest.name'), json_extract(oc.payload_json, '$.guest.name'), json_extract(p.price_snapshot_json, '$.membership.member_name'), CASE WHEN COALESCE(u."isAnonymous", 0) = 0 THEN u.name END)` : 'NULL'} AS buyer_name
      FROM payments p
      ${paymentBookingJoin}
      LEFT JOIN products pr ON pr.id = b.product_id AND pr.organization_id = b.organization_id
      ${includeBuyer ? `LEFT JOIN user u ON u.id = p.buyer_user_id
      LEFT JOIN payment_checkout_holds h ON h.payment_id = p.id
      LEFT JOIN conversations r ON r.id = h.conversation_id AND r.organization_id = p.organization_id
      LEFT JOIN conversations bc ON bc.booking_id = b.id AND bc.organization_id = p.organization_id AND bc.kind = 'booking'
      LEFT JOIN orders o ON p.subject_type = 'order' AND o.id = p.subject_id AND o.organization_id = p.organization_id
      LEFT JOIN conversations oc ON oc.id = o.conversation_id AND oc.organization_id = p.organization_id` : ''}
     WHERE ${selection.sql}`, params: selection.params
  }
  const media = (ownerType: 'product' | 'business_location', sql: string) => mediaPlacementsQuery({
    organizationId, ownerType, includeOrganizationFallback: false,
    owners: { sql, params: selection.params }
  })
  const products = media('product', `SELECT COALESCE(b.product_id, CASE WHEN p.subject_type = 'membership' THEN json_extract(p.price_snapshot_json, '$.product_id') END) FROM payments p ${paymentBookingJoin} WHERE ${selection.sql}`)
  const locations = media('business_location', `SELECT p.location_id FROM payments p ${paymentBookingJoin} WHERE ${selection.sql} AND b.id IS NULL AND json_type(p.price_snapshot_json, '$.stay') IS NOT NULL`)
  return {
    queries: [subjects, products, locations], read(payments: readonly Pick<Payment, 'id' | 'location_id' | 'price_snapshot_json'>[], [subjectRows, productMedia, locationMedia]: D1Result[]) {
      const subjects = subjectRows!.results as PaymentSubject[]
      const byId = new Map(subjects.map(row => [row.id, row]))
      const entries = payments.map(payment => {
        const snapshot = paymentSnapshot(payment)
        const subject = byId.get(payment.id)
        if (!subject) throw new Error(`Payment ${payment.id} is missing from its business`)
        return { id: payment.id, title: snapshot.title, subject, locationId: !subject.booking_id && 'stay' in snapshot ? payment.location_id : null }
      })
      const productIds = entries.flatMap(({ subject }) => subject.product_id ? [subject.product_id] : [])
      const locationIds = entries.flatMap(({ locationId }) => locationId ? [locationId] : [])
      const products = ownerPicturesFromRows(organizationId, 'product', productIds, productMedia!.results, false)
      const locations = ownerPicturesFromRows(organizationId, 'business_location', locationIds, locationMedia!.results, false)
      return new Map(entries.map(({ id, title, subject, locationId }) => {
        const { product_id, booking_id, buyer_name, name, starts_at, ends_at, timezone } = subject
        const image = product_id ? products.get(product_id) : locationId ? locations.get(locationId) : null
        return [id, { title, image_url: image?.imageUrl ?? null, booking_id, buyer_name, name, starts_at, ends_at, timezone }]
      }))
    }
  }
}

async function paymentPictures(db: DbClient, organizationId: string, payments: readonly Pick<Payment, 'id' | 'location_id' | 'price_snapshot_json'>[], includeBuyer = false) {
  if (!payments.length) return new Map<string, PaymentPicture>()
  const plan = preparePaymentPictures(organizationId, { sql: 'p.organization_id = ? AND p.id IN (SELECT value FROM json_each(?))', params: [organizationId, JSON.stringify(payments.map(payment => payment.id))] }, includeBuyer)
  return plan.read(payments, await executeBatch(db, plan.queries, { operation: 'read payment pictures' }))
}

/** Airbnb's Performance: the year by month, and one month by what was sold. */
export async function paymentPerformance(db: DbClient, principal: FinancialPrincipal, year: number, month: string, comparison = false): Promise<EarningsPerformance> {
  await authorizePayments(principal, 'read')
  const plan = preparePaymentPerformance(principal.organizationId, year, month, await roleAllows({
    ...principal, permissions: { payments: ['payouts'] },
  }), comparison)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read the earnings period' }), principal.organizationId)
}

export function preparePaymentPerformance(
  organization: string | { sql: string }, year: number, month: string, payoutAccess: boolean | { sql: string }, comparison = false,
) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid year is required', data: { code: 'INVALID_EARNINGS_PERIOD', field: 'year' } })
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || !month.startsWith(`${year}-`)) throw new HTTPError({ statusCode: 400, statusMessage: 'Valid month within the requested year is required', data: { code: 'INVALID_EARNINGS_PERIOD', field: 'month' } })
  if (comparison && year <= 2000) throw new HTTPError({ statusCode: 400, message: 'Comparison requires a year after 2000', data: { code: 'INVALID_EARNINGS_PERIOD', field: 'year' } })
  const org = typeof organization === 'string' ? '?' : organization.sql
  const orgParams = typeof organization === 'string' ? [organization] : []
  const payoutGuard = typeof payoutAccess === 'boolean' ? payoutAccess ? '1' : '0' : payoutAccess.sql
  const [monthYear, monthNumber] = month.split('-').map(Number)
  const monthStart = `${month}-01`
  const next = new Date(Date.UTC(monthYear!, monthNumber!, 1)).toISOString()
  const monthEnd = next.slice(0, 10)
  const period = `FROM payments p ${paymentBookingJoin}
    WHERE p.organization_id = ${org} AND p.created_at >= ? AND p.created_at < ? AND p.captured_amount > 0`
  const periodParams = [...orgParams, `${monthStart}T00:00:00.000Z`, next]
  const imagesFor = (ownerType: 'product' | 'business_location', selection: string) =>
    mediaPlacementsQuery({ organizationId: organization, ownerType, includeOrganizationFallback: false, owners: { sql: selection, params: periodParams } })
  const queries = [paymentMonthsQuery(organization, year),
  {
    query: `SELECT p.id, p.location_id, p.price_snapshot_json, p.captured_amount, p.refunded_amount,
        b.id AS booking_id, b.product_id ${period}`, params: periodParams
  },
  {
    query: `SELECT o.default_currency, CASE WHEN ${payoutGuard} THEN EXISTS (
      SELECT 1 FROM stripe_connected_accounts s WHERE s.organization_id = o.id AND s.stripe_account_id IS NOT NULL
    ) END AS payouts_connected FROM organization o WHERE o.id = ${org}`, params: orgParams
  },
  channelReservationAmountQuery(organization, monthStart, monthEnd),
  imagesFor('product', `SELECT b.product_id ${period} AND b.product_id IS NOT NULL`),
  imagesFor('business_location', `SELECT p.location_id ${period} AND b.id IS NULL AND json_type(p.price_snapshot_json, '$.stay') IS NOT NULL`),
  ...(comparison ? [paymentMonthsQuery(organization, year - 1)] : []),
  ]
  return { queries, read }

  function read([yearResult, monthResult, organizationResult, channel, productMedia, locationMedia, comparisonResult]: D1Result[], organizationId: string): EarningsPerformance {
    const { currencies, months } = paymentMonths(yearResult!, year)
    const payments = monthResult!.results as Array<Pick<Payment, 'id' | 'location_id' | 'price_snapshot_json' | 'captured_amount' | 'refunded_amount'>
      & { booking_id: string | null; product_id: string | null }>
    const productIds = payments.flatMap(payment => payment.product_id ? [payment.product_id] : [])
    const locationIds = payments.flatMap(payment => payment.location_id ? [payment.location_id] : [])
    const products = ownerPicturesFromRows(organizationId, 'product', productIds, productMedia!.results, false)
    const locations = ownerPicturesFromRows(organizationId, 'business_location', locationIds, locationMedia!.results, false)
    const byTitle = new Map<string, { title: string; image_url: string | null; paid: number; count: number }>()
    for (const payment of payments) {
      const snapshot = paymentSnapshot(payment)
      // An order earns for each product it sold, not under its "X and 1 more" title: what it kept is shared across its lines by their amounts.
      const order = (snapshot as { order?: { lines: Array<{ title: string; amount: number }> } }).order
      if (order?.lines.length) {
        const kept = payment.captured_amount - payment.refunded_amount
        const total = order.lines.reduce((sum, line) => sum + line.amount, 0)
        let left = kept
        order.lines.forEach((line, index) => {
          const share = index === order.lines.length - 1 ? left : total ? Math.round(kept * line.amount / total) : 0
          left -= share
          const entry = byTitle.get(line.title) ?? { title: line.title, image_url: null, paid: 0, count: 0 }
          entry.paid += share
          entry.count += 1
          byTitle.set(line.title, entry)
        })
        continue
      }
      const picture = payment.product_id ? products.get(payment.product_id)
        : !payment.booking_id && 'stay' in snapshot && payment.location_id ? locations.get(payment.location_id) : null
      const entry = byTitle.get(snapshot.title) ?? { title: snapshot.title, image_url: picture?.imageUrl ?? null, paid: 0, count: 0 }
      entry.paid += payment.captured_amount - payment.refunded_amount
      entry.count += 1
      byTitle.set(snapshot.title, entry)
    }
    const account = organizationResult!.results[0] as { default_currency: string; payouts_connected: number | null } | undefined
    const currency = currencies[0] ?? account?.default_currency
    if (!currency) throw new HTTPError({ statusCode: 404, statusMessage: 'Organization not found' })
    const channel_reservations = channelReservationAmounts(channel!, monthStart, monthEnd)
    const previous = comparisonResult ? paymentMonths(comparisonResult, year - 1) : null
    const compared = previous ? { year: year - 1, currency: previous.currencies[0] ?? account!.default_currency, months: previous.months } : null
    return { ...(compared ? { comparison: compared } : {}), currency, payouts_connected: account?.payouts_connected == null ? null : account.payouts_connected === 1, months, items: [...byTitle.values()].sort((a, b) => b.paid - a.paid), channel_reservations }
  }
}

/** Stripe owns date/status filtering and pagination; the app sends UTC calendar days. */
export function payoutFilters(query: Record<string, unknown>): Stripe.PayoutListParams {
  const status = query.status
  if (status !== undefined && (typeof status !== 'string' || !['pending', 'paid', 'failed', 'canceled'].includes(status))) throw new HTTPError({ statusCode: 400, message: 'Invalid payout status', data: { code: 'INVALID_PAYOUT_FILTER', field: 'status' } })
  const boundary = (name: string) => {
    const value = query[name]
    if (value === undefined) return undefined
    if (typeof value !== 'string' || !isValidCalendarDate(value)) throw new HTTPError({ statusCode: 400, message: `${name} must be YYYY-MM-DD`, data: { code: 'INVALID_PAYOUT_FILTER', field: name } })
    return value
  }
  const from = boundary('arrival_from'), to = boundary('arrival_to')
  if (from && to && from > to) throw new HTTPError({ statusCode: 400, message: 'Start date must not follow end date', data: { code: 'INVALID_PAYOUT_FILTER', field: 'arrival_to' } })
  return {
    ...(status ? { status: status as string } : {}), ...(from || to ? {
      arrival_date: {
        ...(from ? { gte: Date.parse(`${from}T00:00:00Z`) / 1000 } : {}), ...(to ? { lt: Date.parse(`${addLocalDays(to, 1)}T00:00:00Z`) / 1000 } : {}),
      }
    } : {})
  }
}

/** The SDK owns pagination; the CSV includes every payout matching the chosen filters. */
export async function paymentPayoutExport(env: CloudflareEnv, principal: FinancialPrincipal, account: StripeConnectedAccount | null, filters: Stripe.PayoutListParams) {
  await authorizePayments(principal, 'payouts')
  if (!account?.stripe_account_id) throw new HTTPError({ statusCode: 409, message: 'Connect Stripe before exporting payouts', data: { code: 'STRIPE_ACCOUNT_REQUIRED', field: 'stripe_account_id' } })
  const stripe = paymentsStripe(env, account.livemode)
  const options = { stripeAccount: account.stripe_account_id }
  const line = (cells: string[]) => cells.map(cell => {
    const escaped = /^[=+@\-\t\r]/.test(cell) ? `'${cell}` : cell
    return `"${escaped.replaceAll('"', '""')}"`
  }).join(',') + '\r\n'
  const rows = [line(['Created date', 'Arrival date', 'Amount', 'Currency', 'Status', 'Payout ID'])]
  for await (const payout of stripe.payouts.list({ ...filters, limit: 100 }, options)) {
    if (payout.livemode !== account.livemode) throw new Error('Stripe payout mode does not match connected account')
    const currency = payout.currency.toUpperCase(), digits = currencyFractionDigits(currency)
    rows.push(line([new Date(payout.created * 1000).toISOString().slice(0, 10), new Date(payout.arrival_date * 1000).toISOString().slice(0, 10),
      (payout.amount / 10 ** digits).toFixed(digits), currency, payout.status, payout.id]))
  }
  return rows.join('')
}

export async function paymentPayouts(env: CloudflareEnv, principal: FinancialPrincipal, account: StripeConnectedAccount | null, after?: string, filters: Stripe.PayoutListParams = {}) {
  await authorizePayments(principal, 'payouts')
  return readStripePayouts(env, principal.organizationId, account, after, filters)
}

export async function readStripePayouts(env: CloudflareEnv, organizationId: string, account: StripeConnectedAccount | null, after?: string, filters: Stripe.PayoutListParams = {}) {
  if (!account?.stripe_account_id) return { organization_id: organizationId, configured: false, balance: null, payouts: [], next_cursor: null, source: 'Stripe account not connected', refreshed_at: null }
  const stripe = paymentsStripe(env, account.livemode), options = { stripeAccount: account.stripe_account_id }
  const [balance, payouts] = await Promise.all([stripe.balance.retrieve({}, options), stripe.payouts.list({ ...filters, limit: 50, ...(after ? { starting_after: after } : {}) }, options)])
  if (balance.livemode !== account.livemode || payouts.data.some(row => row.livemode !== account.livemode)) throw new Error('Stripe payout mode does not match connected account')
  const nextCursor = payouts.has_more ? payouts.data.at(-1)?.id : null
  if (nextCursor === undefined || nextCursor === '') throw new Error('Stripe payout list is missing its next cursor')
  return { organization_id: organizationId, configured: true, balance, payouts: payouts.data, next_cursor: nextCursor, source: 'Stripe', refreshed_at: new Date().toISOString() }
}

/**
 * The payments a payout carried, matched through Stripe's balance transactions
 * to the charges this business recorded. Stripe attributes transactions only to
 * the payouts it schedules itself; a payout someone created by hand carries none.
 */
async function payoutItems(db: DbClient, stripe: Stripe, options: { stripeAccount: string }, organizationId: string, payout: Stripe.Payout): Promise<PayoutItem[]> {
  if (!payout.automatic) return []
  const transactions = await stripe.balanceTransactions.list({ payout: payout.id, type: 'charge', limit: 100 }, options).autoPagingToArray({ limit: 10000 })
  const chargeIds = transactions.map(row => {
    const id = typeof row.source === 'string' ? row.source : row.source?.id
    if (!id) throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe payout transaction has no charge source', data: { code: 'PAYOUT_TRANSACTION_SOURCE_MISSING', field: `transactions.${row.id}.source` } })
    return id
  })
  if (!chargeIds.length) return []
  const selection = { sql: 'p.organization_id = ? AND p.stripe_charge_id IN (SELECT value FROM json_each(?))', params: [organizationId, JSON.stringify(chargeIds)] }
  const plan = preparePaymentPictures(organizationId, selection, true)
  const [paymentRows, ...picturesRows] = await executeBatch(db, [{ query: `SELECT p.* FROM payments p WHERE ${selection.sql}`, params: selection.params }, ...plan.queries], { operation: 'read payout payments and pictures' })
  const payments = paymentRows!.results as unknown as Payment[]
  const pictures = plan.read(payments, picturesRows)
  return payments.map((payment) => {
    const picture = pictures.get(payment.id)!
    const transaction = transactions.find(row => (typeof row.source === 'string' ? row.source : row.source?.id) === payment.stripe_charge_id)
    if (!transaction) throw new HTTPError({ statusCode: 502, statusMessage: 'Payout payment has no Stripe balance transaction', data: { code: 'PAYOUT_TRANSACTION_MISSING', field: `items.${payment.id}.amount` } })
    return { gross_amount: transaction.amount, fee_amount: transaction.fee, payment_id: payment.id, title: picture.title, image_url: picture.image_url, amount: transaction.net, currency: transaction.currency.toUpperCase(), starts_at: picture.starts_at, ends_at: picture.ends_at, timezone: picture.timezone, name: picture.name, buyer_name: picture.buyer_name }
  })
}

/** One payout as Airbnb's sheet shows it: amount, sent date, the bank it went to, and what it carried. */
export async function paymentPayoutDetail(db: DbClient, env: CloudflareEnv, principal: FinancialPrincipal, account: StripeConnectedAccount | null, payoutId: string): Promise<PayoutDetail> {
  await authorizePayments(principal, 'payouts')
  if (!account?.stripe_account_id) throw new HTTPError({ statusCode: 404, statusMessage: 'Stripe account not connected' })
  const stripe = paymentsStripe(env, account.livemode), options = { stripeAccount: account.stripe_account_id }
  const payout = await stripe.payouts.retrieve(payoutId, {}, options)
  const destination = typeof payout.destination === 'string' ? payout.destination : payout.destination?.id
  if (!destination) throw new HTTPError({ statusCode: 502, statusMessage: 'Stripe payout has no destination', data: { code: 'PAYOUT_DESTINATION_MISSING', field: 'payout.destination' } })

  const [external, items] = await Promise.all([
    stripe.accounts.retrieveExternalAccount(options.stripeAccount, destination),
    payoutItems(db, stripe, options, principal.organizationId, payout),
  ])
  const bank = external.object === 'bank_account' ? { bank_name: external.bank_name ?? null, last4: external.last4 } : null
  return {
    id: payout.id,
    amount: payout.amount,
    currency: payout.currency.toUpperCase(),
    status: payout.status,
    arrival_date: payout.arrival_date,
    created: payout.created,
    bank,
    items,
    failure_code: payout.failure_code ?? null,
    failure_message: payout.failure_message ?? null,
  }
}

/** Something to read a payout's status in. */
export function payoutStatusLabel(status: string): string {
  return status === 'paid' ? 'Sent' : status === 'failed' ? 'Failed' : status === 'canceled' ? 'Cancelled' : status === 'in_transit' ? 'On its way' : 'Expected'
}

function paymentTransactionPath(organizationSlug: string, paymentId: string, bookingId: string | null) {
  const base = `/dashboard/${encodeURIComponent(organizationSlug)}/bookings`
  return bookingId ? `${base}/${encodeURIComponent(bookingId)}` : `${base}/payment/${encodeURIComponent(paymentId)}`
}

/** Links from payout and refund detail only need the record the transaction paid. */
export async function paymentTransactionDestination(db: DbClient, organizationId: string, organizationSlug: string, paymentId: string) {
  const row = await queryFirst<{ booking_id: string | null }>(db, `SELECT b.id AS booking_id FROM payments p
    ${paymentBookingJoin} WHERE p.organization_id = ? AND p.id = ?`, [organizationId, paymentId])
  if (!row) throw new HTTPError({ statusCode: 404, statusMessage: 'Payment not found' })
  return { to: paymentTransactionPath(organizationSlug, paymentId, row.booking_id) }
}

/** The month's transactions as Airbnb's list reads them: the picture, the buyer, and the record each opens. */
export async function paymentTransactions(db: DbClient, principal: FinancialPrincipal, organizationSlug: string, page: { payments: VisiblePayment[]; next_cursor: string | null }) {
  const pictures = await paymentPictures(db, principal.organizationId, page.payments, true)
  return {
    next_cursor: page.next_cursor,
    payments: page.payments.map((payment) => {
      const picture = pictures.get(payment.id)!
      return {
        id: payment.id, created_at: payment.created_at, currency: payment.currency, amount: payment.amount, captured_amount: payment.captured_amount, refunded_amount: payment.refunded_amount,
        title: picture.title, image_url: picture.image_url, buyer_name: picture.buyer_name,
        starts_at: picture.starts_at, ends_at: picture.ends_at, timezone: picture.timezone,
        to: paymentTransactionPath(organizationSlug, payment.id, picture.booking_id),
      }
    }),
  }
}

export function paymentMonths(result: D1Result, periodYear: number) {
  const rows = result.results as Array<{ month: string; currency: string; paid: number; refunded: number }>
  const currencies = [...new Set(rows.map(row => row.currency))]
  if (currencies.length > 1) throw new HTTPError({ statusCode: 409, statusMessage: 'Earnings in more than one currency cannot be charted together', data: { code: 'MULTIPLE_EARNINGS_CURRENCIES', field: 'currency' } })
  const months = Array.from({ length: 12 }, (_, index) => {
    const key = `${periodYear}-${String(index + 1).padStart(2, '0')}`
    const row = rows.find(entry => entry.month === key)
    return { month: key, paid: row?.paid ?? 0, refunded: row?.refunded ?? 0 }
  })
  return { currencies, months }
}

export function paymentMonthsQuery(organization: string | { sql: string }, year: number): BatchQuery {
  return { query: `SELECT strftime('%Y-%m', created_at) AS month, currency, SUM(captured_amount) AS paid, SUM(refunded_amount) AS refunded FROM payments WHERE organization_id = ${typeof organization === 'string' ? '?' : organization.sql} AND created_at >= ? AND created_at < ? GROUP BY 1, 2 ORDER BY 1`, params: [...(typeof organization === 'string' ? [organization] : []), `${year}-01-01T00:00:00.000Z`, `${year + 1}-01-01T00:00:00.000Z`] }
}
