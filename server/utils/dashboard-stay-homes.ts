import { prepareCalendarCapabilities } from '~/server/utils/dashboard-context-service'
import { ChannexConnection, prepareChannexStatus } from '~/server/integrations/channex/channel-connection'
import type { CloudflareEnv } from '~/server/utils/auth'
import { HTTPError } from 'nitro'
import { dashboardOrgQueryParam } from '~/server/utils/dashboard-context'
import type { H3Event } from 'nitro'
import { readDashboardMemberResources, type DashboardOrganizationRow } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { prepareStayHomesDocument, stayAccessFor } from '~/server/domain/stays'

import { prepareOrganizationPlan } from '~/server/utils/billing-access'
import { getPlanEntitlements } from '~/server/utils/billing-entitlements'
import { productEditorPath } from '~/server/utils/dashboard-links'
import { prepareStayHomeSetupDraft } from '~/server/utils/stay-home-setup-draft'

// The places to stay this caller may see, with their stay rules and base price.
export async function readDashboardStayHomes(event: H3Event, orgSlug?: string, calendar = false) {
  const plan = prepareDashboardStayHomes(calendar)
  const slug = orgSlug ?? dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Choose a workspace', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const { env, organization, userId, rows } = await readDashboardMemberResources(event, { slug }, plan.queries)
  await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  return plan.read(rows, organization, { env, userId })
}

export function prepareDashboardStayHomes(calendar = false) {
  const homes = prepareStayHomesDocument(null)
  const draft = prepareStayHomeSetupDraft({ sql: BATCH_VIEWER.organization }, { sql: BATCH_VIEWER.member })
  const connection = calendar ? prepareChannexStatus({ sql: BATCH_VIEWER.organization }) : null
  const capabilities = calendar ? prepareCalendarCapabilities({ query: BATCH_VIEWER.organization, params: [] }, { sql: BATCH_VIEWER.user }) : null
  const plan = prepareOrganizationPlan({ sql: BATCH_VIEWER.organization })
  return { queries: [...homes.queries, ...calendar ? [...connection!.queries, capabilities!.query] : [draft.query, plan.query]], async read(rows: D1Result[], organization: DashboardOrganizationRow, context?: { env: CloudflareEnv; userId: string }) {
    const manage = await roleAllows({ ...organization, permissions: { operations: ['update'] } })
    const values = homes.read(rows.slice(0, homes.queries.length))
    if (calendar) {
      let airbnb = null
      if (manage && organization.vertical === 'lodging' && !values.length) {
        if (!context) throw new Error('The empty homes calendar requires its provider context')
        airbnb = await new ChannexConnection(context.env.DB, context.env, organization.id, context.userId).status(connection!.read(rows.slice(homes.queries.length, -1)))
      }
      return { calendar: capabilities!.read(rows.at(-1)!), homes: values, manage, airbnb, first_home_setup: null, resume_home_setup: null }
    }
    return stayHomeSetup(organization, values, manage, manage ? draft.read(rows[homes.queries.length]!) : null,
      manage && getPlanEntitlements(plan.read(rows[homes.queries.length + 1]!, organization.id)).channel_sync === true)
  } }
}

function stayHomeSetup(organization: DashboardOrganizationRow, homes: import('~/server/domain/stays').StayHome[], manage: boolean,
  draft: ReturnType<ReturnType<typeof prepareStayHomeSetupDraft>['read']>, canConnect: boolean) {
  const needsFirstHome = manage && organization.vertical === 'lodging' && organization.onboarding_status === 'active' && homes.length === 0
  const manualSetupTo = `${productEditorPath(organization.slug, 'new')}?kind=stay&setup=guided`
  const resume_home_setup = draft ? { label: 'Continue your listing', detail: 'Pick up where you left off.', to: manualSetupTo } : null
  const first_home_setup = needsFirstHome
    ? {
        title: 'How would you like to add a home?',
        manual: resume_home_setup ?? {
          label: 'Add your first home',
          detail: 'Start with the location and listing details.',
          to: manualSetupTo,
        },
        airbnb: {
          label: 'Import from Airbnb',
          detail: canConnect ? 'Choose the listings to bring over.' : 'Choose the listings to bring over. Airbnb sync requires Business.',
          to: `/dashboard/${encodeURIComponent(organization.slug)}/integrations/airbnb`,
          can_connect: canConnect,
        },
      }
    : null
  return { homes, manage, first_home_setup, resume_home_setup }
}
