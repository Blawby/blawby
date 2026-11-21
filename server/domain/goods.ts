/**
 * Shipped goods: stock, shipping zones, and orders (Shopify's model, Stripe's
 * money). An order is priced here from the catalog, frozen on its payment, and
 * becomes paid in the same batch that writes its conversation, takes its
 * stock and opens its fulfilment task, before Stripe captures the charge.
 */
import { HTTPError } from 'nitro'
import { d1JsonArray, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import { publishEvent } from '~/server/events'
import { selectPrice, AmbiguousPriceError, type Price } from '~/shared/prices'
import { addBusinessDays, countryCodeSchema, madeToOrderQuantity, rateApplies, shippingDetailsSchema, variantTitle, type DeliveryMethod, type InventoryPolicy, type ShippingDetails } from '~/shared/goods'
import { localDateAt, localDateTimeToInstant } from '~/utils/timezone'
import { requireStripeCheckoutAcceptance, paymentsStripe, validatedSurchargeBasisPoints } from '~/server/utils/stripe-connect'
import type { readCheckoutSeller } from '~/server/utils/billing-access'
import type { ConnectedBuyer } from '~/server/utils/billing-customer'
import { conversionOriginSnapshotQuery } from '~/server/utils/organization-conversions'
import { quotePaymentsBillingFx } from '~/server/domain/payments/fx'
import { tokenHash } from '~/server/domain/payments/buyer'
import { openPaymentIntent, readCheckoutAttempt, type PaymentHandoff } from '~/server/domain/payments/checkout'
import { assertBookingBatchWrite } from '~/server/utils/availability'
import { requestInsertQueries } from '~/server/domain/requests'
import { jobAssigneeSql } from '~/server/domain/tasks'
import { messageQueries } from '~/server/domain/conversations'
import { isRecord } from '~/server/utils/type-guards'
import type { Payment } from '~/server/domain/payments'

function fail(statusCode: number, code: string, message: string, field?: string): never {
  throw new HTTPError({ statusCode, statusMessage: message, data: { code, ...(field ? { field } : {}) } })
}

// ---------------------------------------------------------------------------
// Stock
// ---------------------------------------------------------------------------

export interface InventoryLevel { product_variant_id: string; location_id: string; available: number; updated_at: string }

export async function readInventoryLevels(db: DbClient, organizationId: string, productId: string): Promise<InventoryLevel[]> {
  return queryAll<InventoryLevel>(db, `SELECT l.product_variant_id, l.location_id, l.available, l.updated_at FROM inventory_levels l
    JOIN product_variants v ON v.organization_id = l.organization_id AND v.id = l.product_variant_id
    WHERE l.organization_id = ? AND v.product_id = ? ORDER BY v.sort_order, l.location_id`, [organizationId, productId])
}

/** Sets stock counts (Shopify's "set" adjustment) for variants of one product at locations offering it. */
export async function setInventoryLevels(db: DbClient, input: { organizationId: string; productId: string; actorId: string
  levels: Array<{ product_variant_id: string; location_id: string; available: number }> }): Promise<InventoryLevel[]> {
  if (!Array.isArray(input.levels) || input.levels.length === 0 || input.levels.length > 300) fail(400, 'VALIDATION_ERROR', 'levels must list 1–300 stock counts', 'levels')
  const now = new Date().toISOString()
  const queries: BatchQuery[] = []
  for (const [index, level] of input.levels.entries()) {
    if (typeof level?.product_variant_id !== 'string' || typeof level.location_id !== 'string' || !Number.isSafeInteger(level.available) || level.available < -100_000 || level.available > 1_000_000) {
      fail(400, 'VALIDATION_ERROR', `levels[${index}] needs a variant, a location and a whole-number count`, `levels[${index}]`)
    }
    queries.push(assertBookingBatchWrite({ query: `EXISTS (SELECT 1 FROM product_variants v JOIN products p ON p.organization_id = v.organization_id AND p.id = v.product_id
        JOIN product_locations pl ON pl.organization_id = p.organization_id AND pl.product_id = p.id AND pl.location_id = ?
        WHERE v.organization_id = ? AND v.id = ? AND p.id = ? AND p.kind = 'item')`, params: [level.location_id, input.organizationId, level.product_variant_id, input.productId] }))
    queries.push({ query: `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, available, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (product_variant_id, location_id) DO UPDATE SET available = excluded.available, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      params: [input.organizationId, level.product_variant_id, level.location_id, level.available, now, input.actorId] })
  }
  try { await executeBatch(db, queries, { operation: 'Set stock' }) }
  catch (error) {
    if (error instanceof Error && /BOOKING_WRITE_REFUSED/.test(error.message)) fail(409, 'INVENTORY_TARGET_INVALID', 'Stock is counted for a physical item\'s variants at locations that offer it')
    throw error
  }
  return readInventoryLevels(db, input.organizationId, input.productId)
}

// ---------------------------------------------------------------------------
// Shipping zones and pickup
// ---------------------------------------------------------------------------

export interface ShippingRate { id: string; name: string; currency: string; amount: number; min_weight_grams: number | null; max_weight_grams: number | null; min_subtotal: number | null; delivery_days_min: number | null; delivery_days_max: number | null }
export interface ShippingZone { id: string; location_id: string; name: string; countries: string[]; rates: ShippingRate[] }

export async function listShippingZones(db: DbClient, organizationId: string): Promise<ShippingZone[]> {
  const [zones, rates] = await Promise.all([
    queryAll<{ id: string; location_id: string; name: string; countries: string }>(db, 'SELECT id, location_id, name, countries FROM shipping_zones WHERE organization_id = ? ORDER BY location_id, created_at, id', [organizationId]),
    queryAll<ShippingRate & { shipping_zone_id: string }>(db, 'SELECT * FROM shipping_rates WHERE organization_id = ? ORDER BY sort_order, id', [organizationId]),
  ])
  return zones.map(zone => ({ ...zone, countries: JSON.parse(zone.countries) as string[], rates: rates.filter(rate => rate.shipping_zone_id === zone.id).map(({ shipping_zone_id: _zone, ...rate }) => rate) }))
}

export interface ShippingZoneInput {
  location_id: string; name: string; countries: string[]
  rates: Array<Omit<ShippingRate, 'id' | 'currency'>>
}

function shippingZoneInput(value: unknown): ShippingZoneInput {
  if (!isRecord(value)) fail(400, 'VALIDATION_ERROR', 'A shipping zone is required')
  const name = typeof value.name === 'string' ? value.name.trim() : ''
  if (!name || name.length > 100) fail(400, 'VALIDATION_ERROR', 'name must be 1–100 characters', 'name')
  if (typeof value.location_id !== 'string' || !value.location_id) fail(400, 'VALIDATION_ERROR', 'location_id is required', 'location_id')
  if (!Array.isArray(value.countries) || value.countries.length === 0 || value.countries.length > 250) fail(400, 'VALIDATION_ERROR', 'countries must list 1–250 country codes', 'countries')
  const countries = [...new Set(value.countries.map((country, index) => {
    const parsed = countryCodeSchema.safeParse(country)
    if (!parsed.success) fail(400, 'VALIDATION_ERROR', `countries[${index}] must be a two-letter country code`, `countries[${index}]`)
    return parsed.data
  }))]
  if (!Array.isArray(value.rates) || value.rates.length > 20) fail(400, 'VALIDATION_ERROR', 'rates must list up to 20 rates', 'rates')
  const whole = (entry: Record<string, unknown>, field: string, index: number, min = 0) => {
    const raw = entry[field]
    if (raw === undefined || raw === null) return null
    if (!Number.isSafeInteger(raw) || (raw as number) < min) fail(400, 'VALIDATION_ERROR', `rates[${index}].${field} must be a whole number of at least ${min}`, `rates[${index}].${field}`)
    return raw as number
  }
  const rates = value.rates.map((entry, index) => {
    if (!isRecord(entry)) fail(400, 'VALIDATION_ERROR', `rates[${index}] must be an object`)
    const rateName = typeof entry.name === 'string' ? entry.name.trim() : ''
    if (!rateName || rateName.length > 100) fail(400, 'VALIDATION_ERROR', `rates[${index}].name must be 1–100 characters`, `rates[${index}].name`)
    const amount = whole(entry, 'amount', index)
    if (amount === null) fail(400, 'VALIDATION_ERROR', `rates[${index}].amount is required`, `rates[${index}].amount`)
    const rate = { name: rateName, amount, min_weight_grams: whole(entry, 'min_weight_grams', index), max_weight_grams: whole(entry, 'max_weight_grams', index, 1),
      min_subtotal: whole(entry, 'min_subtotal', index), delivery_days_min: whole(entry, 'delivery_days_min', index), delivery_days_max: whole(entry, 'delivery_days_max', index) }
    if (rate.min_weight_grams !== null && rate.max_weight_grams !== null && rate.max_weight_grams <= rate.min_weight_grams) fail(400, 'VALIDATION_ERROR', `rates[${index}] weight band is empty`, `rates[${index}].max_weight_grams`)
    if (rate.delivery_days_min !== null && rate.delivery_days_max !== null && rate.delivery_days_max < rate.delivery_days_min) fail(400, 'VALIDATION_ERROR', `rates[${index}] delivery days are reversed`, `rates[${index}].delivery_days_max`)
    return rate
  })
  return { location_id: value.location_id, name, countries, rates }
}

/** Creates or replaces one zone and its rates, in the organization's currency. A country is in at most one zone per location. */
export async function saveShippingZone(db: DbClient, organizationId: string, zoneId: string | null, value: unknown): Promise<ShippingZone> {
  const input = shippingZoneInput(value)
  const organization = await queryFirst<{ default_currency: string | null; location: string | null; taken: string | null }>(db, `SELECT o.default_currency,
      (SELECT id FROM business_locations WHERE organization_id = o.id AND id = ?) AS location,
      (SELECT group_concat(c.value) FROM shipping_zones z, json_each(z.countries) c WHERE z.organization_id = o.id AND z.location_id = ? AND z.id IS NOT ? AND c.value IN (SELECT value FROM json_each(?))) AS taken
    FROM organization o WHERE o.id = ?`, [input.location_id, input.location_id, zoneId, JSON.stringify(input.countries), organizationId])
  if (!organization) fail(404, 'ORGANIZATION_NOT_FOUND', 'Organization not found')
  if (!organization.default_currency) fail(409, 'CURRENCY_REQUIRED', 'Set the business currency before adding shipping rates')
  if (!organization.location) fail(404, 'LOCATION_NOT_FOUND', 'Location not found', 'location_id')
  if (organization.taken) fail(409, 'COUNTRY_IN_ANOTHER_ZONE', `Already shipped to in another zone: ${organization.taken}`, 'countries')
  const id = zoneId ?? crypto.randomUUID()
  const now = new Date().toISOString()
  const queries: BatchQuery[] = [zoneId
    ? { query: 'UPDATE shipping_zones SET location_id = ?, name = ?, countries = ?, updated_at = ? WHERE organization_id = ? AND id = ?', params: [input.location_id, input.name, JSON.stringify(input.countries), now, organizationId, id] }
    : { query: 'INSERT INTO shipping_zones (id, organization_id, location_id, name, countries, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', params: [id, organizationId, input.location_id, input.name, JSON.stringify(input.countries), now, now] },
  assertBookingBatchWrite({ query: 'changes() = 1', params: [] }),
  { query: 'DELETE FROM shipping_rates WHERE organization_id = ? AND shipping_zone_id = ?', params: [organizationId, id] },
  ...input.rates.map((rate, index) => ({
    query: `INSERT INTO shipping_rates (id, organization_id, shipping_zone_id, name, currency, amount, min_weight_grams, max_weight_grams, min_subtotal, delivery_days_min, delivery_days_max, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    params: [crypto.randomUUID(), organizationId, id, rate.name, organization.default_currency, rate.amount, rate.min_weight_grams, rate.max_weight_grams, rate.min_subtotal, rate.delivery_days_min, rate.delivery_days_max, index, now, now],
  }))]
  try { await executeBatch(db, queries, { operation: 'Save shipping zone' }) }
  catch (error) { if (error instanceof Error && /BOOKING_WRITE_REFUSED/.test(error.message)) fail(404, 'SHIPPING_ZONE_NOT_FOUND', 'Shipping zone not found'); throw error }
  const zone = (await listShippingZones(db, organizationId)).find(entry => entry.id === id)
  if (!zone) throw new Error('Saved shipping zone was not read back')
  return zone
}

export async function deleteShippingZone(db: DbClient, organizationId: string, zoneId: string): Promise<void> {
  const deleted = await executeBatch(db, [{ query: 'DELETE FROM shipping_zones WHERE organization_id = ? AND id = ?', params: [organizationId, zoneId] }], { operation: 'Delete shipping zone' })
  if (deleted[0]?.meta.changes !== 1) fail(404, 'SHIPPING_ZONE_NOT_FOUND', 'Shipping zone not found')
}

export async function setLocationPickup(db: DbClient, organizationId: string, locationId: string, enabled: boolean): Promise<void> {
  if (typeof enabled !== 'boolean') fail(400, 'VALIDATION_ERROR', 'pickup_enabled must be true or false', 'pickup_enabled')
  const [written] = await executeBatch(db, [{ query: 'UPDATE business_locations SET pickup_enabled = ?, updated_at = ? WHERE organization_id = ? AND id = ?', params: [enabled ? 1 : 0, new Date().toISOString(), organizationId, locationId] }], { operation: 'Set pickup' })
  if (written?.meta.changes !== 1) fail(404, 'LOCATION_NOT_FOUND', 'Location not found')
}

// ---------------------------------------------------------------------------
// Pricing an order
// ---------------------------------------------------------------------------

export interface OrderLineInput { product_variant_id: string; quantity: number }
export type OrderDelivery = { method: 'shipping'; country: string; shipping_rate_id?: string } | { method: 'pickup'; location_id: string }

export interface QuotedLine {
  product_id: string; product_variant_id: string; title: string; variant_title: string | null; sku: string | null
  quantity: number; unit_amount: number; amount: number; tax_code: string | null; tax_behavior: Price['tax_behavior']
  made_to_order_quantity: number; image_asset_id: string | null
}
export interface OrderQuote {
  currency: string; location: { id: string; title: string; timezone: string }
  lines: QuotedLine[]; subtotal: number; weight_grams: number | null
  delivery_method: DeliveryMethod
  /** The rates the buyer may choose, cheapest first; empty for pickup. */
  shipping_rates: Array<ShippingRate & { applies: true }>
  /** The local date the order should leave by, when the products state their shipping times. */
  ship_by: string | null
}

interface VariantFacts {
  id: string; product_id: string; name: string; sku: string | null; active: number; option_values: string; media_asset_id: string | null; weight_grams: number | null
  inventory_tracked: number; inventory_policy: InventoryPolicy; kind: string; product_name: string; product_active: number; published: number | null
  tax_code: string | null; processing_days: number | null; made_to_order_days: number | null; product_options: string
}

/**
 * Prices a cart for one location: the first location (in the order the business
 * added them, Shopify's location priority) that offers every product and can
 * deliver it — ships to the country, or is the pickup location chosen.
 */
export async function quoteOrder(db: DbClient, organizationId: string, input: { lines: unknown; delivery: unknown }, at = new Date()): Promise<OrderQuote> {
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 50) fail(400, 'VALIDATION_ERROR', 'An order lists 1–50 items', 'lines')
  const lines = input.lines.map((line, index) => {
    if (!isRecord(line) || typeof line.product_variant_id !== 'string' || !Number.isSafeInteger(line.quantity) || (line.quantity as number) < 1 || (line.quantity as number) > 99) fail(400, 'VALIDATION_ERROR', `lines[${index}] needs a variant and a quantity of 1–99`, `lines[${index}]`)
    return { product_variant_id: line.product_variant_id, quantity: line.quantity as number }
  })
  if (new Set(lines.map(line => line.product_variant_id)).size !== lines.length) fail(400, 'VALIDATION_ERROR', 'Each variant is listed once with its quantity', 'lines')
  const delivery = input.delivery
  if (!isRecord(delivery) || (delivery.method !== 'shipping' && delivery.method !== 'pickup')) fail(400, 'VALIDATION_ERROR', 'delivery.method must be shipping or pickup', 'delivery.method')
  const country = delivery.method === 'shipping' ? countryCodeSchema.safeParse(delivery.country) : null
  if (country && !country.success) fail(400, 'VALIDATION_ERROR', 'delivery.country must be a two-letter country code', 'delivery.country')
  if (delivery.method === 'pickup' && typeof delivery.location_id !== 'string') fail(400, 'VALIDATION_ERROR', 'delivery.location_id is required for pickup', 'delivery.location_id')
  const ids = d1JsonArray(lines.map(line => line.product_variant_id))
  const [variantRows, priceRows, offerRows, stockRows, locationRows, zoneRows, currencyRows] = await executeBatch(db, [
    { query: `SELECT v.id, v.product_id, v.name, v.sku, v.active, v.option_values, v.media_asset_id, v.weight_grams, v.inventory_tracked, v.inventory_policy,
        p.kind, p.name AS product_name, p.active AS product_active, pub.published, p.tax_code, p.processing_days, p.made_to_order_days, p.options AS product_options
      FROM product_variants v JOIN products p ON p.organization_id = v.organization_id AND p.id = v.product_id
      LEFT JOIN product_publications pub ON pub.organization_id = p.organization_id AND pub.product_id = p.id
      WHERE v.organization_id = ? AND v.id IN (SELECT value FROM json_each(?))`, params: [organizationId, ids] },
    { query: `SELECT * FROM prices WHERE organization_id = ? AND product_variant_id IN (SELECT value FROM json_each(?)) AND stay_date IS NULL AND weekend = 0`, params: [organizationId, ids] },
    { query: `SELECT pl.product_id, pl.location_id FROM product_locations pl JOIN product_variants v ON v.organization_id = pl.organization_id AND v.product_id = pl.product_id
      WHERE pl.organization_id = ? AND pl.active = 1 AND v.id IN (SELECT value FROM json_each(?))`, params: [organizationId, ids] },
    { query: 'SELECT product_variant_id, location_id, available FROM inventory_levels WHERE organization_id = ? AND product_variant_id IN (SELECT value FROM json_each(?))', params: [organizationId, ids] },
    { query: "SELECT id, title, timezone, pickup_enabled FROM business_locations WHERE organization_id = ? AND status = 'active' ORDER BY created_at, id", params: [organizationId] },
    { query: `SELECT z.id AS zone_id, z.location_id, z.countries, r.* FROM shipping_zones z JOIN shipping_rates r ON r.organization_id = z.organization_id AND r.shipping_zone_id = z.id
      WHERE z.organization_id = ? ORDER BY r.amount, r.sort_order`, params: [organizationId] },
    { query: 'SELECT default_currency FROM organization WHERE id = ?', params: [organizationId] },
  ], { operation: 'Price order' })
  const variants = (variantRows?.results ?? []) as unknown as VariantFacts[]
  const prices = (priceRows?.results ?? []) as unknown as Price[]
  const offers = (offerRows?.results ?? []) as Array<{ product_id: string; location_id: string }>
  const stock = (stockRows?.results ?? []) as Array<{ product_variant_id: string; location_id: string; available: number }>
  const locations = (locationRows?.results ?? []) as Array<{ id: string; title: string; timezone: string; pickup_enabled: number }>
  const zoneRates = (zoneRows?.results ?? []) as Array<ShippingRate & { zone_id: string; location_id: string; countries: string }>
  const currency = (currencyRows?.results[0] as { default_currency: string | null } | undefined)?.default_currency
  if (!currency) fail(409, 'CURRENCY_REQUIRED', 'This business has not set its currency')
  for (const line of lines) {
    const variant = variants.find(row => row.id === line.product_variant_id)
    if (!variant || variant.kind !== 'item' || variant.active !== 1 || variant.product_active !== 1 || variant.published !== 1) fail(409, 'ITEM_UNAVAILABLE', 'An item in the order is no longer for sale', 'lines')
  }
  const productIds = [...new Set(variants.map(variant => variant.product_id))]
  const offering = locations.filter(location => productIds.every(productId => offers.some(offer => offer.product_id === productId && offer.location_id === location.id)))
  const location = delivery.method === 'pickup'
    ? offering.find(candidate => candidate.id === delivery.location_id && candidate.pickup_enabled === 1)
    : offering.find(candidate => zoneRates.some(rate => rate.location_id === candidate.id && (JSON.parse(rate.countries) as string[]).includes(country!.data!)))
  if (!location) fail(409, delivery.method === 'pickup' ? 'PICKUP_UNAVAILABLE' : 'SHIPPING_UNAVAILABLE', delivery.method === 'pickup' ? 'These items cannot be collected there' : 'These items do not ship to that country', 'delivery')
  const at_ = at.toISOString()
  const quoted = lines.map(line => {
    const variant = variants.find(row => row.id === line.product_variant_id)!
    let price: Price | null
    try { price = selectPrice(prices.filter(row => row.product_variant_id === variant.id).map(row => ({ ...row, active: Boolean(row.active) })), { currency, location_id: location.id, at: at_ }) }
    catch (error) { if (error instanceof AmbiguousPriceError) throw new Error(`Variant ${variant.id} has ambiguous prices`, { cause: error }); throw error }
    if (!price) fail(409, 'ITEM_UNPRICED', `${variant.product_name} has no price here`, 'lines')
    const available = stock.find(row => row.product_variant_id === variant.id && row.location_id === location.id)?.available ?? 0
    const state = { inventory_tracked: variant.inventory_tracked === 1, inventory_policy: variant.inventory_policy, available }
    const madeToOrder = madeToOrderQuantity(state, line.quantity)
    if (madeToOrder > 0 && variant.inventory_policy === 'deny') fail(409, 'OUT_OF_STOCK', `Only ${Math.max(available, 0)} of ${variant.product_name} left`, 'lines')
    const optionValues = JSON.parse(variant.option_values) as string[]
    return {
      product_id: variant.product_id, product_variant_id: variant.id, title: variant.product_name,
      variant_title: optionValues.length ? variantTitle(optionValues) : null, sku: variant.sku,
      quantity: line.quantity, unit_amount: price.unit_amount, amount: price.unit_amount * line.quantity,
      tax_code: variant.tax_code, tax_behavior: price.tax_behavior, made_to_order_quantity: madeToOrder, image_asset_id: variant.media_asset_id,
    }
  })
  const subtotal = quoted.reduce((sum, line) => sum + line.amount, 0)
  const weights = lines.map(line => variants.find(row => row.id === line.product_variant_id)!.weight_grams)
  const weight = weights.every(value => value !== null) ? lines.reduce((sum, line, index) => sum + (weights[index] as number) * line.quantity, 0) : null
  const shippingRates = delivery.method === 'pickup' ? [] : zoneRates
    .filter(rate => rate.location_id === location.id && (JSON.parse(rate.countries) as string[]).includes(country!.data!) && rate.currency === currency)
    .filter(rate => (weight === null ? rate.min_weight_grams === null && rate.max_weight_grams === null : true) && rateApplies(rate, { weight_grams: weight ?? 0, subtotal }))
    .map(({ zone_id: _zone, location_id: _location, countries: _countries, ...rate }) => ({ id: rate.id, name: rate.name, currency: rate.currency, amount: rate.amount, min_weight_grams: rate.min_weight_grams,
      max_weight_grams: rate.max_weight_grams, min_subtotal: rate.min_subtotal, delivery_days_min: rate.delivery_days_min, delivery_days_max: rate.delivery_days_max, applies: true as const }))
  if (delivery.method === 'shipping' && shippingRates.length === 0) fail(409, 'SHIPPING_UNAVAILABLE', 'No shipping rate covers this order', 'delivery')
  const productDays = quoted.map(line => {
    const variant = variants.find(row => row.id === line.product_variant_id)!
    return line.made_to_order_quantity > 0 ? variant.made_to_order_days : variant.processing_days
  })
  const shipBy = productDays.every(days => days !== null) ? addBusinessDays(localDateAt(at, location.timezone), Math.max(0, ...(productDays as number[]))) : null
  return { currency, location: { id: location.id, title: location.title, timezone: location.timezone }, lines: quoted, subtotal, weight_grams: weight,
    delivery_method: delivery.method, shipping_rates: shippingRates, ship_by: shipBy }
}

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

export interface OrderSnapshot {
  id: string; number: number; location_id: string; delivery_method: DeliveryMethod
  lines: Array<Pick<QuotedLine, 'product_id' | 'product_variant_id' | 'title' | 'variant_title' | 'quantity' | 'unit_amount' | 'amount' | 'tax_code' | 'tax_behavior'>>
  shipping: { rate_id: string; name: string; amount: number } | null
  shipping_details: ShippingDetails | null
  guest: { name: string; email: string; phone: string | null }
  note: string | null
  ship_by: string | null
  /** The end of the ship-by day where it ships from, the fulfilment task's due instant. */
  ship_by_due_at: string | null
}

export function orderSnapshotOf(snapshot: Record<string, unknown>): OrderSnapshot | null {
  return isRecord(snapshot.order) ? snapshot.order as unknown as OrderSnapshot : null
}

export interface OrderCheckoutInput {
  organizationId: string; buyerUserId: string | null; buyer?: ConnectedBuyer | null
  lines: unknown; delivery: unknown; shipping_details: unknown
  guest: { name: unknown; email: unknown; phone: unknown }; note: unknown
  idempotencyKey: string
  origin: { request: { headers: Headers }; pageEventId: string | null } | null
  seller?: Awaited<ReturnType<typeof readCheckoutSeller>>
}

const trimmedText = (value: unknown, field: string, max: number, required: boolean) => {
  const text = typeof value === 'string' ? value.trim() : ''
  if (required && !text) fail(400, 'VALIDATION_ERROR', `${field} is required`, field)
  if (text.length > max) fail(400, 'VALIDATION_ERROR', `${field} is at most ${max} characters`, field)
  return text || null
}

/** Freezes the order and its price on a payment, then opens its PaymentIntent. A retry with the same key reopens it. */
export async function createOrderCheckout(db: DbClient, env: CloudflareEnv, input: OrderCheckoutInput): Promise<PaymentHandoff> {
  const key = input.idempotencyKey.trim()
  if (!key || key.length > 200) fail(400, 'VALIDATION_ERROR', 'An idempotency key of 1–200 characters is required', 'idempotency_key')
  const guest = {
    name: trimmedText(input.guest.name, 'guest_name', 200, true)!,
    email: trimmedText(input.guest.email, 'guest_email', 254, true)!.toLowerCase(),
    phone: trimmedText(input.guest.phone, 'guest_phone', 40, false),
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(guest.email)) fail(400, 'VALIDATION_ERROR', 'Enter a valid email', 'guest_email')
  const note = trimmedText(input.note, 'note', 2000, false)
  const quote = await quoteOrder(db, input.organizationId, { lines: input.lines, delivery: input.delivery })
  let shippingDetails: ShippingDetails | null = null
  let shipping: OrderSnapshot['shipping'] = null
  if (quote.delivery_method === 'shipping') {
    const parsed = shippingDetailsSchema.safeParse(input.shipping_details)
    if (!parsed.success) fail(400, 'VALIDATION_ERROR', 'A shipping name and address are required', 'shipping_details')
    shippingDetails = parsed.data
    const delivery = input.delivery as { country: string; shipping_rate_id?: unknown }
    if (shippingDetails.address.country !== delivery.country.toUpperCase()) fail(400, 'VALIDATION_ERROR', 'The address country must match the country quoted', 'shipping_details.address.country')
    const rate = quote.shipping_rates.find(candidate => candidate.id === delivery.shipping_rate_id)
    if (!rate) fail(409, 'SHIPPING_RATE_UNAVAILABLE', 'Choose one of the shipping rates offered', 'delivery.shipping_rate_id')
    shipping = { rate_id: rate.id, name: rate.name, amount: rate.amount }
  }
  const fingerprint = await tokenHash(JSON.stringify({ lines: quote.lines.map(line => [line.product_variant_id, line.quantity, line.unit_amount]), shipping, shippingDetails, guest, note, location: quote.location.id }))
  const previous = await readCheckoutAttempt(db, input.organizationId, key)
  if (previous) {
    const frozen = JSON.parse(previous.price_snapshot_json) as Record<string, unknown>
    if (previous.subject_type !== 'order' || frozen.request_fingerprint !== fingerprint) fail(409, 'IDEMPOTENCY_CONFLICT', 'This checkout key was used for a different order', 'idempotency_key')
  }
  const now = new Date().toISOString()
  const acceptance = previous ? null : await requireStripeCheckoutAcceptance(db, env, input.organizationId, input.seller)
  const connected = acceptance?.connected ?? (previous ? { stripe_account_id: previous.stripe_account_id, livemode: previous.livemode === 1 } : null)
  if (!connected?.stripe_account_id) throw new Error('Checkout has no connected account')
  const stripe = acceptance?.stripe ?? paymentsStripe(env, connected.livemode)
  const frozenSnapshot = previous ? JSON.parse(previous.price_snapshot_json) as { method_configuration_id: string; title: string } : null
  const methodConfigurationId = acceptance?.methodConfigurationId ?? frozenSnapshot!.method_configuration_id
  const surcharge = acceptance ? acceptance.surchargeBasisPoints : validatedSurchargeBasisPoints(previous!.surcharge_basis_points)
  const total = quote.subtotal + (shipping?.amount ?? 0)
  const id = previous?.id ?? crypto.randomUUID()
  const returnToken = previous?.return_token ?? crypto.randomUUID() + crypto.randomUUID()
  const expiresAt = previous?.checkout_expires_at ?? new Date(Date.now() + 60 * 60 * 1000).toISOString()
  const handoff: PaymentHandoff = { payment_id: id, pay_path: `/pay/${encodeURIComponent(id)}`, purchase_claim: returnToken, expires_at: expiresAt }
  const title = frozenSnapshot?.title ?? (quote.lines.length === 1 ? quote.lines[0]!.title : `${quote.lines[0]!.title} and ${quote.lines.length - 1} more`)
  if (previous?.stripe_payment_intent_id) return handoff
  if (!previous) {
    if (expiresAt <= now) throw new Error('A new checkout cannot have expired')
    const orderId = crypto.randomUUID()
    const behaviors = [...new Set(quote.lines.map(line => line.tax_behavior))]
    const order: Omit<OrderSnapshot, 'number'> = {
      id: orderId, location_id: quote.location.id, delivery_method: quote.delivery_method,
      lines: quote.lines.map(({ product_id, product_variant_id, title: lineTitle, variant_title, quantity, unit_amount, amount, tax_code, tax_behavior }) => ({ product_id, product_variant_id, title: lineTitle, variant_title, quantity, unit_amount, amount, tax_code, tax_behavior })),
      shipping, shipping_details: shippingDetails, guest, note, ship_by: quote.ship_by,
      ship_by_due_at: quote.ship_by ? localDateTimeToInstant(quote.ship_by, '23:59', quote.location.timezone, 'compatible').toISOString() : null,
    }
    const purchase = {
      title, tax_code: null, quantity: 1, price: { unit_amount: total, currency: quote.currency, tax_behavior: behaviors.length === 1 ? behaviors[0] : 'unspecified' },
      automatic_tax: acceptance!.automaticTax, method_configuration_id: methodConfigurationId, request_fingerprint: fingerprint,
      billing_fx: await quotePaymentsBillingFx(stripe, quote.currency), product_id: quote.lines[0]!.product_id, order,
    }
    const origin = conversionOriginSnapshotQuery(input.organizationId, input.origin)
    const number = `(SELECT COALESCE(MAX(number), 1000) + 1 FROM orders WHERE organization_id = ?)`
    const queries: BatchQuery[] = [
      { query: `INSERT INTO orders (id, organization_id, number, buyer_user_id, location_id, status, delivery_method, shipping_details, shipping_rate_name, shipping_amount, currency, subtotal_amount, ship_by, created_at, updated_at)
          VALUES (?, ?, ${number}, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [orderId, input.organizationId, input.organizationId, input.buyerUserId, quote.location.id, quote.delivery_method, shippingDetails ? JSON.stringify(shippingDetails) : null,
          shipping?.name ?? null, shipping?.amount ?? 0, quote.currency, quote.subtotal, quote.ship_by, now, now] },
      ...quote.lines.map((line, index) => ({
        query: `INSERT INTO order_lines (id, organization_id, order_id, product_id, product_variant_id, title, variant_title, sku, quantity, unit_amount, made_to_order_quantity, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
        params: [crypto.randomUUID(), input.organizationId, orderId, line.product_id, line.product_variant_id, line.title, line.variant_title, line.sku, line.quantity, line.unit_amount, index],
      })),
      { query: `INSERT INTO payments (id, organization_id, buyer_user_id, stripe_account_id, livemode, subject_type, subject_id, location_id, currency, amount, price_snapshot_json,
          idempotency_key, checkout_expires_at, return_token, return_token_hash, return_expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'order', ?, ?, ?, ?, json_set(?, '$.checkout_origin', json((${origin.query})), '$.order.number', (SELECT number FROM orders WHERE id = ?)), ?, ?, ?, ?, ?, ?, ?)`,
        params: [id, input.organizationId, input.buyerUserId, connected.stripe_account_id, Number(connected.livemode), orderId, quote.location.id, quote.currency, total,
          JSON.stringify(purchase), ...(origin.params ?? []), orderId, `checkout:${input.organizationId}:${key}`, expiresAt, returnToken, await tokenHash(returnToken),
          new Date(Date.now() + 86_400_000).toISOString(), now, now] },
    ]
    try { await executeBatch(db, queries, { operation: 'Save order checkout' }) }
    catch (error) {
      if (await readCheckoutAttempt(db, input.organizationId, key)) return createOrderCheckout(db, env, input)
      throw error
    }
  }
  const savedCards = await openPaymentIntent(db, stripe, {
    paymentId: id, organizationId: input.organizationId, idempotencyKey: `checkout:${input.organizationId}:${key}`, retry: Boolean(previous), amount: total, currency: quote.currency,
    connected, methodConfigurationId, surcharge, description: title, buyerUserId: input.buyerUserId, buyer: input.buyer ?? null,
  })
  await publishEvent(env, { type: 'payment.checkout_started', organization_id: input.organizationId, payment_id: id, saved_cards_offered: savedCards })
  return handoff
}

// ---------------------------------------------------------------------------
// Settlement
// ---------------------------------------------------------------------------

export class OrderStockUnavailableError extends Error {
  constructor() { super('An item in the order sold out while it was being paid for'); this.name = 'OrderStockUnavailableError' }
}

/** The order's opening line in its conversation, as a booking's opens with what was booked. */
export function orderOpening(order: OrderSnapshot): string {
  const items = order.lines.map(line => `${line.title}${line.variant_title ? ` (${line.variant_title})` : ''} × ${line.quantity}`).join(', ')
  return `Order #${order.number}: ${items}. ${order.delivery_method === 'pickup' ? 'Pickup' : `Ship to ${order.shipping_details?.address.country ?? ''}`}`.trim()
}

/**
 * Pays the order: its status, its conversation with the buyer, its stock and
 * its fulfilment task, with the capture queries when Stripe has already
 * captured. A deny-policy variant whose stock ran out refuses the batch.
 */
export async function saveCheckoutOrder(db: DbClient, payment: Payment, snapshot: Record<string, unknown>, paidAt: string, following: BatchQuery[] = []) {
  const order = orderSnapshotOf(snapshot)
  if (!order || payment.subject_type !== 'order' || payment.subject_id !== order.id) throw new Error('Order payment has no frozen order')
  const conversationId = crypto.randomUUID()
  const paid = { query: 'SELECT 1 FROM orders WHERE organization_id = ? AND id = ? AND status = \'paid\' AND conversation_id = ?', params: [payment.organization_id, order.id, conversationId] }
  const stockQueries: BatchQuery[] = []
  for (const line of order.lines) {
    const variant = `(SELECT inventory_tracked FROM product_variants WHERE organization_id = ? AND id = ?)`
    const available = `COALESCE((SELECT available FROM inventory_levels WHERE product_variant_id = ? AND location_id = ?), 0)`
    stockQueries.push(
      { query: `UPDATE order_lines SET made_to_order_quantity = CASE WHEN ${variant} = 1 THEN MAX(quantity - MAX(${available}, 0), 0) ELSE 0 END
          WHERE organization_id = ? AND order_id = ? AND product_variant_id = ?`,
        params: [payment.organization_id, line.product_variant_id, line.product_variant_id, order.location_id, payment.organization_id, order.id, line.product_variant_id] },
      assertBookingBatchWrite({ query: `NOT EXISTS (SELECT 1 FROM order_lines l JOIN product_variants v ON v.organization_id = l.organization_id AND v.id = l.product_variant_id
          WHERE l.organization_id = ? AND l.order_id = ? AND l.product_variant_id = ? AND l.made_to_order_quantity > 0 AND v.inventory_policy = 'deny')`,
        params: [payment.organization_id, order.id, line.product_variant_id] }),
      { query: `INSERT INTO inventory_levels (organization_id, product_variant_id, location_id, available, updated_at, updated_by)
          SELECT ?, ?, ?, -?, ?, ? WHERE ${variant} = 1
          ON CONFLICT (product_variant_id, location_id) DO UPDATE SET available = available - ?, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        params: [payment.organization_id, line.product_variant_id, order.location_id, line.quantity, paidAt, `order:${order.id}`, payment.organization_id, line.product_variant_id, line.quantity] },
    )
  }
  const queries: BatchQuery[] = [
    { query: `UPDATE orders SET status = 'paid', paid_at = ?, conversation_id = ?, buyer_user_id = COALESCE(buyer_user_id, ?), updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'pending'`,
      params: [paidAt, conversationId, payment.buyer_user_id, paidAt, payment.organization_id, order.id] },
    assertBookingBatchWrite({ query: 'changes() = 1', params: [] }),
    ...stockQueries,
    ...requestInsertQueries({
      id: conversationId, kind: 'contact', organization_id: payment.organization_id, location_id: order.location_id, booking_id: null, user_id: payment.buyer_user_id, created_at: paidAt,
      payload: { guest: order.guest, subject: `Order #${order.number}`, consent_at: null, ip_hash: null, source: 'order', answers: [] },
    }, paid, { opening: orderOpening(order), note: order.note }),
    { query: `INSERT INTO tasks (id, organization_id, kind, subject_type, subject_id, location_id, assigned_member_id, due_at, timezone, status, dedupe_key, version, created_at, updated_at)
        SELECT ?, o.organization_id, 'order_fulfillment', 'order', o.id, o.location_id, ${jobAssigneeSql('o.organization_id', 'NULL')}, ?, l.timezone, 'open', ?, 1, ?, ?
        FROM orders o JOIN business_locations l ON l.organization_id = o.organization_id AND l.id = o.location_id
        WHERE o.organization_id = ? AND o.id = ? AND o.status = 'paid' ON CONFLICT (dedupe_key) DO NOTHING`,
      params: [crypto.randomUUID(), order.ship_by_due_at, `order_fulfillment:${order.id}`, paidAt, paidAt, payment.organization_id, order.id] },
    ...following,
  ]
  try { return await executeBatch(db, queries, { operation: 'Pay order' }) }
  catch (error) {
    if (error instanceof Error && /BOOKING_WRITE_REFUSED/.test(error.message)) {
      const current = await queryFirst<{ status: string }>(db, 'SELECT status FROM orders WHERE organization_id = ? AND id = ?', [payment.organization_id, order.id])
      if (current?.status === 'paid') return null
      throw new OrderStockUnavailableError()
    }
    throw error
  }
}

/** Releases an order whose payment never completed. */
export function releaseOrderQuery(payment: Pick<Payment, 'organization_id' | 'subject_id'>): BatchQuery {
  return { query: "UPDATE orders SET status = 'released', updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'pending'", params: [new Date().toISOString(), payment.organization_id, payment.subject_id] }
}

// ---------------------------------------------------------------------------
// Reading and fulfilling
// ---------------------------------------------------------------------------

export interface OrderLineRow { id: string; product_id: string; product_variant_id: string; title: string; variant_title: string | null; sku: string | null; quantity: number; unit_amount: number; made_to_order_quantity: number }
export interface OrderRecord {
  id: string; organization_id: string; organization_name: string | null; number: number; status: string; conversation_id: string | null; location_id: string; location_title: string
  delivery_method: DeliveryMethod; shipping_details: ShippingDetails | null; shipping_rate_name: string | null; shipping_amount: number
  currency: string; subtotal_amount: number; ship_by: string | null; carrier: string | null; tracking_number: string | null; tracking_url: string | null
  fulfilled_at: string | null; paid_at: string | null; cancelled_at: string | null; created_at: string
  payment: { id: string; amount: number; captured_amount: number; refunded_amount: number; tax_amount: number; surcharge_amount: number; receipt_url: string | null } | null
  guest: { name: string | null; email: string | null; phone: string | null } | null
  lines: OrderLineRow[]
}

export function orderRecordQuery(organizationId: string, where: { orderId: string } | { conversationId: string } | { open: boolean }): BatchQuery {
  return { query: `SELECT o.*, l.title AS location_title, (SELECT name FROM organization WHERE id = o.organization_id) AS organization_name,
      (SELECT json_object('id', p.id, 'amount', p.amount, 'captured_amount', p.captured_amount, 'refunded_amount', p.refunded_amount, 'tax_amount', p.tax_amount,
        'surcharge_amount', p.surcharge_amount, 'receipt_url', p.receipt_url) FROM payments p WHERE p.organization_id = o.organization_id AND p.subject_type = 'order' AND p.subject_id = o.id) AS payment,
      (SELECT json_extract(c.payload_json, '$.guest') FROM conversations c WHERE c.organization_id = o.organization_id AND c.id = o.conversation_id) AS guest,
      (SELECT json_group_array(json_object('id', x.id, 'product_id', x.product_id, 'product_variant_id', x.product_variant_id, 'title', x.title, 'variant_title', x.variant_title,
        'sku', x.sku, 'quantity', x.quantity, 'unit_amount', x.unit_amount, 'made_to_order_quantity', x.made_to_order_quantity))
        FROM (SELECT * FROM order_lines WHERE organization_id = o.organization_id AND order_id = o.id ORDER BY sort_order) x) AS lines
    FROM orders o JOIN business_locations l ON l.organization_id = o.organization_id AND l.id = o.location_id
    WHERE o.organization_id = ? AND ${'open' in where
      ? `o.status IN ('paid', 'cancelled')${where.open ? " AND o.status = 'paid' AND o.fulfilled_at IS NULL" : ''} ORDER BY o.created_at DESC LIMIT 200`
      : `${'orderId' in where ? 'o.id' : 'o.conversation_id'} = ?`}`,
  params: [organizationId, ...('open' in where ? [] : ['orderId' in where ? where.orderId : where.conversationId])] }
}

export function orderRecordFromRow(row: unknown): OrderRecord | null {
  if (!isRecord(row)) return null
  const json = (value: unknown) => typeof value === 'string' ? JSON.parse(value) as unknown : null
  return { ...(row as unknown as OrderRecord), shipping_details: json(row.shipping_details) as ShippingDetails | null,
    payment: json(row.payment) as OrderRecord['payment'], guest: json(row.guest) as OrderRecord['guest'], lines: (json(row.lines) ?? []) as OrderLineRow[] }
}

export async function readOrder(db: DbClient, organizationId: string, where: { orderId: string } | { conversationId: string }): Promise<OrderRecord | null> {
  const plan = orderRecordQuery(organizationId, where)
  return orderRecordFromRow(await queryFirst(db, plan.query, plan.params))
}

/**
 * Marks a paid order shipped (with its carrier and tracking) or collected,
 * closes its fulfilment task, and tells the buyer in the order's conversation.
 */
export async function fulfillOrder(db: DbClient, env: CloudflareEnv, input: { organizationId: string; orderId: string; actorId: string; carrier: unknown; tracking_number: unknown; tracking_url: unknown }): Promise<OrderRecord> {
  const order = await readOrder(db, input.organizationId, { orderId: input.orderId })
  if (!order) fail(404, 'ORDER_NOT_FOUND', 'Order not found')
  if (order.status !== 'paid') fail(409, 'ORDER_NOT_PAID', 'Only a paid order can be fulfilled')
  if (order.fulfilled_at) fail(409, 'ORDER_FULFILLED', 'This order is already fulfilled')
  const carrier = trimmedText(input.carrier, 'carrier', 100, false)
  const tracking = trimmedText(input.tracking_number, 'tracking_number', 100, false)
  const url = trimmedText(input.tracking_url, 'tracking_url', 500, false)
  if (url && !/^https:\/\/[^\s]+$/u.test(url)) fail(400, 'VALIDATION_ERROR', 'tracking_url must be an https link', 'tracking_url')
  if (order.delivery_method === 'shipping' && !carrier) fail(400, 'VALIDATION_ERROR', 'carrier is required for a shipped order', 'carrier')
  if ((tracking || url) && order.delivery_method === 'pickup') fail(400, 'VALIDATION_ERROR', 'A collected order has no tracking', 'tracking_number')
  if (!order.conversation_id) throw new Error('Paid order has no conversation')
  const now = new Date().toISOString()
  const body = order.delivery_method === 'pickup'
    ? `Order #${order.number} was collected.`
    : `Order #${order.number} has shipped with ${carrier}${tracking ? `. Tracking number: ${tracking}` : ''}${url ? `. Track it: ${url}` : ''}.`
  const message = messageQueries({ conversationId: order.conversation_id, authorKind: 'member', authorUserId: input.actorId, channel: 'web', body, dedupeKey: `order:${order.id}:fulfilled`, occurredAt: now })
  await executeBatch(db, [
    { query: `UPDATE orders SET carrier = ?, tracking_number = ?, tracking_url = ?, fulfilled_at = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'paid' AND fulfilled_at IS NULL`,
      params: [carrier, tracking, url, now, now, input.organizationId, order.id] },
    assertBookingBatchWrite({ query: 'changes() = 1', params: [] }),
    { query: `UPDATE tasks SET status = 'done', closed_at = ?, closed_by_user_id = ?, version = version + 1, updated_at = ? WHERE dedupe_key = ? AND status = 'open'`,
      params: [now, input.actorId, now, `order_fulfillment:${order.id}`] },
    ...message.queries,
  ], { operation: 'Fulfill order' })
  await publishEvent(env, { type: 'order.fulfilled', organization_id: input.organizationId, order_id: order.id })
  const saved = await readOrder(db, input.organizationId, { orderId: order.id })
  if (!saved?.fulfilled_at) throw new Error('Fulfilled order was not read back')
  return saved
}

export async function listOrders(db: DbClient, organizationId: string, open = false): Promise<OrderRecord[]> {
  const plan = orderRecordQuery(organizationId, { open })
  return (await queryAll(db, plan.query, plan.params)).map(orderRecordFromRow).filter((order): order is OrderRecord => order !== null)
}
