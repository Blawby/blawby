import { expect, test } from '@playwright/test'
import { openTenantPage } from './helpers'
import { seededTenant } from './seed/manifest'
import { seededSiteHeaders, seededSiteURL } from './test-env'

test('physical product media, variant SEO and mobile cart quantities work through the storefront', async ({ page }) => {
  const tenant = seededTenant('experience')
  const product = tenant.products['ceramic-bowl']!
  const errors: string[] = []
  page.on('pageerror', error => errors.push(error.message))
  await page.setViewportSize({ width: 390, height: 844 })
  const response = await openTenantPage(page, `${seededSiteURL('experience')}/products/${product.slug}`, seededSiteHeaders('experience'))
  expect(response?.status()).toBe(200)
  const schema = await page.locator('script[type="application/ld+json"]').allTextContents()
  const group = schema.flatMap(text => JSON.parse(text)['@graph']).find(node => node['@type'] === 'ProductGroup')
  expect(group.hasVariant.map((variant: { offers: { price: string } }) => Number(variant.offers.price))).toEqual([18000, 80000])
  expect(group.image).toHaveLength(2)
  expect(group.aggregateRating).toBeUndefined()
  const gallery = page.locator('[data-media-gallery]')
  await gallery.getByRole('button', { name: `Open media, ${product.name}` }).first().click()
  await expect(page.getByRole('dialog')).toBeVisible()
  await page.getByRole('button', { name: 'Close photos and videos', exact: true }).click()
  await page.getByRole('button', { name: 'Large', exact: true }).click()
  await expect(gallery.locator('img').first()).toHaveAttribute('src', tenant.media.studio!.public_url)
  await expect(page).toHaveURL(/[?&]variant=/)
  const linkedVariant = page.url()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Large', exact: true })).toHaveAttribute('aria-pressed', 'true')
  expect(page.url()).toBe(linkedVariant)
  const quantity = page.getByRole('spinbutton')
  await page.getByRole('button', { name: 'Increment', exact: true }).click()
  await expect(quantity).toHaveValue('2')
  await expect(quantity).not.toBeFocused()
  await page.getByRole('button', { name: 'Decrement', exact: true }).click()
  await expect(quantity).toHaveValue('1')
  await expect(quantity).not.toBeFocused()
  await page.getByRole('button', { name: 'Buy it now', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Cart', exact: true })).toBeVisible()
  const cartQuantity = page.getByRole('spinbutton')
  await expect(cartQuantity).toHaveValue('1')
  await page.getByRole('button', { name: 'Increment', exact: true }).click()
  await expect(cartQuantity).toHaveValue('2')
  await expect(cartQuantity).not.toBeFocused()
  await expect(page.locator('aside')).toContainText('160,000.00')
  await page.reload()
  await expect(cartQuantity).toHaveValue('2')
  for (const width of [320, 390, 768, 1280]) {
    await page.setViewportSize({ width, height: 844 })
    const layout = await page.evaluate(() => {
      const field = document.querySelector('input[role="spinbutton"]')!
      const input = field.getBoundingClientRect()
      const style = getComputedStyle(field)
      const container = document.querySelector('.tenant-container.py-12')!.getBoundingClientRect()
      const aside = document.querySelector('aside')!.getBoundingClientRect()
      return { overflow: document.documentElement.scrollWidth - innerWidth, textWidth: input.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), left: aside.left - container.left, right: container.right - aside.right }
    })
    expect(layout.overflow).toBeLessThanOrEqual(1)
    expect(layout.textWidth).toBeGreaterThanOrEqual(32)
    if (width < 1024) expect(Math.abs(layout.left - layout.right)).toBeLessThanOrEqual(1)
  }
  await page.getByRole('button', { name: 'Decrement', exact: true }).click()
  await expect(cartQuantity).toHaveValue('1')
  await expect(cartQuantity).not.toBeFocused()
  await page.setViewportSize({ width: 390, height: 844 })
  await page.screenshot({ path: test.info().outputPath('mobile-cart.png'), fullPage: true })
  expect(errors).toEqual([])
})
