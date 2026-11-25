import { parseCookie } from 'cookie-es'

export const ZARAZ_ANALYTICS_PURPOSE_ID = 'kc_analytics'

// Zaraz owns this cookie: it holds the visitor's answer for every purpose. Its
// presence means the visitor has answered, so the notice runs only when absent.
export const ZARAZ_CONSENT_COOKIE_NAME = 'kc_analytics_consent'

// The one optional tool Zaraz loads is Google Analytics; this purpose is its
// only switch. Blawby's first-party measurement (/api/analytics/track) is
// not a Zaraz tool and does not read this consent.
/**
 * The event name the collector sends to Zaraz once the native pageview is accepted. The GA4
 * pageview action fires on a trigger that matches exactly this event and on nothing else, so Google
 * Analytics never records a page view the native record did not accept.
 */
export const NATIVE_PAGEVIEW_ZARAZ_EVENT = 'blawby_native_pageview'
export const LEGACY_NATIVE_PAGEVIEW_ZARAZ_EVENT = 'krabiclaw_native_pageview'

/**
 * The visitor's own answer to the analytics purpose, from their Zaraz consent cookie. `absent`
 * means they have not answered (or the cookie is unreadable): that is not consent.
 */
export function readAnalyticsConsent(cookieHeader: string): 'accepted' | 'rejected' | 'absent' {
  const raw = parseCookie(cookieHeader)[ZARAZ_CONSENT_COOKIE_NAME]
  if (!raw) return 'absent'
  let purposes: unknown
  try { purposes = JSON.parse(raw) } catch { return 'absent' }
  if (typeof purposes !== 'object' || purposes === null) return 'absent'
  return (purposes as Record<string, unknown>)[ZARAZ_ANALYTICS_PURPOSE_ID] === true ? 'accepted' : 'rejected'
}
