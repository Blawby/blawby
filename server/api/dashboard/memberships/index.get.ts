import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { jsonResponse } from '~/server/utils/api-response'
import { authorizePayments } from '~/server/domain/payments'
import { organizationMemberships } from '~/server/domain/memberships'

/** The business's members, of one offering when product_id is given, as Stripe has them now. */
export default defineHandler(async event => {
  const query = getQuery(event)
  const { db, env, organization, userId } = await getDashboardContext(event, {})
  await authorizePayments({ organizationId: organization.id, userId, role: organization.role }, 'read')
  const productId = typeof query.product_id === 'string' && query.product_id ? query.product_id : null
  return jsonResponse({ memberships: await organizationMemberships(db, env, organization.id, productId) }, { headers: { 'cache-control': 'private, no-store' } })
})
