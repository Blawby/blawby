/**
 * Physical goods, after Shopify's model: a product's options (up to three,
 * each a name and its values) multiply into variants; a tracked variant counts
 * stock per location and either stops selling at zero (`deny`) or keeps
 * selling to be made to order (`continue`); a location ships to zones of
 * countries at rates chosen by parcel weight or order subtotal.
 */
import { z } from 'zod'

export const PRODUCT_OPTION_LIMITS = { options: 3, values: 100, name: 50, value: 100, variants: 100 } as const
export const INVENTORY_POLICIES = ['deny', 'continue'] as const
export type InventoryPolicy = typeof INVENTORY_POLICIES[number]
/** A variant's goods columns, in storage order (server/types/products.ts ProductVariantGoods). */
export const PRODUCT_VARIANT_GOODS_FIELDS = ['option_values', 'media_asset_id', 'weight_grams', 'length_mm', 'width_mm', 'height_mm', 'hs_code', 'country_of_origin', 'inventory_tracked', 'inventory_policy'] as const
export const DELIVERY_METHODS = ['shipping', 'pickup'] as const
export type DeliveryMethod = typeof DELIVERY_METHODS[number]
export const ORDER_STATUSES = ['pending', 'paid', 'released', 'cancelled'] as const
export type OrderStatus = typeof ORDER_STATUSES[number]

const trimmed = (max: number) => z.string().trim().min(1).max(max)

export const productOptionSchema = z.object({
  name: trimmed(PRODUCT_OPTION_LIMITS.name),
  values: z.array(trimmed(PRODUCT_OPTION_LIMITS.value)).min(1).max(PRODUCT_OPTION_LIMITS.values),
}).strict()
export type ProductOption = z.infer<typeof productOptionSchema>

/** A product's options: distinct names, distinct values within each. */
export const productOptionsSchema = z.array(productOptionSchema).max(PRODUCT_OPTION_LIMITS.options).superRefine((options, ctx) => {
  const names = new Set<string>()
  options.forEach((option, index) => {
    const name = option.name.toLocaleLowerCase('en')
    if (names.has(name)) ctx.addIssue({ code: 'custom', path: [index, 'name'], message: `Option "${option.name}" is listed twice` })
    names.add(name)
    const values = new Set<string>()
    option.values.forEach((value, valueIndex) => {
      const key = value.toLocaleLowerCase('en')
      if (values.has(key)) ctx.addIssue({ code: 'custom', path: [index, 'values', valueIndex], message: `"${value}" is listed twice in ${option.name}` })
      values.add(key)
    })
  })
})

export function parseProductOptions(value: string | null | undefined): ProductOption[] {
  return productOptionsSchema.parse(JSON.parse(value || '[]'))
}

export function parseOptionValues(value: string | null | undefined): string[] {
  return z.array(z.string()).max(PRODUCT_OPTION_LIMITS.options).parse(JSON.parse(value || '[]'))
}

/** Every combination of the options' values, in option order (Shopify's variant matrix). */
export function optionCombinations(options: readonly ProductOption[]): string[][] {
  // Counted before anything is built: three options of 100 values would otherwise allocate a million rows to refuse.
  const count = options.reduce((total, option) => total * option.values.length, 1)
  if (count > PRODUCT_OPTION_LIMITS.variants) throw new Error(`These options make ${count} variants; at most ${PRODUCT_OPTION_LIMITS.variants} are allowed`)
  const combinations = options.reduce<string[][]>((rows, option) => rows.flatMap(row => option.values.map(value => [...row, value])), [[]])
  return options.length ? combinations : []
}

/** The variant's name as Shopify titles it: its option values joined. */
export function variantTitle(optionValues: readonly string[]): string {
  return optionValues.join(' / ')
}

/** Whether each value names one of its option's values, in order. */
export function optionValuesMatch(options: readonly ProductOption[], optionValues: readonly string[]): boolean {
  return optionValues.length === options.length && options.every((option, index) => option.values.includes(optionValues[index]!))
}

export interface StockState {
  inventory_tracked: boolean
  inventory_policy: InventoryPolicy
  /** Units available across the locations that offer it; null when untracked. */
  available: number | null
}

/** How many can be bought now: unlimited when untracked or made to order. */
export function purchasableQuantity(stock: StockState): number | null {
  if (!stock.inventory_tracked || stock.inventory_policy === 'continue') return null
  return Math.max(stock.available ?? 0, 0)
}

/** Of a quantity bought, the part sold past the stock on hand, which is made to order. */
export function madeToOrderQuantity(stock: StockState, quantity: number): number {
  if (!stock.inventory_tracked) return 0
  return Math.max(quantity - Math.max(stock.available ?? 0, 0), 0)
}

export interface ShippingRateRule {
  min_weight_grams: number | null
  max_weight_grams: number | null
  min_subtotal: number | null
}

/** Shopify's rate conditions: a weight band (inclusive lower, exclusive upper) and a minimum subtotal. */
export function rateApplies(rate: ShippingRateRule, parcel: { weight_grams: number; subtotal: number }): boolean {
  return (rate.min_weight_grams === null || parcel.weight_grams >= rate.min_weight_grams)
    && (rate.max_weight_grams === null || parcel.weight_grams < rate.max_weight_grams)
    && (rate.min_subtotal === null || parcel.subtotal >= rate.min_subtotal)
}

/** Adds business days (Monday–Friday) to a local date, as shipping times are quoted. */
export function addBusinessDays(date: string, days: number): string {
  const day = new Date(`${date}T00:00:00Z`)
  let remaining = days
  while (remaining > 0) {
    day.setUTCDate(day.getUTCDate() + 1)
    const weekday = day.getUTCDay()
    if (weekday !== 0 && weekday !== 6) remaining -= 1
  }
  return day.toISOString().slice(0, 10)
}

/** An HS code as customs forms take it: 6, 8 or 10 digits, dots optional between the pairs after the first four ("6913.90", "691390.00"). */
export const HS_CODE_PATTERN = /^\d{4}\.?\d{2}(?:\.?\d{2}){0,2}$/u
export const HS_CODE_RULE = 'An HS code is 6, 8 or 10 digits, such as 6913.90'

export const countryCodeSchema = z.string().trim().toUpperCase().regex(/^[A-Z]{2}$/u, 'Use a two-letter country code')

/** Stripe's shipping details, which the PaymentIntent carries and the order keeps. */
export const shippingDetailsSchema = z.object({
  name: trimmed(200),
  phone: z.string().trim().max(40).nullable().optional().transform(value => value || null),
  address: z.object({
    line1: trimmed(200),
    line2: z.string().trim().max(200).nullable().optional().transform(value => value || null),
    city: z.string().trim().max(100).nullable().optional().transform(value => value || null),
    state: z.string().trim().max(100).nullable().optional().transform(value => value || null),
    postal_code: z.string().trim().max(20).nullable().optional().transform(value => value || null),
    country: countryCodeSchema,
  }).strict(),
}).strict()
export type ShippingDetails = z.infer<typeof shippingDetailsSchema>

/** A shipping address as people read it, one part per line; a state that only repeats the city is said once. */
export function shippingAddressLines(details: Pick<ShippingDetails, 'name' | 'address'>): string[] {
  const address = details.address
  return [details.name, address.line1, address.line2, [address.postal_code, address.city].filter(Boolean).join(' '),
    address.state && address.state !== address.city ? address.state : null, address.country].filter((line): line is string => Boolean(line))
}
