import { defineHandler } from 'nitro'
import { cloudflareEnv, jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { quoteOrder } from '~/server/domain/goods'

/** A cart priced for a delivery: its location, lines, stock state, shipping rates and ship-by date. */
export default defineHandler(async event => {
  const organizationId = event.context.organizationId as string | undefined
  if (!organizationId) return jsonResponse({ error: 'Organization not found' }, { status: 404 })
  const body = await readRequiredBody<{ lines?: unknown; delivery?: unknown }>(event)
  const quote = await quoteOrder(cloudflareEnv(event).DB, organizationId, { lines: body.lines, delivery: body.delivery })
  return jsonResponse(quote, { headers: { 'cache-control': 'private, no-store' } })
})
