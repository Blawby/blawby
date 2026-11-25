import { HTTPError } from 'nitro'
import { formatCalendarDate } from '~/utils/timezone'
import { isRecord } from '~/utils/api-clients'
import {
  CHECKLIST_ITEM_TYPES, CHECKLIST_LIMITS, checklistSummary, flaggedFirst, requiredCount, submittedItemLine,
  type ChecklistArrival, type ChecklistPhoto, type ChecklistSubmission, type ChecklistSubmissionView, type HomeTurnoverChecklist,
  type SubmittedChecklistItem, type TaskChecklist, type TurnoverChecklistItem,
} from '~/shared/turnover-checklist'

/*
  A home's turnover checklist (#2091). The items are one JSON column beside the
  arrival guide on product_stay_configs; an item's reference photo is the
  product's `turnover_checklist.<item id>` media placement, which public media
  reads and the media library leave out. A job reads the checklist with the
  next confirmed arrival at that moment; the submission is the closer's one
  message in the job's conversation (tasks.ts closeTask), carrying what it was
  made against. Nothing here judges a photo.
*/

export const SLOT = 'turnover_checklist.'
const ITEM_ID = /^[A-Za-z0-9_-]{1,64}$/

export function fail(statusCode: number, code: string, message: string, field?: string, extra: Record<string, unknown> = {}): never {
  throw new HTTPError({ statusCode, message, data: { code, ...(field ? { field } : {}), ...extra } })
}

/** The checklist and its reference photos, as columns of a projection that reads the home as `alias`. */
export function checklistColumnsSql(alias: string): string {
  return `${alias}.turnover_checklist AS turnover_checklist,
    (SELECT json_group_array(json_object('slot', mp.slot, 'id', ma.id, 'url', ma.public_url, 'thumbnail_url', COALESCE(ma.thumbnail_url, ma.public_url)))
      FROM media_placements mp JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = mp.organization_id
      WHERE mp.organization_id = ${alias}.organization_id AND mp.owner_type = 'product' AND mp.owner_id = ${alias}.product_id
        AND mp.slot GLOB '${SLOT}*' AND mp.status = 'active' AND ma.status = 'active' AND ma.public_url IS NOT NULL) AS turnover_references`
}

export interface ChecklistColumns { turnover_checklist: string; turnover_references: string }

/** A stored checklist, checked as it is read; a stored item that breaks the rules is a broken record. */
function storedItems(json: string, productId: string): TurnoverChecklistItem[] {
  const parsed: unknown = JSON.parse(json)
  if (!Array.isArray(parsed)) throw new Error(`Home ${productId} has a turnover checklist that is not a list`)
  return parsed.map((value, index) => {
    const item = checkedItem(value, `items[${index}]`, true)
    if (!item.id) throw new Error(`Home ${productId} has a checklist item with no id`)
    return item as TurnoverChecklistItem
  })
}

/** The home's items, each with its reference photo. */
export function checklistOf(row: ChecklistColumns, productId: string): HomeTurnoverChecklist['items'] {
  const references = new Map((JSON.parse(row.turnover_references) as Array<ChecklistPhoto & { slot: string }>)
    .map(({ slot, ...photo }) => [slot.slice(SLOT.length), photo]))
  return storedItems(row.turnover_checklist, productId).map(item => ({ ...item, reference_photo: references.get(item.id) ?? null }))
}

const text = (value: unknown, field: string, max: number, required: boolean): string | null => {
  const trimmed = typeof value === 'string' ? value.trim() : value
  if (trimmed === null || trimmed === undefined || trimmed === '') {
    if (required) fail(422, 'INVALID_CHECKLIST_ITEM', `${field} is required`, field)
    return null
  }
  if (typeof trimmed !== 'string' || trimmed.length > max) fail(422, 'INVALID_CHECKLIST_ITEM', `${field} must be text of at most ${max} characters`, field)
  return trimmed
}
const count = (value: unknown, field: string): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > CHECKLIST_LIMITS.count) fail(422, 'INVALID_CHECKLIST_ITEM', `${field} must be a whole number from 0 to ${CHECKLIST_LIMITS.count}`, field)
  return value as number
}

/** One item as written, or as stored when `stored`; each problem names its field. */
export function checkedItem(value: unknown, field: string, stored = false): Omit<TurnoverChecklistItem, 'id'> & { id?: string; reference_photo_id?: string | null } {
  if (!isRecord(value)) fail(422, 'INVALID_CHECKLIST_ITEM', `${field} must be an item`, field)
  const allowed = ['id', 'title', 'instructions', 'type', 'minimum', 'per_guest', 'baseline', 'photo_required', ...(stored ? [] : ['reference_photo_id', 'reference_photo'])]
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown) fail(422, 'INVALID_CHECKLIST_ITEM', `${field}.${unknown} is not part of a checklist item`, `${field}.${unknown}`)
  if (value.id !== undefined && (typeof value.id !== 'string' || !ITEM_ID.test(value.id))) fail(422, 'INVALID_CHECKLIST_ITEM', `${field}.id must be the id read from the checklist`, `${field}.id`)
  if (!CHECKLIST_ITEM_TYPES.includes(value.type as never)) fail(422, 'INVALID_CHECKLIST_ITEM', `${field}.type must be confirm or count`, `${field}.type`)
  const type = value.type as TurnoverChecklistItem['type']
  if (typeof value.photo_required !== 'boolean') fail(422, 'INVALID_CHECKLIST_ITEM', `${field}.photo_required must be true or false`, `${field}.photo_required`)
  const perGuest = value.per_guest ?? false
  if (typeof perGuest !== 'boolean') fail(422, 'INVALID_CHECKLIST_ITEM', `${field}.per_guest must be true or false`, `${field}.per_guest`)
  let minimum: number | null = null, baseline: number | null = null
  if (type === 'count') {
    minimum = count(value.minimum, `${field}.minimum`)
    if (perGuest) baseline = count(value.baseline, `${field}.baseline`)
    else if (value.baseline !== undefined && value.baseline !== null) fail(422, 'INVALID_CHECKLIST_ITEM', `${field}.baseline is only for a number per arriving guest`, `${field}.baseline`)
  } else if ((value.minimum ?? null) !== null || perGuest || (value.baseline ?? null) !== null) {
    fail(422, 'INVALID_CHECKLIST_ITEM', `${field} is a confirm item: it takes no minimum, per_guest or baseline`, `${field}.type`)
  }
  const reference = value.reference_photo_id ?? null
  if (!stored && reference !== null && typeof reference !== 'string') fail(422, 'INVALID_CHECKLIST_ITEM', `${field}.reference_photo_id must be an image asset id, or null`, `${field}.reference_photo_id`)
  return {
    ...(value.id === undefined ? {} : { id: value.id as string }),
    title: text(value.title, `${field}.title`, CHECKLIST_LIMITS.title, true)!,
    instructions: text(value.instructions, `${field}.instructions`, CHECKLIST_LIMITS.instructions, false),
    type, minimum, per_guest: perGuest, baseline, photo_required: value.photo_required,
    ...(stored ? {} : { reference_photo_id: reference as string | null }),
  }
}

/** "4 guests arriving Fri, Nov 28", or "No arrival booked yet". */
export function arrivalLabel(arrival: ChecklistArrival | null): string {
  if (!arrival) return 'No arrival booked yet'
  return `${arrival.guests} ${arrival.guests === 1 ? 'guest' : 'guests'} arriving ${formatCalendarDate(arrival.check_in_date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })}`
}

/** What a turnover job requires: the home's items, counts resolved against the next arrival as it stands now. */
export function resolveTaskChecklist(items: HomeTurnoverChecklist['items'], arrival: ChecklistArrival | null, closeWithout: boolean): TaskChecklist | null {
  if (!items.length) return null
  return {
    arrival, arrival_label: arrivalLabel(arrival), close_without: closeWithout,
    items: items.map(item => ({ id: item.id, title: item.title, instructions: item.instructions, type: item.type, required: requiredCount(item, arrival), photo_required: item.photo_required, reference_photo: item.reference_photo })),
  }
}

/**
 * A cleaner's answers checked against what the job requires now. Every item
 * needs an answer and every photo-required item its photo; a refusal names
 * each one. A shortage is not a refusal. `photos` are the items that carry one.
 */
export function checkedSubmission(taskId: string, checklist: TaskChecklist, raw: unknown, photos: ReadonlySet<string>): Omit<ChecklistSubmission, 'items' | 'note'> & { items: Array<Omit<SubmittedChecklistItem, 'photo_id'>> } {
  if (!isRecord(raw) || !Array.isArray(raw.items) || Object.keys(raw).some(key => key !== 'items')) fail(422, 'INVALID_CHECKLIST', 'checklist must be { items: [{ id, confirmed } or { id, counted }] }', 'checklist')
  const known = new Set(checklist.items.map(item => item.id))
  const answers = new Map<string, Record<string, unknown>>()
  for (const [index, answer] of raw.items.entries()) {
    if (!isRecord(answer) || typeof answer.id !== 'string') fail(422, 'INVALID_CHECKLIST', `checklist.items[${index}] must name its item id`, `checklist.items[${index}]`)
    if (!known.has(answer.id)) fail(409, 'CHECKLIST_CHANGED', 'The checklist changed since you opened it; reload it', `checklist.items[${index}].id`)
    if (answers.has(answer.id)) fail(422, 'INVALID_CHECKLIST', `checklist.items[${index}] answers an item twice`, `checklist.items[${index}].id`)
    answers.set(answer.id, answer)
  }
  for (const id of photos) if (!known.has(id)) fail(409, 'CHECKLIST_CHANGED', 'The checklist changed since you opened it; reload it', `photo:${id}`)
  const missing: Array<{ id: string; title: string; missing: 'answer' | 'photo' }> = []
  const items = checklist.items.map((item) => {
    const answer = answers.get(item.id)
    const confirmed = item.type === 'confirm' && typeof answer?.confirmed === 'boolean' ? answer.confirmed : null
    const counted = item.type === 'count' && Number.isSafeInteger(answer?.counted) && (answer!.counted as number) >= 0 ? answer!.counted as number : null
    if (item.type === 'confirm' ? confirmed === null : counted === null) missing.push({ id: item.id, title: item.title, missing: 'answer' })
    if (item.photo_required && !photos.has(item.id)) missing.push({ id: item.id, title: item.title, missing: 'photo' })
    const shortage = item.type === 'count' && counted !== null ? Math.max(0, item.required! - counted) : null
    return { id: item.id, title: item.title, instructions: item.instructions, type: item.type, photo_required: item.photo_required, required: item.required,
      counted, confirmed, shortage, flagged: item.type === 'count' ? (shortage ?? 0) > 0 : confirmed === false, reference_photo: item.reference_photo }
  })
  if (missing.length) {
    const needs = missing.map(entry => entry.missing === 'photo' ? `add a photo of ${entry.title}` : `answer ${entry.title}`)
    fail(422, 'CHECKLIST_INCOMPLETE', `Before Done: ${needs.join('; ')}.`, 'checklist', { missing })
  }
  return { task_id: taskId, arrival: checklist.arrival, arrival_label: checklist.arrival_label, items }
}

/** The closing message's words: how it went, what is short, and the cleaner's note. */
export function submissionBody(submission: ChecklistSubmission): string {
  return [`Checklist: ${checklistSummary(submission.items)}`, ...submission.items.filter(item => item.flagged).map(submittedItemLine), submission.note].filter(Boolean).join('\n')
}

/** The body of a job closed past its checklist. */
export const WITHOUT_CHECKLIST = 'Done without the checklist'

/** A stored submission as a conversation draws it, its photos the message's own. */
export function submissionView(stored: unknown, photos: ReadonlyArray<{ id: string; url: string; thumbnailUrl: string }>): ChecklistSubmissionView | null {
  if (!isRecord(stored) || typeof stored.task_id !== 'string' || !Array.isArray(stored.items)) return null
  const submission = stored as unknown as ChecklistSubmission
  const byId = new Map(photos.map(photo => [photo.id, { id: photo.id, url: photo.url, thumbnail_url: photo.thumbnailUrl }]))
  return {
    ...submission, note: submission.note ?? null, summary: checklistSummary(submission.items),
    items: flaggedFirst(submission.items.map(item => ({ ...item, photo: item.photo_id ? byId.get(item.photo_id) ?? null : null }))),
  }
}

/**
 * The turnover before an arrival, as JSON `{ task_id, status, short }` or NULL: the turnover of the
 * last confirmed stay at the same home to check out on or before `booking` arrives. `booking` is the
 * alias of the arriving stay in a projection that reads it.
 */
export function turnoverBeforeSql(booking: string): string {
  return `(SELECT json_object('task_id', t.id, 'status', t.status,
      'confirmed', t.accepted_member_id IS NOT NULL AND t.accepted_member_id = t.assigned_member_id,
      'cleaner', (SELECT u.name FROM member m JOIN user u ON u.id = m.userId WHERE m.id = t.assigned_member_id),
      'short', EXISTS (SELECT 1 FROM messages m, json_each(m.payload_json, '$.checklist.items') item
      WHERE m.organization_id = t.organization_id AND m.dedupe_key = 'task-closed:' || t.id || ':' || t.version AND json_extract(item.value, '$.flagged') = 1))
    FROM tasks t JOIN bookings left_stay ON left_stay.organization_id = t.organization_id AND left_stay.id = t.subject_id
    WHERE t.organization_id = ${booking}.organization_id AND t.kind = 'turnover' AND t.product_id = ${booking}.product_id
      AND left_stay.id <> ${booking}.id AND left_stay.status = 'confirmed' AND left_stay.product_session_id IS NULL
      AND substr(COALESCE(left_stay.actual_check_out_date, left_stay.ends_at), 1, 10) <= substr(${booking}.starts_at, 1, 10)
    ORDER BY COALESCE(left_stay.actual_check_out_date, left_stay.ends_at) DESC, t.id DESC LIMIT 1)`
}

/** An open turnover whose next guests' arrival has passed: shown as Not marked done, and no longer open work. */
export const lapsedTurnoverSql = (task: string, now: string) => `(${task}.kind = 'turnover' AND ${task}.status = 'open' AND ${task}.due_at IS NOT NULL AND ${task}.due_at <= ${now})`
