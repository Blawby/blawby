import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { buildMediaPlacementInsertQuery } from '~/server/utils/media-asset-manager'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { requireManager, visibleHomes, type StayAccess } from '~/server/domain/stays'
import { checkedItem, checklistColumnsSql, checklistOf, fail, referenceSlot, SLOT, type ChecklistColumns } from '~/server/domain/turnover-checklists'
import { CHECKLIST_LIMITS, type HomeTurnoverChecklist, type TurnoverChecklistItem } from '~/shared/turnover-checklist'

/*
  A home's turnover checklist as owners and admins edit it (#2091): read,
  replaced whole, and copied to other homes. Its rules and how a job reads it
  are server/domain/turnover-checklists.ts.
*/

const homeQuery = (access: StayAccess, productId: string): BatchQuery => {
  const scope = visibleHomes(access)
  return { query: `SELECT c.product_id, c.location_id, ${checklistColumnsSql('c')} FROM product_stay_configs c
    WHERE c.organization_id = ? AND c.product_id = ? AND ${scope.sql}`, params: [access.organizationId, productId, ...scope.params] }
}

/** A home's checklist, for the people who can see the home. */
export async function readHomeChecklist(db: DbClient, access: StayAccess, productId: string): Promise<HomeTurnoverChecklist> {
  const query = homeQuery(access, productId)
  const row = await queryFirst<ChecklistColumns & { product_id: string }>(db, query.query, query.params)
  if (!row) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  return { product_id: row.product_id, items: checklistOf(row, row.product_id) }
}

/** The checklist's placements for some homes, replaced: each item with a photo gets its slot. */
function referencePlacements(organizationId: string, productId: string, references: Array<{ itemId: string; assetId: string }>, now: string): BatchQuery[] {
  return [{
    query: `DELETE FROM media_placements WHERE organization_id = ? AND owner_type = 'product' AND owner_id = ? AND slot GLOB '${SLOT}*'`,
    params: [organizationId, productId],
  }, ...references.map(({ itemId, assetId }) => buildMediaPlacementInsertQuery({
    organizationId, ownerType: 'product', ownerId: productId, slot: referenceSlot(itemId), assetId, sortOrder: 0, createdAt: now,
  }))]
}

function checklistEvent(access: StayAccess, locationId: string, productId: string, items: number, copiedFrom?: string): BatchQuery {
  return organizationEventQuery({ organizationId: access.organizationId, locationId, actorId: access.actorId, eventType: 'stay.checklist_updated', entityType: 'stay_home', entityId: productId,
    metadata: { items, ...(copiedFrom ? { copied_from: copiedFrom } : {}) }, onlyIfPreviousChangedOneRow: true })
}

/**
 * Replace a home's checklist with `items`, in order. An item keeps its id
 * when it sends the one it was read with; a new one gets one. Owners and
 * admins only. A submission already made keeps what it was made against.
 */
export async function saveHomeChecklist(db: DbClient, access: StayAccess, productId: string, body: Record<string, unknown>): Promise<HomeTurnoverChecklist> {
  requireManager(access)
  const unknown = Object.keys(body).find(key => key !== 'items')
  if (unknown) fail(422, 'INVALID_CHECKLIST_ITEM', `${unknown} is not part of a checklist`, unknown)
  if (!Array.isArray(body.items)) fail(422, 'INVALID_CHECKLIST_ITEM', 'items must list the checklist items in order', 'items')
  if (body.items.length > CHECKLIST_LIMITS.items) fail(422, 'INVALID_CHECKLIST_ITEM', `A checklist has at most ${CHECKLIST_LIMITS.items} items`, 'items')
  const ids = new Set<string>()
  const items = body.items.map((value: unknown, index) => {
    const item = checkedItem(value, `items[${index}]`)
    const id = item.id ?? crypto.randomUUID()
    if (ids.has(id)) fail(422, 'INVALID_CHECKLIST_ITEM', `items[${index}].id is listed twice`, `items[${index}].id`)
    ids.add(id)
    return { ...item, id }
  })
  const assetIds = [...new Set(items.flatMap(item => item.reference_photo_id ? [item.reference_photo_id] : []))]
  const home = homeQuery(access, productId)
  const [homeRows, assetRows] = (await executeBatch(db, [home, {
    query: `SELECT id FROM media_assets WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?)) AND kind = 'image' AND status = 'active' AND public_url IS NOT NULL`,
    params: [access.organizationId, d1JsonStringSet(assetIds)],
  }], { operation: 'Read a turnover checklist to save' })).map(result => result.results as Array<Record<string, string>>)
  const current = homeRows![0]
  if (!current) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  const found = new Set(assetRows!.map(row => row.id))
  const missing = items.findIndex(item => item.reference_photo_id && !found.has(item.reference_photo_id))
  if (missing >= 0) fail(422, 'INVALID_REFERENCE_PHOTO', 'The reference photo must be an image uploaded to this business', `items[${missing}].reference_photo_id`)
  const stored: TurnoverChecklistItem[] = items.map(({ reference_photo_id: _reference, ...item }) => ({
    id: item.id, title: item.title, instructions: item.instructions, type: item.type, minimum: item.minimum, per_guest: item.per_guest, baseline: item.baseline, photo_required: item.photo_required,
  }))
  const now = new Date().toISOString()
  const [updated] = await executeBatch(db, [{
    query: 'UPDATE product_stay_configs SET turnover_checklist = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND product_id = ?',
    params: [JSON.stringify(stored), now, access.actorId, access.organizationId, productId],
  }, checklistEvent(access, current.location_id!, productId, stored.length),
  ...referencePlacements(access.organizationId, productId, items.flatMap(item => item.reference_photo_id ? [{ itemId: item.id, assetId: item.reference_photo_id }] : []), now),
  ], { operation: 'Save turnover checklist' })
  if (updated?.meta.changes !== 1) fail(409, 'HOME_CHANGED', 'The home changed before its checklist was saved; reload it', 'product_id')
  return readHomeChecklist(db, access, productId)
}

/**
 * Copy a home's checklist, reference photos included, to other homes: each
 * target's checklist becomes this one. Owners and admins only.
 */
export async function copyHomeChecklist(db: DbClient, access: StayAccess, productId: string, body: Record<string, unknown>): Promise<{ product_ids: string[]; checklist: HomeTurnoverChecklist }> {
  requireManager(access)
  const unknown = Object.keys(body).find(key => key !== 'product_ids')
  if (unknown) fail(422, 'INVALID_CHECKLIST_COPY', `${unknown} is not part of a copy`, unknown)
  const targets = body.product_ids
  if (!Array.isArray(targets) || !targets.length || targets.some(id => typeof id !== 'string' || !id) || new Set(targets).size !== targets.length) {
    fail(422, 'INVALID_CHECKLIST_COPY', 'product_ids must list the other homes to copy the checklist to, each once', 'product_ids')
  }
  if (targets.includes(productId)) fail(422, 'INVALID_CHECKLIST_COPY', 'A home cannot copy its checklist to itself', 'product_ids')
  const source = await readHomeChecklist(db, access, productId)
  const homes = await queryAll<{ product_id: string; location_id: string }>(db, `SELECT product_id, location_id FROM product_stay_configs
    WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?))`, [access.organizationId, d1JsonStringSet(targets as string[])])
  const absent = (targets as string[]).filter(id => !homes.some(home => home.product_id === id))
  if (absent.length) fail(404, 'HOME_NOT_FOUND', `These are not places to stay in this organization: ${absent.join(', ')}`, 'product_ids')
  const stored = JSON.stringify(source.items.map(({ reference_photo: _reference, ...item }) => item))
  const references = source.items.flatMap(item => item.reference_photo ? [{ itemId: item.id, assetId: item.reference_photo.id }] : [])
  const now = new Date().toISOString()
  const results = await executeBatch(db, homes.flatMap(home => [{
    query: 'UPDATE product_stay_configs SET turnover_checklist = ?, updated_at = ?, updated_by = ? WHERE organization_id = ? AND product_id = ?',
    params: [stored, now, access.actorId, access.organizationId, home.product_id],
  }, checklistEvent(access, home.location_id, home.product_id, source.items.length, productId),
  ...referencePlacements(access.organizationId, home.product_id, references, now)]), { operation: 'Copy turnover checklist' })
  const perHome = 2 + 1 + references.length
  if (homes.some((_, index) => results[index * perHome]?.meta.changes !== 1)) fail(409, 'HOME_CHANGED', 'A home changed before the checklist was copied; reload and try again', 'product_ids')
  return { product_ids: homes.map(home => home.product_id), checklist: source }
}

