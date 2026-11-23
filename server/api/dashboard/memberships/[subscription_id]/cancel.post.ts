import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'
import { authorizePayments } from '~/server/domain/payments'
import { cancelMembership } from '~/server/domain/memberships'

/** The business ends a membership: at the end of the paid period, or now. */
export default defineHandler(async event => {
  const subscriptionId = getRouterParam(event, 'subscription_id')
  if (!subscriptionId) throw new HTTPError({ statusCode: 404, statusMessage: 'Membership not found' })
  requireFinancialBrowserOrAppRequest(event)
  const { db, env, organization, userId } = await getDashboardContext(event, {})
  await authorizePayments({ organizationId: organization.id, userId, role: organization.role }, 'refund')
  const { when } = await readRequiredBody<{ when?: unknown }>(event)
  return jsonResponse({ membership: await cancelMembership(db, env, organization.id, subscriptionId, when) })
})
