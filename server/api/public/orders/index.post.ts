import { defineHandler } from 'nitro'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { ensureInteractionUser } from '~/server/utils/auth'
import { getClientIp, hashClientIp } from '~/server/utils/hourly-rate-limit'
import { readPageEventId } from '~/server/utils/organization-conversions'
import { bookingRateLimit } from '~/server/domain/product-bookings'
import { createOrderCheckout } from '~/server/domain/goods'

/** Checks out a cart: the order is frozen on its payment and the buyer is handed to the pay page. */
export default defineHandler(async event => {
  const organizationId = event.context.organizationId as string | undefined
  if (!organizationId) return jsonResponse({ error: 'Organization not found' }, { status: 404 })
  const env = cloudflareEnv(event)
  const body = await readRequiredBody<Record<string, unknown>>(event)
  const limited = await bookingRateLimit(env.DB, env, await hashClientIp(getClientIp(event)))
  if (limited) return jsonResponse({ error: limited }, { status: 429 })
  const buyer = await ensureInteractionUser(event, env)
  const handoff = await createOrderCheckout(env.DB, env, {
    organizationId, buyerUserId: buyer.id, buyer,
    lines: body.lines, delivery: body.delivery, shipping_details: body.shipping_details,
    guest: { name: body.guest_name, email: body.guest_email, phone: body.guest_phone }, note: body.note,
    idempotencyKey: typeof body.idempotency_key === 'string' ? body.idempotency_key : '',
    origin: { request: event.req, pageEventId: readPageEventId(body.page_event_id) },
  })
  return jsonResponse({ success: true, status: 'checkout', ...handoff }, { status: 201 })
})
