import { isRecord } from '~/utils/api-clients'

/**
 * A home's turnover checklist (#2091): what a clean must leave, each item
 * confirmed or counted by the cleaner, some with a photo. Counts can follow
 * the party arriving next. The submission is the closer's one message in the
 * job's conversation; nothing judges a photo.
 */

export const CHECKLIST_ITEM_TYPES = ['confirm', 'count'] as const
export type ChecklistItemType = typeof CHECKLIST_ITEM_TYPES[number]

export const CHECKLIST_LIMITS = { items: 30, title: 100, instructions: 500, count: 999 } as const

/** One item as the home stores it. */
export interface TurnoverChecklistItem {
  /** Stable: an answer and the item's reference photo name it. */
  id: string
  title: string
  instructions: string | null
  type: ChecklistItemType
  /** For `count`: the number required, or the number per arriving guest when `per_guest`. Null for `confirm`. */
  minimum: number | null
  per_guest: boolean
  /** For a `per_guest` count: what is required when no arrival is booked. */
  baseline: number | null
  photo_required: boolean
}

export interface ChecklistPhoto { id: string; url: string; thumbnail_url: string }

/** A home's checklist as the editor and MCP read it. */
export interface HomeTurnoverChecklist {
  product_id: string
  items: Array<TurnoverChecklistItem & { reference_photo: ChecklistPhoto | null }>
}

/** An item written by the editor or MCP: no id for a new one; the reference photo by asset id, or null for none. */
export type ChecklistItemInput = Omit<TurnoverChecklistItem, 'id'> & { id?: string; reference_photo_id: string | null }

/** The arrival a job's counts follow: the next confirmed stay at the home after this turnover. */
export interface ChecklistArrival { guests: number; check_in_date: string }

/** A turnover job's checklist, resolved when the job is read. */
export interface TaskChecklist {
  arrival: ChecklistArrival | null
  /** "4 guests arriving Fri, Nov 28" or "No arrival booked yet". */
  arrival_label: string
  items: Array<Pick<TurnoverChecklistItem, 'id' | 'title' | 'instructions' | 'type' | 'photo_required'> & {
    /** The number this job requires, for a count; null for a confirm. */
    required: number | null
    reference_photo: ChecklistPhoto | null
  }>
}

/** A cleaner's answer to one item: `confirmed` for a confirm, `counted` for a count. Its photo travels as the multipart file `photo:<id>`. */
export interface ChecklistAnswer { id: string; confirmed?: boolean; counted?: number }

/** One item of a submission, as it was required and as it was answered. */
export interface SubmittedChecklistItem extends Pick<TurnoverChecklistItem, 'id' | 'title' | 'instructions' | 'type' | 'photo_required'> {
  required: number | null
  counted: number | null
  confirmed: boolean | null
  /** How many short of required, for a count; null for a confirm. */
  shortage: number | null
  /** Short on a count, or a confirm answered no. */
  flagged: boolean
  /** The cleaner's photo: one of the message's own photos. */
  photo_id: string | null
  /** The reference photo the item had when it was submitted. */
  reference_photo: ChecklistPhoto | null
}

/** What the closing message's payload holds (`payload.checklist`): the checklist as it was made against. */
export interface ChecklistSubmission {
  task_id: string
  arrival: ChecklistArrival | null
  arrival_label: string
  items: SubmittedChecklistItem[]
  /** The cleaner's own words with it. */
  note: string | null
}

/** A submission as a conversation draws it: flagged items first, each with the cleaner's photo. */
export interface ChecklistSubmissionView extends Omit<ChecklistSubmission, 'items'> {
  /** "3 of 4 done · 1 short". */
  summary: string
  items: Array<SubmittedChecklistItem & { photo: ChecklistPhoto | null }>
}

/** What a count item requires for this arrival. */
export function requiredCount(item: Pick<TurnoverChecklistItem, 'type' | 'minimum' | 'per_guest' | 'baseline'>, arrival: ChecklistArrival | null): number | null {
  if (item.type !== 'count') return null
  if (!item.per_guest) return item.minimum
  return arrival ? item.minimum! * arrival.guests : item.baseline
}

export function checklistSummary(items: ReadonlyArray<Pick<SubmittedChecklistItem, 'flagged' | 'shortage' | 'type'>>): string {
  const flagged = items.filter(item => item.flagged)
  const short = flagged.filter(item => item.type === 'count').length
  const missed = flagged.length - short
  return [`${items.length - flagged.length} of ${items.length} done`, short ? `${short} short` : null, missed ? `${missed} not done` : null].filter(Boolean).join(' · ')
}

/** One item's line in a summary: "Spare toilet paper: 1 of 2 · short by 1", "TV remote: not done". */
export function submittedItemLine(item: SubmittedChecklistItem): string {
  if (item.type === 'confirm') return `${item.title}: ${item.confirmed ? 'done' : 'not done'}`
  return `${item.title}: ${item.counted} of ${item.required}${item.shortage ? ` · short by ${item.shortage}` : ''}`
}

/** Flagged first, otherwise in the checklist's order. */
export function flaggedFirst<T extends { flagged: boolean }>(items: readonly T[]): T[] {
  return [...items.filter(item => item.flagged), ...items.filter(item => !item.flagged)]
}

const isText = (value: unknown): value is string => typeof value === 'string'
const isCount = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0

export function isChecklistPhoto(value: unknown): value is ChecklistPhoto {
  return isRecord(value) && isText(value.id) && isText(value.url) && isText(value.thumbnail_url)
}

export function isTaskChecklist(value: unknown): value is TaskChecklist {
  return isRecord(value) && isText(value.arrival_label)
    && (value.arrival === null || (isRecord(value.arrival) && isCount(value.arrival.guests) && isText(value.arrival.check_in_date)))
    && Array.isArray(value.items) && value.items.every(item => isRecord(item) && isText(item.id) && isText(item.title)
      && (item.instructions === null || isText(item.instructions)) && (item.type === 'confirm' || item.type === 'count')
      && (item.required === null || isCount(item.required)) && typeof item.photo_required === 'boolean'
      && (item.reference_photo === null || isChecklistPhoto(item.reference_photo)))
}

export function isHomeTurnoverChecklist(value: unknown): value is HomeTurnoverChecklist {
  return isRecord(value) && isText(value.product_id) && Array.isArray(value.items) && value.items.every(item => isRecord(item)
    && isText(item.id) && isText(item.title) && (item.instructions === null || isText(item.instructions))
    && (item.type === 'confirm' || item.type === 'count') && (item.minimum === null || isCount(item.minimum))
    && typeof item.per_guest === 'boolean' && (item.baseline === null || isCount(item.baseline)) && typeof item.photo_required === 'boolean'
    && (item.reference_photo === null || isChecklistPhoto(item.reference_photo)))
}

export function isChecklistSubmissionView(value: unknown): value is ChecklistSubmissionView {
  return isRecord(value) && isText(value.task_id) && isText(value.summary) && isText(value.arrival_label)
    && Array.isArray(value.items) && value.items.every(item => isRecord(item) && isText(item.id) && isText(item.title)
      && (item.type === 'confirm' || item.type === 'count') && typeof item.flagged === 'boolean'
      && (item.photo === null || isChecklistPhoto(item.photo)) && (item.reference_photo === null || isChecklistPhoto(item.reference_photo)))
}
