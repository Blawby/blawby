import { PLATFORM_MESSAGE_AUTHOR_KIND } from '../../shared/messages-contract.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { Miniflare } from 'miniflare'
import { requestInsertQueries, threadPayloadForGuest } from '../../server/domain/requests.ts'
import { openingSentence } from '../../server/domain/guest-threads/opening.ts'
import { appendMessage, markConversationRead } from '../../server/domain/conversations.ts'
import { loadConversationPage } from '../../server/domain/conversation-history.ts'
import { acceptConversationGuestInvite, createConversationGuestInvite, removeConversationGuest } from '../../server/domain/conversation-participants.ts'
import { conversationPageFor } from './support/conversation-page.ts'
import { archiveConversation, conversationListQuery, listConversations, readGuestInbox } from '../../server/domain/guest-threads/repository.ts'
import { BATCH_VIEWER, memberAccessPrincipal, membershipBySlugQuery, withViewer } from '../../server/utils/member-access.ts'
import type { CloudflareEnv } from '../../server/utils/auth.ts'
import { bookedRecordsInRange } from '../../server/domain/product-bookings.ts'
import { applySchema } from './support/schema.ts'

async function guestUnread(db: Parameters<typeof readGuestInbox>[0], userId: string) {
  const inbox = await readGuestInbox(db, { userId, mailbox: 'current' })
  const unread = inbox.threads.filter(row => row.unread).length
  assert.equal(inbox.has_unread, unread > 0, 'the dot is the rows marked unread')
  return unread
}


// inbox-parity.md, Revision 2026-11-06: a table booking's conversation opens
// with real messages, the booking's own sentence then the guest's note,
// written with the record.

const ORG = 'org', OWNER = 'owner'
const CREATED = '2026-11-03T09:00:00.000Z'

test('a table booking opens with its own message and the guest note, written once', { timeout: 300_000 }, async t => {
  const runtime = new Miniflare({ workers: [{ config: {
    name: 'conversation-opening', compatibilityDate: '2024-11-01',
    manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
    env: { DB: { type: 'd1' } },
  } }] })
  try {
    const db = await runtime.getD1Database('DB')
    await applySchema(db)
    await db.prepare(`INSERT INTO organization (id, name, slug, subdomain, settings_json, theme_id, default_currency, status, onboarding_status, url_structure, vertical, updated_at, timezone)
      VALUES (?, 'Kikuzuki', 'kikuzuki', 'kikuzuki', '{}', 'tenant-theme-v1', 'THB', 'active', 'active', 'flat', 'restaurant', ?, 'Asia/Bangkok')`).bind(ORG, CREATED).run()
    await db.prepare("INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, 'Owner Person', 'owner@example.test', 1, 0, 0)").bind(OWNER).run()
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-owner', ?, ?, 'owner', 0)").bind(ORG, OWNER).run()
    await db.prepare(`INSERT INTO business_locations (id, organization_id, slug, title, status, timezone, created_at, updated_at)
      VALUES ('loc', ?, 'krabi', 'Kikuzuki Krabi', 'active', 'Asia/Bangkok', ?, ?)`).bind(ORG, CREATED, CREATED).run()
    // Kikuzuki Krabi's tables, and the seatings these conversations booked.
    await db.batch([
      `INSERT INTO products (kind, id, organization_id, name, slug, created_by, updated_by) VALUES ('table', 'tables', '${ORG}', 'Krabi tables', 'krabi-tables', '${OWNER}', '${OWNER}')`,
      `INSERT INTO product_variants (id, organization_id, product_id, name, created_by, updated_by) VALUES ('tables-v', '${ORG}', 'tables', 'Table', '${OWNER}', '${OWNER}')`,
      `INSERT INTO prices (id, organization_id, product_variant_id, currency, unit_amount, created_by, updated_by) VALUES ('tables-price', '${ORG}', 'tables-v', 'THB', 50000, '${OWNER}', '${OWNER}')`,
      `INSERT INTO product_locations (organization_id, product_id, location_id, created_by, updated_by) VALUES ('${ORG}', 'tables', 'loc', '${OWNER}', '${OWNER}')`,
      `INSERT INTO product_booking_configs (product_id, organization_id, unit, duration_minutes, default_capacity, scheduling_mode, payment_basis, assigned_member_id, created_by, updated_by) VALUES ('tables', '${ORG}', 'slot', 120, 20, 'business', 'per_booking', 'm-owner', '${OWNER}', '${OWNER}')`,
      ...[['seating', '2026-11-04T07:00:00.000Z', '2026-11-04T09:00:00.000Z'], ['held-seating', '2026-11-06T11:00:00.000Z', '2026-11-06T13:00:00.000Z']].map(([id, starts, ends]) =>
        `INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, created_by, updated_by) VALUES ('${id}', '${ORG}', 'tables', 'loc', 'Asia/Bangkok', '${starts}', '${ends}', 20, '${OWNER}', '${OWNER}')`),
    ].map(statement => db.prepare(statement)))
    const env = await runtime.getBindings<CloudflareEnv>()
    const principal = memberAccessPrincipal({ userId: OWNER, organizationId: ORG, role: 'owner' }, { env })
    const reservation = async (id: string, note: string | null, opening: string, booker: string | null = null) => {
      const payload = threadPayloadForGuest({ name: 'Filip Heurckmans', email: 'filip@example.test', phone: '+32475699444', locale: 'en', ipHash: null })
      await db.batch([
        { query: `INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size, policy_json, status, created_at, updated_at,location_id,starts_at,ends_at,timezone,user_id)
            SELECT ?, ?, 'tables', 'seating', 'tables-v', 4, '{"advance_notice_minutes":null,"party_size_min":null,"party_size_max":null,"minimum_guest_age":null,"accessibility_contact_required":false,"payment":null,"cancellation":null}', 'confirmed', ?, ?,location_id,starts_at,ends_at,timezone,? FROM product_sessions WHERE id = 'seating'`, params: [`res-${id}`, ORG, CREATED, CREATED, booker] },
        ...requestInsertQueries({ id, kind: 'booking', organization_id: ORG, location_id: 'loc', booking_id: `res-${id}`, user_id: booker, payload, created_at: CREATED }, undefined, { opening, note }),
      ].map(query => db.prepare(query.query).bind(...(query.params ?? []))))
    }
    const sentence = openingSentence({ kind: 'booking', vertical: 'restaurant', productKind: 'table', productTitle: 'Krabi tables', guestName: 'Filip Heurckmans', guestPhone: '+32475699444', answers: [], partySize: 4, partySizeIsMinimum: false,
      startsAt: '2026-11-04T07:00:00.000Z', timezone: 'Asia/Bangkok', placeTitle: 'Kikuzuki Krabi' })
    assert.match(sentence, /^Table for 4 on Wed, Nov 4 at 2:00 PM at Kikuzuki Krabi\. Filip Heurckmans, \+32 /)
    const messages = async (id: string) => (await conversationPageFor(db, env, principal, id, { before: null, limit: 40 }, new Date('2026-11-05T00:00:00.000Z'))).entries
      .flatMap(item => item.type === 'message' ? [[item.side, item.body]] : [])

    // Created: the booking's own message, then the guest's note, and nothing twice on a replay of the same batch.
    await reservation('new', 'Window seat if possible', sentence)
    assert.deepEqual(await messages('new'), [['guest', sentence], ['guest', 'Window seat if possible']])
    const ledger = async (id: string) => (await db.prepare('SELECT sequence, author_kind, event_name FROM messages WHERE conversation_id = ? ORDER BY sequence').bind(id).all()).results
    const opened = [{ sequence: 1, author_kind: PLATFORM_MESSAGE_AUTHOR_KIND, event_name: 'thread.opening' }, { sequence: 2, author_kind: 'guest', event_name: 'thread.guest_note' }]
    assert.deepEqual(await ledger('new'), opened)
    await db.batch(requestInsertQueries({ id: 'new', kind: 'booking', organization_id: ORG, location_id: 'loc', booking_id: 'res-new', user_id: null,
      payload: threadPayloadForGuest({ name: 'Filip Heurckmans', email: 'filip@example.test', phone: '+32475699444', locale: 'en', ipHash: null }), created_at: CREATED }, undefined, { opening: sentence, note: 'Window seat if possible' })
      .slice(1).map(query => db.prepare(query.query).bind(...(query.params ?? []))))
    assert.deepEqual(await ledger('new'), opened)
    assert.equal(PLATFORM_MESSAGE_AUTHOR_KIND, 'blawby')
    assert.deepEqual(await messages('new'), [['guest', sentence], ['guest', 'Window seat if possible']])

    // Another conversation, opened the same way, where the guest wrote since: their reply is its preview, and its
    // time orders it ahead of the one whose newest message is its opening note.
    await reservation('old', 'Window seat if possible', sentence)
    await appendMessage(db, { conversationId: 'old', authorKind: 'guest', authorUserId: null, channel: 'email', body: 'Running ten minutes late', occurredAt: '2026-11-04T06:50:00.000Z' })
    const rows = await listConversations(db, ORG, { userId: OWNER, mailbox: 'current' }, new Date('2026-11-05T00:00:00.000Z'))
    assert.deepEqual(rows.map(row => [row.id, row.preview_from, row.preview]), [['old', 'Filip', 'Running ten minutes late'], ['new', 'Filip', 'Window seat if possible']])

    // The live message writer updates the index; search reaches Past, short
    // Unicode terms, long terms beyond D1's GLOB limit, and separate words.
    const longTerm = 'confirmationreference' + '0123456789'.repeat(8)
    const indexedMessage = await appendMessage(db, { conversationId: 'new', authorKind: 'guest', authorUserId: null, channel: 'web', body: `Émile José ЖΩ ος Straße question?mark O’Brien ${longTerm}` })
    await archiveConversation(db, { organizationId: ORG, conversationId: 'new', userId: OWNER, archived: true })
    for (const q of ['jose emile', 'ÉMILE jose', 'Ω', 'жω', longTerm, 'filip@example.test jose', 'ΟΣ', 'οσ', 'STRASSE', 'question?mark']) {
      assert.deepEqual((await listConversations(db, ORG, { userId: OWNER, mailbox: 'current', q })).map(row => row.id), ['new'], q)
    }
    assert.deepEqual((await listConversations(db, ORG, { userId: OWNER, q: 'ß' })).map(row => row.id).sort(), ['new', 'old'], 'ss also appears in possible in the other booking’s note')
    assert.deepEqual(await listConversations(db, ORG, { userId: OWNER, q: 'jose nevermentioned' }), [])

    await db.prepare("UPDATE conversations SET payload_json = json_set(payload_json, '$.guest.name', 'Álvaro Éclair') WHERE id = 'new'").run()
    assert.deepEqual((await listConversations(db, ORG, { userId: OWNER, q: 'alvaro eclair' })).map(row => row.id), ['new'])
    await db.prepare('UPDATE messages SET body = ? WHERE id = ?').bind(`Élodie José ЖΩ ος Straße question?mark O’Brien ${longTerm}`, indexedMessage.id).run()
    assert.deepEqual(await listConversations(db, ORG, { userId: OWNER, q: 'emile' }), [])
    assert.deepEqual((await listConversations(db, ORG, { userId: OWNER, q: 'elodie jose' })).map(row => row.id), ['new'])

    // Accept through the normal write, then read using the request's canonical seat and transcript projection.
    const booker = { id: 'booker', email: 'filip@example.test', name: 'Filip Heurckmans', emailVerified: true }
    const traveler = { id: 'traveler', email: 'traveler@example.test', name: 'Taylor Traveler', emailVerified: true }
    await db.batch([booker, traveler].map(user => db.prepare(`INSERT INTO user (id, name, email, emailVerified, createdAt, updatedAt)
      VALUES (?, ?, ?, 1, 0, 0)`).bind(user.id, user.name, user.email)))
    await reservation('shared', 'Private booking note', sentence, booker.id)
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-booker', ?, ?, 'admin', 0)").bind(ORG, booker.id).run()
    const workspace = await listConversations(db, ORG, { userId: booker.id })
    assert(workspace.some(row => row.id === 'new'))
    assert(!workspace.some(row => row.id === 'shared'), 'an admin’s own reservation stays in their guest inbox')
    const companionInvite = { conversationId: 'shared', email: traveler.email }
    const invite = await createConversationGuestInvite(db, { organizationId: ORG, userId: booker.id }, companionInvite)
    const publication = { GUEST_INBOX_HUBS: { idFromName: () => 'hub', get: () => ({ fetch: () => Promise.resolve(new Response(null, { status: 204 })) }) } } as unknown as Parameters<typeof acceptConversationGuestInvite>[1]
    await acceptConversationGuestInvite(db, publication, { token: invite.token, user: traveler })
    const page = (userId: string, limit = 40) => loadConversationPage(db, env, { conversationId: 'shared', userId }, { before: null, limit })
    const list = (q?: string) => listConversations(db, null, { userId: traveler.id, buyerAudience: true, q })
    const privateWords = 'Private card receipt'
    const payment = await appendMessage(db, { conversationId: 'shared', authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: null, eventName: 'payment.payment_captured', body: privateWords })
    const existingPayment = { conversationId: 'shared', authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: null, eventName: 'payment.payment_captured', body: privateWords, dedupeKey: 'historical-payment-replay' }
    const historical = await appendMessage(db, existingPayment)
    assert.equal((await appendMessage(db, existingPayment)).id, historical.id)
    const privatePage = await page(traveler.id)
    assert.deepEqual(privatePage.entries, [])
    assert.equal(privatePage.capabilities.can_invite_guest, false)
    assert(privatePage.conversation.participants.every(person => !person.can_remove && !('invitation_id' in person)))
    await assert.rejects(createConversationGuestInvite(db, { organizationId: ORG, userId: traveler.id }, companionInvite), { statusCode: 404 })
    if (privatePage.conversation.kind === 'team') throw new Error('Expected the traveler’s booking conversation')
    assert.deepEqual([privatePage.conversation.booking_id, privatePage.conversation.activity_path], [null, null])
    const [travelerRow] = await list()
    assert.deepEqual([travelerRow?.id, travelerRow?.preview, travelerRow?.when, travelerRow?.unread], ['shared', '', null, false])
    assert.deepEqual(await list('Private booking note'), [])
    assert.deepEqual(await list(privateWords), [])
    assert.deepEqual(await list('filip@example.test'), [], 'a companion cannot infer the booker’s private contact details through search')
    assert.equal(await guestUnread(db, traveler.id), 0)
    await assert.rejects(markConversationRead(db, { organizationId: ORG, conversationId: 'shared', userId: traveler.id, throughMessageId: payment.id }), { statusCode: 422 })

    const publicMessage = await appendMessage(db, { conversationId: 'shared', authorKind: 'guest', authorUserId: booker.id, channel: 'web', body: 'Meet at the table' })
    assert.equal(await guestUnread(db, traveler.id), 1)
    assert.deepEqual(await markConversationRead(db, { organizationId: ORG, conversationId: 'shared', userId: traveler.id }), { read: true, last_read_message_id: publicMessage.id })
    assert.equal(await guestUnread(db, traveler.id), 0)
    const travelerMessage = await appendMessage(db, { conversationId: 'shared', authorKind: 'guest', authorUserId: traveler.id, channel: 'web', body: 'I will be there' })
    const latestPayment = await appendMessage(db, { conversationId: 'shared', authorKind: PLATFORM_MESSAGE_AUTHOR_KIND, authorUserId: null, eventName: 'payment.payment_captured', body: 'Another private payment' })
    const first = await page(traveler.id, 1)
    const shown = first.entries.filter(entry => entry.type === 'message')
    assert.deepEqual(shown.map(entry => [entry.id, entry.author]), [[travelerMessage.id, 'You']])
    assert.equal(first.page.before, travelerMessage.sequence)
    assert.equal(first.page.newest, travelerMessage.sequence)
    const previous = await loadConversationPage(db, env, { conversationId: 'shared', userId: traveler.id }, { before: first.page.before, limit: 1 })
    assert.deepEqual(previous.entries.filter(entry => entry.type === 'message').map(entry => entry.id), [publicMessage.id])
    assert.equal(previous.page.before, null)
    assert.equal(await guestUnread(db, traveler.id), 0)
    assert.deepEqual((await list()).map(row => [row.preview, row.preview_from, row.unread]), [['I will be there', 'You', false]])
    const original = await page(booker.id)
    assert.equal(original.viewer_role, 'guest')
    assert.equal(original.conversation.booking_id, 'res-shared')
    assert.equal(original.page.newest, latestPayment.sequence)
    assert(original.entries.some(entry => entry.type === 'message' && entry.body === sentence))
    assert(original.entries.some(entry => entry.type === 'event' && entry.id === payment.id))
    assert(original.entries.some(entry => entry.type === 'message' && entry.id === travelerMessage.id && entry.author === traveler.name))
    assert.equal(original.capabilities.can_invite_guest, true)
    const companion = original.conversation.participants.find(person => person.name === traveler.name)
    assert(companion?.invitation_id)
    assert.deepEqual([companion.id, companion.image, companion.can_remove], [null, null, true])
    const removal = { organizationId: ORG, conversationId: 'shared', invitationId: companion.invitation_id }
    await assert.rejects(removeConversationGuest(db, publication, { ...removal, userId: traveler.id }), { statusCode: 404 })
    assert.deepEqual(await removeConversationGuest(db, publication, { ...removal, userId: booker.id }), { removed: true })
    assert(!(await page(booker.id)).conversation.participants.some(person => person.name === traveler.name))
    await assert.rejects(page(traveler.id), { statusCode: 404 })
    await assert.rejects(acceptConversationGuestInvite(db, publication, { token: invite.token, user: traveler }), { statusCode: 404 })

    // In the other reservation the same account is a workspace admin with no stored seat.
    const hostInvite = await createConversationGuestInvite(db, { organizationId: ORG, userId: booker.id }, { conversationId: 'new', email: traveler.email })
    assert.deepEqual(await acceptConversationGuestInvite(db, publication, { token: hostInvite.token, user: traveler }), { conversation_id: 'new', organization_id: ORG })
    // Grow canonical conversations and cancelled historical bookings together.
    // Cancelled records occupy no places in the fixture's twenty-seat session.
    await db.prepare(`INSERT INTO product_sessions (id, organization_id, product_id, location_id, timezone, starts_at, ends_at, capacity, created_by, updated_by)
      VALUES ('archive-seating', ?, 'tables', 'loc', 'Asia/Bangkok', '2026-05-03T07:00:00.000Z', '2026-05-03T09:00:00.000Z', 20, ?, ?)`)
      .bind(ORG, OWNER, OWNER).run()
    const bookingQuery = (q: string, userId = OWNER) => withViewer(membershipBySlugQuery('kikuzuki', userId),
      bookedRecordsInRange(BATCH_VIEWER, { search: { q, limit: 20, offset: 0 }, cancelled: true, includeAssignedStays: true }))
    const measurements: unknown[] = []
    const indexedReads = new Map<string, number>()
    let added = 0
    for (const count of [100, 1000, 5000]) {
      const writeStart = performance.now()
      while (added < count) {
        const batch = []
        const through = Math.min(added + 25, count)
        for (; added < through; added++) {
          const id = `history-${added}`
          const guest = { name: added === 0 ? 'Émile Álvarez' : `Archive Guest ${added}`, email: `${id}@example.test`, phone: `+32475${String(added).padStart(6, '0')}`, locale: 'en', ipHash: null }
          const queries = [{
            query: `INSERT INTO bookings (id, organization_id, product_id, product_session_id, product_variant_id, party_size, policy_json, status,
              cancelled_at, cancellation_reason, created_at, updated_at, location_id, starts_at, ends_at, timezone)
              SELECT ?, s.organization_id, s.product_id, s.id, b.product_variant_id, 4, b.policy_json, 'cancelled', ?, 'host_cancelled', ?, ?, s.location_id, s.starts_at, s.ends_at, s.timezone
              FROM product_sessions s JOIN bookings b ON b.id = 'res-new' WHERE s.id = 'archive-seating'`,
            params: [`res-${id}`, CREATED, CREATED, CREATED],
          }, ...requestInsertQueries({ id, kind: 'booking', organization_id: ORG, location_id: 'loc', booking_id: `res-${id}`, user_id: null, payload: threadPayloadForGuest(guest), created_at: CREATED }, undefined,
            { opening: `A cancelled table reservation from the archive for guest ${added}.`, note: null })]
          batch.push(...queries.map(query => db.prepare(query.query).bind(...(query.params ?? []))))
        }
        await db.batch(batch)
      }
      const writeMs = performance.now() - writeStart
      const reads = []
      for (const q of ['jose elodie', 'Ω', 'жω', longTerm]) {
        const samples = []
        for (let repeat = 0; repeat < 5; repeat++) {
          const start = performance.now()
          assert.deepEqual((await listConversations(db, ORG, { userId: OWNER, q })).map(row => row.id), ['new'])
          samples.push(performance.now() - start)
        }
        const statement = conversationListQuery(ORG, { userId: OWNER, q }, new Date())
        const result = await db.prepare(statement.query).bind(...(statement.params ?? [])).all<{ id: string }>()
        assert.deepEqual(result.results.map(row => row.id), ['new'])
        if (count === 100) indexedReads.set(`conversations:${q}`, result.meta.rows_read)
        else assert.equal(result.meta.rows_read, indexedReads.get(`conversations:${q}`), 'unrelated conversation growth must not add a source scan')
        reads.push({ q, median_ms: samples.sort((a, b) => a - b)[2], rows_read: result.meta.rows_read })
      }
      const bookingReads = []
      for (const q of ['emile alvarez', 'history-0@example.test', '475000000', 'res-history-0']) {
        const statement = bookingQuery(q)
        const samples = []
        let rowsRead: number | undefined
        for (let repeat = 0; repeat < 5; repeat++) {
          const start = performance.now()
          const result = await db.prepare(statement.query).bind(...(statement.params ?? [])).all<{ id: string; starts_at: string }>()
          samples.push(performance.now() - start)
          assert.deepEqual(result.results.map(row => [row.id, row.starts_at]), [['res-history-0', '2026-05-03T07:00:00.000Z']])
          rowsRead = result.meta.rows_read
        }
        if (count === 100) indexedReads.set(`bookings:${q}`, rowsRead!)
        else assert.equal(rowsRead, indexedReads.get(`bookings:${q}`), 'unrelated booking growth must not add a source scan')
        bookingReads.push({ q, median_ms: samples.sort((a, b) => a - b)[2], rows_read: rowsRead })
      }
      const started = performance.now()
      const large = await appendMessage(db, { conversationId: 'new', authorKind: 'guest', authorUserId: null, channel: 'web', body: 'A'.repeat(2000) })
      const insertMs = performance.now() - started
      const updateStarted = performance.now()
      await db.prepare('UPDATE messages SET body = ? WHERE id = ?').bind('É'.repeat(2000), large.id).run()
      const updateMs = performance.now() - updateStarted
      await db.prepare('DELETE FROM messages WHERE id = ?').bind(large.id).run()
      const totals = await db.prepare('SELECT count(*) AS messages, sum(length(body)) AS characters, (SELECT count(*) FROM conversations) AS conversations, (SELECT count(*) FROM bookings) AS bookings FROM messages').first()
      measurements.push({ added_records: count, totals, batch_write_ms: writeMs, insert_2000_ms: insertMs, update_unicode_2000_ms: updateMs, reads, booking_reads: bookingReads })
    }
    await db.prepare("INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('m-restricted', ?, ?, 'kitchen', 0)").bind(ORG, traveler.id).run()
    const restricted = bookingQuery('history-0@example.test', traveler.id)
    assert.deepEqual((await db.prepare(restricted.query).bind(...(restricted.params ?? [])).all()).results, [], 'a member without offering access cannot infer its guest through search')
    for (const [surface, statement] of [
      ['conversations', conversationListQuery(ORG, { userId: OWNER, q: 'jose elodie' }, new Date())],
      ['bookings', bookingQuery('history-0@example.test')],
    ] as const) {
      const plan = await db.prepare(`EXPLAIN QUERY PLAN ${statement.query}`).bind(...(statement.params ?? [])).all()
      t.diagnostic(`SEARCH_QUERY_PLAN ${surface} ${JSON.stringify(plan.results)}`)
    }
    t.diagnostic(`SEARCH_BENCHMARK ${JSON.stringify(measurements)}`)
  } finally {
    await runtime.dispose()
  }
})
