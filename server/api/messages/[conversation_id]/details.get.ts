import { defineHandler } from 'nitro'
import { getConversationDetails } from '~/server/domain/guest-threads/inbox'
import { jsonResponse } from '~/server/utils/api-response'
import { conversationRequest } from '~/server/utils/conversation-request'

export default defineHandler(async event => {
  const { db, env, conversation, user, role } = await conversationRequest(event)
  return jsonResponse(await getConversationDetails(db, env, conversation, user.id, role), { headers: { 'cache-control': 'private, no-store' } })
})
