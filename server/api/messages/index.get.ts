import { defineHandler, HTTPError } from 'nitro'
import { getQuery } from 'nitro/h3'
import { jsonResponse, cloudflareEnv } from '~/server/utils/api-response'
import { messageSession } from '~/server/utils/conversation-request'
import { guestThreadListPage, loadOrganizationConversations, parseGuestThreadListQuery } from '~/server/utils/dashboard-guest-threads'
import { getAuthSession, dashboardSessionUserQuery, type DashboardAuthRead } from '~/server/utils/auth'
import { withViewer } from '~/server/utils/member-access'
import { executeBatch, type BatchQuery } from '~/server/db'
import { prepareUnreadMailboxes, readGuestInbox } from '~/server/domain/guest-threads/repository'
import { finalizeRequestMetrics } from '~/server/utils/request-metrics'

export default defineHandler(async event => {
  const { organization_id: organizationId, ...filters } = getQuery(event)
  if (filters.view === 'unread') {
    if (organizationId !== undefined || Object.keys(filters).some(key => key !== 'view')) throw new HTTPError({ statusCode: 400, message: 'Unread badges cover the account and all workspaces', data: { code: 'INVALID_QUERY', field: 'view' } })
    const env = cloudflareEnv(event)
    const plan = prepareUnreadMailboxes()
    const queries = (user: BatchQuery) => plan.queries.map(query => withViewer({ query: `SELECT (${user.query}) AS user_id`, params: user.params }, query))
    const document: DashboardAuthRead = { queries: token => queries(dashboardSessionUserQuery(token)) }
    const session = await getAuthSession(event, env, { document, forwardCookies: true })
    if (!session?.user.id) throw new HTTPError({ statusCode: 401, message: 'Sign in to read unread badges', data: { code: 'UNAUTHORIZED', field: 'session' } })
    const rows = document.results ?? await executeBatch(env.DB, queries({ query: '?', params: [session.user.id] }), { operation: 'Read all authorized unread mailboxes' })
    return jsonResponse(finalizeRequestMetrics(event, 'unread-mailboxes', plan.read(rows)), { headers: { 'cache-control': 'private, no-store' } })
  }
  const query = parseGuestThreadListQuery(filters)
  if (organizationId !== undefined) {
    if (typeof organizationId !== 'string' || !organizationId.trim()) throw new HTTPError({ statusCode: 400, message: 'Invalid workspace', data: { code: 'INVALID_ORGANIZATION', field: 'organization_id' } })
    const payload = await loadOrganizationConversations(event, organizationId, query)
    return jsonResponse(finalizeRequestMetrics(event, 'messages-list', payload))
  }
  if (query.locationId) throw new HTTPError({ statusCode: 400, message: 'A location filter requires a workspace', data: { code: 'INVALID_GUEST_THREAD_FILTER', field: 'location_id' } })
  const { db, user } = await messageSession(event)
  const inbox = await readGuestInbox(db, { ...query, limit: (query.limit ?? 100) + 1, userId: user.id })
  return jsonResponse(finalizeRequestMetrics(event, 'messages-list', guestThreadListPage(inbox, query)))
})
