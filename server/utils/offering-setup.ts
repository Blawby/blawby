import { HTTPError } from 'nitro'
import type { OfferingSetupAnswer, OfferingSetupField, OfferingSetupResponse } from '~/shared/offering-setup'
import type { DbClient } from '~/server/db'
import type { CloudflareEnv } from '~/server/utils/auth'
import type { MemberAccessPrincipal } from '~/server/utils/member-access'
import { catalogPath } from '~/server/utils/dashboard-links'
import { creationDedupeKey, creationRecordOf } from '~/server/utils/organization-events'
import { prepareProductRead, PRODUCT_COLUMNS, prepareCollectionList, bookingScheduleScopesQuery, scheduleScopesFromRows, checkedOrganizationCurrency } from '~/server/utils/product-management'
import { prepareDashboardLocations } from '~/server/utils/dashboard-context'
import { prepareMemberSchedulingList } from '~/server/domain/member-scheduling'
import { BATCH_VIEWER } from '~/server/utils/member-access'
import { LOCATION_COLUMNS, locationFromRecord, type LocationRecord } from '~/server/utils/location-management'
import { groupMediaPlacements, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { availabilityRulesQuery, type ProductAvailabilityRule } from '~/server/utils/availability'
import { TIMEZONE_OPTIONS, timezoneLabel } from '~/utils/timezone'

export interface OfferingSetupContext {
  db: DbClient
  env: CloudflareEnv
  organizationId: string
  orgSlug: string
  actorId: string
  principal: MemberAccessPrincipal
  exitTo?: string
  read: ReturnType<ReturnType<typeof prepareOfferingSetup>['read']>
}

export const invalidOfferingAnswer = (message: string) => new HTTPError({ statusCode: 400, statusMessage: message, data: { code: 'INVALID_OFFERING_ANSWER' } })
export const offeringSetupChanged = () => new HTTPError({ statusCode: 409, statusMessage: 'Setup changed. Reopen it to continue.', data: { code: 'OFFERING_SETUP_CHANGED' } })
export const offeringToday = (orgSlug: string) => `/dashboard/${encodeURIComponent(orgSlug)}`

export function offeringDestination(orgSlug: string, kind: 'menu' | 'experience' | 'service', productId: string, locationId?: string): OfferingSetupResponse {
  return { to: `${catalogPath(orgSlug)}?kind=${kind}`, product_id: productId, ...(locationId ? { location_id: locationId } : {}) }
}

export function offeringScreen(input: {
  id: string
  title: string
  detail?: string
  fields: OfferingSetupField[]
  index: number
  total: number
  backTo: string
  exitTo: string
  revision?: string
}): OfferingSetupResponse {
  return {
    step: {
      id: input.id, title: input.title, ...(input.detail ? { detail: input.detail } : {}),
      fields: input.fields, position: input.index + 1, total: input.total,
      next_label: input.index + 1 === input.total ? 'Finish' : 'Next',
    },
    ...(input.revision ? { revision: input.revision } : {}),
    back_to: input.backTo, exit_to: input.exitTo, back_label: 'Back', exit_label: 'Save & exit',
  }
}

export function offeringField(key: string, label: string, kind: OfferingSetupField['kind'], value = '', properties: Partial<OfferingSetupField> = {}): OfferingSetupField {
  return { key, label, kind, value, ...properties }
}

export function currencySymbol(currency: string): string {
  const formatted = new Intl.NumberFormat('en', { style: 'currency', currency, currencyDisplay: 'narrowSymbol' })
  return formatted.formatToParts(0).find(part => part.type === 'currency')!.value
}

export function offeringTimezone(value = ''): OfferingSetupField {
  const choices = [...new Set([value, ...TIMEZONE_OPTIONS])].filter(Boolean)
    .map(zone => ({ value: zone, label: timezoneLabel(zone) }))
  return offeringField('timezone', 'Time zone', 'timezone', value, { choices })
}

export function submittedValue(answer: OfferingSetupAnswer, key: string): string {
  return answer.values[key]?.trim() ?? ''
}


/** Supporting facts for all first-offering guides, joined to the authenticated viewer's batch. */
export function prepareOfferingSetup() {
  const organization = { sql: BATCH_VIEWER.organization }
  const selection = `FROM products p WHERE p.organization_id=${BATCH_VIEWER.organization}
    AND p.kind=CASE (SELECT vertical FROM viewer) WHEN 'restaurant' THEN 'dish' WHEN 'experience' THEN 'experience' WHEN 'service' THEN 'service' END`
  const ids = { query: `SELECT p.id ${selection}` }
  const products = prepareProductRead(organization, { query: `SELECT ${PRODUCT_COLUMNS} ${selection} ORDER BY p.name, p.id` })
  const locations = prepareDashboardLocations(organization)
  const members = prepareMemberSchedulingList(organization, BATCH_VIEWER)
  const collections = prepareCollectionList({ organizationId: organization })
  const queries = [...products.queries, ...locations.queries, ...members.queries, ...collections.queries,
    { query: `SELECT id,payload_json FROM onboarding_drafts WHERE organization_id=${BATCH_VIEWER.organization} AND status='committed'` },
    { query: `SELECT dedupe_key,payload_json,EXISTS (SELECT 1 FROM products p WHERE p.organization_id=activity_entries.organization_id AND p.id=json_extract(activity_entries.payload_json,'$.entityId')) AS entity_exists FROM activity_entries WHERE organization_id=${BATCH_VIEWER.organization}
      AND substr(dedupe_key,1,length('create:product:' || ${BATCH_VIEWER.organization} || ':'))='create:product:' || ${BATCH_VIEWER.organization} || ':'` },
    mediaPlacementsQuery({ organizationId: organization, ownerType: 'product', owners: { sql: ids.query }, slot: 'image' }),
    { query: `SELECT ${LOCATION_COLUMNS} FROM business_locations WHERE organization_id=${BATCH_VIEWER.organization}` },
    mediaPlacementsQuery({ organizationId: organization, ownerType: 'business_location', owners: { sql: `SELECT id FROM business_locations WHERE organization_id=${BATCH_VIEWER.organization}` } }),
    { query: `SELECT DISTINCT product_id FROM product_sessions WHERE organization_id=${BATCH_VIEWER.organization} AND product_id IN (${ids.query})` },
    bookingScheduleScopesQuery(organization, ids), availabilityRulesQuery(organization, ids),
    { query: `SELECT organization_id,default_currency FROM viewer` },
  ]
  return { queries, read(rows: D1Result[]) {
    let offset = 0
    const take = (length: number) => { const result = rows.slice(offset, offset + length); offset += length; return result }
    const offerings = products.read(take(products.queries.length))
    const currencyRow = rows.at(-1)!.results[0] as { organization_id: string; default_currency: string }
    const { locations: places } = locations.read(take(locations.queries.length), currencyRow.organization_id)
    const { members: people } = members.read(take(members.queries.length))
    const sections = collections.read(take(collections.queries.length))
    const draft = take(1)[0]!.results[0] as { id: string; payload_json: string } | undefined
    const creations = new Map((take(1)[0]!.results as { dedupe_key: string; payload_json: string; entity_exists: number }[]).map(row => [row.dedupe_key, row]))
    const photos = groupMediaPlacements(take(1)[0]!.results)
    const placeRows = take(1)[0]!.results as unknown as LocationRecord[]
    const placeMedia = groupMediaPlacements(take(1)[0]!.results)
    const fullLocations = new Map(placeRows.map(row => [row.id, locationFromRecord(row, placeMedia.get(row.id) ?? [])]))
    const sessions = new Set((take(1)[0]!.results as { product_id: string }[]).map(row => row.product_id))
    const scopes = scheduleScopesFromRows(take(1)[0]!.results as { product_id: string; location_id: string | null }[])
    const rules = take(1)[0]!.results as unknown as ProductAvailabilityRule[]
    return { products: offerings, locations: places, members: people, collections: sections, draft, photos, fullLocations, sessions, scopes, rules,
      currency: checkedOrganizationCurrency(currencyRow.organization_id, currencyRow.default_currency),
      creation(baseKey: string) {
        let key = baseKey
        const visited = new Set<string>()
        for (;;) {
          if (visited.has(key)) throw new Error('Offering creation history contains a cycle')
          visited.add(key)
          const dedupeKey = creationDedupeKey('product', currencyRow.organization_id, key)
          const row = creations.get(dedupeKey)
          const record = creationRecordOf(row, dedupeKey)
          if (!record) return { key, productId: undefined }
          if (row!.entity_exists) return { key, productId: record.entityId }
          key = `${baseKey}:after:${record.entityId}`
        }
      },
      product(productId: string) {
        const product = offerings.find(row => row.id === productId)
        if (!product) throw new HTTPError({ statusCode: 404, message: 'Product not found', data: { code: 'PRODUCT_NOT_FOUND', field: 'product_id' } })
        return product
      },
    }
  } }
}
