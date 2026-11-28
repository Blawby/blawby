import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { prepareSettingsPayload, prepareWebsiteSettings } from '~/server/utils/organization-settings'
import { readDashboardConnections } from '~/server/utils/dashboard-connections'
import { BATCH_VIEWER, assertOrganizationWideAccess, memberAccessPrincipal } from '~/server/utils/member-access'

export default defineHandler(async event => {
  const query = getQuery(event)
  if (query.connections === '1') return jsonResponse(await readDashboardConnections(event))
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Choose a workspace', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const env = cloudflareEnv(event)
  const plan = query.view === 'website' ? prepareWebsiteSettings({ sql: BATCH_VIEWER.organization }, env) : prepareSettingsPayload({ sql: BATCH_VIEWER.organization }, env)
  const { db, organization, rows } = await readDashboardMemberResources(event, { slug }, plan.queries)
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  const result = plan.read(rows)
  return jsonResponse(query.view === 'website' ? result : { success: true, settings: result })
})
