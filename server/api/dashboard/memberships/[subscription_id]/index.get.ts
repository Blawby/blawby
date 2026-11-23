import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { jsonResponse } from '~/server/utils/api-response'
import { authorizePayments } from '~/server/domain/payments'
import { readOrganizationMembership } from '~/server/domain/memberships'

/** One member's membership, as Stripe has it now, with the payments it made. */
export default defineHandler(async event => {
  const subscriptionId = getRouterParam(event, 'subscription_id')
  if (!subscriptionId) throw new HTTPError({ statusCode: 404, statusMessage: 'Membership not found' })
  const { db, env, organization, userId } = await getDashboardContext(event, {})
  await authorizePayments({ organizationId: organization.id, userId, role: organization.role }, 'read')
  return jsonResponse({ membership: await readOrganizationMembership(db, env, organization.id, subscriptionId) }, { headers: { 'cache-control': 'private, no-store' } })
})
