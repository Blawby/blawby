import { defineHandler } from 'nitro'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { acceptTask } from '~/server/domain/tasks'
import { routeId, taskRouteContext } from '~/server/utils/task-route'

// Accept a clean given to you, or take one offered to the home's cleaners: { version }.
export default defineHandler(async (event) => {
  const { db, viewer } = await taskRouteContext(event)
  const body = await readStrictBody<Record<string, unknown>>(event, { version: 'number' })
  return jsonResponse({ task: await acceptTask(db, await viewer(), routeId(event, 'task_id'), body) })
})
