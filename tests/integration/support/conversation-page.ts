import type { DbClient } from '../../../server/db/index.ts'
import { loadConversationPage } from '../../../server/domain/conversation-history.ts'
import type { ConversationWindow } from '../../../server/domain/conversations.ts'
import type { MemberAccessPrincipal } from '../../../server/utils/member-access.ts'
import type { MediaLinkEnv } from '../../../server/utils/private-media.ts'

export async function conversationPageFor(
  db: DbClient,
  env: MediaLinkEnv,
  viewer: MemberAccessPrincipal | string,
  id: string,
  window: ConversationWindow & { before: null } = { before: null, limit: 40 },
  now?: Date,
) {
  const principal = typeof viewer === 'string' ? null : viewer
  const userId = typeof viewer === 'string' ? viewer : viewer.userId
  return loadConversationPage(db, env, { conversationId: id, userId, organizationId: principal?.organizationId }, window, now)
}
