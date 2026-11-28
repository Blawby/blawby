import type { H3Event } from 'nitro'
import {
  dashboardOrgQueryParam,
  getDashboardMemberContext,
  prepareDashboardLocations,
  type DashboardOrganizationRow,
} from '~/server/utils/dashboard-context'
import { HTTPError } from 'nitro'
import { placesPresenceQuery } from '~/server/domain/places'
import { stayHomeMemberScope } from '~/server/domain/stays'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import type { CalendarCapabilities } from '~/shared/bookings'
import { executeBatch, type BatchQuery } from '~/server/db'
import { prepareOrganizationPlan } from '~/server/utils/billing-access'
import { organizationFeaturesFromRow, organizationFeaturesQuery } from '~/server/utils/cms-capabilities'
import { recordRequestPhase } from '~/server/utils/request-metrics'
import { oncePerRequest } from '~/server/utils/request-scope'
import { hasUnreadQuery, presentHasUnread } from '~/server/domain/guest-threads/repository'
import type { DashboardWorkspaceLink } from '~/composables/useDashboardOrganization'

/** Calendar applicability is read from the same accessible homes and sessions as its views. */
export function prepareCalendarCapabilities(organization: BatchQuery, userId: string | { sql: string }) {
  const user = typeof userId === 'string' ? { sql: '?', params: [userId] } : { ...userId, params: [] }
  const source = { query: 'workspace.id', params: [] }
  const places = placesPresenceQuery(source, { sql: 'membership.userId' })
  const sessions = placesPresenceQuery(source, { sql: 'membership.userId' }, 'offering')
  const manages = roleMatchesSql('membership.role', rolesAllowing({ operations: ['update'] }))
  const opens = roleMatchesSql('membership.role', [...rolesAllowing({ operations: ['update'] }), ...rolesAllowing({ operations: ['assigned'] }), ...rolesAllowing({ operations: ['listing_calendar'] })])
  const catalog = roleMatchesSql('membership.role', [...rolesAllowing({ products: ['read'] }), ...rolesAllowing({ products: ['assigned'] })])
  const query: BatchQuery = { query: `SELECT json_object('can_open', ${opens}, 'manages', ${manages}, 'vertical', workspace.vertical,
      'has_homes', EXISTS (SELECT 1 FROM product_stay_configs home WHERE home.organization_id = workspace.id
        AND (${manages} OR ${stayHomeMemberScope('home', 'membership.id', 'membership.role')})),
      'has_sessions', (${catalog} AND (${sessions.query})), 'has_places', (${places.query})) AS calendar_json
    FROM organization workspace JOIN member membership ON membership.organizationId = workspace.id AND membership.userId = ${user.sql}
    WHERE workspace.id = ${organization.query}`, params: [...sessions.params ?? [], ...places.params ?? [], ...user.params, ...organization.params ?? []] }
  return { query, read(result: D1Result) { return decode((result.results[0] as { calendar_json: string } | undefined)?.calendar_json) }, decode }

  function decode(json: unknown): CalendarCapabilities {
    if (typeof json !== 'string') throw new HTTPError({ statusCode: 404, message: 'Calendar workspace not found', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'calendar' } })
    const row = JSON.parse(json) as { can_open: number; manages: number; vertical: string; has_homes: number; has_sessions: number; has_places: number }
    const modes: CalendarCapabilities['modes'] = []
    if (row.can_open === 1) {
      modes.push({ id: 'bookings', label: 'Bookings', symbol: 'calendar', search_prompt: 'Search bookings' })
      if (row.has_sessions === 1) modes.push({ id: 'availability', label: 'Availability', symbol: 'calendar.badge.clock', search_prompt: 'Search bookings' })
      if (row.has_homes === 1 || row.vertical === 'lodging' && row.manages === 1) modes.push(
        { id: 'all_homes', label: 'All homes', symbol: 'calendar.day.timeline.leading', search_prompt: 'Search listings' },
        { id: 'homes', label: 'Homes', symbol: 'list.bullet', search_prompt: 'Search homes or bookings' },
      )
    }
    return { modes, default_mode: modes.some(mode => mode.id === 'all_homes') ? 'all_homes' : modes.length ? 'bookings' : null,
      can_create_stay: row.manages === 1 && row.has_homes === 1, has_homes: row.has_homes === 1, has_places: row.has_places === 1 }
  }
}

export function readDashboardWorkspaceAccess(
  event: H3Event,
  { db, organization }: Pick<Awaited<ReturnType<typeof getDashboardMemberContext>>, 'db' | 'env' | 'organization'>,
  includeLocations = Boolean(event.context.dashboardDocumentProvider),
  preloaded?: Awaited<ReturnType<ReturnType<typeof prepareDashboardWorkspaceAccess>['read']>>,
) {
  return oncePerRequest(event, `dashboard-workspace-access:${organization.id}:${includeLocations}`, async () => {
    if (preloaded) return preloaded
    const plan = prepareDashboardWorkspaceAccess(organization.id, organization.userId, includeLocations)
    return plan.read(await executeBatch(db, plan.queries, { operation: 'Read dashboard workspace access' }), organization.id)
  })
}

export function prepareDashboardWorkspaceAccess(organizationId: string | { sql: string }, userId: string | { sql: string }, includeLocations: boolean) {
  const plan = prepareOrganizationPlan(organizationId)
  const user = typeof userId === 'string' ? '?' : userId.sql
  const calendar = prepareCalendarCapabilities({ query: typeof organizationId === 'string' ? '?' : organizationId.sql, params: typeof organizationId === 'string' ? [organizationId] : [] }, userId)
  const locations = includeLocations ? prepareDashboardLocations(organizationId, undefined, false, true) : null
  return {
    queries: [
      plan.query,
      organizationFeaturesQuery(organizationId),
      ...(locations ? [
        hasUnreadQuery(organizationId, userId, new Date()),
        { query: `SELECT o.id, o.name, o.slug FROM member m JOIN organization o ON o.id = m.organizationId
          WHERE m.userId = ${user} ORDER BY o.name, o.id`, params: typeof userId === 'string' ? [userId] : [] },
        ...locations.queries,
      ] : []),
      calendar.query,
    ],
    read(results: D1Result[], resolvedId: string) {
      const [subscription, featureRows, unread, workspaces, ...locationRows] = results.slice(0, -1)
      return {
        calendar: calendar.read(results.at(-1)!),
        effective_plan: plan.read(subscription!, resolvedId),
        features: organizationFeaturesFromRow(featureRows!.results[0] as Parameters<typeof organizationFeaturesFromRow>[0]),
        locationData: locations?.read(locationRows, resolvedId),
        has_unread: locations ? presentHasUnread(unread) : undefined,
        workspaces: workspaces?.results as DashboardWorkspaceLink[] | undefined,
      }
    },
  }
}

// The scope is the route's `org` query param. No organization is a 400 and one
// this session cannot see is a 404 (getDashboardContext). Neither is a payload
// with nulls in it: the dashboard rendered that payload as "not found" on the
// client while the server had logged a 200.
//
// There is no second `site` scope beside the organization any more, so there is
// no switcher to draw and no list to load: the organization is the tenant.
export async function loadDashboardContext(
  event: H3Event,
  scope: { orgSlug: string | null } = { orgSlug: dashboardOrgQueryParam(event) },
) {
  const contextStartedAt = performance.now()
  const context = await getDashboardMemberContext(event, {
    organizationSlug: scope.orgSlug,
  })
  const { organization } = context
  recordRequestPhase(event, 'context', contextStartedAt)

  const resourcesStartedAt = performance.now()
  const access = await readDashboardWorkspaceAccess(event, context, true)
  recordRequestPhase(event, 'resources', resourcesStartedAt)
  return presentDashboardContext(organization, access)
}

export function presentDashboardContext(
  organization: DashboardOrganizationRow,
  { effective_plan, features, calendar, locationData, has_unread, workspaces }: Awaited<ReturnType<typeof readDashboardWorkspaceAccess>>,
) {
  const { locations, media } = locationData!
  const { memberId, ...business } = organization
  return {
    success: true as const,
    organization: { ...business, effective_plan, media, features, calendar, member_id: memberId },
    locations,
    has_unread,
    workspaces,
  }
}
