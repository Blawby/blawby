import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'

function versionError(status: number, code: string, message: string) {
  return jsonResponse({ error: true, status, message, data: { code } }, {
    status, headers: { 'cache-control': 'no-store' },
  })
}

// Marketing version (build), from CFBundleShortVersionString and CFBundleVersion.
const VERSION = /^(\d{1,5})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))? \((\d{1,5})(?:\.(\d{1,5}))?(?:\.(\d{1,5}))?\)$/

export default defineHandler((event) => {
  if (!event.url.pathname.startsWith('/api/')) return
  const installed = event.req.headers.get('x-blawby-app-version')
  if (installed === null) return
  const version = VERSION.exec(installed)
  if (!version) {
    return versionError(400, 'INVALID_APP_VERSION', 'Invalid Blawby app version header.')
  }
  const minimum = event.req.runtime?.cloudflare?.env?.IOS_MINIMUM_VERSION
  if (minimum === undefined || minimum === '') return
  const supported = typeof minimum === 'string' ? VERSION.exec(minimum) : null
  if (!supported) {
    return versionError(500, 'INVALID_IOS_MINIMUM_VERSION', 'The minimum supported iOS version is invalid.')
  }
  for (let index = 1; index <= 6; index++) {
    const actual = Number(version[index] ?? 0)
    const required = Number(supported[index] ?? 0)
    if (actual > required) return
    if (actual < required) {
      return versionError(426, 'APP_UPDATE_REQUIRED', 'Update Blawby to continue using the app.')
    }
  }
})
