import { defineHandler, HTTPError } from 'nitro'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { buyerMemberships } from '~/server/domain/memberships'

/** The signed-in member's memberships at every business, as Stripe has them now. */
export default defineHandler(async event => {
  const env = cloudflareEnv(event), session = await getAuthSession(event, env)
  if (!session) throw new HTTPError({ statusCode: 401, statusMessage: 'Sign in to view your memberships' })
  return jsonResponse({ memberships: await buyerMemberships(env.DB, env, session.user.id) }, { headers: { 'cache-control': 'private, no-store' } })
})
