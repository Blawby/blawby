import { billingPlanActions } from '~/shared/billing-model'
import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { BATCH_VIEWER, assertRoleAllows  } from '~/server/utils/member-access'
import { prepareOrganizationBillingScreen, getOrganizationBillingStatus, getOrganizationSubscriptionPrice, hasBillingUpdatePermission, scheduledPlanChange  } from '~/server/utils/billing'
import { readDashboardMemberResources, resolveRequestedOrganization } from '~/server/utils/dashboard-context'
import { getAuthSession } from '~/server/utils/auth'

/** The same organization plan and permitted choices for the dashboard and native account screen. */
export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) throw new HTTPError({ statusCode: 503, statusMessage: 'Billing storage is unavailable', data: { code: 'BILLING_UNAVAILABLE', field: 'database' } })
  const screenQuery = getQuery(event)
  if (screenQuery.view !== undefined && screenQuery.view !== 'screen') throw new HTTPError({ statusCode: 400, message: 'Choose a valid billing view', data: { code: 'INVALID_QUERY', field: 'view' } })
  if (screenQuery.view === 'screen') {
    if (typeof screenQuery.organization_id !== 'string' || !screenQuery.organization_id.trim()) throw new HTTPError({ statusCode: 400, message: 'Choose a workspace', data: { code: 'ORGANIZATION_REQUIRED', field: 'organization_id' } })
    const plan = prepareOrganizationBillingScreen({ sql: BATCH_VIEWER.organization })
    const { organization, rows } = await readDashboardMemberResources(event, screenQuery.organization_id, plan.queries)
    if (screenQuery.org !== undefined && screenQuery.org !== organization.slug) throw new HTTPError({ statusCode: 400, message: 'Organization context conflict', data: { code: 'ORGANIZATION_CONTEXT_CONFLICT', field: 'org' } })
    await assertRoleAllows({ ...organization, permissions: { billing: ['read'] } })
    try {
      return jsonResponse(await plan.read(rows, organization, env, useRuntimeConfig().app.buildId), { headers: { 'cache-control': 'private, no-store' } })
    } catch (cause) {
      if (cause instanceof HTTPError) throw cause
      throw new HTTPError({ statusCode: 502, message: 'Plan and billing could not be read', data: { code: 'BILLING_SCREEN_UNAVAILABLE', field: 'billing' }, cause })
    }
  }
  const session = await getAuthSession(event, env)
  if (!session?.user.id) throw new HTTPError({ statusCode: 401, statusMessage: 'Sign in to read billing', data: { code: 'AUTHENTICATION_REQUIRED', field: 'session' } })
  const query = getQuery(event)
  if (query.organization_id !== undefined && (typeof query.organization_id !== 'string' || !query.organization_id.trim())) throw new HTTPError({ statusCode: 422, statusMessage: 'A valid organization ID is required', data: { code: 'INVALID_QUERY', field: 'organization_id' } })
  if (query.include_price !== undefined && query.include_price !== 'true' && query.include_price !== 'false') throw new HTTPError({ statusCode: 422, statusMessage: 'include_price must be true or false', data: { code: 'INVALID_QUERY', field: 'include_price' } })
  const organization = await resolveRequestedOrganization(event, db, session.user.id, { explicitOrganizationId: typeof query.organization_id === 'string' ? query.organization_id : null })
  if (!organization) throw new HTTPError({ statusCode: 400, statusMessage: 'Choose a workspace to read billing', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { billing: ['read'] } })
  try {
    const status = await getOrganizationBillingStatus(env, db, organization.id)
    const can_update = await hasBillingUpdatePermission(organization.id, organization.role)
    const [subscription_price, scheduled_plan] = await Promise.all([
      getQuery(event).include_price === 'true' ? getOrganizationSubscriptionPrice(env, status) : undefined,
      status.stripeScheduleId ? scheduledPlanChange(env, status.stripeScheduleId) : null,
    ])
    return jsonResponse({ success: true, billing: {
      ...status, subscription_price, scheduled_plan, organization_id: organization.id,
      can_update, actions: billingPlanActions(status, scheduled_plan),
    }, user_role: organization.role }, { headers: { 'cache-control': 'private, no-store' } })
  } catch (cause) {
    if (cause instanceof HTTPError) throw cause
    throw new HTTPError({ statusCode: 502, statusMessage: 'The current subscription could not be read',
      data: { code: 'BILLING_SUBSCRIPTION_UNAVAILABLE', field: 'billing.subscription_price' }, cause })
  }
})
