import { memberAccessPrincipal } from '~/server/utils/member-access'
import { closeTask, createTask, getTask, listTaskAssignees, listTasks, parseTaskListQuery, taskViewer, updateTask, TASK_KINDS } from '~/server/domain/tasks'
import { copyHomeChecklist, readHomeChecklist, saveHomeChecklist } from '~/server/domain/home-checklists'
import { readHomeTeam, setHomeCleaning } from '~/server/domain/home-cleaning'
import { setListingAccess } from '~/server/domain/conversation-participants'
import { listTurnoverSubmissions, photoImage, readTurnoverSubmission } from '~/server/domain/turnover-submissions'
import { stayAccessFor } from '~/server/domain/stays'
import { renderStructuredResponse } from '~/server/utils/mcp-render'
import { CHECKLIST_LIMITS } from '~/shared/turnover-checklist'
import { listOpportunities } from '~/server/domain/opportunities'
import { organizationTool, type McpToolDefinition } from './shared'
import { NOT_HANDLED, optionalString, requiredString, type McpExecutorContext } from './execution'

const text = { type: 'string' }, nullableText = { type: ['string', 'null'] }
const instant = { type: 'string', format: 'date-time', description: 'An instant with Z or a numeric offset.' }
const person = { type: 'object', properties: { type: { type: 'string', enum: ['member'] }, id: text, name: text, initial: text, you: { type: 'boolean' } }, required: ['type', 'id', 'name', 'initial', 'you'] }
const photo = { type: 'object', properties: { id: text, url: text, thumbnail_url: text }, required: ['id', 'url', 'thumbnail_url'] }
const nullablePhoto = { anyOf: [photo, { type: 'null' }] }
const arrival = { anyOf: [{ type: 'object', properties: { guests: { type: 'integer' }, check_in_date: text }, required: ['guests', 'check_in_date'] }, { type: 'null' }], description: 'The next confirmed arrival at the home after this turnover, as bookings stand now; null when none is booked.' }
const taskChecklist = { anyOf: [{ type: 'object', properties: {
  arrival, arrival_label: { ...text, description: '"4 guests arriving Fri, Nov 28" or "No arrival booked yet".' },
  close_without: { type: 'boolean', description: 'You are an owner or admin and may close the job without the checklist; anyone else is refused CHECKLIST_REQUIRED.' },
  items: { type: 'array', items: { type: 'object', properties: { id: text, title: text, instructions: nullableText, type: { type: 'string', enum: ['confirm', 'count'] },
    required: { type: ['integer', 'null'], description: 'For a count: the number this job requires for the arrival; null for a confirm.' }, photo_required: { type: 'boolean' }, reference_photo: nullablePhoto },
  required: ['id', 'title', 'instructions', 'type', 'required', 'photo_required', 'reference_photo'] } },
}, required: ['arrival', 'arrival_label', 'close_without', 'items'] }, { type: 'null' }], description: 'An open turnover at a home with a checklist: what Done asks for. Null otherwise.' }
const homeItem = { id: text, title: { ...text, minLength: 1, maxLength: CHECKLIST_LIMITS.title }, instructions: { type: ['string', 'null'], maxLength: CHECKLIST_LIMITS.instructions },
  type: { type: 'string', enum: ['confirm', 'count'], description: 'confirm: done or not. count: the cleaner enters a number.' },
  minimum: { type: ['integer', 'null'], minimum: 0, maximum: CHECKLIST_LIMITS.count, description: 'For a count: the number required, or the number per arriving guest when per_guest. Null for a confirm.' },
  per_guest: { type: 'boolean', description: 'For a count: minimum is per arriving guest (adults and children of the next confirmed stay).' },
  baseline: { type: ['integer', 'null'], minimum: 0, maximum: CHECKLIST_LIMITS.count, description: 'For a per_guest count: what is required when no arrival is booked. Null otherwise.' },
  photo_required: { type: 'boolean', description: 'Done is refused until the cleaner attaches a photo of this item.' } }
const homeChecklist = { type: 'object', properties: { product_id: text, items: { type: 'array', items: { type: 'object', properties: { ...homeItem, reference_photo: nullablePhoto },
  required: ['id', 'title', 'instructions', 'type', 'minimum', 'per_guest', 'baseline', 'photo_required', 'reference_photo'] } }, revision: text }, required: ['product_id', 'items', 'revision'] }
const submittedItem = { type: 'object', properties: { id: text, title: text, instructions: nullableText, type: { type: 'string', enum: ['confirm', 'count'] }, photo_required: { type: 'boolean' },
  required: { type: ['integer', 'null'] }, counted: { type: ['integer', 'null'] }, confirmed: { type: ['boolean', 'null'] },
  shortage: { type: ['integer', 'null'], description: 'How many short of required, for a count.' }, flagged: { type: 'boolean', description: 'Short on a count, or a confirm answered no.' },
  photo_id: nullableText, photo: nullablePhoto, reference_photo: nullablePhoto },
required: ['id', 'title', 'type', 'required', 'counted', 'confirmed', 'shortage', 'flagged', 'photo', 'reference_photo'] }
const submission = { type: 'object', properties: { task_id: text, message_id: text, conversation_id: text, product_id: text, home: text, submitted_at: text, submitted_by: nullableText,
  without_checklist: { type: 'boolean', description: 'Done was tapped past the checklist: by an owner or admin, or from an app version that cannot show it.' },
  checklist: { anyOf: [{ type: 'object', properties: { task_id: text, arrival, arrival_label: text, summary: text, note: nullableText, items: { type: 'array', items: submittedItem } }, required: ['task_id', 'arrival', 'arrival_label', 'summary', 'note', 'items'] }, { type: 'null' }] } },
required: ['task_id', 'message_id', 'conversation_id', 'product_id', 'home', 'submitted_at', 'submitted_by', 'without_checklist', 'checklist'] }
const task = { type: 'object', properties: {
  id: text, kind: { type: 'string', enum: [...TASK_KINDS] }, status: { type: 'string', enum: ['open', 'done', 'skipped', 'cancelled'] }, version: { type: 'integer' },
  image_url: nullableText,
  status_line: nullableText, title: text, place: nullableText, when: nullableText, detail: nullableText, error: nullableText,
  person: { anyOf: [person, { type: 'null' }] }, assignee: { anyOf: [person, { type: 'null' }] },
  sheet: { type: 'object', properties: { heading: text, title: text, date: nullableText }, required: ['heading', 'title', 'date'] },
  starts_at: nullableText, due_at: nullableText, timezone: text, notes: nullableText,
  action: { type: ['object', 'null'] }, path: nullableText,
  product_id: nullableText, location_id: nullableText, booking_id: nullableText, product_session_id: text, conversation_id: nullableText,
  can: { type: 'object', properties: { complete: { type: 'boolean' }, skip: { type: 'boolean' }, reopen: { type: 'boolean' }, assign: { type: 'boolean' }, edit: { type: 'boolean' },
    accept: { type: 'boolean', description: 'A clean you can accept, or take while it is offered to the home’s cleaners.' }, decline: { type: 'boolean', description: 'A clean you can hand on with Can’t do it.' } }, required: ['complete', 'skip', 'reopen', 'assign', 'edit'] },
  checklist: taskChecklist,
  confirmation: { anyOf: [{ type: 'object', properties: { state: { type: 'string', enum: ['confirmed', 'not_confirmed', 'offered'] }, label: { ...text, description: '"Confirmed by Ann", "Not confirmed yet" or "Offered to the home’s cleaners".' },
    declined: { type: 'array', items: { type: 'object', properties: { name: text, reason: nullableText }, required: ['name', 'reason'] }, description: 'Who could not do this clean and why, in order.' } }, required: ['state', 'label', 'declined'] }, { type: 'null' }],
    description: 'An open clean: whether its cleaner has accepted it. Null for any other task.' },
}, required: ['id', 'kind', 'status', 'version', 'image_url', 'status_line', 'title', 'place', 'when', 'detail', 'error', 'person', 'assignee', 'sheet', 'starts_at', 'due_at', 'timezone', 'notes', 'action', 'path', 'product_id', 'location_id', 'booking_id', 'conversation_id', 'can'] }
const taskResult = { type: 'object', properties: { task }, required: ['task'] }
const homeTeam = { type: 'object', properties: { product_id: text, host: { type: 'object', properties: { member_id: text, name: text }, required: ['member_id', 'name'] },
  members: { type: 'array', items: { type: 'object', properties: { member_id: text, name: text, role: text, access: text, cleaner: { type: 'boolean' } }, required: ['member_id', 'name', 'role', 'access', 'cleaner'] } },
  cleaner_ids: { type: 'array', items: text, description: 'The home’s cleaners, first first.' }, offer_cleans_to_all: { type: 'boolean' } },
required: ['product_id', 'host', 'members', 'cleaner_ids', 'offer_cleans_to_all'] }
const opportunity = { type: 'object', properties: { id: text, status_line: text, title: text, detail: text, icon: text, path: text, product_id: nullableText, location_id: nullableText,
  conversation_id: { type: ['string', 'null'], description: 'The guest conversation a welcome is sent in; null for a setup item.' },
  message: { type: ['string', 'null'], description: 'The message it pre-writes from the business’s own records. Review it, then send it with send_message in conversation_id’s conversation; nothing is sent until then.' } },
  required: ['id', 'status_line', 'title', 'detail', 'icon', 'path', 'product_id', 'location_id', 'conversation_id', 'message'] }
const assignee = {
  assigned_member_id: { type: ['string', 'null'], description: 'A Better Auth member id from list_tasks assignees. null unassigns only a task someone added; a job (a clean, a home to get ready, a follow-up, a prep, maintenance) always has a member, and maintenance goes to a maintenance member, an owner or an admin.' },
}

export const TASK_TOOLS: McpToolDefinition[] = [
  organizationTool({ name: 'list_tasks', domain: 'tasks', minimumRole: 'member', description: 'Read Today or Upcoming as stored tasks: turnovers, maintenance jobs, booking decisions, scheduled messages that did not send and tasks people added. Today is open work starting or due today or earlier plus what was done today; Upcoming is later open work by day. A member sees the tasks given to them and the turnovers at homes they look after. assignees lists who a manager can give work to.',
    inputSchema: { range: { type: 'string', enum: ['today', 'upcoming'] }, assignee: { type: 'string', description: 'me, all, or a member id.' }, location_id: { ...text, minLength: 1 }, status: { type: 'string', enum: ['open', 'done', 'skipped', 'cancelled'] }, kind: { type: 'string', enum: [...TASK_KINDS] } },
    outputSchema: { type: 'object', properties: { sections: { type: 'array', items: { type: 'object', properties: { id: text, title: nullableText, subtitle: nullableText, tasks: { type: 'array', items: task } }, required: ['id', 'title', 'subtitle', 'tasks'] } }, assignees: { type: 'array', items: person }, resolved_at: text }, required: ['sections', 'assignees', 'resolved_at'] },
  }),
  organizationTool({ name: 'create_task', domain: 'tasks', minimumRole: 'member', description: 'Create a task with optional dates and one assignee, or a maintenance job: a repair at a listing (product_id) or a location (location_id), posted to its person in a team conversation. A maintenance job reported by a guest names their message with source_message_id; its photos go with the job. A maintenance job requires assigned_member_id. Specify location_id when the product is offered at multiple locations. A new assignee may be notified according to their settings. Reuse idempotency_key only for the same request.',
    inputSchema: { kind: { type: 'string', enum: ['custom', 'maintenance'], description: 'custom (the default) or maintenance.' }, source_message_id: { ...text, minLength: 1, description: 'For maintenance: the guest message from get_conversation that reported the problem.' }, claim_role: { ...text, description: 'Offer custom work to this role on the selected product_id. Not for maintenance.' }, title: { ...text, minLength: 1, maxLength: 200 }, notes: { ...text, maxLength: 5000 }, starts_at: instant, due_at: instant, ...assignee, product_id: { ...text, minLength: 1 }, location_id: { ...text, minLength: 1 }, idempotency_key: { ...text, minLength: 1, maxLength: 200 } }, required: ['title', 'idempotency_key'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'update_task', domain: 'tasks', minimumRole: 'member', description: 'Reassign, reschedule or edit the notes of an open task. Pass version from list_tasks; a newer version is refused so another change is not overwritten. A new assignee is told.',
    inputSchema: { claim: { type: 'boolean', description: 'Claim available work as yourself. Send only task_id and version with this action.' }, task_id: { ...text, minLength: 1 }, version: { type: 'integer', minimum: 1 }, ...assignee, starts_at: { type: ['string', 'null'], format: 'date-time' }, due_at: { type: ['string', 'null'], format: 'date-time' }, notes: { type: ['string', 'null'], maxLength: 5000 }, title: { ...text, minLength: 1, maxLength: 200, description: 'Only for a task someone added or a maintenance job.' } }, required: ['task_id', 'version'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'complete_task', domain: 'tasks', minimumRole: 'member', description: 'Mark a task done. Say what you found, with photos, in its conversation with send_message. Fix failed scheduled messages from their conversation.',
    inputSchema: { task_id: { ...text, minLength: 1 } }, required: ['task_id'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'skip_task', domain: 'tasks', minimumRole: 'member', description: 'Skip or dismiss a task. Say why in its conversation with send_message.',
    inputSchema: { task_id: { ...text, minLength: 1 } }, required: ['task_id'],
    outputSchema: taskResult,
  }),
  organizationTool({ name: 'get_home_turnover_checklist', domain: 'tasks', minimumRole: 'member', description: 'Read a place to stay’s turnover checklist: what a clean must leave, in order. Each item is confirmed or counted by the cleaner, counts can follow the guests arriving next, and some need a photo; each may have a staff-only reference photo of how it should look.',
    inputSchema: { product_id: { ...text, minLength: 1 } }, required: ['product_id'],
    outputSchema: { type: 'object', properties: { checklist: homeChecklist }, required: ['checklist'] },
  }),
  organizationTool({ name: 'set_home_turnover_checklist', domain: 'tasks', minimumRole: 'admin', description: `Replace a place to stay’s turnover checklist with items, in order (at most ${CHECKLIST_LIMITS.items}). Keep an item’s id from get_home_turnover_checklist to keep it; leave id out for a new item. reference_photo_id is a private reference photo’s asset id (upload one with save_media_attachment and checklist_product_id) or null for none; send the id read back to keep it. expected_revision is the revision get_home_turnover_checklist returned; a checklist changed since is refused CHECKLIST_CHANGED. Jobs read the new checklist from now on; submissions already made keep what they were made against. An empty list removes the checklist, and Done goes back to one tap.`,
    inputSchema: { product_id: { ...text, minLength: 1 }, items: { type: 'array', maxItems: CHECKLIST_LIMITS.items, items: { type: 'object', properties: { ...homeItem, id: { ...text, description: 'The id read from the checklist; omit for a new item.' }, reference_photo_id: { type: ['string', 'null'], description: 'An image asset id, or null.' } },
      required: ['title', 'type', 'photo_required'], additionalProperties: false } }, expected_revision: { ...text, minLength: 1 } }, required: ['product_id', 'items', 'expected_revision'],
    outputSchema: { type: 'object', properties: { checklist: homeChecklist }, required: ['checklist'] },
  }),
  organizationTool({ name: 'copy_home_turnover_checklist', domain: 'tasks', minimumRole: 'admin', description: 'Copy one place to stay’s turnover checklist, reference photos included, to other places to stay. Each target’s checklist is replaced by this one.',
    inputSchema: { product_id: { ...text, minLength: 1, description: 'The home to copy from.' }, to_product_ids: { type: 'array', minItems: 1, items: { ...text, minLength: 1 }, description: 'The homes to copy to.' } }, required: ['product_id', 'to_product_ids'],
    outputSchema: { type: 'object', properties: { product_ids: { type: 'array', items: text }, checklist: homeChecklist }, required: ['product_ids', 'checklist'] },
  }),
  organizationTool({ name: 'get_turnover_requirements', domain: 'tasks', minimumRole: 'member', description: 'Read what an open turnover job’s Done requires at a home with a checklist: each item, counts resolved for the next confirmed arrival as bookings stand now, and which need a photo. checklist is null for a home without one.',
    inputSchema: { task_id: { ...text, minLength: 1 } }, required: ['task_id'],
    outputSchema: { type: 'object', properties: { task_id: text, checklist: taskChecklist }, required: ['task_id', 'checklist'] },
  }),
  organizationTool({ name: 'list_turnover_submissions', domain: 'tasks', minimumRole: 'member', description: 'List the turnover checklists submitted with Done on days from to to (each home’s own days, at most 93), optionally at some homes: each item as required, counted or confirmed, its shortage, and photo links. Use it to total shortages, for example what to restock. Jobs done past the checklist are listed with without_checklist true.',
    inputSchema: { from: { ...text, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { ...text, pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, product_ids: { type: 'array', minItems: 1, items: { ...text, minLength: 1 } } }, required: ['from', 'to'],
    outputSchema: { type: 'object', properties: { submissions: { type: 'array', items: submission } }, required: ['submissions'] },
  }),
  organizationTool({ name: 'get_turnover_submission_photos', domain: 'tasks', minimumRole: 'member', description: 'Look at a done turnover’s checklist photos: returns each item’s photo and its reference photo as images, flagged items first, with the submission. Blawby does not judge the photos; comparing them is yours to do. item_ids narrows it to some items.',
    inputSchema: { task_id: { ...text, minLength: 1 }, item_ids: { type: 'array', minItems: 1, items: { ...text, minLength: 1 } } }, required: ['task_id'],
    outputSchema: { type: 'object', properties: { submission, images: { type: 'array', description: 'The images that follow, in order.', items: { type: 'object', properties: { item_id: text, title: text, kind: { type: 'string', enum: ['photo', 'reference'] } }, required: ['item_id', 'title', 'kind'] } } }, required: ['submission', 'images'] },
  }),
  organizationTool({ name: 'get_home_team', domain: 'tasks', minimumRole: 'member', description: 'Read a place to stay’s team: each member with their role and access, which of them are its cleaners (the cleaner role with task access) in order, its host, and whether it offers each clean to all its cleaners. A new clean goes to the first cleaner; Can’t do it hands it to the next, then to the host; with no cleaner it goes to the host.',
    inputSchema: { product_id: { ...text, minLength: 1 } }, required: ['product_id'],
    outputSchema: { type: 'object', properties: { team: homeTeam }, required: ['team'] },
  }),
  organizationTool({ name: 'set_home_team_member', domain: 'tasks', minimumRole: 'admin', description: 'Put a member on a place to stay’s team with an access level, or take them off it (access null). Owners only. A member with the cleaner role and tasks access becomes one of its cleaners: to say "Maria cleans the Sandy rooms", set her on each of those homes with access tasks. The home’s open cleans that have not started go to whoever cleans it now, and their conversations move with them. Invite a new cleaner with invite_organization_member, role cleaner.',
    inputSchema: { product_id: { ...text, minLength: 1 }, member_id: { ...text, minLength: 1, description: 'A membership ID from list_organization_members.' }, access: { type: ['string', 'null'], enum: ['messaging', 'tasks', 'calendar', 'calendar_and_messaging', 'operations', null] } }, required: ['product_id', 'member_id', 'access'],
    outputSchema: { type: 'object', properties: { team: homeTeam }, required: ['team'] },
  }),
  organizationTool({ name: 'set_home_cleaning', domain: 'tasks', minimumRole: 'admin', description: 'Set the order of a place to stay’s cleaners (every one of them, first first) and whether it offers each clean to all of them, first to accept takes it (off by default). Open cleans that have not started go to whoever cleans the home now.',
    inputSchema: { product_id: { ...text, minLength: 1 }, cleaner_ids: { type: 'array', items: { ...text, minLength: 1 }, description: 'All the home’s cleaners from get_home_team, first first.' }, offer_cleans_to_all: { type: 'boolean' } }, required: ['product_id'],
    outputSchema: { type: 'object', properties: { team: homeTeam }, required: ['team'] },
  }),
  organizationTool({ name: 'list_opportunities', domain: 'tasks', minimumRole: 'admin', description: 'List what Today suggests: setup the business has not finished (connecting payments, adding a first offering, a price for each experience without one); and a welcome for each booked guest or client who has not heard from the business since booking. Each one goes away when that setup is done or the business messages the guest.',
    inputSchema: { location_id: { ...text, minLength: 1 } },
    outputSchema: { type: 'object', properties: { opportunities: { type: 'array', items: opportunity } }, required: ['opportunities'] },
  }),
]

export async function handleTaskTools(ctx: McpExecutorContext): Promise<unknown> {
  const { toolName, args, organization } = ctx
  if (!TASK_TOOLS.some(tool => tool.name === toolName)) return NOT_HANDLED
  const { db, env } = organization
  const principal = memberAccessPrincipal(organization.membership, { env, event: ctx.event })
  switch (toolName) {
    case 'list_tasks': {
      const viewer = await taskViewer(principal)
      const query = parseTaskListQuery(args)
      const [list, assignees] = await Promise.all([listTasks(db, viewer, query), listTaskAssignees(db, viewer)])
      return { ...list, assignees }
    }
    case 'create_task': {
      const result = await createTask(db, await taskViewer(principal), args)
      return { task: result.task }
    }
    case 'update_task': {
      const { task_id: _taskId, organization_id: _organizationId, ...patch } = args
      return { task: await updateTask(db, await taskViewer(principal), requiredString(args, 'task_id'), patch) }
    }
    case 'complete_task':
    case 'skip_task':
      return { task: await closeTask(db, await taskViewer(principal), requiredString(args, 'task_id'), { status: toolName === 'complete_task' ? 'done' : 'skipped', env }) }
    case 'get_home_turnover_checklist':
      return { checklist: await readHomeChecklist(db, env, await stayAccessFor(principal), requiredString(args, 'product_id')) }
    case 'set_home_turnover_checklist':
      return { checklist: await saveHomeChecklist(db, env, await stayAccessFor(principal), requiredString(args, 'product_id'), { items: args.items, expected_revision: args.expected_revision }) }
    case 'copy_home_turnover_checklist':
      return await copyHomeChecklist(db, env, await stayAccessFor(principal), requiredString(args, 'product_id'), { product_ids: args.to_product_ids })
    case 'get_home_team':
      return { team: await readHomeTeam(db, await stayAccessFor(principal), requiredString(args, 'product_id')) }
    case 'set_home_team_member': {
      const productId = requiredString(args, 'product_id')
      await setListingAccess(db, env, principal, { listingId: productId, memberId: requiredString(args, 'member_id'), access: args.access as never })
      return { team: await readHomeTeam(db, await stayAccessFor(principal), productId) }
    }
    case 'set_home_cleaning':
      return { team: await setHomeCleaning(db, env, await stayAccessFor(principal), requiredString(args, 'product_id'), { cleaner_ids: args.cleaner_ids, offer_cleans_to_all: args.offer_cleans_to_all }) }
    case 'get_turnover_requirements': {
      const view = await getTask(db, await taskViewer(principal), requiredString(args, 'task_id'))
      return { task_id: view.id, checklist: view.checklist }
    }
    case 'list_turnover_submissions':
      return await listTurnoverSubmissions(db, await taskViewer(principal), { from: args.from, to: args.to, product_ids: args.product_ids })
    case 'get_turnover_submission_photos': {
      const submission = await readTurnoverSubmission(db, await taskViewer(principal), requiredString(args, 'task_id'))
      const wanted = Array.isArray(args.item_ids) ? new Set(args.item_ids as string[]) : null
      const shown = (submission.checklist?.items ?? []).filter(item => !wanted || wanted.has(item.id)).flatMap(item => [
        ...(item.photo ? [{ item_id: item.id, title: item.title, kind: 'photo' as const, photo: item.photo }] : []),
        ...(item.reference_photo ? [{ item_id: item.id, title: item.title, kind: 'reference' as const, photo: item.reference_photo }] : []),
      ])
      const images = await Promise.all(shown.map(entry => photoImage(entry.photo)))
      const structured = { submission, images: shown.map(({ photo: _photo, ...entry }) => entry) }
      const caption = shown.map((entry, index) => `Image ${index + 1}: ${entry.title}, ${entry.kind === 'photo' ? 'the cleaner’s photo' : 'the reference photo'}`).join('\n')
      return renderStructuredResponse(structured, `${JSON.stringify(structured)}\n\n${caption || 'This submission has no photos.'}`, undefined, false, images)
    }
    case 'list_opportunities': return await listOpportunities(db, principal, { locationId: optionalString(args, 'location_id') ?? undefined })
    default: return NOT_HANDLED
  }
}
