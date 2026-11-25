import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { queryFirst } from '~/server/db'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getPrivateR2Object } from '~/server/utils/cloudflare-r2'
import { verifyFileLink } from '~/server/utils/private-media'
import { privateMediaPlacementSql } from '~/shared/media-placement-contract'

/**
 * A private file, for the holder of a link a read made after its access check
 * (`mediaLinks`). The link names the asset and when it stops working; anything
 * else, or an asset no private slot holds, is not found.
 */
export default defineHandler(async event => {
  const env = cloudflareEnv(event)
  const assetId = getRouterParam(event, 'asset_id', { decode: true })
  const query = getQuery(event)
  const notFound = () => new HTTPError({ statusCode: 404, message: 'File not found', data: { code: 'MEDIA_NOT_FOUND', field: 'asset_id' } })
  if (!assetId || !await verifyFileLink(env, assetId, query.exp, query.sig)) throw notFound()
  const asset = await queryFirst<{ r2_key: string; file_name: string | null; mime_type: string | null }>(env.DB, `
    SELECT ma.r2_key, ma.file_name, ma.mime_type FROM media_assets ma
     WHERE ma.id = ? AND ma.status = 'active' AND ma.provider = 'cloudflare_r2' AND ma.r2_key IS NOT NULL
       AND EXISTS (SELECT 1 FROM media_placements mp WHERE mp.asset_id = ma.id AND mp.organization_id = ma.organization_id AND mp.status = 'active' AND ${privateMediaPlacementSql('mp')})`, [assetId])
  if (!asset) throw notFound()
  const object = await getPrivateR2Object(env, asset.r2_key)
  if (!object) throw new Error(`Private file ${assetId} is missing from storage`)
  const fileName = (asset.file_name ?? 'file').replace(/[^A-Za-z0-9._-]/g, '-')
  return new Response(object.body, {
    headers: {
      'content-type': asset.mime_type ?? object.httpMetadata?.contentType ?? 'application/octet-stream',
      'content-length': String(object.size),
      'content-disposition': `${query.download === '1' ? 'attachment' : 'inline'}; filename="${fileName}"`,
      'cache-control': 'private, no-store',
      'x-content-type-options': 'nosniff',
      // The link is the permission, as a Cloudflare signed image URL is: a tenant site's page may fetch it to draw the PDF.
      'access-control-allow-origin': '*',
    },
  })
})
