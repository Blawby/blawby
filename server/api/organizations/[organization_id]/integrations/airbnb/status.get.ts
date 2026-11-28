import { prepareMemberSchedulingList } from '~/server/domain/member-scheduling'
import { defineHandler } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'
import { prepareDashboardStayHomes } from '~/server/utils/dashboard-stay-homes'
import { ChannexConnection, prepareChannexStatus } from '~/server/integrations/channex/channel-connection'
import { prepareAirbnbSync } from '~/server/integrations/channex/airbnb-sync'

// The organization's Airbnb connection and how many listings it maps.
export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) return jsonResponse({ error: 'Organization ID is required' }, { status: 400 })
  const screen = getQuery(event).view === 'workspace'
  const plan = prepareChannexStatus({ sql: BATCH_VIEWER.organization })
  const jobs = prepareAirbnbSync({ sql: BATCH_VIEWER.organization })
  const homes = prepareDashboardStayHomes()
  const members = prepareMemberSchedulingList({ sql: BATCH_VIEWER.organization }, BATCH_VIEWER)
  const { env, session, organization, rows } = await readDashboardMemberResources(event, organizationId,
    [...plan.queries, ...screen ? [jobs.query, ...homes.queries, ...members.queries] : []])
  await assertOrganizationWideAccess(env.DB, memberAccessPrincipal(organization, { env, event }))
  const connection = new ChannexConnection(env.DB, env, organization.id, session.user.id)
  const context = plan.read(rows.slice(0, plan.queries.length))
  if (!screen) return jsonResponse(await connection.status(context))
  return jsonResponse({ ...await connection.workspace(context), jobs: jobs.read(rows[plan.queries.length]!.results),
    home_context: await homes.read(rows.slice(plan.queries.length + 1, plan.queries.length + 1 + homes.queries.length), organization),
    member_options: members.read(rows.slice(plan.queries.length + 1 + homes.queries.length)).members.map(member => ({ value: member.id, label: member.name })),
  })
})
