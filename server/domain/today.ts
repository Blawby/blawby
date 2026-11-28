import { staffListingsQuery } from '~/server/domain/listing-access'
import { organizationRoleCards, rolesAllowing, rolesForVertical, roleMatchesSql, workspaceManagementRoles } from '~/utils/organization-access'
import { HTTPError, type H3Event } from 'nitro'
import { executeBatch, type BatchQuery, type DbClient } from '~/server/db'
import { assertRoleAllows, roleAllows, BATCH_VIEWER, joinedMemberPrincipal, membershipBySlugQuery, withViewer } from '~/server/utils/member-access'
import { bookedRecordsInRange, type BookedRecordInRange } from '~/server/domain/product-bookings'
import { prepareTaskList, openWorkQuery, taskUpdatePath, taskAssignees, taskAssigneesQuery, taskViewer, type OpenWorkRow, type TaskListQuery, type TaskSection } from '~/server/domain/tasks'
import { bookingWelcomesQuery, bookingWelcomeViews, setupQueries, setupViews } from '~/server/domain/opportunities'
import { bookingDay } from '~/server/domain/requests'
import { groupMediaPlacements, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { ownerPicture } from '~/server/notifications/hero'
import { bookingConversationOrRecordPath, guestConversationPath } from '~/shared/messages-contract'
import { guestGroup, UPCOMING_RESERVATION_DAYS, todayIcon, type BusinessToday, type TodayItem } from '~/shared/dashboard-today'
import { isChannelManagedStay, STAY_CHANNEL_LABELS } from '~/shared/bookings'
import { currencyFractionDigits, type CurrencyCode } from '~/shared/currencies'
import { bookingDues, PAYMENT_TASK_KIND, unpaidQuery, type UnpaidRow } from '~/server/domain/unpaid'
import { formatMinorAmount } from '~/shared/prices'
import { addLocalDays, formatCalendarDate, formatCalendarRange, formatTimestamp, localDateAt } from '~/utils/timezone'
import { resolveBookingPresentation } from '~/utils/booking-presentation'
import type { CloudflareEnv } from '~/server/utils/auth'
import { tenantOrganizationOrigin } from '~/utils/tenant-organization-origin'
import { prepareStayHomesDocument } from '~/server/domain/stays'
import { createPreviewToken, PREVIEW_TOKEN_QUERY, PREVIEW_TOKEN_TTL_MS, previewSecretOf, PUBLIC_WEBSITE_QUERY } from '~/server/utils/preview-token'
import { isDemoOrganization } from '~/shared/demo'
import { turnoverBeforeSql } from '~/server/domain/turnover-checklists'
import { turnoverReadiness, type StoredTurnover } from '~/shared/turnover-checklist'

/*
  Today and Upcoming for the person looking: the bookings they host in the
  range, the jobs they were put in charge of (or, for an owner or admin, that
  nobody is), a request waiting for their decision, a message that did not
  send and a change waiting on the business. One D1 round trip: the caller's
  membership by the route's slug, then every row, each statement scoped by
  that membership in SQL.
*/

type Range = 'today' | 'upcoming'

/** What a card counts as in the heading, singular and plural. */
const NOUNS = {
  reservation: ['reservation', 'reservations'], consultation: ['consultation', 'consultations'], class: ['class', 'classes'],
  clean: ['home to clean', 'homes to clean'], follow_up: ['follow-up', 'follow-ups'], request: ['request', 'requests'],
  change: ['change request', 'change requests'], message: ['message that didn’t send', 'messages that didn’t send'],
  task: ['task', 'tasks'], payment: ['payment to collect', 'payments to collect'],
  // Setup is listed but never counted in the heading.
  setup: ['', ''],
} as const

type Noun = keyof typeof NOUNS

/** A card as it is built: what it counts as, where it sorts, the bookings it stands for and the local day it is on. */
interface Card extends TodayItem { noun: Noun; order: [number, string]; bookings: string[]; day: string }

type TodayReadInput = { slug: string; range: Range; now: Date; staffAccessWrites?: boolean;
  presentation?: { env: CloudflareEnv; event: H3Event };
  native?: { env: CloudflareEnv; event: H3Event; query: TaskListQuery } }

export async function readToday(db: DbClient, input: TodayReadInput & { userId: string }) {
  const plan = prepareToday(input)
  return plan.read(await executeBatch(db, plan.queries, { operation: 'Read Today' }))
}

export function prepareToday(input: TodayReadInput & ({ userId: string } | { membership: BatchQuery })) {
  const { range, now, staffAccessWrites = true } = input
  const utcDay = now.toISOString().slice(0, 10)
  const from = utcDay, to = range === 'today' ? utcDay : addLocalDays(utcDay, UPCOMING_RESERVATION_DAYS + 1)
  const wideFrom = `${addLocalDays(from, -1)}T00:00:00.000Z`, wideTo = `${addLocalDays(to, 1)}T23:59:59.999Z`
  const membership = 'membership' in input ? input.membership : membershipBySlugQuery(input.slug, input.userId)
  const org = BATCH_VIEWER.organization
  const window = `(starts_at <= ? AND ends_at >= ?${range === 'today' ? " OR status = 'pending'" : ''})`
  // What only an owner or admin reads: a member's statements name no organization and read nothing.
  const managed = { sql: `CASE WHEN ${BATCH_VIEWER.organizationWide} = 1 THEN ${org} END` }
  const management = { sql: `CASE WHEN ${roleMatchesSql(BATCH_VIEWER.role!, workspaceManagementRoles)} THEN ${org} END` }
  const tasks = input.native ? prepareTaskList(input.native.query, now) : null
  const homes = prepareStayHomesDocument(null)
  const queries = [
    membership,
    withViewer(membership, bookedRecordsInRange(BATCH_VIEWER, { from, to, pending: range === 'today', includePayments: true })),
    withViewer(membership, openWorkQuery(BATCH_VIEWER, to, now.toISOString())),
    // What the bookings with a payment due today owe, for the people who manage the business.
    withViewer(membership, unpaidQuery(range === 'today' ? management : { sql: 'NULL' }, {
      sql: `SELECT subject_id FROM tasks WHERE organization_id = ${org} AND kind = '${PAYMENT_TASK_KIND}' AND status = 'open' AND due_at <= ?`, params: [wideTo] })),
    withViewer(membership, mediaPlacementsQuery({ organizationId: { sql: org }, ownerType: 'product', owners: {
      sql: `SELECT product_id FROM bookings WHERE organization_id = ${org} AND status <> 'cancelled' AND ${window}
        UNION SELECT product_id FROM tasks WHERE organization_id = ${org} AND status = 'open' AND product_id IS NOT NULL`, params: [wideTo, wideFrom] } })),
    withViewer(membership, mediaPlacementsQuery({ organizationId: { sql: org }, ownerType: 'business_location', owners: {
      sql: `SELECT location_id FROM bookings WHERE organization_id = ${org} AND location_id IS NOT NULL AND status <> 'cancelled' AND ${window}
        UNION SELECT location_id FROM tasks WHERE organization_id = ${org} AND status = 'open' AND kind = 'maintenance' AND product_id IS NULL`, params: [wideTo, wideFrom] } })),
    withViewer(membership, bookingWelcomesQuery(managed, { now })),
    // Whether each arriving stay's home is ready: the stored status of the turnover before it.
    withViewer(membership, { query: `SELECT b.id, ${turnoverBeforeSql('b')} AS turnover FROM bookings b
      WHERE b.organization_id = ${org} AND b.product_session_id IS NULL AND b.status = 'confirmed' AND b.starts_at <= ? AND b.ends_at >= ?`, params: [wideTo, wideFrom] }),
    // The setup the business has not finished is Today's, after the day's cards.
    ...setupQueries(management, { now }).map(query => withViewer(membership, query)),
    withViewer(membership, taskAssigneesQuery(managed)),
    ...(staffAccessWrites ? [withViewer(membership, staffListingsQuery(managed.sql, '(SELECT vertical FROM viewer)'))] : []),
  ]
  const count = queries.length
  queries.push(...[...(tasks?.queries ?? []), ...homes.queries].map(query => withViewer(membership, query)))
  return { queries, read: (results: D1Result[]) => presentToday(results.slice(0, count), input, {
    tasks: tasks ? (viewer: Awaited<ReturnType<typeof taskViewer>>) => tasks.read(results.slice(count, count + tasks.queries.length), viewer) : null,
    homes: homes.read(results.slice(count + (tasks?.queries.length ?? 0))),
  }) }
}

async function presentToday(
  [viewerResult, recordResult, workResult, unpaidResult, productResult, locationResult, welcomeResult, readinessResult, factResult, unpricedResult, improvementResult, assigneeResult, listingResult]: D1Result[],
  input: TodayReadInput,
  context: { tasks: ((viewer: Awaited<ReturnType<typeof taskViewer>>) => Promise<{ sections: TaskSection[] }>) | null;
    homes: import('~/server/domain/stays').StayHome[] },
) {
  const { range, now, native, staffAccessWrites = true } = input
  const viewer = viewerResult!.results[0] as { organization_id: string; member_id: string; user_id: string; slug: string; vertical: string | null; role: string;
    organization_wide: number; status: string; onboarding_status: string; subdomain: string | null; public_url: string | null } | undefined
  if (!viewer) throw new HTTPError({ statusCode: 404, message: 'Organization not found', data: { code: 'ORGANIZATION_NOT_FOUND', field: 'org' } })
  await assertRoleAllows({ organizationId: viewer.organization_id, role: viewer.role, permissions: { task: ['read'] } })
  const manage = viewer.organization_wide === 1
  const administration = viewer.role.split(',').some(value => workspaceManagementRoles.some(role => role === value.trim()))
  const products = groupMediaPlacements(productResult!.results), locations = groupMediaPlacements(locationResult!.results)
  const picture = (ownerType: 'product' | 'business_location', id: string | null) => id === null ? null
    : ownerPicture(ownerType, (ownerType === 'product' ? products : locations).get(id) ?? [], [])?.imageUrl ?? null
  const welcomes = new Map(bookingWelcomeViews(welcomeResult!.results, { now, slug: viewer.slug, vertical: viewer.vertical })
    .map(welcome => [welcome.conversation_id!, welcome] as const))

  const today = (timezone: string) => localDateAt(now, timezone)
  const shows = (day: string, timezone: string) => range === 'today' ? day === today(timezone) : day > today(timezone) && day <= addLocalDays(today(timezone), UPCOMING_RESERVATION_DAYS)
  const time = (instant: string, timezone: string) => formatTimestamp(instant, 'en', timezone, { hour: 'numeric', minute: '2-digit' })
  const dayTime = (instant: string, timezone: string) => `${formatTimestamp(instant, 'en', timezone, { weekday: 'short', month: 'short', day: 'numeric' })} · ${time(instant, timezone)}`
  const nights = (record: Pick<BookedRecordInRange, 'starts_at' | 'ends_at' | 'timezone'>) => formatCalendarRange(bookingDay(record.starts_at, record.timezone), bookingDay(record.ends_at, record.timezone), 'en-US')
  const visitWhen = (instant: string, timezone: string) => range === 'today' ? time(instant, timezone) : dayTime(instant, timezone)
  const recordPath = (bookingId: string, conversationId: string | null, seated: number) => bookingConversationOrRecordPath(viewer.slug, bookingId, seated ? conversationId : null)
  const first = (name: string | null) => name?.trim().split(/\s+/)[0] || null
  // Who booked, in the business's word: a home's guests, a law firm's client or clients.
  const counterparty = (record: BookedRecordInRange) => {
    if (record.unit === 'nights') return 'guests'
    const noun = resolveBookingPresentation(record.product_kind, viewer.vertical).counterpartyNoun
    return record.party_size === 1 ? noun : `${noun}s`
  }

  const turnovers = new Map((readinessResult!.results as Array<{ id: string; turnover: string | null }>).map(row => [row.id, row.turnover === null ? null : JSON.parse(row.turnover) as StoredTurnover]))
  const cards: Card[] = []
  const byBooking = new Map<string, Card>()
  const byClass = new Map<string, { card: Card; party: number }>()
  const add = (input: Omit<Card, 'done' | 'destination'> & { done?: Card['done']; destination?: Card['destination'] }) => {
    const card: Card = { done: null, destination: null, ...input }
    cards.push(card)
    for (const id of card.bookings) byBooking.set(id, card)
    return card
  }

  for (const record of (recordResult!.results as BookedRecordInRange[])) {
    const zone = record.timezone
    const start = bookingDay(record.starts_at, zone), end = bookingDay(record.ends_at, zone)
    const guest = first(record.guest_name)
    const group = guestGroup(record.guest_name, record.party_size)
    const Group = group.charAt(0).toUpperCase() + group.slice(1)
    const image = record.product_kind === 'table' ? picture('business_location', record.location_id) : picture('product', record.product_id)
    // A visit with no location is held online, as its booking reads it.
    const place = record.unit === 'nights' ? record.product_name : [record.product_kind === 'table' ? null : record.product_name, record.location_id === null ? 'Online' : record.location_title].filter(Boolean).join(' · ') || null
    const line = [place, administration ? money(record) : null].filter(Boolean).join(' · ') || null
    const to = recordPath(record.id, record.conversation_id, record.viewer_seated)
    const welcome = record.conversation_id ? welcomes.get(record.conversation_id) : undefined
    const opens = record.conversation_id && record.viewer_seated
    const named = !guest
      ? { title: 'Open the reservation', detail: record.owner === 'channel' ? `No guest name came from ${STAY_CHANNEL_LABELS[record.channel]}` : 'No guest name was recorded' }
      : opens ? { title: `Say hello to your ${counterparty(record)}`, detail: 'See if they have any questions' } : { title: 'Open the reservation', detail: `See what ${guest} booked` }
    const action = welcome && opens ? { title: welcome.title, detail: welcome.detail } : named
    const base = { image_url: image, icon: todayIcon(record.product_kind), line, to, draft: welcome && opens ? welcome.message : null, bookings: [record.id], day: start }
    if (record.status === 'pending') {
      // A request waits for a decision whenever it is for; Today shows it until it is answered.
      if (range === 'today') add({ ...base, id: `booking:${record.id}`, noun: 'request', order: [1, record.starts_at], draft: null,
        when: record.unit === 'nights' ? nights(record) : dayTime(record.starts_at, zone), headline: `${Group} wants to book`,
        action: { title: 'Review the request', detail: 'Accept or decline' } })
      continue
    }
    if (record.unit === 'nights') {
      const timed = (value: string) => value.length > 10 ? time(value, zone) : nights(record)
      // Ready, Ready with a shortage, or Not cleaned yet: the turnover before this arrival as it is stored. From two hours out it is the card's action.
      const readiness = turnoverReadiness(turnovers.get(record.id) ?? null, record.starts_at, now)
      const arriving = readiness ? { ...base, line: [place, readiness.label, administration ? money(record) : null].filter(Boolean).join(' · ') } : base
      const ready = readiness?.urgent ? { title: 'Not cleaned yet', detail: `Guests arrive ${record.starts_at.length > 10 ? `at ${time(record.starts_at, zone)}` : 'today'}` } : action
      // A stay unnamed by its channel is "a group of 2 from Airbnb"; one added by hand without a name, "a group of 2 you added".
      const who = guest ? group : `${group} ${record.owner === 'channel' ? `from ${STAY_CHANNEL_LABELS[record.channel]}` : 'you added'}`
      const Who = who.charAt(0).toUpperCase() + who.slice(1)
      if (range === 'upcoming') {
        if (shows(start, zone)) add({ ...arriving, id: `booking:${record.id}`, noun: 'reservation', order: [0, record.starts_at], when: nights(record), headline: Who, action })
        continue
      }
      if (start === today(zone)) add({ ...arriving, id: `arrival:${record.id}`, noun: 'reservation', order: [0, record.starts_at], when: timed(record.starts_at), headline: `${Who} checks in`, action: ready })
      if (end === today(zone)) add({ ...base, day: end, id: `departure:${record.id}`, noun: 'reservation', order: [0, record.ends_at], when: timed(record.ends_at), headline: `${Who} checks out`, action: guest && opens ? { title: `Message ${guest}`, detail: 'See if they have any questions' } : named })
      continue
    }
    if (!shows(start, zone)) continue
    if (record.product_kind === 'experience' && record.product_session_id) {
      // A class is one card for everyone booked into it.
      const held = byClass.get(record.product_session_id)
      if (held) {
        held.party += record.party_size
        held.card.bookings.push(record.id); byBooking.set(record.id, held.card)
        continue
      }
      const card = add({ ...base, id: `class:${record.product_session_id}`, noun: 'class', order: [0, record.starts_at], draft: null, when: visitWhen(record.starts_at, zone), headline: '',
        to: `/dashboard/${encodeURIComponent(viewer.slug)}/calendar/sessions/${encodeURIComponent(record.product_session_id)}?${new URLSearchParams({ date: start, product_id: record.product_id })}`,
        destination: { native: 'session', title: 'Edit availability', query: { product_id: record.product_id, product_session_id: record.product_session_id, date: start } },
        action: { title: 'Review availability', detail: 'See this scheduled session' } })
      byClass.set(record.product_session_id, { card, party: record.party_size })
      continue
    }
    const service = record.product_kind === 'service'
    add({ ...base, id: `booking:${record.id}`, noun: service ? 'consultation' : 'reservation', order: [0, record.starts_at], when: visitWhen(record.starts_at, zone),
      headline: service ? guest && record.party_size > 1 ? `${Group}, consultation` : `${guest ? `${guest}’s` : 'A'} consultation` : guest && record.party_size === 1 ? `${guest}’s reservation` : Group,
      action })
  }
  for (const [, held] of byClass) {
    const record = (recordResult!.results as BookedRecordInRange[]).find(row => row.id === held.card.bookings[0])!
    // A class is named by itself; its line is where and how many people are booked.
    held.card.headline = record.product_name
    held.card.line = [record.location_id === null ? 'Online' : record.location_title, `${held.party} ${held.party === 1 ? 'guest' : 'guests'}`].filter(Boolean).join(' · ')
  }

  const payments = new Map<string, OpenWorkRow[]>()
  for (const work of workResult!.results as OpenWorkRow[]) {
    if (work.kind === PAYMENT_TASK_KIND) {
      // One card for everything a booking has to pay, built below once every task is read.
      if (range === 'today' && administration && work.booking_id) payments.set(work.booking_id, [...payments.get(work.booking_id) ?? [], work])
      continue
    }
    const job = work.kind === 'turnover' || work.kind === 'consultation_follow_up' || work.kind === 'consultation_prep' || work.kind === 'maintenance'
    const bookingZone = work.booking_timezone ?? work.timezone
    const at = work.starts_at ?? work.due_at
    // An untimed job is on its booking's day: a clean on the checkout.
    const untimed = work.booking_ends_at
    const day = at ? localDateAt(new Date(at), work.timezone) : untimed ? bookingDay(untimed, bookingZone) : null
    const guest = first(work.guest_name)
    const group = work.party_size === null ? 'a guest' : guestGroup(work.guest_name, work.party_size)
    const to = work.booking_id ? recordPath(work.booking_id, work.guest_conversation_id, work.viewer_seated) : null
    if (work.kind === 'custom') {
      // A task someone added: the viewer's, or nobody's for an owner or admin; closed in one tap from its card.
      const available = !manage && work.claim_role !== null && work.assigned_member_id === null
      if (!(available || work.assigned_to_viewer || (work.assigned_member_id === null && manage))) continue
      if (day === null ? range !== 'today' : range === 'today' ? day > today(work.timezone) : !shows(day, work.timezone)) continue
      if (!work.title) throw new Error(`Task ${work.id} has no title`)
      add({ id: `task:${work.id}`, noun: 'task', order: [1, at ?? ''], bookings: [], day: day ?? today(work.timezone),
        when: at ? visitWhen(at, work.timezone) : null, image_url: picture('product', work.product_id), icon: 'i-lucide-list-checks', headline: work.title,
        line: available ? work.product_name : work.created_by_viewer ? 'Added by you' : work.creator_name ? `Added by ${first(work.creator_name)}` : null,
        action: available ? { title: 'Available to claim', detail: '' } : { title: 'Mark as done', detail: work.notes ?? 'One tap when it’s finished' }, to: null, draft: null,
        ...(available ? { claim: { path: taskUpdatePath(viewer.organization_id, work.id), version: work.version, label: 'Claim' } } : {}),
        done: available ? null : { path: `/api/organizations/${encodeURIComponent(viewer.organization_id)}/tasks/${encodeURIComponent(work.id)}/complete` } })
      continue
    }
    if (work.kind === 'order_fulfillment') {
      // A paid order is today's work from the moment it is paid until it is sent or collected, as Shopify lists unfulfilled orders; its conversation holds the order panel.
      if (range !== 'today' || !(work.assigned_to_viewer || manage)) continue
      if (work.order_number === null || !work.order_conversation_id) throw new Error(`Order task ${work.id} has no order`)
      const buyer = first(work.order_guest_name) ?? 'the buyer'
      const dueDay = work.due_at ? localDateAt(new Date(work.due_at), work.timezone) : null
      const shipBy = dueDay === null ? null : dueDay < today(work.timezone) ? `Overdue since ${formatCalendarDate(dueDay, 'en', { weekday: 'short', month: 'short', day: 'numeric' })}` : `Ship by ${formatCalendarDate(dueDay, 'en', { weekday: 'short', month: 'short', day: 'numeric' })}`
      const pickup = work.order_delivery_method === 'pickup'
      add({ id: `task:${work.id}`, noun: 'task', order: [1, work.due_at ?? ''], bookings: [], day: today(work.timezone),
        when: pickup ? 'Pickup' : shipBy, image_url: null, icon: 'i-lucide-list-checks',
        // The place is said only where it matters: where a pickup is collected.
        headline: pickup ? `Order #${work.order_number} for pickup by ${buyer}` : `Ship order #${work.order_number} to ${buyer}`, line: pickup ? work.location_title : null,
        action: { title: 'Open order', detail: pickup ? 'Mark as collected when it is picked up' : 'Mark as shipped with its tracking' },
        to: guestConversationPath(viewer.slug, work.order_conversation_id), draft: null })
      continue
    }
    if (work.kind === 'maintenance') {
      // A repair: its person's card, which they close in one tap, and every repair for the people who manage the business.
      if (!work.assigned_to_viewer && !manage) continue
      if (day === null ? range !== 'today' : range === 'today' ? day > today(work.timezone) : !shows(day, work.timezone)) continue
      if (!work.title) throw new Error(`Maintenance job ${work.id} has no title`)
      const formatCalendarDay = (date: string) => formatCalendarDate(date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })
      // The deadline is its due day, whichever day it starts.
      const dueDay = work.due_at ? localDateAt(new Date(work.due_at), work.timezone) : null
      const due = dueDay === null ? null : dueDay === today(work.timezone) ? 'Due today' : dueDay < today(work.timezone) ? `Overdue since ${formatCalendarDay(dueDay)}` : `Due ${formatCalendarDay(dueDay)}`
      const team = work.team_conversation_id
      add({ id: `task:${work.id}`, noun: 'task', order: [1, at ?? ''], bookings: [], day: day ?? today(work.timezone),
        when: ['Maintenance', due].filter(Boolean).join(' · '),
        image_url: work.product_id ? picture('product', work.product_id) : picture('business_location', work.location_id),
        icon: work.product_kind ? todayIcon(work.product_kind) : 'i-lucide-list-checks', headline: work.title, line: work.product_name ?? work.location_title,
        // The job's conversation is where its note and photos go; the card's strip closes it.
        action: work.assigned_to_viewer ? { title: 'Mark as done', detail: work.notes ?? 'Add a note and photos in the job’s conversation' }
          : { title: `${first(work.assignee_name) ?? 'A teammate'} has it`, detail: 'Open the job' },
        to: team ? guestConversationPath(viewer.slug, team) : null, draft: null,
        done: work.assigned_to_viewer ? { path: `${taskUpdatePath(viewer.organization_id, work.id)}/complete` } : null })
      continue
    }
    if (!job) {
      // A message that did not send and a change waiting on the business are today's work.
      if (range !== 'today' || !work.booking_id || !to || !work.booking_starts_at || !work.booking_ends_at) continue
      const bookedWhen = work.booking_unit === 'nights' ? nights({ starts_at: work.booking_starts_at, ends_at: work.booking_ends_at, timezone: bookingZone }) : dayTime(work.booking_starts_at, bookingZone)
      const place = [work.product_kind === 'table' ? null : work.product_name, work.booking_unit === 'nights' ? null : work.location_id === null ? 'Online' : work.location_title].filter(Boolean).join(' · ') || null
      const opens = Boolean(work.guest_conversation_id && work.viewer_seated)
      const image = work.product_kind === 'table' ? picture('business_location', work.location_id) : picture('product', work.product_id)
      if (work.kind === 'message_delivery') {
        if (!work.message_title) throw new Error(`Delivery task ${work.id} has no scheduled message`)
        add({ id: `task:${work.id}`, noun: 'message', order: [1, work.booking_starts_at], bookings: [], day: today(work.timezone), when: bookedWhen, image_url: image, icon: todayIcon(work.product_kind), line: place, to, draft: null,
          headline: `${work.message_title} to ${guest ?? 'the guest'} didn’t send`, action: work.unreachable_reason
            ? { title: opens ? 'Open conversation' : 'Open booking', detail: work.unreachable_reason }
            : { title: 'Send it yourself', detail: opens ? `Open ${guest ?? 'the guest'}’s conversation` : 'Open the reservation' } })
      } else {
        const Group = group.charAt(0).toUpperCase() + group.slice(1)
        add({ id: `task:${work.id}`, noun: 'change', order: [1, work.booking_starts_at], bookings: [], day: today(work.timezone), when: bookedWhen, image_url: image, icon: todayIcon(work.product_kind), line: place, to, draft: null,
          headline: `${Group} asked to change their ${work.booking_unit === 'nights' ? 'stay' : 'booking'}`, action: { title: 'Review the change', detail: 'Accept or decline' } })
      }
      continue
    }
    if (day === null || (range === 'today' ? day > today(work.timezone) : !shows(day, work.timezone))) continue
    // A follow-up is due the day after its visit: it is work on the day it is due, and Upcoming already shows the visit.
    if (work.kind === 'consultation_follow_up' && range === 'upcoming') continue
    // A job always has someone. Another person's clean is the action of its booking's card on that day ("Casey is cleaning");
    // the viewer's own job is its own card, which opens the job's conversation, where its Done is.
    const confirmed = work.accepted_member_id !== null && work.accepted_member_id === work.assigned_member_id
    if (!work.assigned_to_viewer) {
      // A clean offered to the home's cleaners: any of them accepts it from its card; the first to do so has it.
      if (work.kind === 'turnover' && work.claim_role !== null && work.accepted_member_id === null && !manage) {
        add({ id: `task:${work.id}`, noun: 'clean', order: [0, at ?? untimed ?? ''], bookings: [], day,
          when: at ? visitWhen(at, work.timezone) : range === 'today' ? 'Today' : formatTimestamp(`${day}T12:00:00.000Z`, 'en', 'UTC', { weekday: 'short', month: 'short', day: 'numeric' }),
          image_url: picture('product', work.product_id), icon: todayIcon(work.product_kind), headline: `Clean up after ${group}`, line: work.product_name,
          action: { title: 'Available to accept', detail: 'The first cleaner to accept has it' }, to: null, draft: null,
          claim: { path: taskUpdatePath(viewer.organization_id, work.id), version: work.version, label: 'Accept' } })
        continue
      }
      const held = work.kind === 'turnover' && work.booking_id ? byBooking.get(work.booking_id) : undefined
      const cleaner = first(work.assignee_name) ?? 'A teammate'
      if (held?.day === day) held.action = { title: confirmed ? `${cleaner} is cleaning` : `${cleaner} hasn’t confirmed yet`, detail: guest && work.viewer_seated ? `Message ${guest}` : held.action.detail }
      continue
    }
    // Prep is the host's own preparation for a visit already on their list.
    if (work.kind === 'consultation_prep') {
      if (manage || work.product_kind !== 'service' || (work.booking_id && byBooking.has(work.booking_id))) continue
      add({ id: `task:${work.id}`, noun: 'task', order: [1, at ?? ''], bookings: [], day,
        when: at ? visitWhen(at, work.timezone) : null, image_url: picture('product', work.product_id), icon: 'i-lucide-list-checks',
        headline: 'Prepare for consultation', line: work.product_name, action: { title: 'Mark as done', detail: 'One tap when it’s finished' },
        to: null, draft: null, done: { path: taskUpdatePath(viewer.organization_id, work.id) + '/complete' } })
      continue
    }
    const headline = work.kind === 'turnover' ? `Clean up after ${group}` : `Follow up with ${group}`
    const team = work.team_conversation_id
    add({
      id: `task:${work.id}`, noun: work.kind === 'consultation_follow_up' ? 'follow_up' : 'clean', order: [0, at ?? untimed ?? ''], bookings: [], day,
      when: at ? visitWhen(at, work.timezone) : range === 'today' ? 'Today' : formatTimestamp(`${day}T12:00:00.000Z`, 'en', 'UTC', { weekday: 'short', month: 'short', day: 'numeric' }),
      image_url: picture('product', work.product_id), icon: todayIcon(work.product_kind), headline: headline.charAt(0).toUpperCase() + headline.slice(1),
      line: work.booking_unit === 'nights' ? work.product_name : work.location_id === null ? 'Online' : work.location_title,
      // The host's own job has nobody to message: it opens the job, where its Done is.
      action: work.kind === 'turnover' && !confirmed && !manage ? { title: 'Accept or hand it back', detail: 'Open the job to confirm you can clean' }
        : manage ? { title: 'Open the job', detail: 'Tap Done when it’s finished' }
        : { title: 'Message the host', detail: range === 'today' ? 'Send photos when you’re done' : 'Ask anything before the day' },
      // The job's conversation is written with the job; a job read before it exists is not linked anywhere else.
      to: team ? guestConversationPath(viewer.slug, team) : null, draft: null,
    })
  }

  // Who has to pay: a booking whose rent, balance or deposit fell due on or before today, as its open tasks say,
  // in the amounts its stored payments leave owing. The writes that cancel a booking or settle a debt close its tasks.
  const owing = new Map((unpaidResult!.results as UnpaidRow[]).map(row => [row.id, row]))
  for (const [bookingId, tasks] of payments) {
    const work = tasks[0]!
    const row = owing.get(bookingId)
    const zone = row?.timezone ?? work.booking_timezone ?? work.timezone
    const guest = first(row?.guest_name ?? work.guest_name)
    const fallen = tasks.filter(task => task.due_at && localDateAt(new Date(task.due_at), zone) <= today(zone))
    const due = (row ? bookingDues(row, row, now) : []).filter(entry => fallen.some(task => task.dedupe_key === `payment:${bookingId}:${entry.key}`))
      .sort((left, right) => left.due_at.localeCompare(right.due_at))
    // A task whose debt the stored payments no longer show is out of date: its card says so, and the rest of Today stands.
    if (due.length < fallen.length) {
      add({ id: `unpaid:${bookingId}`, noun: 'payment', order: [1, fallen[0]!.due_at!], bookings: [], day: today(zone), when: null, image_url: null, icon: 'i-lucide-credit-card',
        headline: `What ${guest ?? 'this booking'} owes couldn’t be read`, line: row?.product_name ?? work.product_name,
        action: { title: 'Open the reservation', detail: 'Its payments changed since this was written; check them there' },
        to: recordPath(bookingId, work.guest_conversation_id, work.viewer_seated), draft: null })
      continue
    }
    if (!due.length || !row) continue
    if (!row.currency) throw new Error(`Booking ${bookingId} owes money and has no currency`)
    const oldest = due[0]!
    const late = oldest.due_on < today(zone)
    const what = oldest.reason === 'rent' ? `rent is ${late ? 'overdue' : 'due today'}` : oldest.reason === 'balance' ? 'stay balance is unpaid' : `${oldest.label.toLowerCase()} hasn’t been received`
    const total = due.reduce((sum, entry) => sum + entry.owed_minor, 0)
    const amount = formatMinorAmount(total, row.currency as CurrencyCode, 'en-US', total % (10 ** currencyFractionDigits(row.currency)) === 0 ? 0 : undefined)
    const place = [row.product_name, row.unit === 'nights' ? null : row.location_id === null ? 'Online' : row.location_title].filter(Boolean).join(' · ')
    const opens = Boolean(work.guest_conversation_id && work.viewer_seated)
    add({ id: `unpaid:${bookingId}`, noun: 'payment', order: [1, oldest.due_at], bookings: [], day: today(zone),
      when: late ? `Overdue since ${formatCalendarDate(oldest.due_on, 'en', { month: 'short', day: 'numeric' })}` : 'Due today',
      image_url: null, icon: 'i-lucide-credit-card', headline: guest ? `${guest}’s ${what}` : `${what.charAt(0).toUpperCase()}${what.slice(1)}`,
      line: [place, amount].filter(Boolean).join(' · '),
      action: opens && guest ? { title: `Message ${guest}`, detail: `${amount} to collect` } : { title: 'Open the reservation', detail: `${amount} to collect` },
      to: recordPath(bookingId, work.guest_conversation_id, work.viewer_seated), draft: null })
  }

  // The business's unfinished setup, after the day's cards: each opens the editor or settings that finishes it.
  const quiet = cards.length === 0
  const suggestions = setupViews(factResult!.results, unpricedResult!.results, quiet ? improvementResult!.results : [])?.opportunities ?? []
  const opportunities = (range === 'today' || quiet ? suggestions : []).filter(step => quiet || step.id.startsWith('payments.connect:') || step.id.startsWith('product.create:') || step.id.startsWith('product.readiness:')).slice(0, 3)
  for (const [index, step] of opportunities.entries()) {
    add({ id: step.id, noun: 'setup', order: [2, String(index).padStart(4, '0')], bookings: [], day: '', when: null, image_url: null, icon: step.icon,
      headline: step.title, line: null, action: { title: step.detail.replace(/\.$/, ''), detail: step.status_line }, to: step.path, destination: step.destination, draft: null })
  }

  cards.sort((a, b) => a.order[0] - b.order[0] || a.order[1].localeCompare(b.order[1]) || a.id.localeCompare(b.id))
  const response: BusinessToday = {
    title: heading(cards, range), cards: cards.map(({ noun: _noun, order: _order, bookings: _bookings, day: _day, ...card }) => card),
    ...(manage && staffAccessWrites ? { claim_options: {
      roles: rolesForVertical(viewer.vertical)
        .filter(role => rolesAllowing({ task: ['claim'] }).includes(role) && organizationRoleCards[role].access.includes('tasks'))
        .map(value => ({ value, label: organizationRoleCards[value].label })),
      listings: listingResult!.results as NonNullable<BusinessToday['claim_options']>['listings'],
    } } : {}),
    assignees: taskAssignees(assigneeResult!.results, viewer.user_id), resolved_at: now.toISOString(), website: null,
    home_context: { homes: context.homes, manage: await roleAllows({ organizationId: viewer.organization_id, role: viewer.role, permissions: { operations: ['update'] } }) },
    actions: {
      add_task: await roleAllows({ organizationId: viewer.organization_id, role: viewer.role, permissions: { task: ['create'] } }),
      add_stay: context.homes.length > 0 && await roleAllows({ organizationId: viewer.organization_id, role: viewer.role, permissions: { operations: ['update'] } }),
    },
  }
  // Installed TodayWork clients still read task sections. Their canonical task plan shares this batch.
  const principal = native ? joinedMemberPrincipal({ userId: viewer.user_id, organizationId: viewer.organization_id,
    memberId: viewer.member_id, role: viewer.role }, native) : null
  const sections = context.tasks && principal ? (await context.tasks(await taskViewer(principal))).sections : null
  const privateSite = viewer.status === 'inactive'
  const hasOpenWork = cards.some(card => card.noun !== 'setup')
  let website = null
  const presentation = input.presentation ?? native
  if (presentation && range === 'today' && !native?.query.kind && !native?.query.location_id && administration && viewer.onboarding_status === 'active'
    && (privateSite || viewer.status === 'active' && !hasOpenWork) && !isDemoOrganization(viewer)) {
    if (!viewer.public_url) throw new HTTPError({ statusCode: 409, message: 'Configure the website address before opening its preview', data: { code: 'TODAY_WEBSITE_ADDRESS_REQUIRED', field: 'website.address' } })
    {
      const origin = tenantOrganizationOrigin({ platformDomain: presentation.env.NUXT_PUBLIC_PLATFORM_DOMAIN ?? '',
        freeOrganizationDomain: presentation.env.NUXT_PUBLIC_FREE_ORGANIZATION_DOMAIN ?? '', subdomain: viewer.subdomain ?? '',
        canonicalDomain: new URL(viewer.public_url).hostname })
      if (!origin) throw new HTTPError({ statusCode: 502, message: 'The website has no configured public origin', data: { code: 'INVALID_TODAY_WEBSITE', field: 'website.address' } })
      const address = `${origin}/`
      const preview = new URL(address)
      const secret = previewSecretOf(presentation.env)
      if (!secret) throw new HTTPError({ statusCode: 500, message: 'Website preview signing is unavailable', data: { code: 'TODAY_WEBSITE_PREVIEW_UNAVAILABLE', field: 'website.preview_url' } })
      preview.searchParams.set(PREVIEW_TOKEN_QUERY, await createPreviewToken(secret, viewer.organization_id, now.getTime() + PREVIEW_TOKEN_TTL_MS))
      website = {
        address, preview_url: preview.toString(), preview_label: 'Website preview', status_label: privateSite ? 'Private' : 'Live',
        action: privateSite
          ? { label: 'Publish website', to: `/dashboard/${encodeURIComponent(viewer.slug)}/website?publish=1`, type: 'publish' }
          : { label: 'View website', to: address + PUBLIC_WEBSITE_QUERY, type: 'visit' },
      }
    }
  }
  return { ...response, website,
    ...(sections ? { tasks: sections, opportunities: privateSite ? opportunities.slice(0, 3) : opportunities, opportunity_issues: [] } : {}),
  }
}

/**
 * "You have 2 reservations and 1 task", "You have 2 upcoming reservations",
 * "Nothing needs you today". Setup is not counted: a business with only setup
 * left reads "Finish setting up to take bookings".
 */
function heading(cards: Card[], range: Range): string {
  const counted = cards.filter(card => card.noun !== 'setup')
  if (!counted.length) return cards.some(card => /^(product.create|product.readiness):/.test(card.id)) ? 'Finish setting up to take bookings' : range === 'today' ? 'Nothing needs you today' : 'Nothing needs you in the coming days'
  const parts = (Object.keys(NOUNS) as Noun[]).filter(noun => noun !== 'setup').flatMap((noun) => {
    const count = cards.filter(card => card.noun === noun).length
    return count ? [`${count} ${range === 'upcoming' ? 'upcoming ' : ''}${NOUNS[noun][count === 1 ? 0 : 1]}`] : []
  })
  return `You have ${parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0]}`
}

/** What an owner or admin reads of a booking's money, only when there is some: "$1,240 paid", "$200 of $380 paid", "free", a request's price. */
function money(record: Pick<BookedRecordInRange, 'status' | 'unit' | 'owner' | 'channel' | 'total_minor' | 'currency' | 'paid_minor' | 'id'>): string | null {
  if (record.unit === 'nights' && isChannelManagedStay(record)) return record.channel === 'direct' ? null : `Paid through ${STAY_CHANNEL_LABELS[record.channel]}`
  if (record.total_minor === 0) return 'free'
  const format = (amount: number) => {
    if (!record.currency) throw new Error(`Booking ${record.id} has an amount and no currency`)
    const whole = amount % (10 ** currencyFractionDigits(record.currency)) === 0
    return formatMinorAmount(amount, record.currency, 'en-US', whole ? 0 : undefined)
  }
  if (record.status === 'pending') return record.total_minor === null ? null : format(record.total_minor)
  if (record.paid_minor > 0) return record.total_minor !== null && record.paid_minor < record.total_minor ? `${format(record.paid_minor)} of ${format(record.total_minor)} paid` : `${format(record.paid_minor)} paid`
  return null
}

