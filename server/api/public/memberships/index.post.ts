import { defineHandler } from 'nitro'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { ensureInteractionUser } from '~/server/utils/auth'
import { getClientIp, hashClientIp } from '~/server/utils/hourly-rate-limit'
import { resolvePublicOrigin } from '~/server/utils/platform-llm'
import { bookingRateLimit } from '~/server/domain/product-bookings'
import { createMembershipCheckout } from '~/server/domain/memberships'

/** Joins a membership: the buyer is handed to Stripe Checkout on the business's account. */
export default defineHandler(async event => {
  const organizationId = event.context.organizationId as string | undefined
  if (!organizationId) return jsonResponse({ error: 'Organization not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  const body = await readRequiredBody<Record<string, unknown>>(event)
  const limited = await bookingRateLimit(env.DB, env, await hashClientIp(getClientIp(event)))
  if (limited) return jsonResponse({ error: limited }, { status: 429 })
  const buyer = await ensureInteractionUser(event, env)
  const checkout = await createMembershipCheckout(env.DB, env, {
    organizationId, buyer, product_id: body.product_id, product_variant_id: body.product_variant_id, location_id: body.location_id,
    guest: { name: body.guest_name, email: body.guest_email, phone: body.guest_phone }, idempotencyKey: body.idempotency_key, siteOrigin: resolvePublicOrigin(event),
  })
  return jsonResponse(checkout, { status: 201 })
})
