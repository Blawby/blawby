import type { ProductKind } from '~/shared/product-details'
import { isRecord } from '~/utils/api-clients'

/** Who owes the business (#2079), as `GET /api/dashboard/payments/unpaid` and MCP `list_unpaid_bookings` state it. */
export type UnpaidReason = 'rent' | 'balance' | 'deposit'

export interface UnpaidItem {
  reason: UnpaidReason
  /** What it is for: "Rent for Dec 1 – Jan 1", "Stay balance", the deposit's label. */
  label: string
  period_start: string | null
  period_end: string | null
  owed_minor: number
  /** The local day it fell due. */
  owed_since: string
}

export interface UnpaidBooking {
  booking_id: string
  unit: 'nights' | 'slot'
  conversation_id: string | null
  guest_name: string | null
  product_id: string
  product_kind: ProductKind
  product_name: string
  location_id: string | null
  location_title: string | null
  currency: string
  /** Everything owed now, in the booking's currency. */
  owed_minor: number
  /** The local day the oldest of it fell due. */
  owed_since: string
  items: UnpaidItem[]
}

const text = (value: unknown) => typeof value === 'string'
const nullableText = (value: unknown) => value === null || typeof value === 'string'

export function isUnpaidList(value: unknown): value is { bookings: UnpaidBooking[] } {
  return isRecord(value) && Array.isArray(value.bookings) && value.bookings.every(row => isRecord(row)
    && [row.booking_id, row.product_id, row.product_kind, row.product_name, row.currency, row.owed_since].every(text)
    && [row.conversation_id, row.guest_name, row.location_id, row.location_title].every(nullableText)
    && (row.unit === 'nights' || row.unit === 'slot') && Number.isSafeInteger(row.owed_minor) && Array.isArray(row.items)
    && row.items.every(item => isRecord(item) && (item.reason === 'rent' || item.reason === 'balance' || item.reason === 'deposit')
      && text(item.label) && nullableText(item.period_start) && nullableText(item.period_end) && Number.isSafeInteger(item.owed_minor) && text(item.owed_since)))
}
