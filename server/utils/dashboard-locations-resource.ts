
import type { H3Event } from 'nitro'
import { HTTPError } from 'nitro'
import { ownerPicturesFromRows } from '~/server/notifications/hero'
import { dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { parsePostalAddress } from '~/utils/postal-address'
import type { StayMapSharing } from '~/shared/stay-listing'

export interface DashboardLocationResource {
  id: string
  slug: string
  title: string
  stay_map_sharing: StayMapSharing
  status: string
  address: string | null | Record<string, unknown>
  phone: string | null
  email: string | null
}

export async function listDashboardLocationsResource(
  event: H3Event,
  scope: { organizationSlug?: string } = {},
) {
  const slug = scope.organizationSlug ?? dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Choose a workspace', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const plan = prepareDashboardLocationsResource({ sql: BATCH_VIEWER.organization })
  const { db, env, organization, rows } = await readDashboardMemberResources(event, { slug }, plan.queries)
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  return plan.read(rows, organization.id)
}

export function prepareDashboardLocationsResource(organization: string | { sql: string }) {
  const selection = `FROM business_locations WHERE organization_id = ${typeof organization === 'string' ? '?' : organization.sql}`
  const params = typeof organization === 'string' ? [organization] : []
  return { queries: [
    { query: `SELECT id, slug, title, status, address, stay_map_sharing, phone, email ${selection} ORDER BY title ASC`, params },
    mediaPlacementsQuery({ organizationId: organization, ownerType: 'business_location', owners: { sql: `SELECT id ${selection}`, params }, includeOrganizationFallback: true }),
  ], read([places, media]: D1Result[], organizationId: string) {
    const locations = places!.results as unknown as DashboardLocationResource[]
    const pictures = ownerPicturesFromRows(organizationId, 'business_location', locations.map(row => row.id), media!.results)
    return { success: true as const, locations: locations.map(location => ({
      ...location, address: parsePostalAddress(location.address), image_url: pictures.get(location.id)?.imageUrl ?? null,
    })) }
  } }
}
