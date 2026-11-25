import { errorChainForTelemetry } from '~/shared/error-telemetry'

/**
 * Where a file is stored follows from who may read it. `MEDIA_BUCKET` is served
 * to anyone by its public custom domains (media.blawby.com); a private slot's
 * file is kept in `PRIVATE_MEDIA_BUCKET`, which has no public access and is read
 * only through the Worker's signed-in media route.
 */
export type R2Visibility = 'public' | 'private'

function bucket(env: ApiRecord, visibility: R2Visibility): R2Bucket {
  const binding = visibility === 'private' ? env.PRIVATE_MEDIA_BUCKET : env.MEDIA_BUCKET
  if (!binding) throw new Error(`${visibility === 'private' ? 'PRIVATE_MEDIA_BUCKET' : 'MEDIA_BUCKET'} binding not available`)
  return binding as R2Bucket
}

function normalizeR2Key(key: string): string {
  const raw = String(key)
  if (!raw) throw new Error('Invalid key')
  if (raw.includes('\u0000')) throw new Error('Invalid key')
  if (raw.startsWith('/')) throw new Error('Invalid key')

  const parts = raw.split('/').filter(Boolean)
  if (!parts.length) throw new Error('Invalid key')

  const safeParts = parts.map((part) => {
    if (part === '.' || part === '..') throw new Error('Invalid key')
    if (!/^[A-Za-z0-9._-]+$/.test(part)) throw new Error('Invalid key')
    return part
  })

  return safeParts.join('/')
}

function r2BodyBytes(body: ArrayBuffer | ArrayBufferView | ReadableStream | Blob): number | null {
  if (body instanceof ArrayBuffer) return body.byteLength
  if (ArrayBuffer.isView(body)) return body.byteLength
  if (body instanceof Blob) return body.size
  return null
}

/** Upload a file to R2. A public file returns its CDN URL; a private one has none. */
export async function uploadToR2(
  env: ApiRecord,
  key: string,
  body: ArrayBuffer | ArrayBufferView | ReadableStream | Blob,
  contentType: string,
  visibility: R2Visibility = 'public',
): Promise<string | null> {
  const normalizedKey = normalizeR2Key(key)
  const startedAt = Date.now()
  try {
    await bucket(env, visibility).put(normalizedKey, body, { httpMetadata: { contentType } })
  } catch (putError) {
    // R2 surfaces transient internal errors as `put: ... (10001)`. Callers outside
    // uploadResolvedMediaToAssetStore log nothing, so record the write here.
    console.error({
      event: 'r2_put_failed',
      r2_key: normalizedKey,
      visibility,
      content_type: contentType,
      bytes: r2BodyBytes(body),
      streamed: !(body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof Blob),
      duration_ms: Date.now() - startedAt,
      errors: errorChainForTelemetry(putError),
    })
    throw putError
  }
  return visibility === 'public' ? getR2Url(env, normalizedKey) : null
}

/** Delete a file from R2. */
export async function deleteFromR2(env: ApiRecord, key: string, visibility: R2Visibility): Promise<void> {
  const normalizedKey = normalizeR2Key(key)
  await bucket(env, visibility).delete(normalizedKey)
}

/** Build the public CDN URL for an R2 key. */
export function getR2Url(env: ApiRecord, key: string): string {
  const base = typeof env.MEDIA_BASE_URL === 'string' ? env.MEDIA_BASE_URL.trim() : ''
  if (!base) throw new Error('MEDIA_BASE_URL is required')
  const normalizedBase = base.replace(/\/+$/, '')
  const encodedKey = normalizeR2Key(key)
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/')
  return `${normalizedBase}/${encodedKey}`
}

export function getR2KeyFromPublicUrl(env: ApiRecord, value: string): string | null {
  const base = typeof env.MEDIA_BASE_URL === 'string' ? env.MEDIA_BASE_URL.trim() : ''
  if (!base) return null
  try {
    const baseUrl = new URL(base.replace(/\/+$/, '') + '/')
    const candidate = new URL(value)
    if (candidate.origin !== baseUrl.origin || !candidate.pathname.startsWith(baseUrl.pathname)) return null
    const encodedKey = candidate.pathname.slice(baseUrl.pathname.length)
    if (!encodedKey) return null
    return normalizeR2Key(encodedKey.split('/').map(segment => decodeURIComponent(segment)).join('/'))
  } catch {
    return null
  }
}

/** Read a stored object's bytes, or null when the key holds nothing. */
export async function readR2Object(env: ApiRecord, key: string, visibility: R2Visibility): Promise<Uint8Array<ArrayBuffer> | null> {
  const object = await bucket(env, visibility).get(normalizeR2Key(key))
  return object ? new Uint8Array(await object.arrayBuffer()) : null
}

/** A private file as a stream, for the signed-in media route. */
export async function getPrivateR2Object(env: ApiRecord, key: string): Promise<R2ObjectBody | null> {
  return await bucket(env, 'private').get(normalizeR2Key(key))
}

/** Generate a namespaced R2 key for a media asset. */
export function buildR2Key(organizationId: string, assetId: string, filename: string): string {
  const sanitizeSegment = (value: string, label: string): string => {
    const trimmed = String(value).trim().replace(/^\/+|\/+$/g, '')
    if (!trimmed) throw new Error(`Invalid ${label}`)
    if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
      throw new Error(`Invalid ${label}`)
    }
    return trimmed
  }

  const safeOrganizationId = sanitizeSegment(organizationId, 'organizationId')
  const safeAssetId = sanitizeSegment(assetId, 'assetId')
  const safeFilename = sanitizeSegment(filename, 'filename')
  const dotIndex = safeFilename.lastIndexOf('.')
  const ext = dotIndex > 0 ? safeFilename.slice(dotIndex + 1) : ''
  return `organizations/${safeOrganizationId}/media/${safeAssetId}${ext ? '.' + ext : ''}`
}
