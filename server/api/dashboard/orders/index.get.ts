import { defineHandler } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireRequestedOrganizationWideAccess } from '~/server/utils/location-access'
import { listOrders, readOrder } from '~/server/domain/goods'

/** Paid orders, newest first; `open=1` keeps those still to send. `conversation_id` reads the one order a conversation is about. */
export default defineHandler(async event => {
  const { db, organization } = await requireRequestedOrganizationWideAccess(event)
  const query = getQuery(event)
  if (typeof query.conversation_id === 'string') return jsonResponse({ order: await readOrder(db, organization.id, { conversationId: query.conversation_id }) })
  return jsonResponse({ orders: await listOrders(db, organization.id, query.open === '1') })
})
