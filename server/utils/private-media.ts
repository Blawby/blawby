import { timingSafeEqual } from 'node:crypto'
import { isPrivateMediaPlacement, type MediaPlacementSlot } from '~/shared/media-placement-contract'
import { PRIVATE_IMAGE_LINK_SECONDS, signedImageUrls } from '~/server/utils/cloudflare-images'
import { platformOrigin } from '~/server/utils/dashboard-notification-links'
import type { CloudflareEnv } from '~/server/utils/auth'

/*
  The one way a read turns a stored asset into URLs. A public slot's asset is
  read at its stored public URL. A private slot's asset is given a link that
  works for `PRIVATE_IMAGE_LINK_SECONDS` and only because the read that made it
  passed its owner's access check (a seat in the conversation, the booking's
  agreement rule, the listing's member scope):

  - an image: a Cloudflare Images signed URL, signed by the Images binding, so
    its variants are served by Cloudflare and nothing streams through us;
  - any other file (a PDF, an AVIF photo Cloudflare Images cannot store): this
    Worker's `/api/media/<asset_id>` route, with the same `exp` and `sig` shape,
    streaming from the private R2 bucket.

  Web, iOS and MCP load a URL either way. Local development and CI sign with
  Miniflare's own Images key, so a private image copied from production shows
  as missing locally instead of failing the read.
*/

export interface LinkedMediaAsset {
  id: string
  kind: string
  provider: string
  cloudflare_image_id: string | null
  public_url: string | null
  thumbnail_url: string | null
}

export interface MediaLinks { url: string; thumbnail_url: string | null }

export type MediaLinkEnv = Pick<CloudflareEnv, 'BETTER_AUTH_SECRET' | 'IMAGES' | 'NUXT_PUBLIC_PLATFORM_DOMAIN'>

/** The URLs a reader is given for an asset in this slot. */
export async function mediaLinks(env: MediaLinkEnv, asset: LinkedMediaAsset, placement: MediaPlacementSlot): Promise<MediaLinks> {
  if (!isPrivateMediaPlacement(placement)) {
    if (!asset.public_url) throw new Error(`Public media asset ${asset.id} has no public URL`)
    return { url: asset.public_url, thumbnail_url: asset.thumbnail_url }
  }
  if (asset.provider === 'cloudflare_images') {
    if (!asset.cloudflare_image_id) throw new Error(`Private image ${asset.id} has no Cloudflare image`)
    return await signedImageUrls(env, asset.cloudflare_image_id)
  }
  if (asset.provider !== 'cloudflare_r2') throw new Error(`Private media asset ${asset.id} is stored by ${asset.provider}, which cannot keep it private`)
  const url = await signedFileUrl(env, asset.id)
  return { url, thumbnail_url: asset.kind === 'image' ? url : null }
}

const encoder = new TextEncoder()

async function linkSignature(secret: string, assetId: string, expiresAt: number): Promise<string> {
  // A key of its own, derived from the auth secret, so a media link signs nothing else.
  const derive = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const keyBytes = await crypto.subtle.sign('HMAC', derive, encoder.encode('blawby-private-media-link:v1'))
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${assetId}.${expiresAt}`))
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

export const MEDIA_ROUTE_PREFIX = '/api/media/'

async function signedFileUrl(env: MediaLinkEnv, assetId: string): Promise<string> {
  if (!env.BETTER_AUTH_SECRET) throw new Error('BETTER_AUTH_SECRET is required to link a private file')
  const expiresAt = Math.floor(Date.now() / 1000) + PRIVATE_IMAGE_LINK_SECONDS
  const url = new URL(`${MEDIA_ROUTE_PREFIX}${encodeURIComponent(assetId)}`, platformOrigin(env))
  url.searchParams.set('exp', String(expiresAt))
  url.searchParams.set('sig', await linkSignature(env.BETTER_AUTH_SECRET, assetId, expiresAt))
  return url.href
}

/** Whether a media route request carries a link this Worker made for this asset that has not expired. */
export async function verifyFileLink(env: Pick<CloudflareEnv, 'BETTER_AUTH_SECRET'>, assetId: string, exp: unknown, sig: unknown): Promise<boolean> {
  if (typeof exp !== 'string' || typeof sig !== 'string' || !/^\d{1,12}$/.test(exp) || !/^[0-9a-f]{64}$/.test(sig)) return false
  const expiresAt = Number(exp)
  if (expiresAt < Date.now() / 1000) return false
  const expected = encoder.encode(await linkSignature(env.BETTER_AUTH_SECRET, assetId, expiresAt))
  return timingSafeEqual(expected, encoder.encode(sig))
}
