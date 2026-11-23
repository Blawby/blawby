import { AmbiguousPriceError, selectPrice, type Price, type PriceRecurringInterval, type PriceSelection } from './prices.ts'
import type { ProductKind } from './product-details.ts'

/**
 * A membership (#1907) is an offering bought for a recurring price, with no
 * session: Pottery House's monthly open studio, a dining club, a monthly legal
 * service plan. It is the ordinary Product of its own kind, sold on Stripe's
 * subscription on the business's connected account. Stripe owns renewal,
 * retries, cancellation and the billing anchor; Blawby records each paid
 * invoice as a payment.
 */
export const MEMBERSHIP_KINDS = ['experience', 'service', 'table'] as const satisfies readonly ProductKind[]

type Recurring = Pick<Price, 'id' | 'active' | 'currency' | 'location_id' | 'type' | 'recurring_interval' | 'recurring_interval_count' | 'valid_from_at' | 'valid_until_at'>

/** The one recurring offer a variant sells in this scope, or null when it sells none. Two terms at once are refused, never chosen between. */
export function membershipPrice<T extends Recurring>(prices: readonly T[], selection: Omit<PriceSelection, 'billing'>): T | null {
  const at = selection.at ?? new Date().toISOString()
  // Offers in force at that moment, in this currency and scope: a monthly price that ended yesterday and a yearly one starting today are not two terms at once.
  const live = prices.filter(price => price.active && price.type === 'recurring' && price.currency === selection.currency
    && !(price.valid_from_at && price.valid_from_at > at) && !(price.valid_until_at && at >= price.valid_until_at))
  // selectPrice's scope precedence: a location's own offers govern there; the neutral ones apply only where a location has none.
  const own = selection.location_id === null ? [] : live.filter(price => price.location_id === selection.location_id)
  const scoped = own.length ? own : live.filter(price => price.location_id === null)
  const terms = new Map(scoped.map(price => [`${price.recurring_interval}:${price.recurring_interval_count}`, { interval: price.recurring_interval as PriceRecurringInterval, interval_count: price.recurring_interval_count as number }]))
  if (terms.size > 1) throw new AmbiguousPriceError(scoped.map(price => price.id))
  const [term] = terms.values()
  return term ? selectPrice(prices, { ...selection, at, billing: { type: 'recurring', ...term } }) : null
}

/**
 * The offer a variant sells in this scope, priced once or as a membership:
 * a location's own offer, of either kind, governs there before a neutral one,
 * as selectPrice's precedence has it. `recurring` false asks for one-time offers only.
 */
export function offeredPrice<T extends Recurring>(prices: readonly T[], selection: Omit<PriceSelection, 'billing'>, recurring: boolean): T | null {
  const own = selection.location_id === null ? [] : prices.filter(price => price.location_id === selection.location_id)
  for (const scope of own.length ? [own, prices] : [prices]) {
    const found = selectPrice(scope, selection) ?? (recurring ? membershipPrice(scope, selection) : null)
    if (found) return found
  }
  return null
}

/** A product of a membership kind with no booking or outside link, whose active variants sell a recurring price. */
export function isMembershipProduct(product: { kind: ProductKind; booking: unknown; order_url: string | null; variants: ReadonlyArray<{ active: boolean; prices: ReadonlyArray<Pick<Price, 'active' | 'type'>> }> }): boolean {
  return (MEMBERSHIP_KINDS as readonly ProductKind[]).includes(product.kind) && !product.booking && !product.order_url
    && product.variants.some(variant => variant.active && variant.prices.some(price => price.active && price.type === 'recurring'))
}

/** A recurring price as Stripe writes it: "THB 5,000.00 per month", "$90.00 every 3 months". */
export function formatBillingTerms(amount: string, price: Pick<Price, 'recurring_interval' | 'recurring_interval_count'>): string {
  const count = price.recurring_interval_count ?? 1
  return count === 1 ? `${amount} per ${billingCadence(price)}` : `${amount} every ${billingCadence(price)}`
}

/** Stripe's own words for the cadence: "month", "3 months", "year". */
export function billingCadence(price: Pick<Price, 'recurring_interval' | 'recurring_interval_count'>): string {
  const count = price.recurring_interval_count ?? 1
  if (!price.recurring_interval) throw new Error('A recurring price has no interval')
  return count === 1 ? price.recurring_interval : `${count} ${price.recurring_interval}s`
}

/** The state of a member's Stripe subscription in the customer's words. */
export const MEMBERSHIP_STATES = ['active', 'cancelling', 'payment_failed', 'ended', 'incomplete'] as const
export type MembershipState = typeof MEMBERSHIP_STATES[number]

export interface Membership {
  /** Stripe's subscription ID: the membership's identity on the business's account. */
  id: string
  organization_id: string
  product_id: string | null
  title: string
  member_name: string | null
  member_email: string | null
  state: MembershipState
  currency: string
  unit_amount: number
  /** The price as Stripe charges it: "THB 5,000.00 per month". */
  terms: string
  started_at: string
  /** When the current paid period ends: the next payment, or the last day of access when cancelling. */
  current_period_end: string | null
  ended_at: string | null
  /** Payments Stripe collected for it, newest first. */
  payments: Array<{ id: string; amount: number; created_at: string; period_start: string | null; period_end: string | null; receipt_url: string | null; refunded_amount: number }>
}

export const MEMBERSHIP_STATE_LABELS: Record<MembershipState, string> = {
  active: 'Active', cancelling: 'Cancels at the end of the period', payment_failed: 'Payment failed', ended: 'Ended', incomplete: 'Not paid',
}
