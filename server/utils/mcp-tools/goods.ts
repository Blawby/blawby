import { deleteShippingZone, fulfillOrder, listOrders, listShippingZones, readInventoryLevels, readOrder, saveShippingZone, setInventoryLevels, setLocationPickup } from '~/server/domain/goods'
import { assertOrganizationWideAccess, assertProductAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { organizationTool, type McpToolDefinition } from './shared'
import { NOT_HANDLED, requiredString, type McpExecutorContext } from './execution'

const text = { type: 'string' }, nullableText = { type: ['string', 'null'] }, nullableInteger = { type: ['integer', 'null'] }
const level = { type: 'object', properties: { product_variant_id: text, location_id: text, available: { type: 'integer' }, updated_at: text }, required: ['product_variant_id', 'location_id', 'available', 'updated_at'] }
const rateWrite = { type: 'object', properties: {
  name: { ...text, minLength: 1, maxLength: 100, description: 'What the buyer chooses, such as Thailand Post EMS.' },
  amount: { type: 'integer', minimum: 0, description: 'In the currency’s smallest unit, in the business currency.' },
  min_weight_grams: { ...nullableInteger, description: 'The parcel weight band this rate covers: at least this many grams.' },
  max_weight_grams: { ...nullableInteger, description: 'Less than this many grams.' },
  min_subtotal: { ...nullableInteger, description: 'Offered only for orders of at least this subtotal (free shipping over an amount).' },
  delivery_days_min: nullableInteger, delivery_days_max: nullableInteger,
}, required: ['name', 'amount'], additionalProperties: false }
const rate = { type: 'object', properties: { ...rateWrite.properties, id: text, currency: text }, required: ['id', 'name', 'currency', 'amount', 'min_weight_grams', 'max_weight_grams', 'min_subtotal', 'delivery_days_min', 'delivery_days_max'] }
const zone = { type: 'object', properties: { id: text, location_id: text, name: text, countries: { type: 'array', items: text }, rates: { type: 'array', items: rate } }, required: ['id', 'location_id', 'name', 'countries', 'rates'] }
const zoneWrite = {
  location_id: { ...text, minLength: 1, description: 'The location it ships from.' },
  name: { ...text, minLength: 1, maxLength: 100 },
  countries: { type: 'array', minItems: 1, maxItems: 250, items: { ...text, pattern: '^[A-Za-z]{2}$' }, description: 'ISO 3166-1 alpha-2 destination countries. A country is in one zone per location.' },
  rates: { type: 'array', maxItems: 20, items: rateWrite, description: 'The complete list of rates; it replaces the zone’s rates.' },
}
const line = { type: 'object', properties: { id: text, product_id: text, product_variant_id: text, title: text, variant_title: nullableText, sku: nullableText, quantity: { type: 'integer' }, unit_amount: { type: 'integer' }, made_to_order_quantity: { type: 'integer' } },
  required: ['id', 'product_id', 'product_variant_id', 'title', 'variant_title', 'sku', 'quantity', 'unit_amount', 'made_to_order_quantity'] }
const order = { type: 'object', properties: {
  id: text, number: { type: 'integer' }, status: { type: 'string', enum: ['paid', 'cancelled'] }, conversation_id: nullableText, location_id: text, location_title: text,
  delivery_method: { type: 'string', enum: ['shipping', 'pickup'] }, shipping_details: { type: ['object', 'null'] }, shipping_rate_name: nullableText, shipping_amount: { type: 'integer' },
  currency: text, subtotal_amount: { type: 'integer' }, ship_by: nullableText, carrier: nullableText, tracking_number: nullableText, tracking_url: nullableText,
  fulfilled_at: nullableText, paid_at: nullableText, created_at: text, guest: { type: ['object', 'null'] }, payment: { type: ['object', 'null'] }, lines: { type: 'array', items: line },
}, required: ['id', 'number', 'status', 'conversation_id', 'location_id', 'delivery_method', 'currency', 'subtotal_amount', 'ship_by', 'fulfilled_at', 'lines'] }

export const GOODS_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'get_inventory', domain: 'goods', minimumRole: 'member', description: 'Read the stock counts of a physical item’s variants at each location that offers it. A variant counts stock only when inventory_tracked; with inventory_policy continue it keeps selling past zero and is made to order.',
    inputSchema: { product_id: { ...text, minLength: 1 } }, required: ['product_id'],
    outputSchema: { type: 'object', properties: { levels: { type: 'array', items: level } }, required: ['levels'] } }),
  organizationTool({ name: 'set_inventory', domain: 'goods', minimumRole: 'member', description: 'Set how many of each variant of a physical item are available at a location (a count, not an adjustment). Orders take stock when they are paid.',
    inputSchema: { product_id: { ...text, minLength: 1 }, levels: { type: 'array', minItems: 1, maxItems: 300, items: { type: 'object', properties: { product_variant_id: { ...text, minLength: 1 }, location_id: { ...text, minLength: 1 }, available: { type: 'integer' } }, required: ['product_variant_id', 'location_id', 'available'], additionalProperties: false } } },
    required: ['product_id', 'levels'],
    outputSchema: { type: 'object', properties: { levels: { type: 'array', items: level } }, required: ['levels'] } }),
  organizationTool({ name: 'list_shipping_zones', domain: 'goods', minimumRole: 'admin', description: 'List where physical items ship: each zone is a set of destination countries served from one location, with the rates buyers choose from.',
    outputSchema: { type: 'object', properties: { zones: { type: 'array', items: zone } }, required: ['zones'] } }),
  organizationTool({ name: 'save_shipping_zone', domain: 'goods', minimumRole: 'admin', description: 'Create a shipping zone, or replace one by shipping_zone_id: its countries and its complete list of rates, in the business currency.',
    inputSchema: { shipping_zone_id: { ...text, minLength: 1, description: 'Omit to create a zone.' }, ...zoneWrite }, required: ['location_id', 'name', 'countries', 'rates'],
    outputSchema: { type: 'object', properties: { zone }, required: ['zone'] } }),
  organizationTool({ name: 'delete_shipping_zone', domain: 'goods', minimumRole: 'admin', description: 'Delete a shipping zone and its rates. Buyers in its countries can no longer have items shipped from that location.',
    inputSchema: { shipping_zone_id: { ...text, minLength: 1 } }, required: ['shipping_zone_id'],
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] } }),
  organizationTool({ name: 'set_pickup', domain: 'goods', minimumRole: 'admin', description: 'Turn free pickup of physical-item orders at a location on or off.',
    inputSchema: { location_id: { ...text, minLength: 1 }, pickup_enabled: { type: 'boolean' } }, required: ['location_id', 'pickup_enabled'],
    outputSchema: { type: 'object', properties: { success: { type: 'boolean' } }, required: ['success'] } }),
  organizationTool({ name: 'list_orders', domain: 'goods', minimumRole: 'admin', description: 'List paid orders of physical items, newest first, with what to send, where and by when. open keeps those not yet shipped or collected. Talk to the buyer in the order’s conversation_id with send_message.',
    inputSchema: { open: { type: 'boolean' }, conversation_id: { ...text, minLength: 1, description: 'Read the one order a conversation is about.' } },
    outputSchema: { type: 'object', properties: { orders: { type: 'array', items: order } }, required: ['orders'] } }),
  organizationTool({ name: 'fulfill_order', domain: 'goods', minimumRole: 'admin', description: 'Mark a paid order shipped, with its carrier and tracking, or collected (pickup, no tracking). Closes its fulfilment task, posts it in the order’s conversation and emails the buyer.',
    inputSchema: { order_id: { ...text, minLength: 1 }, carrier: { ...text, maxLength: 100 }, tracking_number: { ...text, maxLength: 100 }, tracking_url: { ...text, maxLength: 500, pattern: '^https://\\S+$' } }, required: ['order_id'],
    outputSchema: { type: 'object', properties: { order }, required: ['order'] } }),
]

export async function handleGoodsTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  if (!GOODS_TOOLS.some(tool => tool.name === toolName)) return NOT_HANDLED
  const { db, env } = organization
  const principal = memberAccessPrincipal(organization.membership, { env, event: ctx.event })
  const organizationId = organization.organizationId
  switch (toolName) {
    case 'get_inventory': {
      const productId = requiredString(args, 'product_id')
      await assertProductAccess(db, { ...principal, productId })
      return { levels: await readInventoryLevels(db, organizationId, productId) }
    }
    case 'set_inventory': {
      const productId = requiredString(args, 'product_id')
      await assertProductAccess(db, { ...principal, productId, patch: args })
      return { levels: await setInventoryLevels(db, { organizationId, productId, actorId: principal.userId, levels: args.levels as never }) }
    }
    default: break
  }
  await assertOrganizationWideAccess(db, principal)
  switch (toolName) {
    case 'list_shipping_zones': return { zones: await listShippingZones(db, organizationId) }
    case 'save_shipping_zone': return { zone: await saveShippingZone(db, organizationId, typeof args.shipping_zone_id === 'string' ? args.shipping_zone_id : null, args) }
    case 'delete_shipping_zone': await deleteShippingZone(db, organizationId, requiredString(args, 'shipping_zone_id')); return { success: true }
    case 'set_pickup': await setLocationPickup(db, organizationId, requiredString(args, 'location_id'), args.pickup_enabled as boolean); return { success: true }
    case 'list_orders': {
      if (typeof args.conversation_id === 'string') {
        const found = await readOrder(db, organizationId, { conversationId: args.conversation_id })
        return { orders: found && found.status !== 'pending' && found.status !== 'released' ? [found] : [] }
      }
      return { orders: await listOrders(db, organizationId, args.open === true) }
    }
    case 'fulfill_order': return { order: await fulfillOrder(db, env, { organizationId, orderId: requiredString(args, 'order_id'), actorId: principal.userId, carrier: args.carrier, tracking_number: args.tracking_number, tracking_url: args.tracking_url }) }
    default: return NOT_HANDLED
  }
}
