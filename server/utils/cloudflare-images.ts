import { HTTPError } from 'nitro'
import { MAX_IMAGE_BYTES } from '~/server/utils/media-mime'

interface CloudflareImagesEnv {
  CF_ACCOUNT_ID?: string
  CLOUDFLARE_IMAGES_API_TOKEN?: string
  CLOUDFLARE_IMAGES_VARIANT_BASE?: string
  IMAGES?: ImagesBinding
}

function accountId(env: CloudflareImagesEnv): string {
  return env.CF_ACCOUNT_ID || ''
}

/**
 * Only production holds the Images credentials, on purpose. Staging, preview,
 * local development and E2E run on copies of production's rows, and those rows
 * name production's images: an environment holding the token deleted
 * production's social cards whenever it regenerated its own. Without the
 * credentials those environments still show every image (delivery URLs are
 * public) but cannot store or delete one, and this says so rather than failing
 * somewhere further down.
 */
export function cloudflareImagesConfigured(env: CloudflareImagesEnv): boolean {
  return Boolean(accountId(env) && env.CLOUDFLARE_IMAGES_API_TOKEN && env.CLOUDFLARE_IMAGES_VARIANT_BASE)
}

export function assertCloudflareImagesConfigured(env: CloudflareImagesEnv): void {
  if (cloudflareImagesConfigured(env)) return
  throw new HTTPError({
    statusCode: 503,
    statusMessage: 'Cloudflare Images is not configured in this environment, by design',
    data: { code: 'IMAGE_UPLOAD_UNAVAILABLE' },
    message: 'Cloudflare Images is not configured in this environment, by design. Only production holds the Images credentials: staging, preview, local development and E2E run on copies of production data, so storing or deleting an image from them would change production\'s images. Image uploads, social-card generation and image deletion run only in production; do not add the credentials here to make this pass.',
  })
}

interface CloudflareImagesResponse {
  result?: {
    id?: string
    uploadURL?: string
  }
}

function apiBase(env: CloudflareImagesEnv): string {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId(env)}/images`
}

function authHeader(env: CloudflareImagesEnv): Record<string, string> {
  return { Authorization: `Bearer ${env.CLOUDFLARE_IMAGES_API_TOKEN}` }
}

/** Request a one-time Direct Creator Upload URL. Client uploads directly to CF Images — no server buffering. */
export async function requestImageUpload(env: CloudflareImagesEnv): Promise<{ imageId: string; uploadUrl: string }> {
  assertCloudflareImagesConfigured(env)
  const formData = new FormData()
  const res = await fetch(`${apiBase(env)}/v2/direct_upload`, {
    method: 'POST',
    headers: authHeader(env),
    body: formData,
  })
  if (!res.ok) throw new Error(`CF Images direct_upload error ${res.status}: ${await res.text()}`)
  const data = await res.json() as CloudflareImagesResponse
  const imageId = typeof data?.result?.id === 'string' ? data.result.id : ''
  const uploadUrl = typeof data?.result?.uploadURL === 'string' ? data.result.uploadURL : ''
  if (!imageId || !uploadUrl) {
    throw new Error(`CF Images direct_upload malformed response ${res.status}: ${JSON.stringify(data)}`)
  }
  return { imageId, uploadUrl }
}

async function sha256Hex(buffer: ArrayBuffer | Uint8Array<ArrayBuffer>): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * Store an image. A public image is stored under our own id. A private one
 * cannot be: Cloudflare refuses `requireSignedURLs` on an image uploaded with a
 * custom id ("Images with custom ID paths cannot be made private using signed
 * URL tokens"), so it gets Cloudflare's own id and carries its asset id in its
 * metadata instead.
 *
 * Private uploads use the provider's generated ID. A failed upload fails;
 * successful MCP retries use the saved media asset and creation event.
 */
export async function uploadImageBuffer(env: CloudflareImagesEnv, buffer: ArrayBuffer | Uint8Array<ArrayBuffer>, filename: string, contentType?: string, image?: { id: string }): Promise<{ imageId: string; publicUrl: string; thumbnailUrl: string }>
export async function uploadImageBuffer(env: CloudflareImagesEnv, buffer: ArrayBuffer | Uint8Array<ArrayBuffer>, filename: string, contentType: string, image: { privateAssetId: string; replacedImageId?: string }): Promise<{ imageId: string; publicUrl: null; thumbnailUrl: null }>
export async function uploadImageBuffer(
  env: CloudflareImagesEnv,
  buffer: ArrayBuffer | Uint8Array<ArrayBuffer>,
  filename: string,
  contentType = 'image/png',
  image: { id: string } | { privateAssetId: string; replacedImageId?: string } = { id: `image-${crypto.randomUUID()}` },
): Promise<{ imageId: string; publicUrl: string | null; thumbnailUrl: string | null }> {
  assertCloudflareImagesConfigured(env)
  const contentHash = await sha256Hex(buffer)
  const privateAssetId = 'privateAssetId' in image ? image.privateAssetId : null
  const form = new FormData()
  form.append('file', new Blob([buffer], { type: contentType }), filename)
  if ('id' in image) form.append('id', image.id)
  else form.append('requireSignedURLs', 'true')
  form.append('metadata', JSON.stringify({ content_sha256: contentHash, ...(privateAssetId ? { asset_id: privateAssetId, ...('replacedImageId' in image && image.replacedImageId ? { replaced_image_id: image.replacedImageId } : {}) } : {}) }))
  let imageId: string
  try {
    const res = await fetch(`${apiBase(env)}/v1`, {
      method: 'POST',
      headers: authHeader(env),
      body: form,
    })
    if (!res.ok) throw new Error(`CF Images upload error ${res.status}: ${await res.text()}`)
    const data = await res.json() as CloudflareImagesResponse
    const returned = data.result?.id
    if (!returned || ('id' in image && returned !== image.id)) throw new Error(`CF Images upload did not return image ${'id' in image ? image.id : `for asset ${privateAssetId}`}`)
    imageId = returned
  } catch (error) {
    if ('privateAssetId' in image) throw error
    let uploaded: string | null
    try {
      uploaded = await publicImageMatching(env, image.id, contentHash)
    } catch (readError) {
      throw new AggregateError([error, readError], `The upload result for ${privateAssetId ? `asset ${privateAssetId}` : `image ${(image as { id: string }).id}`} could not be read`, { cause: readError })
    }
    if (!uploaded) throw error
    imageId = uploaded
  }
  if (privateAssetId) return { imageId, publicUrl: null, thumbnailUrl: null }
  return {
    imageId,
    publicUrl: buildImageUrl(env, imageId, 'public'),
    thumbnailUrl: buildImageUrl(env, imageId, 'thumbnail'),
  }
}

async function publicImageMatching(env: CloudflareImagesEnv, imageId: string, contentHash: string): Promise<string | null> {
  const uploaded = await getUploadedImage(env, imageId)
  return uploaded && !uploaded.draft && uploaded.meta?.content_sha256 === contentHash ? imageId : null
}

/**
 * How long a private image's link works. A link is made each time a read that
 * passed its access check returns the image; 24 hours is Cloudflare's own
 * example and outlasts a working session, so a thread left open keeps its photos.
 */
export const PRIVATE_IMAGE_LINK_SECONDS = 24 * 60 * 60

/** A private image's full and thumbnail links, signed by the Images binding: the Worker never holds the signing key. */
export async function signedImageUrls(env: CloudflareImagesEnv, imageId: string): Promise<{ url: string; thumbnail_url: string }> {
  if (!env.IMAGES) throw new Error('The Cloudflare Images binding is required to link a private image')
  const image = env.IMAGES.hosted.image(imageId)
  const [url, thumbnail_url] = await Promise.all([
    image.signedUrl({ variant: 'public', expiresIn: PRIVATE_IMAGE_LINK_SECONDS }),
    image.signedUrl({ variant: 'thumbnail', expiresIn: PRIVATE_IMAGE_LINK_SECONDS }),
  ])
  return { url, thumbnail_url }
}

/** Read the stored original through the Images binding. */
export async function downloadImageBuffer(env: CloudflareImagesEnv, imageId: string): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!env.IMAGES) throw new Error('The Cloudflare Images binding is required to read an original image')
  const original = await env.IMAGES.hosted.image(imageId).bytes()
  if (!original) return null
  const bytes = new Uint8Array(await new Response(original).arrayBuffer())
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(`CF Images download ${imageId} exceeds the message photo limit`)
  return bytes
}

/** Delete an image from Cloudflare Images. */
export async function deleteImage(env: CloudflareImagesEnv, imageId: string): Promise<void> {
  assertCloudflareImagesConfigured(env)
  let res: Response
  try {
    res = await fetch(`${apiBase(env)}/v1/${imageId}`, {
      method: 'DELETE',
      headers: authHeader(env),
      })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error'
    throw new Error(`CF Images delete request failed for ${imageId}: ${message}`, { cause: error })
  }

  if (!res.ok && res.status !== 404) {
    const details = await res.text()
    throw new Error(`CF Images delete error ${res.status}: ${details}`)
  }
}

/** Build a Cloudflare Images delivery URL for a given variant. */
/**
 * The stored filename of an image, from Cloudflare rather than from anything a
 * client sent. Null when the image is gone.
 */
export async function getUploadedImage(env: CloudflareImagesEnv, imageId: string) {
  assertCloudflareImagesConfigured(env)
  const res = await fetch(`${apiBase(env)}/v1/${imageId}`, {
    headers: authHeader(env),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`CF Images lookup error ${res.status}: ${await res.text()}`)
  // The details response carries the metadata an upload sent as `meta`.
  const data = await res.json() as { result?: { id?:string; filename?:string; meta?:Record<string,unknown>; draft?:boolean; requireSignedURLs?: boolean } }
  if (data.result?.id !== imageId || typeof data.result.filename !== 'string') throw new Error(`CF Images lookup did not return image ${imageId}`)
  return data.result
}

export async function getImageFilename(env: CloudflareImagesEnv, imageId: string): Promise<string | null> {
  return (await getUploadedImage(env,imageId))?.filename ?? null
}

/**
 * Deletes an image only when Cloudflare says it carries the expected filename.
 *
 * Ownership is never inferred from a delivery URL. `user.image` is a plain
 * Better Auth field an authenticated client can set to any string, so a URL
 * there proves nothing — someone could point it at another person's image and
 * have us delete it with the account-wide token. The filename we set at upload
 * is server-trusted state, and this checks it.
 */
export async function deleteImageOwnedBy(env: CloudflareImagesEnv, imageId: string, expectedFilename: string): Promise<boolean> {
  const filename = await getImageFilename(env, imageId)
  if (filename !== expectedFilename) return false
  await deleteImage(env, imageId)
  return true
}

export function buildImageUrl(env: CloudflareImagesEnv, imageId: string, variant = 'public'): string {
  if (!env.CLOUDFLARE_IMAGES_VARIANT_BASE) {
    throw new Error('Cloudflare Images variant base not configured')
  }
  return `${env.CLOUDFLARE_IMAGES_VARIANT_BASE}/${imageId}/${variant}`
}
