import type { SeedClient } from '../client.ts'

export async function seedPlatform(owner: SeedClient, platformOrganizationId: string) {
  const tool = <T>(name: string, args: Record<string, unknown>) => owner.tool<T>(platformOrganizationId, name, args)

  const { pages } = await tool<{ pages: Array<{ id: string; path: string }> }>('list_site_pages', { locale: 'en' })
  const home = pages.find(page => page.path === '/')
  if (!home) throw new Error('The platform site has no home page')
  const { page } = await tool<{ page: { blocks: Array<{ id: string; type: string; updated_at: string }> } }>('get_site_page', { variant_id: home.id })
  const hero = page.blocks.find(block => block.type === 'hero')
  if (!hero) throw new Error('The platform home page has no hero')
  await tool('replace_content_block', {
    block_id: hero.id, updated_at: hero.updated_at,
    data: { title: 'Your business, online in minutes', subtitle: 'Websites, bookings and messages for local businesses.', cta_label: 'Start free', cta_url: '/signup' },
  })

  for (const [locale, title, heading] of [
    ['ja', 'Blawby 日本語', 'ウェブサイトを数分で公開'],
    ['zh-Hans', 'Blawby 简体中文', '几分钟内发布网站'],
    ['zh-Hant', 'Blawby 繁體中文', '幾分鐘內發佈網站'],
  ]) {
    await tool('add_organization_language', { locale })
    await tool('create_site_page', {
      page_id: home.id, path: '/', locale, title,
      blocks: [{
        type: 'hero',
        source_block_id: hero.id,
        data: { title: heading },
      }],
    })
    await tool('publish_organization_language', { locale })
  }

  for (const [path, title] of [['/plugin', 'Blawby for your AI assistant'], ['/products', 'Your website is just the beginning']]) {
    await tool('create_site_page', { path, title, page_type: 'custom', locale: 'en', blocks: [{ type: 'hero', data: { title } }] })
  }
  await tool('create_site_page', {
    path: '/pricing', title: 'Pricing', page_type: 'custom', locale: 'en',
    blocks: [
      { type: 'hero', data: { eyebrow: 'Simple, flexible plans', title: 'Simple, transparent pricing.' } },
      { type: 'feature_grid', data: { source: 'billing_plans', title: 'Plans' } },
      { type: 'feature_grid', data: { source: 'billing_features', title: 'Compare the details.' } },
    ],
  })
}
