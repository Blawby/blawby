import { parseCookie } from 'cookie-es'
import type { ProductKind } from '~/shared/product-details'
import { HTTPError, type H3Event } from 'nitro'
import { executeBatch, type BatchQuery, type DbClient } from '~/server/db'
import { faqBlockSource, faqItems, qaListQuery, type QaDocument } from '~/server/utils/location-qa'
import { prepareOrganizationReviews } from '~/server/utils/organization-reviews'
import { prepareTenantPageAtPath, publicTenantPageSql, type TenantPageDto } from '~/server/utils/content/pages'
import { normalizeTenantPagePath, validateContentBlockData, type TenantPageBlock } from '~/utils/tenant-page-blocks'
import type { MediaPlacementItem } from '~/server/utils/media-placement'
import { COVER_SELECT, attachCoverMedia, coverJoinSql } from '~/server/utils/content/cover'
import { publicSocialMediaFromPlacements, type SocialImageSource } from '~/utils/social-metadata'
import { groupMediaPlacements, mediaPlacementsQuery } from '~/server/utils/media-asset-manager'
import { assertExactCanonicalLocale, assertPublicOrganizationLanguage, getPersistedSourceLocale, readPublicOrganizationLanguage, readPublicSourceLocale } from '~/server/utils/localization'
import {
  indexStoredPublicLocalizations,
  preloadedPublicLocalizations,
  publicLocalizationsQuery,
  type StoredPublicLocalizationRow,
  projectExactLocalizedCollection,
  projectLocalizedMediaAlt,
  type ExactPublicLocalization,
} from '~/server/utils/public-localization'
import { documentOfRootSql } from '~/server/utils/content/documents'
import { listPublicLocaleRepresentations, publicDocumentLocaleQuery, type LocalizedRouteCandidate } from '~/server/utils/public-locale-representations'
import { preparePublicPostBlocks, type PublicSocialPost } from '~/server/utils/post-management'
import { cloudflareEnv } from '~/server/utils/api-response'
import { isLegalPracticeSite, PLATFORM_SITE, resolvePublicSite } from '~/utils/site-routing'
import { tenantBlogPostPath } from '~/utils/tenant-blog-route'
import { hasSiteProductPage, presentationForProduct, publicLocationPath } from '~/utils/product-presentation'
import { publicLocationSql } from '~/server/utils/public-locations'
import { projectPublicLocation, type PublicLocationPrivacySource } from '~/shared/location-sharing'
import { publicLocationPrivacySql } from '~/server/utils/public-location-privacy'
import { formatMinorAmount, selectPrice } from '~/shared/prices'
import { isCurrencyCode, type CurrencyCode } from '~/shared/currencies'
import { preparePublishedOfferingGrid, publicProduct } from '~/server/utils/product-management'
import { PRICING_NOTE_HANDLE } from '~/shared/product-details'
import { summarizeProductPrices } from '~/utils/product-money'
import { isMembershipProduct } from '~/shared/memberships'
import { cartLinesSchema, purchasableQuantity } from '~/shared/goods'
import { publicTenantVisibilitySql } from '~/server/utils/public-base'
import { VISITOR_COOKIE, isCanonicalEventId } from '~/server/utils/pageview-tracking'
import type { PublicLocaleRepresentation } from '~/utils/public-resource-contracts'
import { addressPlaceName, formatPostalAddress, parsePostalAddress } from '~/utils/postal-address'
import { getVerticalCopy } from '~/utils/vertical-copy'

export interface PublicTenantPage {
  id: string
  page_id: string
  product_id?: string | null
  path: string
  title: string
  summary: string | null
  page_type: string
  recipe: string | null
  sort_order: number
  locale: string
  blocks: TenantPageBlock[]
  media: MediaPlacementItem[]
  social_image: SocialImageSource | null
  locale_representations?: PublicLocaleRepresentation[]
  updated_at: string
}

/** A page referenced by a page_grid block. */
export interface PublicTenantPageReferenceRow {
  product_id: string | null
  id: string
  title: string
  summary: string | null
  slug: string
  path: string
  media: MediaPlacementItem[]
}

/** A product referenced by a product_grid block. */
export interface PublicTenantPageProductRow {
  id: string
  name: string
  slug: string
  description: string
  kind: ProductKind
  featured: boolean
  /**
   * Site-wide offerings use their canonical product route. Location-scoped
   * offerings link only when their location is explicit.
   */
  public_path: string | null
  available: boolean
  pricing_note: string | null
  unit_amount: number | null
  max_unit_amount: number | null
  compare_at_unit_amount: number | null
  currency: string | null
  media: MediaPlacementItem[]
}

type AuthoredPageSite = { theme_id: string | null; vertical: string | null; default_currency: string | null; address_visibility: string | null }

type AuthoredArticleRow = { id: string; title: string; slug: string; excerpt: string | null;
  cover_asset_id: string | null; cover_public_url: string | null; cover_thumbnail_url: string | null;
  cover_kind: string | null; cover_alt_text: string | null; cover_width: number | null; cover_height: number | null;
}

function prepareAuthoredBlockReferences(organization: { sql: string }, document: { sql: string }, locale: { sql: string }) {
  const blockScope = (type: string, source?: string) => ({ sql: `(SELECT organization_id FROM page_scope WHERE EXISTS (
    SELECT 1 FROM content_blocks b WHERE b.document_id = ${document.sql} AND b.type = '${type}'
      ${source ? `AND json_extract(b.data_json, '$.source') = '${source}'` : ''}))` })
  const pages: BatchQuery = { query: `SELECT root.id, root.product_id, COALESCE(rep.title, root.title) AS title,
    COALESCE(rep.summary, root.summary) AS summary, COALESCE(rep.slug, root.slug) AS slug,
    CASE WHEN rep.id IS NULL THEN root.path WHEN rep.path = '/' THEN '/' || rep.locale ELSE '/' || rep.locale || rep.path END AS path
    FROM content_documents root
    LEFT JOIN content_documents rep ON rep.root_id = root.id AND rep.row_role = 'representation' AND rep.locale = ${locale.sql}
    WHERE root.organization_id = ${organization.sql} AND root.row_role = 'root' AND root.kind = 'page'
      AND root.path IS NOT NULL AND root.title IS NOT NULL AND ${publicTenantPageSql('root')}
      AND root.id IN (SELECT selected.value FROM content_blocks b, json_each(b.data_json, '$.page_ids') selected
        WHERE b.document_id = ${document.sql} AND b.type = 'page_grid')
    ORDER BY root.sort_order, root.title` }
  const placements = mediaPlacementsQuery({
    organizationId: organization, ownerType: 'content_document', owners: { sql: `SELECT id FROM (${pages.query})` },
  })
  const reviews = prepareOrganizationReviews(blockScope('testimonial_grid'), { publishedOnly: true })
  return {
    queries: [pages, placements,
      qaListQuery(blockScope('faq', 'organization_qa'), null, locale, true),
      qaListQuery(blockScope('faq', 'page_qa'), null, locale, true, { sql: '(SELECT path FROM page_scope)' }),
      { query: `SELECT p.id, p.title, p.slug, p.summary AS excerpt, ${COVER_SELECT}
        FROM content_documents root JOIN content_documents p ON ${documentOfRootSql('p', 'root')} AND p.locale = ${locale.sql}
        ${coverJoinSql('p')}
        WHERE root.kind = 'article' AND root.row_role = 'root' AND p.organization_id = ${blockScope('feature_grid', 'organization_posts').sql}
          AND root.status = 'published' AND root.visibility = 'listed'
        ORDER BY root.published_at IS NULL, root.published_at DESC, p.id DESC` },
      ...reviews.queries,
    ],
    read([pages, placements, siteQa, pageQa, articles, ...reviewsRows]: D1Result[], organizationId: string) {
      const media = groupMediaPlacements(placements!.results)
      return {
        sourcePages: (pages!.results as Omit<PublicTenantPageReferenceRow, 'media'>[]).map(row =>
          ({ ...row, media: (media.get(row.id) ?? []).filter(item => item.slot !== 'social_card') })),
        qaItemsBySource: { organization_qa: faqItems(siteQa!.results as QaDocument[]), page_qa: faqItems(pageQa!.results as QaDocument[]) },
        reviewRows: reviews.read(reviewsRows, organizationId),
        postRows: articles!.results as AuthoredArticleRow[],
      }
    },
  }
}

/**
 * Resolve the products a product_grid names, by collection or by id.
 *
 * The grid stores references only, so names and descriptions come from the
 * product every time it renders and cannot go stale.
 */
function prepareTenantPageCatalog(organization: { sql: string }, document: { sql: string }, locale: { sql: string; params?: unknown[] }, home: boolean, predicate?: string) {
  const block = `SELECT id, type, data_json FROM content_blocks WHERE document_id = ${document.sql}`
  const sections = `SELECT data_json FROM (${block}) grid WHERE grid.type = 'product_grid' AND COALESCE(json_extract(grid.data_json, '$.source'), 'selected') <> 'recently_viewed'`
  const org = organization.sql
  const hasDefaultCatalog = home ? `(SELECT theme_id FROM organization WHERE id = ${org}) <> '${PLATFORM_SITE.themeId}'` : '0'
  const hasGrid = `EXISTS (SELECT 1 FROM (${block}) b WHERE b.type = 'product_grid'
    OR (b.type = 'contact_form' AND json_extract(b.data_json, '$.booking_product_id') IS NOT NULL))`
  const catalogScope = predicate ? organization : { sql: `(SELECT organization_id FROM page_scope
    WHERE ${hasDefaultCatalog} OR ${hasGrid} OR path = '/services')` }
  const offerings = preparePublishedOfferingGrid(catalogScope, predicate ?? `
    p.id IN (SELECT selected.value FROM (${sections}) grid, json_each(grid.data_json, '$.product_ids') selected)
    OR p.id IN (SELECT json_extract(data_json, '$.booking_product_id') FROM (${block}) form WHERE form.type='contact_form')
    OR EXISTS (SELECT 1 FROM collection_products cp WHERE cp.organization_id = p.organization_id AND cp.product_id = p.id
      AND cp.collection_id IN (SELECT json_extract(data_json, '$.collection_id') FROM (${sections})))
    OR (p.kind='service' AND (SELECT path FROM page_scope)='/services' AND (SELECT COUNT(*) FROM (${block}))=1
      AND EXISTS (SELECT 1 FROM (${block}) hero WHERE hero.type='hero'))
    ${home ? `OR ((SELECT o.theme_id FROM organization o WHERE o.id = ${org}) <> '${PLATFORM_SITE.themeId}' AND (
      p.kind IN ('experience','stay') OR json_extract(p.details_json, '$.featured') = 1
      OR (p.kind='dish' AND EXISTS (SELECT 1 FROM (${sections})
        WHERE COALESCE(json_array_length(data_json, '$.product_ids'), 0)=0
          AND NULLIF(TRIM(json_extract(data_json, '$.collection_id')), '') IS NULL))))` : ''}
  `)
  const collections = { query: `SELECT id, location_id FROM collections
    WHERE organization_id = ${org} AND id IN (SELECT json_extract(data_json, '$.collection_id') FROM (${sections}))` }
  const media = mediaPlacementsQuery({ organizationId: organization, ownerType: 'product',
    owners: { sql: offerings.ids.query, params: offerings.ids.params } })
  const paths = { query: `SELECT root.product_id, rep.path
    FROM content_documents root JOIN content_documents rep ON rep.root_id=root.id AND rep.row_role='representation' AND rep.locale=${locale.sql}
    WHERE root.organization_id=${org} AND root.kind='page' AND rep.path IS NOT NULL
      AND root.product_id IN (${offerings.ids.query}) AND ${publicTenantPageSql('root')}`, params: [...locale.params ?? [], ...offerings.ids.params ?? []] }
  return {
    queries: [...offerings.queries, collections, media, paths],
    async read(rows: D1Result[], context: { db: DbClient; env: CloudflareEnv; organizationId: string; locale: string; site: AuthoredPageSite; locations: Array<{ id: string; slug: string }>; localizations: readonly ExactPublicLocalization[] | null }) {
      const { db, env, organizationId, locale, site, locations, localizations } = context
      const products = (await offerings.read(rows.slice(0, offerings.queries.length), db, env, organizationId, site.default_currency as CurrencyCode | null)).map(publicProduct)
      return {
        products: localizations ? projectExactLocalizedCollection('product', products, localizations) : products,
        collections: rows.at(-3)!.results as Array<{ id: string; location_id: string | null }>,
        locations: localizations ? projectExactLocalizedCollection('business_location', locations, localizations) : locations,
        media: groupMediaPlacements(rows.at(-2)!.results), locale, localizations,
        pageRepresentations: rows.at(-1)!.results as { product_id: string; path: string }[],
      }
    },
  }
}

type AuthoredPageCatalog = Awaited<ReturnType<ReturnType<typeof prepareTenantPageCatalog>['read']>>

function tenantPageProductRows(
  source: AuthoredPageCatalog,
  selection: { collectionId?: string; productIds?: readonly string[]; locationId?: string | null },
  currency: string,
): PublicTenantPageProductRow[] {
  if (!isCurrencyCode(currency)) throw new Error('The public catalog requires a supported currency')
  const productIds = new Set(selection.productIds ?? [])
  const collection = selection.collectionId ? source.collections.find(item => item.id === selection.collectionId) : null
  if (selection.collectionId && !collection) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page collection reference is unavailable' })
  const locations = new Map(source.locations.map(location => [location.id, location]))
  const at = new Date().toISOString()
  const selected = source.products.filter(product => productIds.has(product.id) || product.collections.some(item => item.collection_id === collection?.id))
    .sort((left, right) => (left.collections.find(item => item.collection_id === collection?.id)?.sort_order ?? 0)
      - (right.collections.find(item => item.collection_id === collection?.id)?.sort_order ?? 0) || left.name.localeCompare(right.name))
  return selected.flatMap(product => {
    const offered = product.locations.filter(location => location.published && locations.has(location.location_id))
    const selectedLocation = selection.locationId ?? collection?.location_id
    if (selectedLocation && !offered.some(location => location.location_id === selectedLocation)) return []
    // A membership offered at no location is joined from anywhere, as an online offering is booked.
    const online = Boolean(product.booking?.held_online || product.order_url) || (isMembershipProduct(product) && !product.locations.length)
    if (!offered.length && !online) return []
    const locationId = product.kind === 'item' ? null : selectedLocation ?? (offered.length === 1 && !online ? offered[0]!.location_id : null)
    const scopes = product.kind === 'item' ? [null] : locationId ? [locationId] : [...offered.map(location => location.location_id), ...(online ? [null] : [])]
    const prices = summarizeProductPrices(product.variants, scopes.map(location_id => ({ currency, location_id, at })))
    const locationSlug = locationId ? locations.get(locationId)?.slug ?? null : null
    const presentation = presentationForProduct(product)
    const sourcePath = presentation && hasSiteProductPage(product.kind)
      ? presentation.productPath('', product.slug) + (product.kind === 'experience' && locationId ? `?location_id=${encodeURIComponent(locationId)}` : '')
      : product.page?.path ?? (locationSlug && presentation ? presentation.productPath(locationSlug, product.slug) : null)
    const localizedPage = source.pageRepresentations.find(page => page.product_id === product.id)
    let publicPath = sourcePath
    if (source.localizations) {
      if (product.page && !hasSiteProductPage(product.kind)) publicPath = localizedPage ? `/${source.locale}${localizedPage.path}` : null
      else publicPath = sourcePath ? `/${source.locale}${sourcePath}` : null
    }
    const note = product.details[PRICING_NOTE_HANDLE]
    return [{ id: product.id, name: product.name, slug: product.slug, description: product.description, kind: product.kind, featured: product.details.featured === true,
      public_path: publicPath,
      available: product.active && (locationId ? offered.some(location => location.location_id === locationId && location.active) : online || offered.some(location => location.active)),
      pricing_note: typeof note === 'string' ? note : null,
      unit_amount: prices.lowest?.unit_amount ?? null, max_unit_amount: prices.highest?.unit_amount ?? null,
      compare_at_unit_amount: prices.lowest?.compare_at_unit_amount ?? null, currency: prices.lowest?.currency ?? null,
      media: projectLocalizedMediaAlt(
        (source.media.get(product.id) ?? []).filter(item => item.slot === 'image' || item.slot === 'gallery'),
        source.localizations,
      ),
    }]
  })
}

export function tenantProductGridItem(product: PublicTenantPageProductRow, locale: string) {
  return {
    id: product.id,
    title: product.name,
    description: product.description || undefined,
    // Authored and visitor-specific cards share the product's public route.
    kind: product.kind,
    featured: product.featured,
    url: product.public_path ?? '',
    unavailable: !product.available,
    value: product.unit_amount === null || !product.currency
      ? product.pricing_note ?? undefined
      : product.max_unit_amount !== null && product.max_unit_amount !== product.unit_amount
        ? `${formatMinorAmount(product.unit_amount, product.currency as CurrencyCode, locale)} – ${formatMinorAmount(product.max_unit_amount, product.currency as CurrencyCode, locale)}`
        : formatMinorAmount(product.unit_amount, product.currency as CurrencyCode, locale),
    compare_at: product.compare_at_unit_amount === null || !product.currency
      ? undefined
      : formatMinorAmount(product.compare_at_unit_amount, product.currency as CurrencyCode, locale),
    labelKey: 'site.posts.cta_default',
    // The product's cover, or its first gallery item when there is no cover.
    media: product.media.filter(item => item.slot === 'image').length
      ? product.media.filter(item => item.slot === 'image')
      : product.media.filter(item => item.slot === 'gallery').slice(0, 1),
  }
}

function projectBlocks(
  pagePath: string,
  locale: string,
  blocks: TenantPageBlock[],
  organizationRow: AuthoredPageSite,
  productCatalog: AuthoredPageCatalog,
  sourceLocations: AuthoredPageLocation[],
  socialFeeds: Map<string, PublicSocialPost[]>,
  { sourcePages, qaItemsBySource, reviewRows, postRows }: ReturnType<ReturnType<typeof prepareAuthoredBlockReferences>['read']>,
  localizations: readonly ExactPublicLocalization[] | null = null,
): TenantPageBlock[] {
  const productIds = new Set<string>()
  const collectionIds = new Set<string>()
  for (const block of blocks) {
    if (block.type === 'product_grid' && block.data.source !== 'recently_viewed') {
      if (Array.isArray(block.data.product_ids)) {
        for (const value of block.data.product_ids) if (typeof value === 'string' && value.trim()) productIds.add(value)
      }
      if (typeof block.data.collection_id === 'string' && block.data.collection_id.trim()) collectionIds.add(block.data.collection_id)
    }
    // A contact form may name an offering whose booking flow a visitor can enter instead.
    if (block.type === 'contact_form' && typeof block.data.booking_product_id === 'string' && block.data.booking_product_id.trim()) productIds.add(block.data.booking_product_id)
  }
  const site = resolvePublicSite({ themeId: organizationRow.theme_id})
  // Legal practices list their practice areas on /services, and their offices
  // link to the contact page rather than to location pages they do not have.
  const legalPractice = isLegalPracticeSite({ themeId: organizationRow.theme_id, vertical: organizationRow.vertical })
  const defaultServices = pagePath === '/services' && legalPractice && blocks.length === 1 && blocks[0]?.type === 'hero'
  const defaultLocationGrid = pagePath === '/' && site.slug !== 'platform' && organizationRow.vertical !== 'lodging' && !blocks.some(block => block.type === 'location_grid')
  const addressVisible = !legalPractice || organizationRow.address_visibility === 'visible'
  // Each grid gets the products it named, and only those. Keyed by collection
  // rather than flattened into one list: two grids on a page name two different
  // collections, and a flat union rendered both collections in both grids.
  const currency = organizationRow.default_currency
  const homepage = pagePath === '/' && site.slug !== 'platform'
  if (homepage && !blocks.some(block => block.type === 'product_grid' && block.data.source === 'recently_viewed')) {
    const afterHero = blocks.findIndex(block => block.type === 'hero') + 1
    blocks = [...blocks.slice(0, afterHero), {
      id: 'homepage-recently-viewed', type: 'product_grid', position: afterHero,
      data: { source: 'recently_viewed' }, media: [],
    }, ...blocks.slice(afterHero)]
  }
  const homepageMenu = homepage && !legalPractice
  for (const service of defaultServices ? productCatalog.products.filter(product => product.kind === 'service') : []) {
    if (!service.page) throw new HTTPError({ statusCode: 500, statusMessage: 'Published service page is unavailable', data: { code: 'SERVICE_PAGE_MISSING', product_id: service.id } })
    productIds.add(service.id)
  }
  if (defaultServices && productIds.size) blocks = [...blocks, {
    id: 'services-list', type: 'product_grid', position: blocks.length,
    data: { product_ids: [...productIds] }, media: [],
  }]
  const homepageDishes = homepageMenu ? productCatalog.products.filter(product => product.kind === 'dish') : []
  const defaultMenuGrid = homepageMenu && blocks.some(block => block.type === 'product_grid' && block.data.source !== 'recently_viewed'
    && !(Array.isArray(block.data.product_ids) && block.data.product_ids.length) && !block.data.collection_id)
  for (const product of homepageDishes) if (defaultMenuGrid || product.details.featured === true) productIds.add(product.id)
  if (homepage) for (const product of productCatalog.products) if (product.kind === 'experience' || product.details.featured === true || (organizationRow.vertical === 'lodging' && product.kind === 'stay')) productIds.add(product.id)
  // Null on a site that sells nothing; its pages carry no product grid.
  if ((collectionIds.size || productIds.size) && !currency) {
    throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page site has no currency' })
  }
  const productsByCollection = new Map([...collectionIds].map(collectionId =>
    [collectionId, tenantPageProductRows(productCatalog, { collectionId }, currency!)] as const))
  const productById = new Map((productIds.size
    ? tenantPageProductRows(productCatalog, { productIds: [...productIds] }, currency!)
    : []).map(product => [product.id, product]))
  const menuProducts = [...productById.values()].filter(product => product.kind === 'dish')
  const featuredMenuProducts = menuProducts.filter(product => product.featured)
  const defaultMenuProducts = featuredMenuProducts.length ? featuredMenuProducts : menuProducts
  const displayed = new Set(blocks.filter(block => block.type === 'product_grid' && block.data.source !== 'recently_viewed').flatMap(block =>
    Array.isArray(block.data.product_ids) && block.data.product_ids.length
      ? block.data.product_ids.filter((id): id is string => typeof id === 'string' && productById.has(id))
      : block.data.collection_id
        ? (productsByCollection.get(String(block.data.collection_id)) ?? []).map(product => product.id)
        : homepageMenu ? defaultMenuProducts.map(product => product.id) : []))
  if (homepage) {
    const missing = [...productById.values()].filter(product => (product.featured || (organizationRow.vertical === 'lodging' && product.kind === 'stay')) && product.kind !== 'experience' && !displayed.has(product.id))
    if (missing.length) blocks = [...blocks, {
      id: 'homepage-featured-products', type: 'product_grid',
      position: Math.max(-1, ...blocks.map(block => block.position)) + 1,
      data: {
        title: organizationRow.vertical === 'lodging' ? getVerticalCopy(organizationRow.vertical, locale).staysPageTitle : undefined,
        product_ids: missing.map(product => product.id),
      }, media: [],
    }]
  }
  const missingExperiences = homepage ? [...productById.values()].filter(product => product.kind === 'experience' && !displayed.has(product.id)) : []
  if (missingExperiences.length) blocks = [...blocks, {
    id: 'homepage-experiences', type: 'product_grid',
    position: Math.max(-1, ...blocks.map(block => block.position)) + 1,
    data: { title: getVerticalCopy(organizationRow.vertical, locale).experiencesPageTitle, product_ids: missingExperiences.map(product => product.id) }, media: [],
  }]
  // The row stores the address as text and a translation carries only the parts
  // that are words, so the canonical one is read first: the overlay then merges
  // the translated parts onto it and keeps the region code and postcode. Left as
  // text, the overlay replaced the whole value with a partial address.
  const parsedLocations = sourceLocations.filter(location => location.published_location === 1).map(location => ({ ...location, address: parsePostalAddress(location.address) }))
  const localizedLocations = localizations
    ? projectExactLocalizedCollection('business_location', parsedLocations, localizations).map((location) => {
        const representation = localizations.find(item => item.resourceType === 'business_location' && item.resourceId === location.id)
        const slug = representation?.routePath?.split('/').filter(Boolean).at(-1)
        if (!representation?.routePath?.startsWith('/') || !slug) {
          throw new HTTPError({ statusCode: 500, statusMessage: 'Stored localized location route is invalid', data: { code: 'INVALID_STORED_CONTENT' } })
        }
        return { ...location, slug, public_path: representation.routePath }
      })
    : parsedLocations
  const locations = localizedLocations.map(({ stay_map_sharing, is_stay_location, ...location }) =>
    projectPublicLocation(location, { stay_map_sharing, is_stay_location }))
  const locationCopy = getVerticalCopy(organizationRow.vertical, locale)
  // A legal practice lists the offices a client can visit: those with an address
  // it shows. A practice that works online, or keeps its address private, has none.
  const defaultLocations = legalPractice
    ? (addressVisible ? locations.filter(location => location.address) : [])
    : locations
  if (defaultLocationGrid && defaultLocations.length) {
    blocks = [...blocks, {
      id: 'homepage-locations', type: 'location_grid',
      position: Math.max(-1, ...blocks.map(block => block.position)) + 1,
      data: { title: locationCopy.locationGroupLine(defaultLocations.length), description: locationCopy.findUsKicker, location_ids: defaultLocations.map(location => location.id) },
      media: [],
    }]
  }
  if (homepageMenu) {
    const ctaTypes = ['cta', 'booking_cta', 'contact_cta']
    blocks = [...blocks].sort((left, right) => Number(ctaTypes.includes(left.type)) - Number(ctaTypes.includes(right.type)))
  }
  // A page's translation is its representation row, loaded by locale in the
  // reference query above. Only the media
  // alt text needs projecting here.
  const pages = localizations
    ? sourcePages.map(page => ({ ...page, media: projectLocalizedMediaAlt(page.media, localizations) }))
    : sourcePages
  const pageById = new Map(pages.map(item => [item.id, item]))
  const sourceLocationById = new Map(parsedLocations.map(item => [item.id, item]))
  const activeLocationIds = new Set(sourceLocations.map(item => item.id))
  const locationById = new Map(locations.map(item => [item.id, item]))
  const reviewItems = (reviewRows as unknown as Array<Record<string, unknown>>).map(row => ({
    id: String(row.id),
    title: typeof row.author_name === 'string' ? row.author_name : '',
    description: typeof row.content === 'string' ? row.content : undefined,
    value: row.rating == null ? undefined : String(row.rating),
    // The reviewer's picture, which the review record owns. It was dropped on
    // the way into the item, so a site drawing portraits drew none.
    media: Array.isArray(row.media) ? row.media : [],
  }))
  const postItems = postRows.map((post) => {
    const { cover, ...row } = attachCoverMedia(post)
    return {
      id: row.id,
      title: row.title,
      description: row.excerpt || undefined,
      url: tenantBlogPostPath(row.slug),
      labelKey: 'site.posts.read_full_story',
      media: cover
        ? projectLocalizedMediaAlt([{ asset_id: cover.asset_id, slot: 'media', public_url: cover.public_url, thumbnail_url: cover.thumbnail_url, kind: cover.kind, alt_text: cover.alt_text }], localizations)
        : [],
    }
  })
  return blocks.map(block => {
    if (block.type === 'showcase' || block.type === 'language_reach' || block.type === 'steps' || block.type === 'how_to') validateContentBlockData(block.type, block.data)
    const data = { ...block.data }
    if (block.type === 'contact_form') {
      // The offering's own page, opened on its booking; an offering this site no longer publishes offers no link.
      const product = typeof data.booking_product_id === 'string' ? productById.get(data.booking_product_id) : undefined
      data.booking = product?.public_path && product.available ? { url: `${product.public_path}${product.public_path.includes('?') ? '&' : '?'}book=1`, label: typeof data.booking_label === 'string' && data.booking_label.trim() ? data.booking_label : null } : null
    }
    if (block.type === 'page_grid') {
      data.items = (data.page_ids as string[]).map((id) => {
        const page = pageById.get(id)
        // A reference to a page that is gone or unpublished is a broken block,
        // not a row to quietly drop: the editor chose it and needs to know.
        if (!page) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page reference is unavailable' })
        return {
          id: page.id,
          product_id: page.product_id,
          title: page.title,
          description: page.summary ?? undefined,
          url: page.path,
          labelKey: 'site.posts.cta_default',
          media: page.media,
        }
      })
    }
    if (block.type === 'product_grid') {
      if (data.source === 'recently_viewed') return { ...block, data: { ...data, items: [] } }
      // Explicit selections stay as authored; an unscoped homepage menu uses
      // the merchant's featured dishes, or its ordinary menu when none are featured.
      const collectionId = typeof data.collection_id === 'string' && data.collection_id.trim() ? data.collection_id : null
      const selected = Array.isArray(data.product_ids) && data.product_ids.length > 0
        ? data.product_ids.flatMap((id) => {
            const product = typeof id === 'string' ? productById.get(id) : undefined
            return product ? [product] : []
          })
        : collectionId
          ? productsByCollection.get(collectionId)
          : homepageMenu ? defaultMenuProducts : []
      if (!selected) throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page collection reference is unavailable' })
      data.items = selected.map(product => tenantProductGridItem(product, locale))
    }
    if (block.type === 'location_grid' && Array.isArray(data.location_ids)) {
      data.items = data.location_ids.flatMap((id) => {
        const sourceLocation = typeof id === 'string' ? sourceLocationById.get(id) : undefined
        if (!sourceLocation) {
          throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page location reference is unavailable' })
        }
        const location = locationById.get(sourceLocation.id)
        if (!location) return []
        return [{
          id: location.id,
          title: location.title,
          // The town the visitor is being sent to. A location card names it
          // above the title, and the item carried everything except that.
          ...(addressVisible ? { city: location.public_area?.locality || addressPlaceName(location.address) || undefined, address: formatPostalAddress(location.address) || undefined } : {}),
          public_area: location.public_area,
          description: location.short_description || location.description || undefined,
          url: legalPractice ? pagePath === '/contact' ? undefined : '/contact'
            : 'public_path' in location && typeof location.public_path === 'string' ? location.public_path : publicLocationPath(location),
          label: locationCopy.visitLocationCta,
          media: location.asset_id
            ? projectLocalizedMediaAlt([{ asset_id: location.asset_id, slot: 'hero', public_url: location.public_url, thumbnail_url: location.thumbnail_url, kind: location.kind, alt_text: location.alt_text }], localizations)
            : [],
        }]
      })
    }
    const faqSource = faqBlockSource(block)
    if (faqSource === 'organization_qa') {
      data.items = qaItemsBySource[faqSource]
    } else if (faqSource === 'page_qa') {
      data.items = (Array.isArray(block.data.items) && block.data.items.length)
        ? block.data.items
        : qaItemsBySource[faqSource]
    }
    if (block.type === 'testimonial_grid') data.items = reviewItems
    if (block.type === 'social_posts') {
      const locationId = typeof data.location_id === 'string' && data.location_id ? data.location_id : null
      if (locationId && !activeLocationIds.has(locationId)) {
        throw new HTTPError({ statusCode: 500, statusMessage: 'Tenant page location reference is unavailable' })
      }
      const feed = socialFeeds.get(block.id) ?? []
      const limit = Number(data.limit)
      data.posts = feed.slice(0, limit)
      data.has_more = feed.length > limit
    }
    if (block.type === 'feature_grid' && data.source === 'organization_posts') {
      const items = postItems
      const limit = typeof data.limit === 'number' && Number.isInteger(data.limit) && data.limit > 0 ? data.limit : items.length
      data.items = items.slice(0, limit)
    }
    return { ...block, data }
  })
}

function mapPage(
  page: TenantPageDto,
  blocks: TenantPageBlock[],
  socialMedia: { media: MediaPlacementItem[]; social_image: SocialImageSource | null },
  locale_representations: PublicLocaleRepresentation[],
): PublicTenantPage {
  return {
    id: page.id,
    page_id: page.page_id,
    product_id: page.product_id,
    path: page.path,
    title: page.title,
    summary: page.summary,
    page_type: page.page_type,
    recipe: page.recipe,
    sort_order: page.sort_order,
    locale: page.locale,
    blocks,
    ...socialMedia,
    locale_representations,
    updated_at: page.updated_at,
  }
}

type AuthoredPageLocation = PublicLocationPrivacySource & {
  id: string; title: string; slug: string; published_location: number; address: string | null; latitude: number | null; longitude: number | null;
  description: string | null; short_description: string | null; asset_id: string | null; public_url: string | null;
  thumbnail_url: string | null; kind: string | null; alt_text: string | null;
}

export function preparePublicAuthoredPage(
  organization: string | { sql: string }, path: string, locale: string | { sql: string }, preview = false,
) {
  const page = prepareTenantPageAtPath(organization, path, locale, preview)
  const scoped = { sql: '(SELECT organization_id FROM page_scope)' }
  const document = { sql: '(SELECT id FROM page_scope)' }
  const language = { sql: '(SELECT locale FROM page_scope)' }
  const home = path === '/'
  const media = mediaPlacementsQuery({
    organizationId: scoped, ownerType: home ? 'organization' : 'content_document',
    owners: { sql: `SELECT ${home ? 'organization_id' : 'id'} FROM page_scope` }, includeOrganizationFallback: !home,
  })
  const alternates = publicDocumentLocaleQuery(scoped, { sql: '(SELECT page_id FROM page_scope)' })
  const site: BatchQuery = {
    query: `SELECT theme_id, vertical, default_currency, json_extract(settings_json, '$.compliance.address_visibility') AS address_visibility
              FROM organization WHERE id = ${scoped.sql}`,
  }
  const catalog = prepareTenantPageCatalog(scoped, document, language, home)
  const location: BatchQuery = {
    query: `SELECT bl.id, bl.title, bl.slug, bl.address, bl.latitude, bl.longitude, ${publicLocationPrivacySql('bl')},
      (${publicLocationSql('bl')}) AS published_location, bl.description, bl.short_description, ma.id AS asset_id, ma.public_url, ma.thumbnail_url, ma.kind, ma.alt_text
      FROM business_locations bl
      LEFT JOIN media_placements mp ON mp.organization_id = bl.organization_id AND mp.owner_type = 'business_location'
        AND mp.owner_id = bl.id AND mp.slot = 'hero' AND mp.sort_order = 0 AND mp.status = 'active'
      LEFT JOIN media_assets ma ON ma.id = mp.asset_id AND ma.organization_id = bl.organization_id AND ma.status = 'active'
      WHERE bl.organization_id = ${scoped.sql} AND bl.status = 'active'
        AND (${home ? `EXISTS (SELECT 1 FROM organization o WHERE o.id = bl.organization_id AND o.theme_id <> '${PLATFORM_SITE.themeId}') OR` : ''}
          (SELECT path FROM page_scope) = '/services'
          OR EXISTS (SELECT 1 FROM content_blocks b WHERE b.document_id = ${document.sql}
            AND b.type IN ('location_grid','product_grid','contact_form','social_posts')))
      ORDER BY bl.title, bl.id`,
  }
  const feeds = preparePublicPostBlocks(scoped, document, language)
  const blockReferences = prepareAuthoredBlockReferences(scoped, document, language)
  const feedOffset = catalog.queries.length
  const referenceOffset = feedOffset + feeds.queries.length
  const related: BatchQuery[] = [media, alternates, site, location, ...catalog.queries, ...feeds.queries, ...blockReferences.queries]
  return {
    queries: [...page.queries, ...related.map(statement => {
      const sql = statement.query.trimStart()
      return {
        query: `WITH page_scope AS (${page.statement.query})${sql.startsWith('WITH ') ? `, ${sql.slice(5)}` : ` ${sql}`}`,
        params: [...page.statement.params ?? [], ...statement.params ?? []],
      }
    })],
    read(rows: D1Result[]) {
      const record = page.read(rows)
      if (!record) return null
      const [placements, candidates, configuration, locationRows, ...offerings] = rows.slice(page.queries.length)
      const site = configuration!.results[0] as AuthoredPageSite | undefined
      if (!site || !record.row.source_path) throw new Error('Tenant page is missing its site or source path')
      const grouped = groupMediaPlacements(placements!.results)
      const brand = grouped.get(record.page.organization_id) ?? []
      const picture = home ? publicSocialMediaFromPlacements('organization', brand, brand)
        : publicSocialMediaFromPlacements('content_document', grouped.get(record.page.id) ?? [], brand)
      const locations = locationRows!.results as AuthoredPageLocation[]
      return { page: record.page, sourcePath: record.row.source_path, site, locations,
        catalog: (context: { db: DbClient; env: CloudflareEnv; localizations: readonly ExactPublicLocalization[] | null }) =>
          catalog.read(offerings.slice(0, catalog.queries.length), { ...context, site, locations, organizationId: record.page.organization_id, locale: record.page.locale }),
        feeds: (context: Parameters<typeof feeds.read>[1]) => feeds.read(offerings.slice(feedOffset, referenceOffset), context),
        blockReferences: blockReferences.read(offerings.slice(referenceOffset), record.page.organization_id),
        social: home ? { media: [], social_image: picture.social_image } : picture,
        candidates: candidates!.results as LocalizedRouteCandidate[] }
    },
  }
}

export async function getPublicTenantPageForPath(
  env: CloudflareEnv,
  db: DbClient,
  organizationId: string,
  path: string,
  options: { locale?: string | null; preview?: boolean; event?: H3Event; localizations?: readonly ExactPublicLocalization[] | null } = {},
): Promise<PublicTenantPage | null> {
  path = normalizeTenantPagePath(path)
  const { event, preview = false } = options
  const source = await (event ? readPublicSourceLocale(event, db, organizationId) : getPersistedSourceLocale(db, organizationId))
  const locale = options.locale || source.locale
  const translated = locale !== source.locale
  if (translated) await (event ? readPublicOrganizationLanguage(event, db, organizationId, locale, source)
    : assertPublicOrganizationLanguage(db, organizationId, locale, source))
  const preloaded = event?.context.publicAuthoredPage as { organizationId: string; locale: string; path: string;
    plan: ReturnType<typeof preparePublicAuthoredPage>; rows: D1Result[] } | undefined
  const reuse = !preview && preloaded?.organizationId === organizationId && preloaded.locale === locale && preloaded.path === path
  const stored = translated && !options.localizations && event ? preloadedPublicLocalizations(event, organizationId, locale) : undefined
  const plan = reuse ? preloaded.plan : preparePublicAuthoredPage(organizationId, path, locale, preview)
  const localizationRead = translated && !options.localizations && !stored ? publicLocalizationsQuery(organizationId, locale) : null
  const rows = reuse && !localizationRead ? preloaded.rows
    : await executeBatch(db, [...plan.queries, ...localizationRead ? [localizationRead] : []], { operation: 'Read authored public page' })
  const record = plan.read(rows)
  if (!record) return null
  const { page, site, social, sourcePath, candidates } = record
  const localizations = translated ? options.localizations ?? indexStoredPublicLocalizations(
    stored ?? rows.at(-1)!.results as StoredPublicLocalizationRow[]) : null
  const [blocks, locale_representations] = await Promise.all([
    record.catalog({ db, env, localizations }).then(catalog =>
      projectBlocks(page.path, page.locale, page.blocks, site, catalog, record.locations,
        record.feeds({ env, organizationId, sourceLocale: source.locale, locale, localizations }), record.blockReferences, localizations)),
    listPublicLocaleRepresentations(env, db, { organizationId, sourceLocale: source, sourcePath, candidates }),
  ])
  if (localizations) for (const block of blocks) {
    block.media = projectLocalizedMediaAlt(block.media.map(item => ({ ...item, alt_text: item.alt_text ?? null })), localizations)
  }
  return mapPage(page, blocks, localizations ? { ...social, media: projectLocalizedMediaAlt(social.media, localizations) } : social, locale_representations)
}

export async function readPublicAuthoredPage(event: H3Event, query: Record<string, unknown>) {
  const organizationId = event.context.organizationId as string | undefined
  if (!organizationId) throw new HTTPError({ statusCode: 400, statusMessage: 'Unknown tenant' })
  const env = cloudflareEnv(event)
  if (!env.db) throw new HTTPError({ statusCode: 503, statusMessage: 'Database unavailable' })
  const path = typeof query.path === 'string' ? query.path : null
  if (!path) throw new HTTPError({ statusCode: 400, statusMessage: 'A page path is required' })
  const locale = typeof query.locale === 'string' ? query.locale : null
  const preview = event.context.previewAuthorized === true
  const page = await getPublicTenantPageForPath(env, env.db, organizationId, path, { locale, preview, event })
  if (!page) throw new HTTPError({ statusCode: 404, statusMessage: 'Tenant page not found' })
  return { success: true as const, page, preview }
}

/** Visitor-only cards reuse the authored grid's catalog, localization and media projection in one D1 batch. */
export function prepareRecentlyViewedProducts(
  target: string | BatchQuery, query: Record<string, unknown>, cookieHeader: string,
) {
  const locale = assertExactCanonicalLocale(query.locale)
  const exclude = query.exclude_product_id
  if (exclude !== undefined && (typeof exclude !== 'string' || !exclude.trim() || exclude.length > 100)) throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid excluded product' })
  const excludeProductId = typeof exclude === 'string' ? exclude : null
  const cookies = parseCookie(cookieHeader)
  const visitorId = cookies[VISITOR_COOKIE]
  if (visitorId !== undefined && !isCanonicalEventId(visitorId)) throw new HTTPError({ statusCode: 400, statusMessage: 'Visitor cookie is invalid' })
  const targetSql = typeof target === 'string' ? '?' : `(${target.query})`
  const targetParams = typeof target === 'string' ? [target] : target.params ?? []
  const scope = `SELECT o.id AS organization_id, o.theme_id, o.vertical, o.default_currency,
      json_extract(o.settings_json, '$.compliance.address_visibility') AS address_visibility, source.locale AS source_locale,
      COALESCE((SELECT value FROM json_each(?) WHERE key='cart_' || o.id), '[]') AS cart_json
    FROM organization o JOIN organization_locales source ON source.organization_id=o.id AND source.is_source=1 AND source.status='published'
    WHERE o.id=${targetSql} AND ${publicTenantVisibilitySql('o', false)}
      AND EXISTS (SELECT 1 FROM organization_locales language WHERE language.organization_id=o.id AND language.locale=? AND language.status='published')`
  const prefix = `WITH personalization_scope AS (${scope}), cart_scope AS (
    SELECT CASE WHEN json_valid(cart_json) THEN CASE WHEN json_type(cart_json)='array' THEN cart_json ELSE '[]' END ELSE '[]' END AS cart_json FROM personalization_scope
  ), raw_candidates AS (
    SELECT v.product_id, v.id AS product_variant_id, CAST(CASE WHEN line.type='object' THEN json_extract(line.value, '$.quantity') END AS INTEGER) AS quantity,
      0 AS priority, CAST(line.key AS INTEGER) AS position, '' AS viewed_at, NULL AS location_id
    FROM json_each((SELECT cart_json FROM cart_scope)) line JOIN product_variants v ON v.id=CASE WHEN line.type='object' THEN json_extract(line.value, '$.product_variant_id') END
      AND v.organization_id=(SELECT organization_id FROM personalization_scope) AND v.active=1
    UNION ALL
    SELECT recent.product_id, NULL, 1, 1, 0, recent.viewed_at, recent.location_id FROM (
      SELECT * FROM (SELECT json_extract(payload_json, '$.product_id') AS product_id, created_at AS viewed_at, location_id,
        ROW_NUMBER() OVER (PARTITION BY json_extract(payload_json, '$.product_id') ORDER BY created_at DESC, id DESC) AS view_rank
      FROM analytics_events WHERE organization_id=(SELECT organization_id FROM personalization_scope)
        AND kind='pageview' AND visitor_id=? AND created_at>=strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days')
        AND json_extract(payload_json, '$.product_id') IS NOT NULL
      ) WHERE view_rank=1 ORDER BY viewed_at DESC LIMIT 12
    ) recent
  ), candidates AS (SELECT * FROM raw_candidates WHERE product_id IS NOT ?)`
  const cartCookies = Object.fromEntries(Object.entries(cookies).filter(([name]) => name.startsWith('cart_')))
  const params = [JSON.stringify(cartCookies), ...targetParams, locale, visitorId ?? null, excludeProductId]
  const organization = { sql: '(SELECT organization_id FROM personalization_scope)' }
  const catalog = prepareTenantPageCatalog(organization, { sql: 'NULL' }, { sql: '?', params: [locale] }, false,
    'p.id IN (SELECT product_id FROM candidates) AND p.active=1')
  const locations: BatchQuery = { query: `SELECT id, title, slug FROM business_locations WHERE organization_id=${organization.sql} AND status='active'` }
  const localized = publicLocalizationsQuery(organization, locale)
  const queries: BatchQuery[] = [
    { query: 'SELECT * FROM personalization_scope' },
    { query: 'SELECT * FROM candidates ORDER BY priority, position DESC, viewed_at DESC, product_id' },
    locations, ...catalog.queries, localized,
  ]
  return {
    queries: queries.map(statement => {
      const sql = statement.query.trimStart()
      return { query: `${prefix}${sql.startsWith('WITH ') ? `, ${sql.slice(5)}` : ` ${sql}`}`, params: [...params, ...statement.params ?? []] }
    }),
    async read(rows: D1Result[], db: DbClient, env: CloudflareEnv) {
      const site = rows[0]!.results[0] as (AuthoredPageSite & { organization_id: string; source_locale: string; cart_json: string }) | undefined
      if (!site) throw new HTTPError({ statusCode: 404, statusMessage: 'Public site language not found' })
      let cartValue: unknown
      try { cartValue = JSON.parse(site.cart_json) }
      catch { throw new HTTPError({ statusCode: 400, statusMessage: 'Cart cookie is invalid' }) }
      if (!cartLinesSchema.safeParse(cartValue).success) throw new HTTPError({ statusCode: 400, statusMessage: 'Cart cookie is invalid' })
      const candidates = rows[1]!.results as Array<{ product_id: string; product_variant_id: string | null; quantity: number; location_id: string | null }>
      if (!candidates.length) return { items: [] }
      const organizationId = site.organization_id
      if (!isCurrencyCode(site.default_currency)) throw new Error('The public catalog requires a supported currency')
      const localizations = site.source_locale === locale ? null : indexStoredPublicLocalizations(rows.at(-1)!.results as StoredPublicLocalizationRow[])
      const source = await catalog.read(rows.slice(3, -1), {
        db, env, organizationId, locale, site, locations: rows[2]!.results as Array<{ id: string; title: string; slug: string }>, localizations,
      })
      const products = new Map(source.products.map(product => [product.id, product]))
      const seen = new Set<string>()
      const items = []
      for (const candidate of candidates) {
        if (seen.has(candidate.product_id)) continue
        const product = products.get(candidate.product_id)
        const card = tenantPageProductRows(source, { productIds: [candidate.product_id], locationId: candidate.location_id }, site.default_currency)[0]
        if (!product || !card?.available || !card.public_path) continue
        const locations = product.locations.filter(location => location.active && location.published && source.locations.some(entry => entry.id === location.location_id))
        const variants = product.variants.filter(variant => variant.active && (!candidate.product_variant_id || variant.id === candidate.product_variant_id))
        const available = variants.find(variant => {
          if (product.kind !== 'item') return true
          if (!selectPrice(variant.prices, { currency: site.default_currency as CurrencyCode, location_id: null })) return false
          const stock = Math.max(0, ...variant.inventory_levels.filter(level => locations.some(location => location.location_id === level.location_id)).map(level => level.available))
          const quantity = purchasableQuantity({ ...variant, available: stock })
          return quantity === null || quantity >= candidate.quantity
        })
        if (!available) continue
        seen.add(product.id)
        const price = candidate.product_variant_id ? selectPrice(available.prices, { currency: site.default_currency, location_id: null }) : null
        const picture = candidate.product_variant_id && available.media_asset_id ? source.media.get(product.id)?.find(asset => asset.asset_id === available.media_asset_id) : null
        items.push({ ...tenantProductGridItem(price ? { ...card, unit_amount: price.unit_amount, max_unit_amount: price.unit_amount,
          currency: price.currency, compare_at_unit_amount: price.compare_at_unit_amount } : card, locale),
          cart_recovery: candidate.product_variant_id !== null,
          ...(candidate.product_variant_id ? { url: '/cart' } : {}), ...(picture ? { media: [picture] } : {}) })
        if (items.length === 8) break
      }
      return { items }
    },
  }
}
