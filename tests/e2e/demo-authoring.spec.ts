import { expect, test } from '@playwright/test'
import { loginAs } from './helpers/auth'
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
