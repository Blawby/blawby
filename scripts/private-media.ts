// One-time move of the files private slots held before those slots were
// private (#2092): conversation photos stored as public images under our own
// id, and documents in the public bucket. Each is stored privately by the same
// code new uploads use (storePlacedMediaPrivately), and its public copy is
// deleted. Run --prepare before deployment to copy R2 destinations without
// changing existing reads, then run the ordinary repair after deployment. Run after the release that declares the slots private is deployed:
// until then that release's reads already sign links, which work for a public
// image too, so nothing breaks in between. Repeating it changes nothing.
//
// Usage (CLOUDFLARE_IMAGES_API_TOKEN, CF_ACCOUNT_ID and
// CLOUDFLARE_IMAGES_VARIANT_BASE in the environment; production only, as for
// every Images write):
//   yarn db:private-media --production --dry-run
//   yarn db:private-media --production
//
// Staging runs on copies of production's rows, which name production's images,
// so it stores no image (it still reads the variants, so it needs the same token): `--staging` adopts, for each private slot image it
// copied, the private image production now names for the same asset, and moves
// staging's own documents to its private bucket.
//   yarn db:private-media --staging --dry-run
//   yarn db:private-media --staging
//
// Each run reports the private slot files still stored publicly before and
// after, and a write run fails unless none are left.
import { parseArgs } from 'node:util'
import { Miniflare } from 'miniflare'
import { startRemoteProxySession, unstable_readConfig } from 'wrangler'
import { executeBatch, queryAll, type DbClient } from '../server/db/index.ts'
import { storePlacedMediaPrivately, uploadResolvedMediaToAssetStore } from '../server/utils/media-upload.ts'
import { readR2Object, uploadToR2 } from '../server/utils/cloudflare-r2.ts'
import { deleteImage, downloadImageBuffer } from '../server/utils/cloudflare-images.ts'
import { privateMediaPlacementSql } from '../shared/media-placement-contract.ts'

const { values } = parseArgs({
  options: { staging: { type: 'boolean', default: false }, production: { type: 'boolean', default: false }, 'dry-run': { type: 'boolean', default: false }, prepare: { type: 'boolean', default: false } },
  strict: true,
})
if (values.staging === values.production) throw new Error('Pass exactly one of --staging or --production.')
const write = !values['dry-run']

function bindings(envName: string | undefined) {
  const config = unstable_readConfig({ config: 'wrangler.toml', env: envName }, { hideWarnings: true })
  const database = config.d1_databases.find((binding: { binding: string }) => binding.binding === 'DB')
  const bucket = (name: string) => config.r2_buckets.find((binding: { binding: string }) => binding.binding === name)?.bucket_name
  if (!database?.database_id || !bucket('MEDIA_BUCKET') || !bucket('PRIVATE_MEDIA_BUCKET')) throw new Error(`wrangler.toml lacks DB, MEDIA_BUCKET or PRIVATE_MEDIA_BUCKET for ${envName ?? 'production'}`)
  return { compatibilityDate: config.compatibility_date ?? '2024-11-01', databaseId: database.database_id as string, databaseName: database.database_name as string, publicBucket: bucket('MEDIA_BUCKET')!, privateBucket: bucket('PRIVATE_MEDIA_BUCKET')! }
}

const target = bindings(values.staging ? 'staging' : undefined)
const production = values.staging ? bindings(undefined) : null
const session = await startRemoteProxySession({
  DB: { type: 'd1', database_id: target.databaseId },
  ...(production ? { PRODUCTION_DB: { type: 'd1', database_id: production.databaseId } } : {}),
  MEDIA_BUCKET: { type: 'r2', bucket_name: target.publicBucket },
  PRIVATE_MEDIA_BUCKET: { type: 'r2', bucket_name: target.privateBucket },
  IMAGES: { type: 'images' },
})
const runtime = new Miniflare({
  workers: [{
    dev: { remoteProxyConnectionString: session.remoteProxyConnectionString },
    config: {
      name: 'private-media',
      compatibilityDate: target.compatibilityDate,
      manifest: { mainModule: 'index.mjs', modules: { 'index.mjs': { type: 'esm', contents: 'export default { fetch() { return new Response("ok") } }' } } },
      env: {
        DB: { type: 'd1', id: target.databaseId, dev: { remote: true } },
        ...(production ? { PRODUCTION_DB: { type: 'd1', id: production.databaseId, dev: { remote: true } } } : {}),
        MEDIA_BUCKET: { type: 'r2', name: target.publicBucket, dev: { remote: true } },
        PRIVATE_MEDIA_BUCKET: { type: 'r2', name: target.privateBucket, dev: { remote: true } },
        IMAGES: { type: 'images', dev: { remote: true } },
      },
    },
  }],
})

type Candidate = { id: string; organization_id: string; provider: string; cloudflare_image_id: string | null; r2_key: string | null; file_name: string | null; mime_type: string | null }

/** Every active asset a private slot holds, as stored. */
const PRIVATE_SLOT_ASSETS = `SELECT DISTINCT ma.id, ma.organization_id, ma.provider, ma.cloudflare_image_id, ma.r2_key, ma.file_name, ma.mime_type, ma.public_url
  FROM media_assets ma JOIN media_placements mp ON mp.asset_id = ma.id AND mp.organization_id = ma.organization_id AND mp.status = 'active'
  WHERE ma.status = 'active' AND ${privateMediaPlacementSql('mp')}`

try {
  const bound = await runtime.getBindings<Record<string, unknown>>()
  const db = bound.DB as DbClient
  const images = bound.IMAGES as ImagesBinding
  const publicBucket = bound.MEDIA_BUCKET as R2Bucket
  const privateBucket = bound.PRIVATE_MEDIA_BUCKET as R2Bucket
  const env = {
    ...bound,
    CF_ACCOUNT_ID: process.env.CF_ACCOUNT_ID, CLOUDFLARE_IMAGES_API_TOKEN: process.env.CLOUDFLARE_IMAGES_API_TOKEN,
    CLOUDFLARE_IMAGES_VARIANT_BASE: process.env.CLOUDFLARE_IMAGES_VARIANT_BASE,
  }

  // A variant that never requires a signature serves every private image unsigned to anyone who knows its id, which a signed URL shows.
  if (!process.env.CF_ACCOUNT_ID || !process.env.CLOUDFLARE_IMAGES_API_TOKEN) throw new Error('CF_ACCOUNT_ID and CLOUDFLARE_IMAGES_API_TOKEN are required')
  const variants = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}/images/v1/variants`, { headers: { Authorization: `Bearer ${process.env.CLOUDFLARE_IMAGES_API_TOKEN}` } })
  if (!variants.ok) throw new Error(`Cloudflare Images variants could not be read: ${variants.status} ${await variants.text()}`)
  const unsigned = Object.entries((await variants.json() as { result: { variants: Record<string, { neverRequireSignedURLs?: boolean }> } }).result.variants)
    .filter(([, variant]) => variant.neverRequireSignedURLs).map(([name]) => name)
  if (unsigned.length) throw new Error(`Cloudflare Images variants ${unsigned.join(', ')} never require a signed URL, so a private image is public through them; turn that off first`)

  const storageEnv = env as Parameters<typeof storePlacedMediaPrivately>[0]['env']
  if (values.prepare) {
    // Prepare the destination before deploy; the installed Worker still reads
    // the public copy. The ordinary repair removes that copy after cutover.
    for (const asset of await queryAll<Candidate>(db, PRIVATE_SLOT_ASSETS)) {
      if (asset.provider !== 'cloudflare_r2' || !asset.r2_key) continue
      if (!write) { console.log(`Prepare private R2 file ${asset.id}`); continue }
      const bytes = await readR2Object(storageEnv, asset.r2_key, 'public')
      if (!bytes) throw new Error(`Missing public R2 file ${asset.id}`)
      await uploadToR2(storageEnv, asset.r2_key, bytes, asset.mime_type ?? 'application/octet-stream', 'private')
      const copied = await privateBucket.head(asset.r2_key)
      if (!copied || copied.size !== bytes.byteLength) throw new Error(`Private R2 copy ${asset.id} was not stored`)
    }
    console.log('Private R2 destinations prepared; source rows and public copies unchanged.')
  } else {
  // A shared listing photo keeps its public owner. Its private placements
  // receive a separate private asset through the ordinary upload boundary.
  const shared = await queryAll<Candidate>(db, `${PRIVATE_SLOT_ASSETS} AND EXISTS (SELECT 1 FROM media_placements other
    WHERE other.asset_id = ma.id AND other.organization_id = ma.organization_id AND other.status = 'active' AND NOT ${privateMediaPlacementSql('other')})`)
  if (write) for (const asset of shared) {
    const bytes = asset.provider === 'cloudflare_images' && asset.cloudflare_image_id
      ? await downloadImageBuffer(storageEnv, asset.cloudflare_image_id)
      : asset.r2_key ? await readR2Object(storageEnv, asset.r2_key, 'public') : null
    if (!bytes) throw new Error(`Shared media asset ${asset.id} has no file`)
    await uploadResolvedMediaToAssetStore({ db, env: storageEnv, organizationId: asset.organization_id, userId: null, source: 'external',
      kind: 'image', provider: 'cloudflare_r2', buffer: bytes, contentType: asset.mime_type ?? 'image/jpeg', filename: asset.file_name ?? 'reference-photo',
      placement: { owner_type: 'product', slot: 'turnover_checklist.reference' },
      queries: assetId => [{ query: `UPDATE media_placements SET asset_id = ?, updated_at = ?
        WHERE asset_id = ? AND organization_id = ? AND ${privateMediaPlacementSql('media_placements')}`,
        params: [assetId, new Date().toISOString(), asset.id, asset.organization_id] }],
    })
  }

  /** The private slot files still readable without a signed link: an image that does not require one, or a file in the public bucket. */
  async function stillPublic(): Promise<(Candidate & { reason: string })[]> {
    const found: (Candidate & { reason: string })[] = []
    for (const asset of await queryAll<Candidate & { public_url: string | null }>(db, PRIVATE_SLOT_ASSETS)) {
      if (asset.provider === 'cloudflare_images' && asset.cloudflare_image_id) {
        const details = await images.hosted.image(asset.cloudflare_image_id).details()
        // Staging's copy still names the public image production replaced and deleted.
        if (!details && production) found.push({ ...asset, reason: 'image production replaced' })
        else if (!details) throw new Error(`Media asset ${asset.id} names Cloudflare image ${asset.cloudflare_image_id}, which is gone`)
        else if (!details.requireSignedURLs) found.push({ ...asset, reason: 'public image' })
        else if (!production && typeof details.meta?.replaced_image_id === 'string'
          && await images.hosted.image(details.meta.replaced_image_id).details()) found.push({ ...asset, reason: 'public original awaiting deletion' })
      } else if (asset.provider === 'cloudflare_r2' && asset.r2_key) {
        if (await publicBucket.head(asset.r2_key)) found.push({ ...asset, reason: 'file in the public bucket' })
      } else {
        throw new Error(`Media asset ${asset.id} in a private slot is stored by ${asset.provider}`)
      }
    }
    return found
  }

  const before = await stillPublic()
  const summary = (rows: { reason: string }[]) => Object.fromEntries([...new Set(rows.map(row => row.reason))].map(reason => [reason, rows.filter(row => row.reason === reason).length]))
  console.log(`${target.databaseName}: ${before.length} private slot files readable without a signed link`, summary(before))
  if (write) {
    // Files first: on staging they move whether or not production has stored its images yet.
    for (const asset of [...before].sort((a, b) => Number(a.provider === 'cloudflare_images') - Number(b.provider === 'cloudflare_images'))) {
      if (asset.reason === 'public original awaiting deletion' && asset.cloudflare_image_id) {
        const details = await images.hosted.image(asset.cloudflare_image_id).details()
        const original = details?.meta?.replaced_image_id
        if (typeof original !== 'string') throw new Error(`Private image ${asset.id} lost its public source identity`)
        await deleteImage(storageEnv, original)
        continue
      }
      if (production && asset.provider === 'cloudflare_images') {
        // Staging's row is a copy of production's: it takes the private image production stored for the same asset.
        const [stored] = await queryAll<{ cloudflare_image_id: string | null }>(bound.PRODUCTION_DB as DbClient, 'SELECT cloudflare_image_id FROM media_assets WHERE id = ? AND organization_id = ?', [asset.id, asset.organization_id])
        const details = stored?.cloudflare_image_id ? await images.hosted.image(stored.cloudflare_image_id).details() : null
        if (!stored?.cloudflare_image_id || !details?.requireSignedURLs) throw new Error(`Production has not stored media asset ${asset.id} privately yet; run --production first`)
        await executeBatch(db, [{ query: 'UPDATE media_assets SET cloudflare_image_id = ?, public_url = NULL, thumbnail_url = NULL, updated_at = ? WHERE id = ? AND organization_id = ? AND cloudflare_image_id = ?',
          params: [stored.cloudflare_image_id, new Date().toISOString(), asset.id, asset.organization_id, asset.cloudflare_image_id] }], { operation: 'Adopt production private image' })
        continue
      }
      await storePlacedMediaPrivately({ db, env: storageEnv, asset: { ...asset, provider: asset.provider as 'cloudflare_images' | 'cloudflare_r2' } })
    }
    const after = await stillPublic()
    console.log(`${target.databaseName}: ${after.length} private slot files readable without a signed link after the run`, summary(after))
    if (after.length) throw new Error(`${after.length} private slot files are still public: ${after.map(asset => asset.id).join(', ')}`)
  } else {
    console.log(`Dry run: nothing written; ${shared.length} shared private references will receive separate assets.`)
  }
  }
} finally {
  await runtime.dispose()
  await session.dispose()
}
