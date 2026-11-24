import { ChannexConnection } from '~/server/integrations/channex/channel-connection'
import { readAirbnbSync, requestAirbnbSync } from '~/server/integrations/channex/airbnb-sync'
import { DETAIL_FIELDS, IMPORT_STAGES } from '~/shared/airbnb-import'
import { organizationTool, type McpToolDefinition } from './shared'
import { NOT_HANDLED, requiredString, type McpExecutorContext } from './execution'

const text = { type: 'string' }, nullableText = { type: ['string', 'null'] }
const id = { type: 'string', minLength: 1 }
const stage = { type: 'string', enum: [...IMPORT_STAGES] }
const listing = { type: 'object', properties: {
  id: text, channel_id: { ...text, description: 'The connected Airbnb account the listing is on.' }, title: text, city: text, country_code: text,
  import: { type: 'object', description: 'not_imported, or the home it syncs with: product_id, its stage and whether it syncs now.', properties: {
    status: { type: 'string', enum: ['not_imported', 'imported'] }, product_id: text, stage, syncing: { type: 'boolean' }, content: { type: ['object', 'null'] },
  }, required: ['status'] },
}, required: ['id', 'channel_id', 'title', 'city', 'country_code', 'import'] }
const job = { type: 'object', properties: {
  listing_id: text, product_id: nullableText, action: { type: 'string', enum: ['sync', 'stop'] },
  status: { type: 'string', enum: ['queued', 'running', 'done', 'failed'] }, stage: { anyOf: [stage, { type: 'null' }] },
  error: { anyOf: [{ type: 'object', properties: { code: text, message: text }, required: ['code', 'message'] }, { type: 'null' }] }, updated_at: text,
}, required: ['listing_id', 'product_id', 'action', 'status', 'stage', 'error', 'updated_at'] }

export const AIRBNB_TOOLS: McpToolDefinition[] = [
  organizationTool({
    name: 'list_airbnb_listings', domain: 'airbnb', minimumRole: 'admin',
    description: 'Read the listings on every connected Airbnb account, each with the home it syncs with (import.product_id), homes whose Airbnb listing has gone, and where each sync or stop asked for stands. Two listings of the same unit (a backup listing, even on a second Airbnb account) share one calendar when the backup is synced onto the primary listing’s home with sync_airbnb_listings. This tool makes no changes.',
    outputSchema: { type: 'object', properties: {
      listings: { type: 'array', items: listing },
      missing_listings: { type: 'array', items: { type: 'object', properties: { listing_id: text, product_id: text, internal_name: text }, required: ['listing_id', 'product_id', 'internal_name'] } },
      jobs: { type: 'array', items: job },
    }, required: ['listings', 'missing_listings', 'jobs'] },
  }),
  organizationTool({
    name: 'get_airbnb_listing', domain: 'airbnb', minimumRole: 'admin',
    description: 'Read one Airbnb listing’s details and missing_fields: the fields Airbnb left out that sync_airbnb_listings needs as details to import it as a new home. This tool makes no changes.',
    inputSchema: { listing_id: id }, required: ['listing_id'],
    outputSchema: { type: 'object', properties: {
      id: text, title: text, currency: text, max_guests: { type: 'integer' }, default_occupancy: { type: 'integer' }, nightly_rate: text, minimum_nights: { type: 'integer' },
      fields: { type: 'object' }, missing_fields: { type: 'array', items: { type: 'string', enum: [...DETAIL_FIELDS] } },
      check_in_time: nullableText, check_in_end_time: nullableText, check_out_time: nullableText,
    }, required: ['id', 'title', 'currency', 'max_guests', 'default_occupancy', 'nightly_rate', 'minimum_nights', 'fields', 'missing_fields'] },
  }),
  organizationTool({
    name: 'sync_airbnb_listings', domain: 'airbnb', minimumRole: 'admin',
    description: 'Start or stop syncing Airbnb listings; the work runs in the background and list_airbnb_listings reports each listing’s progress. Each sync item imports the listing as a new home (details: the missing_fields from get_airbnb_listing) or, with product_id, puts it on an existing home that already syncs so both listings share that home’s calendar, price and stay rules; a listing that already has its own home is merged into the chosen one, its bookings and conversations moving with it. stop takes homes, stop_listing_ids takes single listings; a stopped listing keeps its home and its reservations stay on that calendar. Syncing needs the Business plan.',
    inputSchema: {
      sync: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        listing_id: id,
        product_id: { ...id, description: 'An existing home from list_airbnb_listings import.product_id or list_stay_homes. Leave out to import a new home.' },
        details: { type: 'object', description: 'Only the missing_fields get_airbnb_listing reports, each as text. Not with product_id.', additionalProperties: { type: 'string', minLength: 1 } },
      }, required: ['listing_id'] } },
      stop: { type: 'array', items: id, description: 'Homes (product ids) whose Airbnb listings stop syncing.' },
      stop_listing_ids: { type: 'array', items: id, description: 'Airbnb listings that stop syncing.' },
    },
    outputSchema: { type: 'object', properties: { listings: { type: 'array', items: job } }, required: ['listings'] },
  }),
]

export async function handleAirbnbTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  const { env, organizationId, userId } = organization
  const connection = () => new ChannexConnection(env.DB, env, organizationId, userId)
  switch (toolName) {
    case 'list_airbnb_listings': {
      const [inventory, jobs] = await Promise.all([connection().listings(), readAirbnbSync(env.DB, organizationId)])
      return { ...inventory, jobs }
    }
    case 'get_airbnb_listing': return await connection().details(requiredString(args, 'listing_id'))
    case 'sync_airbnb_listings': return { listings: await requestAirbnbSync(env, env.DB, organizationId, userId, { sync: args.sync, stop: args.stop, stop_listing_ids: args.stop_listing_ids }) }
    default: return NOT_HANDLED
  }
}
