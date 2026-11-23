import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { membershipCheckoutReturn } from '~/server/domain/memberships'

/** Where Stripe returns the member after Checkout: the membership it started, read for the identity that started it. */
export default defineHandler(async event => {
  const organizationId = event.context.organizationId as string | undefined
  const sessionId = getRouterParam(event, 'checkout_session_id')
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!organizationId || !sessionId || !session?.user) return jsonResponse({ error: 'Membership not found' }, { status: 404 })
  return jsonResponse(await membershipCheckoutReturn(env.DB, env, organizationId, session.user.id, sessionId), { headers: { 'cache-control': 'private, no-store' } })
})
