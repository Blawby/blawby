import { HTTPError } from 'nitro'
import { d1JsonStringSet, queryAll, type DbClient } from '~/server/db'
import { conversationMemberSql } from '~/server/domain/conversations'
import { scopeSql, type TaskViewer } from '~/server/domain/tasks'
import { submissionView } from '~/server/domain/turnover-checklists'
import { messagePhotoRowsSql, groupMessagePhotos, type MessagePhotoRow } from '~/server/domain/guest-threads/attachments'
import { addLocalDays, localDateAt } from '~/utils/timezone'
import type { ChecklistPhoto, ChecklistSubmissionView } from '~/shared/turnover-checklist'

/*
  Turnover checklists as they were submitted (#2091): the closing messages of
  done turnovers, read by whoever can read the job and sits in its
  conversation. For a host's own assistant to total shortages and look at the
  photos; nothing here judges them.
*/

export interface TurnoverSubmission {
  task_id: string
  message_id: string
  conversation_id: string
  product_id: string
  home: string
  /** When Done was tapped. */
  submitted_at: string
  submitted_by: string | null
  /** Done past the checklist: by a manager, or from an app that cannot show it. */
  without_checklist: boolean
  checklist: ChecklistSubmissionView | null
}

function fail(statusCode: number, code: string, message: string, field?: string): never {
  throw new HTTPError({ statusCode, message, data: { code, ...(field ? { field } : {}) } })
}

const DAY = /^\d{4}-\d{2}-\d{2}$/
const MAX_DAYS = 93

type Row = { task_id: string; product_id: string; timezone: string; closed_at: string; closed_by: string | null; message_id: string; conversation_id: string; payload_json: string; home: string; photo_rows: string }

async function readSubmissions(db: DbClient, viewer: TaskViewer, where: { sql: string; params: unknown[] }): Promise<Array<TurnoverSubmission & { timezone: string }>> {
  const scope = scopeSql(viewer)
  const photos = messagePhotoRowsSql("mp.owner_type = 'message' AND mp.owner_id = m.id AND mp.organization_id = m.organization_id")
  const rows = await queryAll<Row>(db, `SELECT t.id AS task_id, t.product_id, t.timezone, t.closed_at, u.name AS closed_by,
      m.id AS message_id, m.conversation_id, m.payload_json, COALESCE(sc.internal_name, p.name) AS home,
      (SELECT json_group_array(json_object('owner_id', ph.owner_id, 'id', ph.id, 'public_url', ph.public_url, 'thumbnail_url', ph.thumbnail_url,
        'alt_text', ph.alt_text, 'width', ph.width, 'height', ph.height)) FROM (${photos}) ph) AS photo_rows
    FROM tasks t
    JOIN messages m ON m.organization_id = t.organization_id AND m.dedupe_key = 'task-closed:' || t.id || ':' || t.version
    JOIN conversations c ON c.organization_id = m.organization_id AND c.id = m.conversation_id AND c.kind = 'team'
    JOIN products p ON p.organization_id = t.organization_id AND p.id = t.product_id
    LEFT JOIN product_stay_configs sc ON sc.organization_id = p.organization_id AND sc.product_id = p.id
    LEFT JOIN user u ON u.id = t.closed_by_user_id
    WHERE t.organization_id = ? AND t.kind = 'turnover' AND t.status = 'done'
      AND (json_type(m.payload_json, '$.checklist') = 'object' OR json_extract(m.payload_json, '$.checklist_skipped') = 1)
      AND ${conversationMemberSql('c', '?')} AND ${where.sql} AND ${scope.sql}
    ORDER BY t.closed_at, t.id`, [viewer.principal.organizationId, viewer.principal.userId, ...where.params, ...scope.params])
  return rows.map((row) => {
    const payload = JSON.parse(row.payload_json) as Record<string, unknown>
    const photos = groupMessagePhotos(JSON.parse(row.photo_rows) as MessagePhotoRow[]).get(row.message_id) ?? []
    const checklist = payload.checklist === undefined ? null : submissionView(payload.checklist, photos)
    if (payload.checklist !== undefined && !checklist) throw new Error(`Message ${row.message_id} carries a checklist that cannot be read`)
    return { task_id: row.task_id, message_id: row.message_id, conversation_id: row.conversation_id, product_id: row.product_id, home: row.home,
      submitted_at: row.closed_at, submitted_by: row.closed_by, without_checklist: checklist === null, checklist, timezone: row.timezone }
  })
}

/** The checklists submitted on days `from` to `to` (each home's own days), optionally at some homes. */
export async function listTurnoverSubmissions(db: DbClient, viewer: TaskViewer, input: { from: unknown; to: unknown; product_ids?: unknown }): Promise<{ submissions: TurnoverSubmission[] }> {
  const { from, to } = input
  if (typeof from !== 'string' || !DAY.test(from)) fail(422, 'INVALID_RANGE', 'from must be a day, YYYY-MM-DD', 'from')
  if (typeof to !== 'string' || !DAY.test(to) || to < from) fail(422, 'INVALID_RANGE', 'to must be a day, YYYY-MM-DD, on or after from', 'to')
  if (addLocalDays(from, MAX_DAYS) <= to) fail(422, 'INVALID_RANGE', `Read at most ${MAX_DAYS} days at a time`, 'to')
  const homes = input.product_ids
  if (homes !== undefined && (!Array.isArray(homes) || !homes.length || homes.some(id => typeof id !== 'string' || !id))) fail(422, 'INVALID_HOMES', 'product_ids must list homes', 'product_ids')
  // A home's day can start up to a day either side of UTC's; each closure is then kept by its home's own day.
  const rows = await readSubmissions(db, viewer, {
    sql: `t.closed_at >= ? AND t.closed_at < ? AND (? IS NULL OR t.product_id IN (SELECT value FROM json_each(?)))`,
    params: [addLocalDays(from, -1), addLocalDays(to, 2), homes ? d1JsonStringSet(homes as string[]) : null, homes ? d1JsonStringSet(homes as string[]) : null],
  })
  return { submissions: rows.filter(row => { const day = localDateAt(new Date(row.submitted_at), row.timezone); return day >= from && day <= to }).map(({ timezone: _timezone, ...row }) => row) }
}

/** One done turnover's submission. */
export async function readTurnoverSubmission(db: DbClient, viewer: TaskViewer, taskId: string): Promise<TurnoverSubmission> {
  const [row] = await readSubmissions(db, viewer, { sql: 't.id = ?', params: [taskId] })
  if (!row) fail(404, 'SUBMISSION_NOT_FOUND', 'No checklist was submitted with this job’s Done, or you cannot read its conversation', 'task_id')
  const { timezone: _timezone, ...submission } = row
  return submission
}

const MODEL_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])

/** A photo's thumbnail as image content a model can read. */
export async function photoImage(photo: ChecklistPhoto): Promise<{ data: string; mimeType: string }> {
  const response = await fetch(photo.thumbnail_url, { headers: { accept: 'image/jpeg,image/png,image/webp' } })
  if (!response.ok) throw new Error(`Photo ${photo.id} could not be read: HTTP ${response.status}`)
  const mimeType = response.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
  if (!MODEL_IMAGE_TYPES.has(mimeType)) throw new Error(`Photo ${photo.id} came back as ${mimeType || 'an unknown type'}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  let binary = ''
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return { data: btoa(binary), mimeType }
}
