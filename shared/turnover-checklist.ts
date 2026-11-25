import { isRecord } from '~/utils/api-clients'
import { cyrb53 } from './form-questions'

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
  /** What a save sends back as `expected_revision`, so it never overwrites a change it did not read. */
  revision: string
}

/** The checklist's content, as a save checks it was read: its items in order with each reference photo. */
export function checklistRevision(items: HomeTurnoverChecklist['items']): string {
  return `cr_${cyrb53(JSON.stringify(items.map(item => [item.id, item.title, item.instructions, item.type, item.minimum, item.per_guest, item.baseline, item.photo_required, item.reference_photo?.id ?? null])))}`
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
  /** The viewer is an owner or admin and may close the job without the checklist; anyone else is refused `CHECKLIST_REQUIRED`. */
  close_without: boolean
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
  /** The reference photo the item had when it was submitted, by asset id: its link is made when the submission is read, as it expires. */
  reference_photo: Pick<ChecklistPhoto, 'id'> | null
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
  items: Array<SubmittedChecklistItem & { photo: ChecklistPhoto | null; reference_photo: ChecklistPhoto | null }>
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
  return isRecord(value) && isText(value.arrival_label) && typeof value.close_without === 'boolean'
    && (value.arrival === null || (isRecord(value.arrival) && isCount(value.arrival.guests) && isText(value.arrival.check_in_date)))
    && Array.isArray(value.items) && value.items.every(item => isRecord(item) && isText(item.id) && isText(item.title)
      && (item.instructions === null || isText(item.instructions)) && (item.type === 'confirm' || item.type === 'count')
      && (item.required === null || isCount(item.required)) && typeof item.photo_required === 'boolean'
      && (item.reference_photo === null || isChecklistPhoto(item.reference_photo)))
}

export function isHomeTurnoverChecklist(value: unknown): value is HomeTurnoverChecklist {
  return isRecord(value) && isText(value.product_id) && isText(value.revision) && Array.isArray(value.items) && value.items.every(item => isRecord(item)
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

/**
 * Whether a home is ready for an arrival, from the stored status of the turnover before it (#2091):
 * Ready once it is done, with a shortage when its checklist flagged one; Not cleaned yet while it is open,
 * `urgent` from two hours before the guests arrive, the same window as the hosts' warning.
 */
export interface TurnoverReadiness {
  state: 'ready' | 'not_cleaned'
  /** "Ready", "Ready · shortage flagged", "Not cleaned yet". */
  label: string
  shortage: boolean
  urgent: boolean
  /** Whether the cleaner has accepted the clean (#2091 section 8); true once it is done. */
  confirmed: boolean
  task_id: string
}

export const READINESS_WARNING_MS = 2 * 3_600_000

export interface StoredTurnover { task_id: string; status: string; short: number; confirmed: number; cleaner: string | null }

export function turnoverReadiness(stored: StoredTurnover | null, arrivesAt: string, now: Date): TurnoverReadiness | null {
  if (!stored || (stored.status !== 'done' && stored.status !== 'open')) return null
  if (stored.status === 'done') {
    const shortage = stored.short === 1
    return { state: 'ready', label: shortage ? 'Ready · shortage flagged' : 'Ready', shortage, urgent: false, confirmed: true, task_id: stored.task_id }
  }
  const confirmed = stored.confirmed === 1
  const cleaner = stored.cleaner?.trim().split(/\s+/)[0] ?? null
  return { state: 'not_cleaned', label: `Not cleaned yet · ${confirmed ? `${cleaner ?? 'Cleaner'} confirmed` : 'not confirmed yet'}`, shortage: false,
    urgent: now.getTime() >= Date.parse(arrivesAt) - READINESS_WARNING_MS, confirmed, task_id: stored.task_id }
}

export function isTurnoverReadiness(value: unknown): value is TurnoverReadiness {
  return isRecord(value) && (value.state === 'ready' || value.state === 'not_cleaned') && isText(value.label)
    && typeof value.shortage === 'boolean' && typeof value.urgent === 'boolean' && typeof value.confirmed === 'boolean' && isText(value.task_id)
}
