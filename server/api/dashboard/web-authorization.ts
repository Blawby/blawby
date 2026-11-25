import { defineHandler, HTTPError } from 'nitro'
import { getQuery, readBody } from 'nitro/h3'
import { validatedInternalPath } from '~/shared/auth/return-target'
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { createAuth, NATIVE_TOKEN_PREFIX, NATIVE_TOKEN_PURPOSE_HEADER } from '~/server/utils/auth'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { resolveUserOrganization } from '~/server/utils/member-access'

const privateHeaders = { 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }

export default defineHandler(async event => {
  for (const [name, value] of Object.entries(privateHeaders)) {
    event.res.headers.set(name, value)
    event.res.errHeaders.set(name, value)
  }
  if (event.req.method !== 'GET' && event.req.method !== 'POST') throw new HTTPError({ status: 405, message: 'Method not allowed', data: { code: 'METHOD_NOT_ALLOWED' } })
  const input = event.req.method === 'POST' ? await readBody<{ path?: unknown; token?: unknown }>(event) : getQuery(event)
  const path = validatedInternalPath(input?.path)
  const slug = path?.match(/^\/dashboard\/([a-z0-9][a-z0-9-]*)(?:[/?#]|$)/)?.[1]
  if (!path || path !== input?.path || !slug || slug === 'app' || slug === 'account') {
    throw new HTTPError({ status: 400, message: 'Choose a dashboard page in the workspace you want to edit.', data: { code: 'INVALID_DASHBOARD_PATH', field: 'path' } })
  }
  const env = cloudflareEnv(event)
  const auth = createAuth(env)
  if (event.req.method === 'POST') {
    await getDashboardMemberContext(event, { organizationSlug: slug })
    const headers = new Headers(event.req.headers)
    headers.set(NATIVE_TOKEN_PURPOSE_HEADER, 'dashboard')
    const { token } = await auth.api.generateOneTimeToken({ headers })
    const url = new URL('/api/dashboard/web-authorization', env.BETTER_AUTH_URL)
    url.search = new URLSearchParams({ path, token }).toString()
    return jsonResponse({ authorization_url: url.href }, { headers: privateHeaders })
  }

  const token = input?.token
  if (typeof token !== 'string' || !token.startsWith(NATIVE_TOKEN_PREFIX.dashboard)) {
    throw new HTTPError({ status: 400, message: 'The dashboard link is incomplete. Open the editor again from the app.', data: { code: 'INVALID_DASHBOARD_LINK', field: 'token' } })
  }
  const verified = await auth.api.verifyOneTimeToken({ body: { token }, asResponse: true })
  if (!verified.ok) {
    const headers = new Headers(verified.headers)
    for (const [name, value] of Object.entries(privateHeaders)) headers.set(name, value)
    headers.delete('set-cookie')
    return new Response(verified.body, { status: verified.status, statusText: verified.statusText, headers })
  }
  const session = await verified.json() as { user: { id: string } }
  const membership = await resolveUserOrganization(env, { userId: session.user.id, organizationSlug: slug }, event)
  if (!membership) throw new HTTPError({ status: 403, message: 'You no longer have access to this workspace.', data: { code: 'WORKSPACE_ACCESS_CHANGED' } })
  const headers = new Headers({ ...privateHeaders, Location: path })
  for (const cookie of verified.headers.getSetCookie()) headers.append('Set-Cookie', cookie)
  return new Response(null, { status: 303, headers })
})
