import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { readOrder } from '~/server/domain/goods'
import { createReplayableReservationCancelToken, hashReservationCancelToken, readBearerToken, TOKEN_TTL_DAYS } from '~/server/utils/reservation-cancel-token'

/**
 * The buyer's own order on the business's site, opened by the link its
 * confirmation carries: the link names the order's conversation and signs it.
 */
export default defineHandler(async (event) => {
  const organizationId = event.context.organizationId as string | undefined
  const activityId = getRouterParam(event, 'activity_id')
  if (!organizationId || !activityId) throw new HTTPError({ statusCode: 404, statusMessage: 'Order not found' })
  const token = readBearerToken(event.req.headers.get('authorization'))
  if (!token) throw new HTTPError({ statusCode: 401, statusMessage: 'Open your order from the link in your confirmation email' })
  const env = cloudflareEnv(event)
  const expected = await createReplayableReservationCancelToken(env.EMAIL_REPLY_SECRET ?? '', activityId)
  if (await hashReservationCancelToken(token) !== await hashReservationCancelToken(expected.token)) throw new HTTPError({ statusCode: 404, statusMessage: 'Order not found' })
  const order = await readOrder(env.DB, organizationId, { conversationId: activityId })
  if (!order || order.status === 'pending' || order.status === 'released') throw new HTTPError({ statusCode: 404, statusMessage: 'Order not found' })
  if (Date.parse(order.created_at) + TOKEN_TTL_DAYS * 86_400_000 <= Date.now()) throw new HTTPError({ statusCode: 410, statusMessage: 'This link has expired. Your order is in your Blawby account once you create one with the email you ordered with.' })
  const { payment, ...visible } = order
  return jsonResponse({ ...visible, total: payment ? payment.captured_amount - payment.refunded_amount : null, receipt_url: payment?.receipt_url ?? null },
    { headers: { 'cache-control': 'private, no-store' } })
})
