import type { Price, PriceSelection } from '~/shared/prices'
import { formatMinorAmount, selectPrice } from '~/shared/prices'
import { formatBillingTerms, membershipPrice } from '~/shared/memberships'
import type { MenuPrice, ProductVariant } from '~/server/types/products'

/**
 * Render one resolved offer.
 *
 * Null means the caller omits the price element entirely. There is no
 * "Price on request" stand-in: text nobody supplied is not a price.
 */
export function formatProductMoney<T extends Pick<Price, 'unit_amount' | 'currency'> & Partial<Pick<Price, 'type' | 'recurring_interval' | 'recurring_interval_count'>>>(price: T | null, locale?: string): string | null {
  if (!price) return null
  const amount = formatMinorAmount(price.unit_amount, price.currency, locale)
  // A membership's price is charged again each period, and says so wherever it is shown.
  return price.type === 'recurring' ? formatBillingTerms(amount, { recurring_interval: price.recurring_interval ?? null, recurring_interval_count: price.recurring_interval_count ?? null }) : amount
}

/**
 * The price a surface shows for one variant, in one currency and location.
 *
 * A thin pass-through to the one selection contract, so a component never
 * reaches into `variant.prices` and invents a rule of its own. It throws on an
 * ambiguous set and returns null when nothing applies — both are the surface's
 * problem to state, not to paper over.
 */
export function formatVariantPrice(variant: ProductVariant, selection: PriceSelection, locale?: string): string | null {
  return formatProductMoney(selectPrice(variant.prices, selection), locale)
}

/** Card prices use the same offer selection as the chosen variant at checkout. */
export function summarizeProductPrices<T extends MenuPrice>(variants: readonly { active: boolean; prices: readonly T[] }[], selections: readonly PriceSelection[], includeInactive = false) {
  const offers = [...new Map(selections.flatMap(selection => variants.filter(variant => includeInactive || variant.active)
    // A variant with no one-time offer may be a membership's, sold for its recurring price.
    .flatMap(variant => selectPrice(variant.prices, selection) ?? membershipPrice(variant.prices, selection) ?? [])).map(offer => [offer.id, offer])).values()]
  if (!offers.length) return { lowest: null, highest: null, count: 0 }
  if (new Set(offers.map(offer => offer.currency)).size !== 1) throw new Error('A price range requires one currency')
  offers.sort((left, right) => left.unit_amount - right.unit_amount)
  return { lowest: offers[0]!, highest: offers.at(-1)!, count: offers.length }
}

export function formatProductPriceRange(summary: ReturnType<typeof summarizeProductPrices>, locale?: string): string | null {
  if (!summary.lowest || !summary.highest) return null
  const lowest = formatProductMoney(summary.lowest, locale)!
  return summary.lowest.unit_amount === summary.highest.unit_amount ? lowest : `${lowest} – ${formatProductMoney(summary.highest, locale)}`
}
