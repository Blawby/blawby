import { d1JsonStringSet, executeBatch, queryAll, queryFirst, type BatchQuery, type DbClient } from '~/server/db'
import { MAX_D1_BATCH_STATEMENTS } from '~/server/db/d1-limits'
import { organizationEventQuery } from '~/server/utils/organization-events'
import { mediaLinks, type MediaLinkEnv } from '~/server/utils/private-media'
import { buildMediaPlacementInsertQuery, getMediaAsset } from '~/server/utils/media-asset-manager'
import { uploadResolvedMediaToAssetStore, type UploadResolvedMediaInput } from '~/server/utils/media-upload'
import { privateMediaPlacementSql } from '~/shared/media-placement-contract'
import { requireManager, visibleHomes, type StayAccess } from '~/server/domain/stays'
import { checkedItem, checklistColumnsSql, checklistOf, fail, SLOT, type ChecklistColumns } from '~/server/domain/turnover-checklists'
import { CHECKLIST_LIMITS, checklistRevision, type HomeTurnoverChecklist, type TurnoverChecklistItem } from '~/shared/turnover-checklist'

/*
  A home's turnover checklist as owners and admins edit it (#2091): read,
  replaced whole, and copied to other homes. Its rules and how a job reads it
  are server/domain/turnover-checklists.ts.
*/

/** A home's reference photo placements as one comparable value, so a save can check they are as it read them. */
const referencesKeySql = (home: string) => `(SELECT COALESCE(group_concat(slot || '=' || asset_id, ','), '') FROM (SELECT mp.slot, mp.asset_id FROM media_placements mp
  WHERE mp.organization_id = ${home}.organization_id AND mp.owner_type = 'product' AND mp.owner_id = ${home}.product_id AND mp.slot GLOB '${SLOT}*' ORDER BY mp.slot))`

const homeQuery = (access: StayAccess, productId: string): BatchQuery => {
  const scope = visibleHomes(access)
  return { query: `SELECT c.product_id, c.location_id, ${checklistColumnsSql('c')}, ${referencesKeySql('c')} AS references_key FROM product_stay_configs c
    WHERE c.organization_id = ? AND c.product_id = ? AND ${scope.sql}`, params: [access.organizationId, productId, ...scope.params] }
}

/** A home's checklist, for the people who can see the home. */
export async function readHomeChecklist(db: DbClient, env: MediaLinkEnv, access: StayAccess, productId: string): Promise<HomeTurnoverChecklist> {
  const query = homeQuery(access, productId)
  const row = await queryFirst<ChecklistColumns & { product_id: string }>(db, query.query, query.params)
  if (!row) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  const items = await checklistOf(env, row, row.product_id)
  return { product_id: row.product_id, items, revision: checklistRevision(items) }
}

/** A statement that fails the batch unless the one before it changed exactly `count` rows. */
const changed = (count: number): BatchQuery => ({ query: `SELECT CASE WHEN changes() = ${count} THEN NULL ELSE json('CHECKLIST_CHANGED') END` })

/**
 * The writes that give `homes` this checklist and these reference photos, as one batch that fails whole:
 * the checklist, then its placements, each checked. `read` names the checklist and photos a save read, so
 * a change made since refuses the save instead of being overwritten.
 */
function checklistWrites(organizationId: string, actorId: string, homes: string[], stored: string, references: Array<{ itemId: string; assetId: string }>, now: string, read?: { checklist: string; references: string }): BatchQuery[] {
  const targets = d1JsonStringSet(homes)
  return [{
    query: `UPDATE product_stay_configs SET turnover_checklist = ?, updated_at = ?, updated_by = ?
      WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?))${read ? ` AND turnover_checklist = ? AND ${referencesKeySql('product_stay_configs')} = ?` : ''}`,
    params: [stored, now, actorId, organizationId, targets, ...(read ? [read.checklist, read.references] : [])],
  }, changed(homes.length), {
    query: `DELETE FROM media_placements WHERE organization_id = ? AND owner_type = 'product' AND owner_id IN (SELECT value FROM json_each(?)) AND slot GLOB '${SLOT}*'`,
    params: [organizationId, targets],
  }, {
    query: `INSERT INTO media_placements (id, organization_id, owner_type, owner_id, slot, asset_id, sort_order, status, created_at, updated_at)
      SELECT lower(hex(randomblob(16))), ma.organization_id, 'product', home.value, '${SLOT}' || json_extract(ref.value, '$.item'), ma.id, 0, 'active', ?, ?
        FROM json_each(?) home JOIN json_each(?) ref
        JOIN media_assets ma ON ma.organization_id = ? AND ma.id = json_extract(ref.value, '$.asset') AND ma.kind = 'image' AND ma.status = 'active'`,
    params: [now, now, targets, JSON.stringify(references.map(ref => ({ item: ref.itemId, asset: ref.assetId }))), organizationId],
  }, changed(homes.length * references.length)]
}

/** Run checklist writes; a check that failed is a change made since the checklist was read. */
async function runChecklistWrites(db: DbClient, queries: BatchQuery[], operation: string): Promise<void> {
  try {
    await executeBatch(db, queries, { operation })
  } catch (error) {
    if (/malformed JSON/.test(error instanceof Error ? error.message : String(error))) fail(409, 'CHECKLIST_CHANGED', 'The checklist or a home changed since you opened it; reload it', 'expected_revision')
    throw error
  }
}

function checklistEvent(access: StayAccess, locationId: string, productId: string, items: number, copiedFrom?: string): BatchQuery {
  return organizationEventQuery({ organizationId: access.organizationId, locationId, actorId: access.actorId, eventType: 'stay.checklist_updated', entityType: 'stay_home', entityId: productId,
    metadata: { items, ...(copiedFrom ? { copied_from: copiedFrom } : {}) } })
}

/**
 * Replace a home's checklist with `items`, in order. An item keeps its id
 * when it sends the one it was read with; a new one gets one. Owners and
 * admins only. A submission already made keeps what it was made against.
 */
export async function saveHomeChecklist(db: DbClient, env: MediaLinkEnv, access: StayAccess, productId: string, body: Record<string, unknown>): Promise<HomeTurnoverChecklist> {
  requireManager(access)
  const unknown = Object.keys(body).find(key => key !== 'items' && key !== 'expected_revision')
  if (unknown) fail(422, 'INVALID_CHECKLIST_ITEM', `${unknown} is not part of a checklist`, unknown)
  if (typeof body.expected_revision !== 'string' || !body.expected_revision) fail(422, 'INVALID_CHECKLIST_ITEM', 'expected_revision is the revision read with the checklist', 'expected_revision')
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
    // A reference photo is private (#2092): one uploaded for a checklist slot, stored where only signed links reach it — it has no
    // public URL — and on no public slot, so a listing photo is never made a reference.
    query: `SELECT id FROM media_assets ma WHERE organization_id = ? AND id IN (SELECT value FROM json_each(?)) AND kind = 'image' AND status = 'active' AND public_url IS NULL
      AND NOT EXISTS (SELECT 1 FROM media_placements held WHERE held.asset_id = ma.id AND held.organization_id = ma.organization_id AND NOT ${privateMediaPlacementSql('held')})`,
    params: [access.organizationId, d1JsonStringSet(assetIds)],
  }], { operation: 'Read a turnover checklist to save' })).map(result => result.results as Array<Record<string, string>>)
  const current = homeRows![0] as (ChecklistColumns & { product_id: string; location_id: string; references_key: string }) | undefined
  if (!current) fail(404, 'HOME_NOT_FOUND', 'That place to stay is not in this organization')
  if (checklistRevision(await checklistOf(env, current, productId)) !== body.expected_revision) fail(409, 'CHECKLIST_CHANGED', 'The checklist changed since you opened it; reload it', 'expected_revision')
  const found = new Set(assetRows!.map(row => row.id))
  const missing = items.findIndex(item => item.reference_photo_id && !found.has(item.reference_photo_id))
  if (missing >= 0) fail(422, 'INVALID_REFERENCE_PHOTO', 'The reference photo must be an image uploaded for this checklist (its upload names the checklist slot)', `items[${missing}].reference_photo_id`)
  const stored: TurnoverChecklistItem[] = items.map(({ reference_photo_id: _reference, ...item }) => ({
    id: item.id, title: item.title, instructions: item.instructions, type: item.type, minimum: item.minimum, per_guest: item.per_guest, baseline: item.baseline, photo_required: item.photo_required,
  }))
  const now = new Date().toISOString()
  const references = items.flatMap(item => item.reference_photo_id ? [{ itemId: item.id, assetId: item.reference_photo_id }] : [])
  await runChecklistWrites(db, [
    ...checklistWrites(access.organizationId, access.actorId, [productId], JSON.stringify(stored), references, now, { checklist: current.turnover_checklist, references: current.references_key }),
    checklistEvent(access, current.location_id, productId, stored.length),
  ], 'Save turnover checklist')
  return readHomeChecklist(db, env, access, productId)
}

const MAX_COPY_HOMES = MAX_D1_BATCH_STATEMENTS - 10

/**
 * Copy a home's checklist, reference photos included, to other homes: each
 * target's checklist becomes this one. Owners and admins only.
 */
export async function copyHomeChecklist(db: DbClient, env: MediaLinkEnv, access: StayAccess, productId: string, body: Record<string, unknown>): Promise<{ product_ids: string[]; checklist: HomeTurnoverChecklist }> {
  requireManager(access)
  const unknown = Object.keys(body).find(key => key !== 'product_ids')
  if (unknown) fail(422, 'INVALID_CHECKLIST_COPY', `${unknown} is not part of a copy`, unknown)
  const targets = body.product_ids
  if (!Array.isArray(targets) || !targets.length || targets.some(id => typeof id !== 'string' || !id) || new Set(targets).size !== targets.length) {
    fail(422, 'INVALID_CHECKLIST_COPY', 'product_ids must list the other homes to copy the checklist to, each once', 'product_ids')
  }
  if (targets.includes(productId)) fail(422, 'INVALID_CHECKLIST_COPY', 'A home cannot copy its checklist to itself', 'product_ids')
  // Each home is one recorded event in the copy's one batch.
  if (targets.length > MAX_COPY_HOMES) fail(422, 'INVALID_CHECKLIST_COPY', `Copy to at most ${MAX_COPY_HOMES} homes at a time`, 'product_ids')
  const source = await readHomeChecklist(db, env, access, productId)
  const homes = await queryAll<{ product_id: string; location_id: string }>(db, `SELECT product_id, location_id FROM product_stay_configs
    WHERE organization_id = ? AND product_id IN (SELECT value FROM json_each(?))`, [access.organizationId, d1JsonStringSet(targets as string[])])
  const absent = (targets as string[]).filter(id => !homes.some(home => home.product_id === id))
  if (absent.length) fail(404, 'HOME_NOT_FOUND', `These are not places to stay in this organization: ${absent.join(', ')}`, 'product_ids')
  const stored = JSON.stringify(source.items.map(({ reference_photo: _reference, ...item }) => item))
  const references = source.items.flatMap(item => item.reference_photo ? [{ itemId: item.id, assetId: item.reference_photo.id }] : [])
  const now = new Date().toISOString()
  await runChecklistWrites(db, [
    ...checklistWrites(access.organizationId, access.actorId, homes.map(home => home.product_id), stored, references, now),
    ...homes.map(home => checklistEvent(access, home.location_id, home.product_id, source.items.length, productId)),
  ], 'Copy turnover checklist')
  return { product_ids: homes.map(home => home.product_id), checklist: source }
}


/**
 * A reference photo uploaded for a home's checklist (#2092): stored privately and
 * kept on a reference slot of its own until a save names it, which clears the
 * slots it does not name. It is never a library or listing picture.
 */
export async function storeReferencePhoto(db: DbClient, env: UploadResolvedMediaInput['env'] & MediaLinkEnv, input: {
  organizationId: string; userId: string; productId: string; buffer: Uint8Array<ArrayBuffer>; contentType: string; filename: string
}): Promise<{ asset_id: string; url: string; thumbnail_url: string }> {
  const placement = { owner_type: 'product', slot: `${SLOT}upload-${crypto.randomUUID()}` } as const
  const uploaded = await uploadResolvedMediaToAssetStore({
    db, env, organizationId: input.organizationId, userId: input.userId, source: 'uploaded', kind: 'image',
    buffer: input.buffer, contentType: input.contentType, filename: input.filename, placement,
    queries: assetId => [buildMediaPlacementInsertQuery({ organizationId: input.organizationId, ownerType: 'product', ownerId: input.productId, slot: placement.slot, assetId, sortOrder: 0 })],
  })
  const asset = await getMediaAsset(db, uploaded.assetId, input.organizationId)
  if (!asset) throw new Error(`Reference photo ${uploaded.assetId} was not saved`)
  const links = await mediaLinks(env, asset, placement)
  return { asset_id: asset.id, url: links.url, thumbnail_url: links.thumbnail_url ?? links.url }
}
