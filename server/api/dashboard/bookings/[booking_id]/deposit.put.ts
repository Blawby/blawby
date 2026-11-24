import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { depositRequest } from '~/server/utils/deposit-request'
import { setBookingDeposit } from '~/server/domain/deposits'

/** The deposit the business asks for on this booking, or null for none. */
export default defineHandler(async event => {
  const { db, env, actor } = await depositRequest(event)
  const body = await readRequiredBody<{ deposit_minor?: unknown }>(event)
  return jsonResponse({ deposit: await setBookingDeposit(db, env, actor, getRouterParam(event, 'booking_id') ?? '', body.deposit_minor) })
})
