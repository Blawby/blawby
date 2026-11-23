import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { membershipPortal } from '~/server/domain/memberships'

/** Stripe's customer portal for one of the member's own memberships; Stripe returns them to the page they came from. */
export default defineHandler(async event => {
  const env = cloudflareEnv(event), session = await getAuthSession(event, env)
  const subscriptionId = getRouterParam(event, 'subscription_id')
  if (!session || !subscriptionId) throw new HTTPError({ statusCode: 401, statusMessage: 'Sign in to manage your membership' })
  const { return_path: returnPath } = await readRequiredBody<{ return_path?: unknown }>(event)
  const origin = new URL(event.req.url).origin
  // Resolved first, then held to this site: "/\\other.example" parses as another host.
  const returnUrl = typeof returnPath === 'string' && returnPath.startsWith('/') ? new URL(returnPath, origin) : null
  if (!returnUrl || returnUrl.origin !== origin) throw new HTTPError({ statusCode: 400, statusMessage: 'A return path on this site is required' })
  return jsonResponse(await membershipPortal(env.DB, env, session.user.id, subscriptionId, returnUrl.toString()))
})
