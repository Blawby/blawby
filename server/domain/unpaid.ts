import { executeBatch, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows } from '~/server/utils/member-access'
import { depositReceivedSql } from '~/server/domain/deposits'
import { bookingDay } from '~/server/domain/requests'
import type { StayLedgerPeriod, StayOnlinePayment, StayPayment } from '~/server/domain/stays'
import { isChannelManagedStay, type StayChannel } from '~/shared/bookings'
import { depositLabel } from '~/shared/deposits'
import type { ProductKind } from '~/shared/product-details'
import { enteredStayInstallments, type StayInstallment } from '~/shared/stay-installments'
import type { UnpaidBooking, UnpaidReason } from '~/shared/unpaid'
import { formatCalendarDate, localDateAt, localDateTimeToInstant } from '~/utils/timezone'

/*
  Who owes the business money (#2079), defined on the booking: a month of a
  stay paid monthly that has started unpaid, a stay that has begun with less
  paid than its total, and a deposit or retainer asked for and not received.
  A channel's reservation is paid through its channel and never owes here; a
  cancelled booking owes nothing. Everything is read from stored rows: the
  booking, the plan its checkout froze, Stripe payments, receipts recorded
  outside Stripe and deposit entries.
*/

/** What a stay's money is read from, as `stayMoneyColumns` selects it. */
export interface StayMoneyRow { offline_payments_json: string; online_payments_json: string; installments_json: string | null }

/**
 * A stay's receipts outside Stripe, its frozen monthly plan and its Stripe
 * payments, for a statement that names the booking `alias`; each is NULL
 * where `when` (SQL) does not hold.
 */
export const stayMoneyColumns = (alias: string, when = '1') => `
    CASE WHEN ${when} THEN (SELECT json_group_array(json_object('id', id, 'booking_id', booking_id, 'amount_minor', amount_minor, 'currency', currency,
      'method', method, 'paid_on', paid_on, 'reference', reference, 'note', note, 'period_start', period_start, 'created_at', created_at, 'created_by', created_by))
      FROM (SELECT * FROM offline_payments WHERE organization_id = ${alias}.organization_id AND booking_id = ${alias}.id AND purpose = 'payment' ORDER BY paid_on, created_at)
    ) END AS offline_payments_json,
    CASE WHEN ${when} THEN (SELECT json_extract(price_snapshot_json, '$.installments') FROM payments WHERE organization_id = ${alias}.organization_id AND subject_type = 'booking' AND subject_id = ${alias}.id ORDER BY created_at, id LIMIT 1) END AS installments_json,
    CASE WHEN ${when} THEN (SELECT json_group_array(json_object('payment_id', id, 'period_start', json_extract(price_snapshot_json, '$.installment.period_start'), 'currency', currency, 'amount_minor', amount, 'captured_minor', captured_amount,
      'refunded_minor', refunded_amount, 'receipt_url', receipt_url, 'created_at', created_at))
      FROM (SELECT * FROM payments WHERE organization_id = ${alias}.organization_id AND subject_type = 'booking' AND subject_id = ${alias}.id ORDER BY created_at, id)
    ) END AS online_payments_json`

/** The facts of a stay its money is measured against. */
export interface LedgerStay { owner: 'app' | 'channel'; channel: StayChannel; check_in_date: string; check_out_date: string; total_minor: number; timezone: string }

export interface StayMoney {
  payments: StayPayment[]
  online_payments: StayOnlinePayment[]
  installments: StayLedgerPeriod[] | null
  /** What the guest paid for the stay, net of refunds. A deposit, held or kept for damage, is not payment for the nights. */
  paid_minor: number
  payment_status: 'unpaid' | 'partial' | 'paid' | 'overpaid' | null
}

export function stayMoney(stay: LedgerStay, row: StayMoneyRow, now = new Date()): StayMoney {
  const payments = JSON.parse(row.offline_payments_json) as StayPayment[]
  const online = JSON.parse(row.online_payments_json) as StayOnlinePayment[]
  // Counting what was kept from a deposit turned a stay paid in full into an overpaid one.
  const paid = payments.reduce((sum, payment) => sum + payment.amount_minor, 0) + online.reduce((sum, payment) => sum + payment.captured_minor - payment.refunded_minor, 0)
  const status = isChannelManagedStay(stay) ? null
    : paid === 0 ? 'unpaid' : paid < stay.total_minor ? 'partial' : paid === stay.total_minor ? 'paid' : 'overpaid'
  return { payments, online_payments: online, installments: stayLedger(stay, row.installments_json, online, payments, now), paid_minor: paid, payment_status: status }
}

/**
 * Each month of a stay paid monthly against what was paid toward it: its
 * checkout payment pays the first, each Stripe invoice its own, and a receipt
 * recorded outside Stripe the month it names. A month is overdue once its
 * first day has passed in the home's clock without being paid.
 */
function stayLedger(stay: LedgerStay, plan: string | null, online: StayOnlinePayment[], offline: StayPayment[], now: Date): StayLedgerPeriod[] | null {
  const periods = plan ? JSON.parse(plan) as StayInstallment[] : enteredStayInstallments(stay, online.length > 0)
  if (!periods) return null
  const today = localDateAt(now, stay.timezone)
  // A payment naming no month is the checkout's, which paid the first.
  const monthOf = (payment: StayOnlinePayment) => payment.period_start ?? periods[0]!.period_start
  const starts = new Set(periods.map(period => period.period_start))
  const named = periods.map(period => online.filter(payment => monthOf(payment) === period.period_start)
    .reduce((sum, payment) => sum + payment.captured_minor - payment.refunded_minor, 0)
    + offline.filter(payment => payment.period_start === period.period_start).reduce((sum, payment) => sum + payment.amount_minor, 0))
  // A receipt recorded for the stay as a whole, or for a month its dates no longer have, pays the oldest months first; what is left over (or refunded) is the last month's.
  let unassigned = offline.filter(payment => payment.period_start === null || !starts.has(payment.period_start)).reduce((sum, payment) => sum + payment.amount_minor, 0)
  return periods.map((period, index) => {
    const applied = Math.max(0, Math.min(unassigned, period.amount_minor - named[index]!))
    unassigned -= applied
    const paid = named[index]! + applied + (index === periods.length - 1 ? unassigned : 0)
    const status = paid >= period.amount_minor ? 'paid' : paid > 0 ? 'partial' : period.period_start < today ? 'overdue' : period.period_start === today ? 'due' : 'upcoming'
    return { ...period, paid_minor: paid, status }
  })
}

/** One thing a booking still has to pay, and from when. */
export interface Due {
  /** Names it within its booking: `rent:<period_start>`, `balance` or `deposit`. */
  key: string
  reason: UnpaidReason
  /** What it is for: "Rent for Dec 1 – Jan 1", "Stay balance", the deposit's own label. */
  label: string
  period_start: string | null
  period_end: string | null
  owed_minor: number
  /** When it falls due: the month's or stay's first day in the home's clock, or when the booking was made for a deposit. */
  due_at: string
  /** The local day it fell due. */
  due_on: string
  /** Owed now: a month whose first day has passed, a stay that has begun, a deposit once the booking stands. */
  owed: boolean
}

/** A booking as what it owes is read: the booking row, its deposit, and for a stay its money. */
export interface DueBooking {
  id: string
  status: 'pending' | 'confirmed' | 'cancelled'
  owner: 'app' | 'channel'
  channel: StayChannel
  unit: 'nights' | 'slot'
  product_kind: ProductKind
  timezone: string
  starts_at: string
  ends_at: string
  created_at: string
  total_minor: number | null
  deposit_minor: number | null
  deposit_received_minor: number
}

const dayStart = (day: string, timezone: string) => localDateTimeToInstant(day, '00:00', timezone, 'compatible').toISOString()
const shortDay = (day: string) => formatCalendarDate(day, 'en', { month: 'short', day: 'numeric' })

/** What a stay still has to pay: each unpaid month of a stay paid monthly, or the rest of its total. Nothing for a channel's, a request or a cancelled stay. */
export function stayDues(stay: LedgerStay & { status: DueBooking['status'] }, money: Pick<StayMoney, 'installments' | 'paid_minor'>, now = new Date()): Due[] {
  if (stay.status !== 'confirmed' || isChannelManagedStay(stay)) return []
  const today = localDateAt(now, stay.timezone)
  if (money.installments) {
    return money.installments.filter(period => period.paid_minor < period.amount_minor).map(period => ({
      key: `rent:${period.period_start}`, reason: 'rent', label: `Rent for ${shortDay(period.period_start)} – ${shortDay(period.period_end)}`,
      period_start: period.period_start, period_end: period.period_end, owed_minor: period.amount_minor - period.paid_minor,
      due_at: dayStart(period.period_start, stay.timezone), due_on: period.period_start, owed: period.period_start < today,
    }))
  }
  if (money.paid_minor >= stay.total_minor) return []
  return [{ key: 'balance', reason: 'balance', label: 'Stay balance', period_start: null, period_end: null, owed_minor: stay.total_minor - money.paid_minor,
    due_at: dayStart(stay.check_in_date, stay.timezone), due_on: stay.check_in_date, owed: stay.check_in_date <= today }]
}

/** The deposit or retainer still to be received. Required minus received: a deposit returned at checkout was paid, not owed again. */
export function depositDue(booking: DueBooking): Due | null {
  if (booking.status !== 'confirmed' || isChannelManagedStay(booking) || !booking.deposit_minor || booking.deposit_received_minor >= booking.deposit_minor) return null
  return { key: 'deposit', reason: 'deposit', label: depositLabel(booking.product_kind), period_start: null, period_end: null,
    owed_minor: booking.deposit_minor - booking.deposit_received_minor, due_at: booking.created_at, due_on: localDateAt(new Date(booking.created_at), booking.timezone), owed: true }
}

/** Every unpaid thing of one booking, oldest first. */
export function bookingDues(booking: DueBooking, money: StayMoneyRow | null, now = new Date()): Due[] {
  const deposit = depositDue(booking)
  const stay = booking.unit === 'nights' && booking.total_minor !== null && money ? stayDues(ledgerStay(booking), stayMoney(ledgerStay(booking), money, now), now) : []
  return [...stay, ...(deposit ? [deposit] : [])].sort((left, right) => left.due_at.localeCompare(right.due_at) || left.key.localeCompare(right.key))
}

function ledgerStay(booking: DueBooking): LedgerStay & { status: DueBooking['status'] } {
  if (booking.total_minor === null) throw new Error(`Stay ${booking.id} has no total`)
  return { owner: booking.owner, channel: booking.channel, status: booking.status, total_minor: booking.total_minor, timezone: booking.timezone,
    check_in_date: bookingDay(booking.starts_at, booking.timezone), check_out_date: bookingDay(booking.ends_at, booking.timezone) }
}

// ---------------------------------------------------------------------------
// Today: one stored task per thing to pay, written by the operation that makes
// the debt and closed by the one that pays it, in the same batch. A month's
// task is due on its first day, so Today shows it then with no timer.
// ---------------------------------------------------------------------------

export const PAYMENT_TASK_KIND = 'payment_due'
const DEPOSIT_KEY = 'deposit'

/**
 * A stay's month and balance tasks as one write leaves the stay: open for each
 * thing still to pay, done for one that was paid, cancelled for a month its
 * dates no longer have. `money` is the stay's money after the write; `guard`
 * keeps every statement to a batch whose write took effect.
 */
export function stayPaymentTaskQueries(input: {
  organizationId: string; stay: LedgerStay & { id: string; product_id: string; status: DueBooking['status'] }
  money: Pick<StayMoney, 'installments' | 'paid_minor'>; now: string; guard?: BatchQuery
}): BatchQuery[] {
  const { organizationId, stay, now } = input
  const rows = JSON.stringify(stayDues(stay, input.money, new Date(now)).map(due => ({ id: crypto.randomUUID(), key: due.key, due_at: due.due_at })))
  // What the stay is paid in now: its months, or its total at once. A task for anything else was for dates it no longer has,
  // and every task of a stay cancelled or paid through its channel is cancelled.
  const standing = stay.status === 'confirmed' && !isChannelManagedStay(stay)
  const known = JSON.stringify(!standing ? [] : input.money.installments ? input.money.installments.map(period => `rent:${period.period_start}`) : ['balance'])
  const guard = input.guard ? ` AND (${input.guard.query})` : ''
  const guardParams = input.guard?.params ?? []
  const prefix = `payment:${stay.id}:`
  return [{
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, timezone, due_at, status, dedupe_key, version, created_at, updated_at)
      SELECT json_extract(value, '$.id'), ?, '${PAYMENT_TASK_KIND}', 'booking', ?, ?, ?, json_extract(value, '$.due_at'), 'open', ? || json_extract(value, '$.key'), 1, ?, ?
        FROM json_each(?) WHERE 1 = 1${guard}
      ON CONFLICT (dedupe_key) DO UPDATE SET status = 'open', closed_at = NULL, closed_by_user_id = NULL, due_at = excluded.due_at, version = tasks.version + 1, updated_at = excluded.updated_at
        WHERE tasks.status <> 'open' OR tasks.due_at IS NOT excluded.due_at`,
    params: [organizationId, stay.id, stay.product_id, stay.timezone, prefix, now, now, rows, ...guardParams],
  }, {
    query: `UPDATE tasks SET status = CASE WHEN substr(dedupe_key, ?) IN (SELECT value FROM json_each(?)) THEN 'done' ELSE 'cancelled' END,
        closed_at = ?, version = version + 1, updated_at = ?
      WHERE organization_id = ? AND kind = '${PAYMENT_TASK_KIND}' AND subject_type = 'booking' AND subject_id = ? AND status = 'open'
        AND dedupe_key <> ? AND substr(dedupe_key, ?) NOT IN (SELECT json_extract(value, '$.key') FROM json_each(?))${guard}`,
    params: [prefix.length + 1, known, now, now, organizationId, stay.id, prefix + DEPOSIT_KEY, prefix.length + 1, rows, ...guardParams],
  }]
}

/** A stay's money as a write that changes it reads it first. */
export type StayMoneyFacts = LedgerStay & StayMoneyRow & { id: string; product_id: string; status: DueBooking['status'] }

/** One stay's money by its id; null for a booking that is not a stay or has no total. */
export async function readStayMoney(db: DbClient, organizationId: string, bookingId: string): Promise<StayMoneyFacts | null> {
  const [rows] = await executeBatch(db, [{
    query: `SELECT b.id, b.product_id, b.status, b.owner, b.channel, b.timezone, b.starts_at, b.ends_at, b.total_minor, ${stayMoneyColumns('b')}
      FROM bookings b WHERE b.organization_id = ? AND b.id = ? AND b.product_session_id IS NULL AND b.total_minor IS NOT NULL`,
    params: [organizationId, bookingId],
  }], { operation: 'Read stay money' })
  const row = rows!.results[0] as (Omit<StayMoneyFacts, 'check_in_date' | 'check_out_date'> & { starts_at: string; ends_at: string }) | undefined
  if (!row) return null
  const { starts_at: startsAt, ends_at: endsAt, ...facts } = row
  return { ...facts, check_in_date: bookingDay(startsAt, row.timezone), check_out_date: bookingDay(endsAt, row.timezone) }
}

/** `stayPaymentTaskQueries` for a stay as `readStayMoney` read it, changed by the caller to what its write leaves. */
export function stayMoneyTaskQueries(organizationId: string, stay: StayMoneyFacts, now: string, guard?: BatchQuery): BatchQuery[] {
  return stayPaymentTaskQueries({ organizationId, stay, money: stayMoney(stay, stay, new Date(now)), now, guard })
}

/**
 * A booking's deposit task from its stored deposit, in SQL: it needs nothing
 * the write's caller holds, so any write that changes the deposit or makes
 * the booking appends it. Open while less was received than is asked for.
 */
export function depositTaskQuery(organizationId: string, booking: { sql: string; params?: unknown[] }, now: string, guard?: BatchQuery): BatchQuery {
  const owed = `b.status = 'confirmed' AND b.owner = 'app' AND b.channel = 'direct' AND COALESCE(b.deposit_minor, 0) > ${depositReceivedSql('b.organization_id', 'b.id')}`
  return {
    query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, product_id, timezone, due_at, status, closed_at, dedupe_key, version, created_at, updated_at)
      SELECT ?, b.organization_id, '${PAYMENT_TASK_KIND}', 'booking', b.id, b.product_id, b.timezone, b.created_at,
          CASE WHEN ${owed} THEN 'open' WHEN b.status = 'cancelled' THEN 'cancelled' ELSE 'done' END, CASE WHEN ${owed} THEN NULL ELSE ? END, 'payment:' || b.id || ':${DEPOSIT_KEY}', 1, ?, ?
        FROM bookings b
       WHERE b.organization_id = ? AND b.id = ${booking.sql}${guard ? ` AND (${guard.query})` : ''}
         AND (${owed} OR EXISTS (SELECT 1 FROM tasks t WHERE t.dedupe_key = 'payment:' || b.id || ':${DEPOSIT_KEY}'))
      ON CONFLICT (dedupe_key) DO UPDATE SET status = excluded.status, closed_at = excluded.closed_at, closed_by_user_id = NULL, version = tasks.version + 1, updated_at = excluded.updated_at
        WHERE tasks.status IS NOT excluded.status`,
    params: [crypto.randomUUID(), now, now, now, organizationId, ...booking.params ?? [], ...guard?.params ?? []],
  }
}

// ---------------------------------------------------------------------------
// The read: every booking that owes, for the Unpaid list, MCP and iOS.
// ---------------------------------------------------------------------------

/** One unpaid-candidate booking as `unpaidQuery` reads it. */
export type UnpaidRow = DueBooking & StayMoneyRow & {
  product_id: string; product_name: string; location_id: string | null; location_title: string | null
  currency: string | null; guest_name: string | null; conversation_id: string | null
}

/**
 * The bookings that may owe, as one statement for the caller's batch: every
 * standing booking the business took itself with a deposit asked for, or a
 * stay with a total. `organization` is SQL naming the organization (NULL reads
 * nothing); `bookings` narrows to a set of booking ids.
 */
export function unpaidQuery(organization: { sql: string; params?: unknown[] }, bookings?: { sql: string; params?: unknown[] }): BatchQuery {
  return {
    query: `SELECT b.id, b.status, b.owner, b.channel, CASE WHEN b.product_session_id IS NULL THEN 'nights' ELSE 'slot' END AS unit, b.product_id, p.kind AS product_kind,
        COALESCE(sc.internal_name, p.name) AS product_name, COALESCE(b.location_id, sc.location_id) AS location_id, l.title AS location_title,
        b.starts_at, b.ends_at, b.timezone, b.created_at, b.total_minor, COALESCE(b.currency, org.default_currency) AS currency, b.deposit_minor,
        ${depositReceivedSql('b.organization_id', 'b.id')} AS deposit_received_minor,
        json_extract(r.payload_json, '$.guest.name') AS guest_name, r.id AS conversation_id, ${stayMoneyColumns('b')}
      FROM bookings b
      JOIN organization org ON org.id = b.organization_id
      JOIN products p ON p.organization_id = b.organization_id AND p.id = b.product_id
      LEFT JOIN product_stay_configs sc ON b.product_session_id IS NULL AND sc.organization_id = b.organization_id AND sc.product_id = b.product_id
      LEFT JOIN business_locations l ON l.organization_id = b.organization_id AND l.id = COALESCE(b.location_id, sc.location_id)
      LEFT JOIN conversations r ON r.organization_id = b.organization_id AND r.booking_id = b.id AND r.kind = 'booking'
     WHERE b.organization_id = ${organization.sql} AND b.status = 'confirmed' AND b.owner = 'app' AND b.channel = 'direct'
       AND (COALESCE(b.deposit_minor, 0) > 0 OR (b.product_session_id IS NULL AND b.total_minor > 0))
       ${bookings ? `AND b.id IN (${bookings.sql})` : ''}
     ORDER BY b.starts_at, b.id`,
    params: [...organization.params ?? [], ...bookings?.params ?? []],
  }
}

/** Each booking that owes something now, oldest debt first. */
export function unpaidBookings(rows: readonly UnpaidRow[], now = new Date()): UnpaidBooking[] {
  return rows.flatMap((row) => {
    const owed = bookingDues(row, row, now).filter(due => due.owed)
    if (!owed.length) return []
    if (!row.currency) throw new Error(`Booking ${row.id} owes money and has no currency`)
    return [{
      booking_id: row.id, unit: row.unit, conversation_id: row.conversation_id, guest_name: row.guest_name, product_id: row.product_id, product_kind: row.product_kind,
      product_name: row.product_name, location_id: row.location_id, location_title: row.location_title, currency: row.currency,
      owed_minor: owed.reduce((sum, due) => sum + due.owed_minor, 0), owed_since: owed[0]!.due_on,
      items: owed.map(due => ({ reason: due.reason, label: due.label, period_start: due.period_start, period_end: due.period_end, owed_minor: due.owed_minor, owed_since: due.due_on })),
    }]
  }).sort((left, right) => left.owed_since.localeCompare(right.owed_since) || left.booking_id.localeCompare(right.booking_id))
}

/** Who owes the business, for the people who manage it. */
export async function readUnpaid(db: DbClient, principal: { organizationId: string; role: string }, now = new Date()): Promise<{ bookings: UnpaidBooking[] }> {
  // The people who manage the business, as a booking's payments are shown only to them.
  await assertRoleAllows({ organizationId: principal.organizationId, role: principal.role, permissions: { settings: ['update'] }, message: 'Only owners and admins see who owes the business' })
  const [rows] = await executeBatch(db, [unpaidQuery({ sql: '?', params: [principal.organizationId] })], { operation: 'Read unpaid bookings' })
  return { bookings: unpaidBookings(rows!.results as UnpaidRow[], now) }
}
