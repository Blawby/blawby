import { expect, test, type Page } from '@playwright/test'
import { dismissPreviewToolbar, waitForNuxtHydration } from './helpers'
import { loginAs } from './helpers/auth'
import { mcpData, mcpRequest } from './helpers/mcp'
import { acquireTenantMutationLock } from './helpers/tenant-mutation-lock'
import type { Product, CatalogProduct } from '../../server/types/products'
import type { DashboardLocation } from '../../composables/useDashboardOrganization'
import { countCatalog, type CatalogCounts } from '../../utils/product-presentation'
import { seededTenant } from './seed/manifest'
import { readLocalTenant } from './test-env'
const WIDE = { width: 1440, height: 900 }
const PHONE = { width: 390, height: 844 }

/** The panes on screen, left to right, by the id each DashboardIndexPanel/LeafPanel is given. */
async function visiblePanes(page: Page): Promise<string[]> {
  return page.locator('[id^="dashboard-panel-"]').evaluateAll(elements => elements
    .filter(element => element.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
    .map(element => element.id.replace('dashboard-panel-', '')))
}

async function expectPanes(page: Page, panes: string[]) {
  await expect.poll(() => visiblePanes(page)).toEqual(panes)
}

async function open(page: Page, path: string) {
  const response = await page.goto(path)
  expect(response?.status()).toBe(200)
  await waitForNuxtHydration(page)
}

test.describe('dashboard pane hierarchy', () => {
  test.beforeEach(async ({ page, baseURL }) => {
    await dismissPreviewToolbar(page)
    await loginAs(page.request, baseURL!)
  })

  test('a phone opens menu categories from the shared dish catalog without a second catalog read', async ({ page }, testInfo) => {
    const tenant = seededTenant('restaurant')
    await page.setViewportSize(PHONE)
    await open(page, `/dashboard/${tenant.slug}/products/menu`)
    const category = page.locator('a[href*="/products/menu/"]').filter({ hasText: 'Pizzas' }).first()
    await expect(category).toBeVisible()
    const catalogReads: string[] = []
    page.on('request', request => {
      if (new URL(request.url()).pathname === `/api/editor/organizations/${tenant.organizationId}/products`) catalogReads.push(request.url())
    })
    const started = Date.now()
    await category.click()
    const section = page.locator('#dashboard-panel-menu-section')
    await expect(section.getByRole('heading', { name: 'Pizzas', exact: true })).toBeVisible()
    await expect(section.getByRole('link').filter({ hasText: 'Margherita' })).toBeVisible()
    await expect(section.getByRole('link').filter({ hasText: 'Pepperoni' })).toBeVisible()
    expect(catalogReads).toEqual([])
    await testInfo.attach('menu-navigation-timing', { body: JSON.stringify({ viewport: PHONE, elapsed_ms: Date.now() - started, catalog_reads: catalogReads }), contentType: 'application/json' })
  })

  test('a phone moves a dish through the initially opened Move dialog', async ({ page }, testInfo) => {
    const tenant = seededTenant('restaurant')
    const release = await acquireTenantMutationLock(testInfo, tenant.organizationId)
    const endpoint = `/api/editor/organizations/${tenant.organizationId}`
    const read = async () => {
      const response = await page.request.get(`${endpoint}/products?include=collections`)
      expect(response.status(), await response.text()).toBe(200)
      return response.json() as Promise<{ products: CatalogProduct[]; collections: Array<{ id: string; name: string }> }>
    }
    const members = (catalog: Awaited<ReturnType<typeof read>>, id: string) => catalog.products.flatMap(product => {
      const membership = product.collections.find(row => row.collection_id === id)
      return membership ? [{ id: product.id, order: membership.sort_order }] : []
    }).sort((a, b) => a.order - b.order).map(row => row.id)
    const before = await read()
    const source = before.collections.find(row => row.name === 'Pizzas')!
    const target = before.collections.find(row => row.name === 'Starters')!
    const dish = before.products.find(row => row.name === 'Margherita')!
    try {
      await page.setViewportSize(PHONE)
      await open(page, `/dashboard/${tenant.slug}/products/menu/${source.id}?kind=dish`)
      const section = page.locator('#dashboard-panel-menu-section')
      await section.getByTestId('list-editor-toggle').click()
      await section.getByRole('checkbox', { name: 'Select Margherita', exact: true }).check()
      await section.getByTestId('product-move-open').click()
      const dialog = page.getByRole('dialog', { name: 'Move item', exact: true })
      await dialog.getByRole('radio', { name: /Starters/ }).check()
      await dialog.getByRole('button', { name: 'Move', exact: true }).click()
      await expect(dialog).not.toBeVisible()
      const after = await read()
      expect(members(after, source.id)).toEqual(members(before, source.id).filter(id => id !== dish.id))
      expect(members(after, target.id)).toEqual([...members(before, target.id), dish.id])
    } finally {
      try {
        const current = await read()
        for (const collection of [source, target]) {
          const restored = await page.request.put(`${endpoint}/collections/${collection.id}/products`, { data: { product_ids: members(before, collection.id), expected_product_ids: members(current, collection.id) } })
          expect(restored.status(), await restored.text()).toBe(200)
        }
      } finally { await release() }
    }
  })

  test('a phone opens its sole location and moves between days across a month boundary', async ({ page }, testInfo) => {
    const tenant = seededTenant('legal')
    await page.setViewportSize(PHONE)
    await open(page, `/dashboard/${tenant.slug}/calendar/2026-11-30?view=month`)
    const day = page.locator('#dashboard-panel-calendar-day')
    await expect(day.getByText('Raleigh Office', { exact: true })).toBeVisible()
    expect(new URL(page.url()).searchParams.get('location_id')).toBeNull()
    await expect(day.getByRole('button', { name: 'Block date', exact: true })).toBeVisible()
    const scope = new URL(page.url()).searchParams.get('location_id')
    await day.getByRole('link', { name: 'Next day', exact: true }).click()
    await expect(day.getByRole('heading', { name: 'Tuesday, December 1', exact: true })).toBeVisible()
    expect(new URL(page.url()).searchParams.get('location_id')).toBe(scope)
    await day.getByRole('link', { name: 'Previous day', exact: true }).click()
    await expect(day.getByRole('heading', { name: 'Monday, November 30', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('calendar-phone.png'), fullPage: true })
  })

  test('a location change removes the previous availability action while the new location loads', async ({ page }) => {
    const tenant = seededTenant('restaurant')
    const response = await page.request.get(`/api/dashboard/locations?org=${tenant.slug}&organization=true`)
    expect(response.status(), await response.text()).toBe(200)
    const { locations } = await response.json() as { locations: DashboardLocation[] }
    expect(locations).toHaveLength(2)
    const [first, second] = locations as [DashboardLocation, DashboardLocation]
    await page.setViewportSize(PHONE)
    await open(page, `/dashboard/${tenant.slug}/calendar/2026-11-25?location_id=${first.id}`)
    const day = page.locator('#dashboard-panel-calendar-day')
    await expect(day.getByRole('button', { name: 'Block date', exact: true })).toBeVisible()
    let release!: () => void, requested!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const pending = new Promise<void>(resolve => { requested = resolve })
    await page.route(`**/api/organizations/${tenant.organizationId}/locations/${second.id}`, async route => {
      requested()
      await held
      await route.continue()
    })
    try {
      await day.getByRole('combobox', { name: 'Location', exact: true }).click()
      await page.getByRole('option', { name: second.title, exact: true }).click()
      await pending
      await expect(day.getByRole('button', { name: 'Block date', exact: true })).toHaveCount(0)
      release()
      await expect(day.getByRole('button', { name: 'Block date', exact: true })).toBeVisible()
    } finally { release() }
  })

  test('an empty phone Posts screen offers existing social connections and a first post', async ({ page }, testInfo) => {
    const tenant = seededTenant('restaurant')
    await page.setViewportSize(PHONE)
    await open(page, `/dashboard/${tenant.slug}/website/posts`)
    const posts = page.locator('#dashboard-panel-organization-posts')
    await expect(posts.getByRole('heading', { name: 'No posts yet', exact: true })).toBeVisible()
    await expect(posts.getByRole('link', { name: 'Connect Facebook', exact: true })).toBeVisible()
    await expect(posts.getByRole('link', { name: 'Connect Instagram', exact: true })).toBeVisible()
    await expect(posts.getByTestId('posts-empty').getByRole('button', { name: 'Write a post', exact: true })).toBeVisible()
    await page.screenshot({ path: testInfo.outputPath('posts-phone.png'), fullPage: true })
  })

  test('an unconnected business offers optional payment setup without an empty debt warning', async ({ page }, testInfo) => {
    const tenant = seededTenant('restaurant')
    const release = await acquireTenantMutationLock(testInfo, tenant.organizationId)
    try {
    const balances = await page.request.get(`/api/dashboard/payments/unpaid?org=${tenant.slug}`)
    expect(balances.status(), await balances.text()).toBe(200)
    expect(await balances.json()).toEqual({ bookings: [] })
    await page.setViewportSize(PHONE)
    await open(page, `/dashboard/${tenant.slug}/payments`)
    const payments = page.locator('#dashboard-panel-organization-payments')
    await expect(payments.getByRole('link', { name: /Accept online payments/ })).toBeVisible()
    await expect(payments.getByText('Loading payments to collect…', { exact: true })).toHaveCount(0)
    await expect(payments.getByRole('link', { name: /Payments to collect|Unpaid/ })).toHaveCount(0)
    await expect(payments.getByText('Nobody owes you money', { exact: true })).toHaveCount(0)
    } finally { await release() }
  })

  test('automatic messages use the vertical’s words and show an exact hour offset', async ({ page }) => {
    const restaurant = seededTenant('restaurant')
    await page.setViewportSize(PHONE)
    await open(page, `/dashboard/${restaurant.slug}/messages/automatic/new`)
    const editor = page.locator('#dashboard-panel-new-automatic-message')
    await expect(editor.getByRole('button', { name: 'Tables and experiences', exact: true })).toBeVisible()
    await editor.getByRole('button', { name: 'Timing', exact: true }).click()
    await page.getByPlaceholder('Search timing', { exact: true }).fill('1 hour before')
    await page.getByRole('option', { name: '1 hour before', exact: true }).click()
    await expect(editor.getByText('1 hour before the reservation starts', { exact: true })).toBeVisible()
  })

  test('task creation uses one form and team messaging names its recipients', async ({ page }, testInfo) => {
    const tenant = seededTenant('restaurant')
    await page.setViewportSize(PHONE)
    for (const colorScheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme })
      await page.setViewportSize(WIDE)
      await open(page, `/dashboard/${tenant.slug}`)
      await expect(page.getByTestId('today-item').first()).toBeVisible()
      await page.screenshot({ path: testInfo.outputPath(`today-cards-${colorScheme}.png`), fullPage: true })
    }
    await page.setViewportSize(PHONE)
    await page.getByRole('button', { name: 'Add task', exact: true }).click()
    const task = page.getByRole('dialog', { name: 'Add a task', exact: true })
    await expect(task.getByLabel(/^What needs doing/)).toBeVisible()
    await task.getByRole('checkbox', { name: 'This task is a repair', exact: true }).check()
    await expect(task.getByRole('combobox', { name: /^Where/ })).toBeVisible()
    await expect(task.getByRole('combobox', { name: /^Assigned/ })).toHaveCount(1)
    await task.getByRole('button', { name: 'Cancel', exact: true }).click()
    await open(page, `/dashboard/${tenant.slug}/messages/new`)
    const conversation = page.locator('#dashboard-panel-new-team-conversation')
    await expect(conversation.getByRole('heading', { name: 'Message your team', exact: true })).toBeVisible()
    await expect(conversation.getByText('Start a conversation with someone already on your team. Guest messages appear with their enquiries and bookings.', { exact: true })).toBeVisible()
  })

  // A service is a Product and the page that shows it: Catalog's Add opens the
  // shared creation form, and Create writes both, bound, through one request.
  test('Catalog adds a service with its page through the one Product editor', async ({ page, baseURL, playwright }) => {
    const legal = seededTenant('legal')
    const services = `/dashboard/${legal.slug}`
    const editor = `/api/editor/organizations/${legal.organizationId}`
    await page.setViewportSize(WIDE)
    await page.context().clearCookies()
    await loginAs(page.request, baseURL!, 'user-e2e-ncls-owner')
    const cleanupRequest = await playwright.request.newContext({ baseURL, storageState: await page.request.storageState() })
    let productId: string | undefined
    let pageId: string | null = null
    const failures: unknown[] = []
    try {
      const initialReads: string[] = []
      const watchInitialRead = (request: import('@playwright/test').Request) => {
        const path = new URL(request.url()).pathname
        if (path === '/api/dashboard/context' || path === '/api/dashboard/catalog') initialReads.push(path)
      }
      page.on('request', watchInitialRead)
      const document = await page.goto(`${services}/products`)
      expect(document?.status()).toBe(200)
      expect(document?.headers()['cache-control']).toContain('no-store')
      expect(await document?.text()).toContain('id="dashboard-panel-catalog"')
      await waitForNuxtHydration(page)
      await expectPanes(page, ['catalog'])
      expect(initialReads).toEqual([])
      page.off('request', watchInitialRead)
      await page.locator('#dashboard-panel-catalog').getByTestId('catalog-add').click()
      await expect(page).toHaveURL(`${services}/products/new`)
      const kind = page.locator('#dashboard-panel-product')
      await kind.getByText('Practice area or consultation', { exact: true }).click()
      await expect(kind.getByRole('radio', { name: 'Practice area or consultation', exact: true })).toBeChecked()
      await expect(page).toHaveURL(`${services}/products/new`)
      // The name and introduction are written together before the one commit.
      await expect(page.locator('#dashboard-panel-product').getByRole('heading', { name: 'New practice area', level: 1, exact: true })).toBeVisible()
      await expect(kind.getByRole('button', { name: 'Create practice area', exact: true })).toBeDisabled()
      const name = `E2E Service ${Date.now().toString(36)}`
      const description = 'An authored legal practice introduction supplied during creation.'
      await page.getByRole('textbox', { name: 'Name' }).fill(name)
      await kind.getByRole('textbox', { name: 'Short description', exact: true }).fill(description)
      const created = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/products` && response.request().method() === 'POST')
      await kind.getByRole('button', { name: 'Create practice area', exact: true }).click()
      const response = await created
      expect(response.status(), await response.text()).toBe(201)
      const request = response.request().postDataJSON() as { idempotency_key?: string }
      expect(request.idempotency_key).toBeTruthy()
      const createdProduct = (await response.json() as { product: Product }).product
      productId = createdProduct.id
      pageId = createdProduct.page?.id ?? null
      await expect(page).toHaveURL(`${services}/products/${productId}/name`)
      await expectPanes(page, ['product', 'product-name'])
      // Read back through other paths than the one that wrote it.
      const productRead = await page.request.get(`${editor}/products/${productId}`)
      expect(productRead.status(), await productRead.text()).toBe(200)
      const product = (await productRead.json() as { product: Product }).product
      expect(product).toMatchObject({ kind: 'service', active: false, name, description, publications: [{ published: false }], booking: null })
      expect(product.variants).toHaveLength(1)
      expect(product.page).toMatchObject({ title: name })
      expect(product.page?.path).toMatch(/^\/services\/e2e-service-/)
      pageId = product.page!.id
      const bound = (await (await page.request.get(`${editor}/pages/${pageId}`)).json() as { page: { product_id: string | null } }).page
      expect(bound.product_id).toBe(productId)
      const cards = page.getByTestId('legal-editor-cards')
      await expect(page.locator('#dashboard-panel-product').getByRole('heading', { name: 'Legal Services editor', exact: true })).toBeVisible()
      await expect(cards.getByTestId('editor-card-assignment')).toHaveCount(0)
      await expect(cards.getByTestId('editor-card-booking')).toHaveCount(0)
      await expect(cards.getByTestId('editor-card-price')).toHaveCount(0)
      await expect(cards.getByTestId('editor-card-locations')).toHaveCount(0)
      const renamed = `${name} revised`
      const nameLeaf = page.locator('#dashboard-panel-product-name')
      await nameLeaf.getByRole('textbox', { name: 'Name', exact: true }).fill(renamed)
      await expect(cards.getByTestId('editor-card-name')).toContainText(name)
      await expect(cards.getByTestId('editor-card-name')).not.toContainText(renamed)
      const outgoingNameInput = await nameLeaf.getByRole('textbox', { name: 'Name', exact: true }).elementHandle()
      expect(outgoingNameInput).not.toBeNull()
      await nameLeaf.getByRole('button', { name: 'Cancel', exact: true }).click()
      // Cancel leaves this pane before the parent automatically opens Name again.
      await outgoingNameInput!.waitForElementState('hidden')
      await expect(page).toHaveURL(`${services}/products/${productId}/name`)
      await expect(nameLeaf.getByRole('textbox', { name: 'Name', exact: true })).toBeVisible()
      await expect(nameLeaf.getByRole('textbox', { name: 'Name', exact: true })).toHaveValue(name)
      await nameLeaf.getByRole('textbox', { name: 'Name', exact: true }).fill(renamed)
      const renamedResponse = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/products/${productId}` && response.request().method() === 'PATCH')
      await nameLeaf.getByRole('button', { name: 'Save', exact: true }).click()
      const renameSaved = await renamedResponse
      expect(renameSaved.status()).toBe(200)
      expect(renameSaved.request().postDataJSON()).toMatchObject({ name: renamed })
      await expect(cards.getByTestId('editor-card-name')).toContainText(renamed)
      const renamedRead = await mcpRequest(page.request, baseURL!, { method: 'tools/call', toolName: 'get_product', args: { organization_id: seededTenant('legal').organizationId, product_id: productId } })
      expect(renamedRead.status(), await renamedRead.text()).toBe(200)
      expect(mcpData<{ product: Product }>(await renamedRead.json()).product).toMatchObject({ name: renamed, slug: product.slug, page: { id: pageId, path: product.page!.path, title: name } })

      await page.locator('#dashboard-panel-product').getByRole('button', { name: 'Add detail', exact: true }).click()
      await expect(page.getByRole('menuitem', { name: 'Consultation pricing', exact: true })).toHaveAttribute('href', `${services}/products/${productId}/price`)
      await page.getByRole('menuitem', { name: 'Set up consultations', exact: true }).click()
      await expect(page).toHaveURL(`${services}/products/${productId}/booking/enabled`)
      const consultationSetup = page.locator('#dashboard-panel-booking-enabled')
      await expect(consultationSetup.getByRole('switch', { name: 'Use a consultation calendar', exact: true })).not.toBeChecked()
      await expect(consultationSetup.getByRole('button', { name: 'Save', exact: true })).toBeDisabled()

      const officesRead = await page.request.get('/api/dashboard/locations', { params: { org: 'harbor-legal-aid', organization: 'true', status: 'all' } })
      expect(officesRead.status(), await officesRead.text()).toBe(200)
      const office = (await officesRead.json() as { locations: DashboardLocation[] }).locations.find(location => location.status === 'active')
      expect(office, 'the firm has an authored active office').toBeDefined()
      await open(page, `${services}/products/${productId}/name`)
      await page.locator('#dashboard-panel-product').getByRole('button', { name: 'Add detail', exact: true }).click()
      await page.getByRole('menuitem', { name: 'Offices', exact: true }).click()
      await expect(page).toHaveURL(`${services}/products/${productId}/locations`)
      await page.locator('#dashboard-panel-product-locations').getByRole('link', { name: `${office!.title} Not offered here`, exact: true }).click()
      const officeLeaf = page.locator('#dashboard-panel-product-location')
      await officeLeaf.getByRole('switch', { name: 'Show at this office', exact: true }).check()
      await officeLeaf.getByRole('switch', { name: 'Available at this office', exact: true }).check()
      const officeSaved = page.waitForResponse(response => new URL(response.url()).pathname === `${editor}/products/${productId}/locations/${encodeURIComponent(office!.id)}` && response.request().method() === 'PUT')
      await officeLeaf.getByRole('button', { name: 'Save', exact: true }).click()
      expect((await officeSaved).status()).toBe(200)
      const officeReadback = await page.request.get(`${editor}/products/${productId}`)
      expect(officeReadback.status(), await officeReadback.text()).toBe(200)
      expect((await officeReadback.json() as { product: Product }).product.locations).toEqual([{ location_id: office!.id, active: true, published: true }])
      await expect(cards.getByTestId('editor-card-locations')).toContainText(office!.title)

      // The Office hub counts actual assignments even when Legal has no Menu
      // presentation. Compare its complete read with the independent catalog.
      const catalogRead = await page.request.get(`${editor}/products`)
      expect(catalogRead.status(), await catalogRead.text()).toBe(200)
      const officeProducts = (await catalogRead.json() as { products: Product[] }).products.filter(product => product.locations.some(location => location.location_id === office!.id))
      expect(officeProducts.some(product => product.id === productId)).toBe(true)
      const overviewPath = '/api/dashboard/locations'
      await open(page, `${services}/locations/${office!.slug}`)
      const overviewResponse = await page.request.get(overviewPath, { params: { org: seededTenant('legal').slug, view: 'editor', location_slug: office!.slug } })
      expect(overviewResponse.status(), await overviewResponse.text()).toBe(200)
      expect((await overviewResponse.json() as { catalog: CatalogCounts }).catalog).toEqual(countCatalog(officeProducts))
      const officeIndex = page.locator('#dashboard-panel-location-index')
      await expect(officeIndex.getByRole('heading', { name: office!.title, exact: true })).toBeVisible()
      await expect(officeIndex.getByRole('link', { name: `Name ${office!.title}`, exact: true })).toBeVisible()
      await expect(officeIndex.getByText('Failed to load location overview', { exact: true })).toHaveCount(0)
      await open(page, `${services}/products/${productId}/locations/${office!.id}`)
      await expect(officeLeaf.getByRole('switch', { name: 'Show at this office', exact: true })).toBeChecked()
      await expect(officeLeaf.getByRole('switch', { name: 'Available at this office', exact: true })).toBeChecked()

      await open(page, `${services}/products/${productId}/name`)
      await page.locator('#dashboard-panel-product').getByRole('link', { name: 'View', exact: true }).click()
      const preview = page.getByRole('dialog', { name: 'Legal Services preview', exact: true })
      const frame = preview.getByTestId('content-preview-frame')
      await expect(frame).toHaveAttribute('src', new RegExp(`${product.page!.path.replaceAll('/', '\\/')}\\?preview_token=`))
      const listing = frame.contentFrame().getByRole('heading', { name: renamed, level: 1, exact: true })
      await expect(listing).toBeVisible()
      await expect(preview.getByTestId('preview-share')).toHaveCount(0)
      // The signed preview renders the saved practice area. A visitor without
      // the preview token still cannot load the unpublished page.
      const publicURL = new URL((await frame.getAttribute('src'))!)
      publicURL.searchParams.delete('preview_token')
      const anonymous = await playwright.request.newContext()
      try {
        const response = await readLocalTenant(anonymous, legal.subdomain, publicURL)
        expect(response.status()).toBe(404)
        expect(await response.text()).not.toContain(renamed)
      } finally {
        await anonymous.dispose()
      }
      await preview.getByRole('tab', { name: 'Mobile view', exact: true }).click()
      await expect(page).toHaveURL(url => url.searchParams.get('previewViewport') === 'mobile')
      await expect(frame).toHaveCSS('max-width', '390px')
      await page.setViewportSize(PHONE)
      await expect(listing).toBeVisible()
      await preview.getByRole('button', { name: 'Close', exact: true }).click()
      await expect(preview).toHaveCount(0)
      await page.setViewportSize(WIDE)
      await page.locator('#dashboard-panel-product').getByTestId('dashboard-navbar-back').click()
      await expect(page).toHaveURL(`${services}/products`)
      await expectPanes(page, ['catalog'])
      const catalogService = page.getByTestId('catalog-grid').getByTestId(`selector-item-${productId}`)
      await expect(catalogService).toHaveAttribute('href', `${services}/products/${productId}`)
      await expect(catalogService).toContainText(renamed)
      await expect(catalogService).toContainText('No photo')
      await expect(catalogService).toContainText('No price set')
      await expect(catalogService).toContainText(office!.title)
      // MCP reads the same pair, and the editor URL it hands an agent opens this record.
      const viaMcp = mcpData<{ product: { page: { id: string; path: string } | null; admin_edit_url: string | null } }>(await (await mcpRequest(page.request, baseURL!, {
        method: 'tools/call', toolName: 'get_product', args: { organization_id: seededTenant('legal').organizationId, product_id: productId },
      })).json()).product
      expect(viaMcp.page).toMatchObject({ id: pageId, path: product.page!.path })
      expect(viaMcp.admin_edit_url).toBe(`${services}/products/${productId}`)
      await open(page, viaMcp.admin_edit_url!)
      await expect(page.locator('#dashboard-panel-product')).toContainText(renamed)

      // Its Page content row opens the page in Pages, the one page editor.
      await page.locator('#dashboard-panel-product').getByTestId('editor-card-page').click()
      await expect(page).toHaveURL(new RegExp(`${services}/website/pages/${pageId}`))
      await expect(page.locator('#dashboard-panel-organization-page')).toContainText(name)
    } catch (error) { failures.push(error) }
    finally {
      try {
        if (pageId) {
          const read = await cleanupRequest.get(`${editor}/pages/${pageId}`)
          expect(read.status(), await read.text()).toBe(200)
          const current = (await read.json() as { page: { document: { updated_at: string } } }).page
          const removedPage = await cleanupRequest.delete(`${editor}/pages/${pageId}`, { data: { updated_at: current.document.updated_at } })
          expect(removedPage.status(), await removedPage.text()).toBe(200)
          const removedRead = await cleanupRequest.get(`${editor}/pages/${pageId}`)
          expect(removedRead.status(), await removedRead.text()).toBe(404)
        }
      } catch (error) { failures.push(error) }
      try {
        if (productId) {
          const removed = await cleanupRequest.delete(`${editor}/products/${productId}`)
          expect(removed.status(), await removed.text()).toBe(200)
          const removedRead = await cleanupRequest.get(`${editor}/products/${productId}`)
          expect(removedRead.status(), await removedRead.text()).toBe(404)
        }
      } catch (error) { failures.push(error) }
      try { await cleanupRequest.dispose() }
      catch (error) { failures.push(error) }
    }
    if (failures.length) throw new AggregateError(failures, 'Legal Product creation or cleanup failed')
  })
})
