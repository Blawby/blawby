import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { declineTask } from '~/server/domain/tasks'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

// Can't do it: { version, reason? }. The clean goes to the home's next cleaner, else its host.
export default defineHandler(async (event) => {
  const { db, viewer } = await taskRouteContext(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { version: 'number', reason: 'nullable-string' })
  return jsonResponse({ task: await declineTask(db, await viewer(), routeId(event, 'task_id'), body) })
})
