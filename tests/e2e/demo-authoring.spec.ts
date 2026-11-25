import { expect, test } from '@playwright/test'
import { acceptOrganizationInvitation, authRequestHeaders, loginAs, sendOrganizationInvitation } from './helpers/auth'
import { findE2eAuthFixture } from '../../config/development-auth-fixtures'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import { seededTenant } from './seed/manifest'

test('demo website and language writes return readable coded refusals without changing saved state', async ({ request, baseURL }, testInfo) => {
  const tenant = seededTenant('restaurant')
  await loginAs(request, baseURL!, 'user-e2e-demo-owner')
  const release = await acquireTenantMutationLock(testInfo, tenant.organizationId)
  try {
    const settingsPath = `/api/dashboard/settings?org=${tenant.slug}`
    const languagesPath = `/api/editor/organizations/${tenant.organizationId}/locales`
    const settingsRead = await request.get(settingsPath)
    expect(settingsRead.status(), await settingsRead.text()).toBe(200)
    const settings = await settingsRead.json()
    const languagesRead = await request.get(languagesPath)
    expect(languagesRead.status(), await languagesRead.text()).toBe(200)
    const languages = await languagesRead.json() as { languages: { locale: string; is_source: number }[] }
    const source = languages.languages.find(language => language.is_source === 1)
    expect(source).toBeDefined()
    if (!source) throw new Error('The seeded demo has no saved source language')

    const settingsWrite = await request.patch(settingsPath, { data: { default_currency: settings.settings.default_currency } })
    expect(settingsWrite.status(), await settingsWrite.text()).toBe(403)
    expect(await settingsWrite.json()).toEqual({ error: 'Demo organization is read-only', code: 'DEMO_ORGANIZATION_READ_ONLY' })

    for (const action of ['add', 'publish', 'disable', 'delete']) {
      const path = `${languagesPath}/${source.locale}${action === 'delete' ? '' : `/${action}`}`
      const response = action === 'delete' ? await request.delete(path) : await request.post(path)
      expect(response.status(), await response.text()).toBe(403)
      expect(await response.json()).toMatchObject({
        error: true, status: 403, message: 'Demo organization is read-only',
        data: { code: 'DEMO_ORGANIZATION_READ_ONLY' },
      })
    }

    const productId = tenant.products['tables-brooklyn']!.id
    const productPath = `/api/editor/organizations/${tenant.organizationId}/products/${productId}?editor=1`
    const productRead = await request.get(productPath)
    expect(productRead.status(), await productRead.text()).toBe(200)
    const product = await productRead.json()
    const translationPath = `/api/editor/organizations/${tenant.organizationId}/localization/product/${productId}/${source.locale}`
    for (const method of ['PUT', 'DELETE']) {
      const response = await request.fetch(translationPath, { method, data: { values: {}, updated_at: null } })
      expect(response.status(), await response.text()).toBe(403)
      expect(await response.json()).toMatchObject({
        error: true, status: 403, message: 'Demo organization is read-only',
        data: { code: 'DEMO_ORGANIZATION_READ_ONLY' },
      })
    }
    const savedProduct = await request.get(productPath)
    expect(savedProduct.status(), await savedProduct.text()).toBe(200)
    expect(await savedProduct.json()).toEqual(product)

    const savedSettings = await request.get(settingsPath)
    expect(savedSettings.status(), await savedSettings.text()).toBe(200)
    expect(await savedSettings.json()).toEqual(settings)
    const savedLanguages = await request.get(languagesPath)
    expect(savedLanguages.status(), await savedLanguages.text()).toBe(200)
    expect(await savedLanguages.json()).toEqual(languages)
  } finally { release() }
})

test('a native dashboard link signs a fresh browser into the explicit workspace once', async ({ request, playwright, baseURL }) => {
  const tenant = seededTenant('restaurant')
  const signedIn = await loginAs(request, baseURL!, 'user-e2e-demo-owner')
  const { token } = await signedIn.json() as { token: string }
  const native = await playwright.request.newContext({ baseURL, extraHTTPHeaders: { authorization: `Bearer ${token}` } })
  const browser = await playwright.request.newContext({ baseURL })
  try {
    const anonymous = await browser.get('/api/auth/get-session')
    expect(anonymous.status()).toBe(200)
    expect(await anonymous.json()).toBeNull()
    for (const section of ['pages', 'blog', 'posts', 'qa', 'preferences/localization']) {
      const path = `/dashboard/${tenant.slug}/website/${section}`
      const started = await native.post('/api/dashboard/web-authorization', { data: { path } })
      expect(started.status(), await started.text()).toBe(200)
      const { authorization_url } = await started.json() as { authorization_url: string }
      expect(new URL(authorization_url).origin).toBe(new URL(baseURL!).origin)
      const opened = await browser.get(authorization_url, { maxRedirects: 0 })
      expect(opened.status(), await opened.text()).toBe(303)
      expect(opened.headers().location).toBe(path)
      expect(opened.headers()['cache-control']).toBe('no-store')
      expect(opened.headers()['referrer-policy']).toBe('no-referrer')
      const session = await browser.get('/api/auth/get-session')
      expect(session.status()).toBe(200)
      expect(await session.json()).toMatchObject({ user: { id: 'user-e2e-demo-owner' } })
      const repeated = await browser.get(authorization_url, { maxRedirects: 0 })
      expect(repeated.status(), await repeated.text()).toBe(400)
      expect(repeated.headers()['cache-control']).toBe('no-store')
      expect(repeated.headers()['referrer-policy']).toBe('no-referrer')
      expect(await repeated.json()).toMatchObject({ message: 'Invalid token' })
    }
  } finally { await native.dispose(); await browser.dispose() }
})

test('dashboard handoff rejects external, inferred and inaccessible destinations', async ({ request, baseURL }) => {
  await loginAs(request, baseURL!, 'user-e2e-demo-owner')
  for (const path of ['https://example.com/dashboard/ember-slice-demo', '//example.com', '/dashboard/app/website/pages', '/dashboard/account/profile', '/dashboard/%2f%2fexample.com', '/dashboard/ember-slice-demo/%2e%2e/harbor-legal-aid/website/pages', '/dashboard/ember-slice-demo/../harbor-legal-aid/website/pages']) {
    const response = await request.post('/api/dashboard/web-authorization', { data: { path } })
    expect(response.status(), await response.text()).toBe(400)
    expect(response.headers()['cache-control']).toBe('no-store')
    expect(response.headers()['referrer-policy']).toBe('no-referrer')
    expect(await response.json()).toMatchObject({ data: { code: 'INVALID_DASHBOARD_PATH', field: 'path' } })
  }
  const inaccessible = seededTenant('legal')
  const denied = await request.post('/api/dashboard/web-authorization', { data: { path: `/dashboard/${inaccessible.slug}/website/pages` } })
  expect(denied.status(), await denied.text()).toBe(404)
  expect(await denied.json()).toMatchObject({ data: { code: 'ORGANIZATION_NOT_FOUND' } })
  for (const endpoint of ['generate', 'verify']) {
    const response = await request.fetch(`/api/auth/one-time-token/${endpoint}`, { method: endpoint === 'generate' ? 'GET' : 'POST', data: endpoint === 'verify' ? { token: 'not-a-token' } : undefined })
    expect(response.status(), await response.text()).toBe(404)
  }
})


test('a dashboard link refuses membership removed after issuance and sets no browser session', async ({ request, playwright, baseURL }, testInfo) => {
  const tenant = seededTenant('legal')
  const actor = findE2eAuthFixture('user-e2e-ncls-consultation-owner')
  const release = await acquireTenantMutationLock(testInfo, tenant.organizationId)
  const member = await playwright.request.newContext({ baseURL })
  const browser = await playwright.request.newContext({ baseURL })
  let removed = false
  let originalRole: string | undefined
  try {
    await loginAs(request, baseURL!)
    await loginAs(member, baseURL!, actor.id)
    const roster = await request.get('/api/dashboard/members', { params: { org: tenant.slug } })
    expect(roster.status(), await roster.text()).toBe(200)
    const saved = (await roster.json() as { members: { id: string; userId: string; role: string }[] }).members.find(row => row.userId === actor.id)
    expect(saved).toBeDefined()
    if (!saved) throw new Error('The seeded attorney is not a member')
    originalRole = saved.role
    const scheduling = await request.get(`/api/organizations/${tenant.organizationId}/members/${saved.id}/scheduling`)
    expect(scheduling.status(), await scheduling.text()).toBe(200)
    expect(await scheduling.json()).toEqual({ scheduling: null })
    const started = await member.post('/api/dashboard/web-authorization', { data: { path: `/dashboard/${tenant.slug}/website/pages` } })
    expect(started.status(), await started.text()).toBe(200)
    const { authorization_url } = await started.json() as { authorization_url: string }
    const removal = await request.post('/api/auth/organization/remove-member', {
      headers: authRequestHeaders(baseURL!), data: { organizationId: tenant.organizationId, memberIdOrEmail: saved.id },
    })
    expect(removal.status(), await removal.text()).toBe(200)
    removed = true
    const opened = await browser.get(authorization_url, { maxRedirects: 0 })
    expect(opened.status(), await opened.text()).toBe(403)
    expect(await opened.json()).toMatchObject({ data: { code: 'WORKSPACE_ACCESS_CHANGED' } })
    expect(opened.headers()['set-cookie']).toBeUndefined()
    expect(opened.headers()['cache-control']).toBe('no-store')
    expect(opened.headers()['referrer-policy']).toBe('no-referrer')
    const session = await browser.get('/api/auth/get-session')
    expect(session.status()).toBe(200)
    expect(await session.json()).toBeNull()
  } finally {
    try {
      if (removed) {
        const invitation = await sendOrganizationInvitation(request, baseURL!, tenant.organizationId, actor.email, 'member')
        const joined = await acceptOrganizationInvitation(member, baseURL!, invitation)
        const restored = await request.post('/api/auth/organization/update-member-role', {
          headers: authRequestHeaders(baseURL!), data: { organizationId: tenant.organizationId, memberId: joined.id, role: originalRole },
        })
        expect(restored.status(), await restored.text()).toBe(200)
        const roster = await request.get('/api/dashboard/members', { params: { org: tenant.slug } })
        expect(roster.status()).toBe(200)
        expect((await roster.json() as { members: { userId: string; role: string }[] }).members.find(row => row.userId === actor.id)?.role).toBe(originalRole)
      }
    } finally {
      await member.dispose()
      await browser.dispose()
      await release()
    }
  }
})

test('provider connection authorization still reaches Google after dashboard cookie support is enabled', async ({ request, playwright, baseURL }) => {
  await loginAs(request, baseURL!, 'user-e2e-demo-owner')
  const tenant = seededTenant('restaurant')
  const started = await request.post('/api/dashboard/connection-authorization', {
    params: { org: tenant.slug }, data: { integration: 'google-calendar', attempt: crypto.randomUUID() },
  })
  expect(started.status(), await started.text()).toBe(200)
  const { authorization_url } = await started.json() as { authorization_url: string }
  const browser = await playwright.request.newContext({ baseURL })
  try {
    const opened = await browser.get(authorization_url, { maxRedirects: 0 })
    expect(opened.status(), await opened.text()).toBe(302)
    expect(new URL(opened.headers().location!).hostname).toBe('accounts.google.com')
    const session = await browser.get('/api/auth/get-session')
    expect(session.status()).toBe(200)
    expect(await session.json()).toBeNull()
  } finally { await browser.dispose() }
})
