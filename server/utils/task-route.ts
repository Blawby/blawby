import { HTTPError, type H3Event } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { requireOrganizationMembership } from '~/server/utils/location-access'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { closeTask, getTask, taskViewer } from '~/server/domain/tasks'
import { MAX_MESSAGE_PHOTOS, type MessagePhoto } from '~/server/domain/guest-threads/attachments'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'

/** The organization a task route names, and the caller as its domain reads them. */
export async function taskRouteContext(event: H3Event) {
  const organizationId = getRouterParam(event, 'organization_id')
  if (!organizationId) throw new HTTPError({ statusCode: 400, message: 'organization_id is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'organization_id' } })
  const { db, env, organization } = await requireOrganizationMembership(event, organizationId)
  const principal = memberAccessPrincipal(organization.membership, { env, event })
  return { db, env, principal, viewer: () => taskViewer(principal) }
}

export function routeId(event: H3Event, name: 'task_id'): string {
  const id = getRouterParam(event, name)
  if (!id) throw new HTTPError({ statusCode: 400, message: `${name} is required`, data: { code: 'ID_REQUIRED', field: name } })
  return id
}

export async function taskReadResponse(event: H3Event) {
  const { db, viewer } = await taskRouteContext(event)
  return jsonResponse({ task: await getTask(db, await viewer(), routeId(event, 'task_id')) }, { headers: { 'cache-control': 'private, no-store' } })
}

/**
 * Done or Skip. JSON `{ note?, checklist? }`, or multipart with `note`, `photos`, a `checklist`
 * JSON field and one `photo:<item id>` file per checklist item that carries a photo.
 */
export async function taskCloseResponse(event: H3Event, status: 'done' | 'skipped') {
  const { db, env, viewer } = await taskRouteContext(event)
  const multipart = event.req.headers.get('content-type')?.startsWith('multipart/form-data') ?? false
  const invalidPhoto = () => new HTTPError({ statusCode: 422, message: 'Each photo must be a file of at most 10 MB. Send no more than ten photos besides one per checklist item.', data: { code: 'INVALID_PHOTO', field: 'photos' } })
  const toPhoto = async (file: File): Promise<MessagePhoto> => ({ bytes: new Uint8Array(await file.arrayBuffer()), filename: file.name })
  let note: unknown
  let checklist: unknown
  let photos: MessagePhoto[] = []
  const checklistPhotos = new Map<string, MessagePhoto>()
  if (multipart) {
    const form = await event.req.formData()
    const keys = [...form.keys()]
    if (keys.some(key => key !== 'note' && key !== 'photos' && key !== 'checklist' && !key.startsWith('photo:'))
      || form.getAll('note').length > 1 || form.getAll('checklist').length > 1) {
      throw new HTTPError({ statusCode: 400, message: 'Send one note, its photos, and one checklist with a photo per item', data: { code: 'INVALID_BODY', field: 'body' } })
    }
    const files = form.getAll('photos')
    if (files.length > MAX_MESSAGE_PHOTOS || files.some(file => !(file instanceof File) || file.size > MAX_IMAGE_BYTES)) throw invalidPhoto()
    photos = await Promise.all((files as File[]).map(toPhoto))
    for (const key of new Set(keys.filter(key => key.startsWith('photo:')))) {
      const [file, ...more] = form.getAll(key)
      if (more.length || !(file instanceof File) || file.size > MAX_IMAGE_BYTES) throw invalidPhoto()
      checklistPhotos.set(key.slice('photo:'.length), await toPhoto(file))
    }
    note = form.get('note')
    const answers = form.get('checklist')
    if (answers !== null) {
      if (typeof answers !== 'string') throw new HTTPError({ statusCode: 422, message: 'checklist must be JSON text', data: { code: 'INVALID_CHECKLIST', field: 'checklist' } })
      try { checklist = JSON.parse(answers) } catch { throw new HTTPError({ statusCode: 422, message: 'checklist must be JSON text', data: { code: 'INVALID_CHECKLIST', field: 'checklist' } }) }
    }
  } else {
    const body = await readStrictBody<{ note?: string | null; checklist?: unknown }>(event, { note: 'nullable-string', checklist: 'unknown' })
    note = body.note
    checklist = body.checklist
  }
  return jsonResponse({ task: await closeTask(db, await viewer(), routeId(event, 'task_id'), { status, env, note, photos, checklist, checklistPhotos }) })
}
