import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { jsonResponse } from '~/server/utils/api-response'
import { dashboardOrgQueryParam, readDashboardMemberResources } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assertOrganizationWideAccess, assertRoleAllows, memberAccessPrincipal, roleAllows } from '~/server/utils/member-access'
import { prepareServices, managedAdsRequirementsFrom } from '~/server/utils/organization-services'
import { strategyFromSubscription } from '~/server/utils/strategy-service'
import { getStripe, prepareOrganizationBillingScreen } from '~/server/utils/billing'
import { integrationsQuery, integrationsFromRows } from '~/server/utils/organization-integrations'
import { SERVICES as offers, billingServiceScreen } from '~/shared/billing-model'

/** Services, eligibility and the next permitted step share the screen's authorized read. */
export default defineHandler(async event => {
  const query = getQuery(event)
  const requested = query.requirements
  if (requested !== undefined && requested !== 'managed_ads' && requested !== 'strategy') throw new HTTPError({ statusCode: 422, message: 'Unknown service requirements', data: { code: 'INVALID_QUERY', field: 'requirements' } })
  if (query.view !== undefined && query.view !== 'screen') throw new HTTPError({ statusCode: 400, message: 'Choose a valid service view', data: { code: 'INVALID_QUERY', field: 'view' } })
  if (query.view === 'screen' && !requested) throw new HTTPError({ statusCode: 400, message: 'Choose a service', data: { code: 'INVALID_QUERY', field: 'requirements' } })
  const slug = dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Choose a workspace', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const plan = prepareOrganizationBillingScreen({ sql: BATCH_VIEWER.organization })
  const integrations = integrationsQuery({ sql: BATCH_VIEWER.organization })
  const { db, env, organization, rows } = await readDashboardMemberResources(event, { slug }, [...plan.queries, integrations])
  await assertOrganizationWideAccess(db, memberAccessPrincipal(organization, { env, event }))
  await assertRoleAllows({ ...organization, permissions: { billing: ['read'] } })
  try {
    const billingRows = rows.slice(0, plan.queries.length)
    const status = plan.status(billingRows, organization.id)
    const subscription = status.stripeSubscriptionId ? await getStripe(env, db).subscriptions.retrieve(status.stripeSubscriptionId, { expand: ['items.data.price.product', 'items.data.price.tiers'] }) : null
    const serviceRows = plan.services(billingRows)
    const agreements = prepareServices(organization.id).read(serviceRows)
    const strategy = strategyFromSubscription(subscription, serviceRows.some(row => row.service as string === 'strategy'))
    const services = { ...agreements, strategy }
    const requirements = requested === 'managed_ads' ? await managedAdsRequirementsFrom(env, status, subscription,
      integrationsFromRows(rows.at(-1)!.results).find(row => row.provider === 'google_ads') ?? null)
      : requested === 'strategy' ? { paid_plan: Boolean(status.stripeSubscriptionId && ['active', 'trialing'].includes(status.status ?? '')) } : null
    const can_update = await roleAllows({ ...organization, permissions: { billing: ['update'] } })
    const screen = query.view === 'screen' && requested && requirements ? billingServiceScreen(requested, requirements, {
      on: Boolean(services[requested]), can_update, org_slug: organization.slug, subscription_status: status.status,
    }) : null
    const plan_review = screen?.next_action?.id === 'review_plan' ? await plan.read(billingRows, organization, env, useRuntimeConfig().app.buildId, subscription) : null
    return jsonResponse({ success: true, services, offers, ...(requested && requirements ? { requirements: { [requested]: requirements } } : {}),
      ...(screen ? { screen, plan_review, can_update } : {}),
    }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (cause) {
    if (cause instanceof HTTPError) throw cause
    throw new HTTPError({ statusCode: 502, message: 'Service status could not be read', data: { code: 'SERVICE_STATUS_UNAVAILABLE', field: 'services' }, cause })
  }
})
