import { prepareDashboardStayHomes } from '~/server/utils/dashboard-stay-homes'
import { listingGrantSql } from '~/server/domain/listing-access'
import type { BatchQuery } from '~/server/db'
import { HTTPError, type H3Event } from 'nitro'
import { getQuery } from 'nitro/h3'
import { dashboardOrgQueryParam, getDashboardMemberContext, prepareDashboardLocations, readDashboardMemberResources, type DashboardOrganizationRow } from '~/server/utils/dashboard-context'
import { BATCH_VIEWER, assignedOfferingCondition, type OfferingReadScope, roleAllows, assertRoleAllows, isOrganizationWideRole } from '~/server/utils/member-access'
import { prepareCatalogOfferings, prepareCollectionList, PUBLIC_PRODUCT_SQL } from '~/server/utils/product-management'
import { roleMatchesSql, rolesAllowing } from '~/utils/organization-access'
import { groupProductsByCollection } from '~/utils/product-presentation'
import { formatProductPriceRange, summarizeProductPrices } from '~/utils/product-money'
import { isCurrencyCode } from '~/shared/currencies'
import { PRICING_NOTE_HANDLE } from '~/shared/product-details'
import { mediaStillUrl } from '~/shared/media-placement-contract'
import type { CatalogRow, CatalogScreen } from '~/shared/catalog-screen'
import type { Product } from '~/server/types/products'
import { oncePerRequest } from '~/server/utils/request-scope'

const kinds = [
  { value: 'menu', label: 'Menu' }, { value: 'experience', label: 'Experiences' },
  { value: 'service', label: 'Services' }, { value: 'stay', label: 'Places to stay' },
  { value: 'table', label: 'Tables' }, { value: 'item', label: 'Products' },
]

export function readDashboardCatalogDocument(event: H3Event, slug: string, preloaded?: ReturnType<ReturnType<typeof prepareDashboardCatalog>['read']>) {
  return oncePerRequest(event, `dashboard-catalog-data:${slug}`, () => loadDashboardCatalog(event, slug, preloaded))
}

export async function loadDashboardCatalog(event: H3Event, organizationSlug?: string, preloaded?: ReturnType<ReturnType<typeof prepareDashboardCatalog>['read']>) {
  const query = getQuery(event)
  const slug = organizationSlug ?? dashboardOrgQueryParam(event)
  if (!slug) throw new HTTPError({ statusCode: 400, message: 'Organization context is required', data: { code: 'ORGANIZATION_REQUIRED', field: 'org' } })
  const plan = prepareDashboardCatalog({ organizationId: { sql: BATCH_VIEWER.organization },
    assignedUserId: { user: BATCH_VIEWER.user, unrestricted: roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ products: ['read'] })) } }, query)
  let organization: DashboardOrganizationRow
  let data: ReturnType<typeof plan.read>
  if (preloaded) {
    organization = (await getDashboardMemberContext(event, { organizationSlug: slug })).organization
    data = preloaded
  } else {
    const context = await readDashboardMemberResources(event, { slug }, plan.queries)
    organization = context.organization
    data = plan.read(context.rows, organization.id)
  }
  if (await roleAllows({ ...organization, permissions: { menu: ['read'] } })) {
    if (query.location_id !== undefined && !data.kitchenLocations.some(row => row.location_id === query.location_id)) throw new HTTPError({ statusCode: 404, message: 'Location not found', data: { code: 'LOCATION_NOT_FOUND', field: 'location_id' } })
    const screen: CatalogScreen = { title: 'Menu', fields: [], empty_title: 'No dishes',
      rows: data.kitchenDishes.map(dish => ({ id: dish.id, label: dish.name, summary: dish.description || undefined })) }
    return { ...screen, screen, filters: [], kind: 'menu', can_create: false, has_stays: false, layout: 'catalog', listing_context: null }
  }
  const manages = await roleAllows({ ...organization, permissions: { products: ['read'] } })
  if (!manages) await assertRoleAllows({ ...organization, permissions: { products: ['assigned'] } })
  const can_create = await roleAllows({ ...organization, permissions: { products: ['create'] } })
  const kind = query.kind === undefined || query.kind === 'all' ? 'all' : kinds.find(item => item.value === query.kind)?.value
  if (!kind) throw new HTTPError({ statusCode: 400, message: 'Choose a valid catalog kind', data: { code: 'INVALID_CATALOG_FILTER', field: 'kind' } })
  const isMenu = query.view === 'menu' || query.view === 'section'
  const { identities, collections, locations, offerings } = data
  const location = locations.find(item => item.id === query.location_id)
  if (query.location_id !== undefined && !location) throw new HTTPError({ statusCode: 404, message: 'Location not found' })
  const products = identities.map(product => ({ ...product, collection_ids: JSON.parse(product.collection_ids) as string[] }))
  const scopedProducts = location ? products.filter(product => product.at_location) : products
  const scopedCollections = location ? collections.filter(section => section.location_id === null || section.location_id === location.id) : collections
  const occupiedSections = new Set(products.flatMap(product => product.collection_ids))
  const dishSections = new Set(products.filter(product => product.kind === 'dish').flatMap(product => product.collection_ids))
  const menu = scopedCollections.filter(section => !occupiedSections.has(section.id) || dishSections.has(section.id))
  const offers = (value: string) => value === 'menu'
    ? menu.length > 0 || scopedProducts.some(product => product.kind === 'dish')
    : scopedProducts.some(product => product.kind === value)
  const filters = [{ value: 'all', label: 'All' }, ...kinds.filter(item => item.value === kind || offers(item.value))]
  const base = `/dashboard/${encodeURIComponent(organization.slug)}/products`
  const currency = organization.default_currency
  if (!isCurrencyCode(currency)) throw new Error('Unsupported organization currency')
  const item = (product: Product, locationId?: string, internalName?: string | null): CatalogRow => {
    const bindings = product.locations.map(binding => {
      const place = locations.find(row => row.id === binding.location_id)
      if (!place) throw new Error('The offering location could not be loaded')
      return place.title
    })
    const scopes = locationId ? [locationId] : [null, ...locations.map(place => place.id)]
    const price = formatProductPriceRange(summarizeProductPrices(product.variants, scopes.map(location_id => ({ currency, location_id }))))
    const note = product.details[PRICING_NOTE_HANDLE]
    return {
      id: product.id, label: internalName ?? product.stay?.internal_name ?? product.name,
      summary: [price ?? (typeof note === 'string' && note.trim() ? note : 'No price set'), product.booking?.held_online ? 'Online' : null, ...bindings,
        ...(!bindings.length && !product.booking?.held_online ? ['No locations set'] : [])].filter(Boolean).join(' · '),
      to: `${base}/${product.id}${locationId ? `?location_id=${encodeURIComponent(locationId)}&kind=${product.kind}` : ''}`,
      native: product.kind === 'stay' ? 'stay' : 'offering',
      query: { product_id: product.id, ...(locationId ? { location_id: locationId } : {}) },
    }
  }
  const screen: CatalogScreen = { title: location ? `${location.title} catalog` : 'Catalog', fields: [], rows: [], empty_title: 'No offerings' }
  const wide = isOrganizationWideRole(organization.role)
  if (query.view === 'menu' || query.view === 'section') {
    const locationId = location?.id
    const sections = menu.filter(section => section.location_id === null || section.location_id === locationId)
    const sectionIds = new Set(sections.map(section => section.id))
    const dishes = products.filter(product => product.kind === 'dish' && (locationId
      ? product.at_location
      : !product.has_location || product.collection_ids.some(id => sectionIds.has(id))))
    screen.title = location ? `${location.title} menu` : 'Menu'
    screen.empty_title = 'No dishes'
    if (query.view === 'section') {
      const section = sections.find(entry => entry.id === query.section_id)
      if (!section) throw new HTTPError({ statusCode: 404, message: 'Section not found' })
      screen.title = section.name
      const sectionIds = new Set(dishes.filter(dish => dish.collection_ids.includes(section.id)).map(dish => dish.id))
      const sectionProducts = offerings.filter(entry => sectionIds.has(entry.product.id)).map(entry => entry.product)
      screen.rows = (groupProductsByCollection(sectionProducts, [section])[0]?.products ?? []).map(dish => item(dish, locationId))
      if (wide && section.location_id === (locationId ?? null)) {
        const edit = (native: string, label: string, summary?: string): CatalogRow => ({
          id: native, native, label, summary, query: { section_id: section.id },
        })
        screen.rows.unshift(
          edit('section-name', 'Name', section.name),
          edit('section-description', 'Description', section.description ?? undefined),
          { ...edit('section-photo', 'Photo'), image: mediaStillUrl(section.image) },
          edit('section-membership', 'Choose dishes'),
          edit('section-move', 'Move a dish'),
          edit('create-offering', 'Create a dish'),
          edit('section-items', 'Order items'),
          edit('delete-section', 'Delete section'),
        )
      }
    } else {
      const unsectionedIds = new Set(dishes.filter(dish => !dish.collection_ids.some(id => sectionIds.has(id))).map(dish => dish.id))
      const unsectioned = offerings.filter(entry => unsectionedIds.has(entry.product.id)).map(entry => entry.product)
      screen.rows = [
        ...(wide && can_create ? [{ id: 'add-section', native: 'add-section', label: 'Add section', query: locationId ? { location_id: locationId } : {} }] : []),
        ...(wide && sections.filter(section => section.location_id === (locationId ?? null)).length > 1
          ? [{ id: 'menu-order', native: 'menu-order', label: 'Reorder sections', query: locationId ? { location_id: locationId } : {} }] : []),
        ...sections.map(section => ({
          id: section.id, label: section.name, image: mediaStillUrl(section.image), native: 'section',
          query: { section_id: section.id, ...(section.location_id ? { location_id: section.location_id } : {}) },
        })),
        ...unsectioned.map(dish => item(dish, locationId)),
      ]
    }
  } else {
    if (wide && can_create && query.native === '1') screen.rows.push({
      id: 'create-offering', label: 'Add offering', native: 'create-offering', query: {},
    })
    if ((kind === 'all' || kind === 'menu') && offers('menu')) {
      const hasSharedMenu = menu.some(section => section.location_id === null)
        || products.some(product => product.kind === 'dish' && !product.has_location)
      const menuLocations = location ? [location] : [...(hasSharedMenu || !locations.length ? [null] : []), ...locations]
      screen.rows.push(...menuLocations.map((place): CatalogRow => {
        const count = menu.filter(section => section.location_id === null || section.location_id === place?.id).length
        return {
          id: place ? `menu-${place.id}` : 'menu', label: place?.title ?? (locations.length ? 'Shared menu' : 'Menu'),
          eyebrow: place && place.status !== 'active' ? `Menu (${place.status})` : 'Menu',
          summary: `${count} ${count === 1 ? 'section' : 'sections'}`, image: place?.picture_url ?? null,
          to: `${base}/menu${place ? `?location_id=${encodeURIComponent(place.id)}` : ''}`,
          native: 'menu', query: place ? { location_id: place.id } : {},
        }
      }))
    }
    screen.rows.push(...offerings.map(({ product, internalName, image }) => ({
      ...item(product, location?.id, internalName), image: mediaStillUrl(image),
    })))
  }
  if (isMenu) {
    const dishRows = screen.rows.filter(row => row.native === 'offering')
    const images = new Map(offerings.map(entry => [entry.product.id, entry.image]))
    for (const row of dishRows) row.image = mediaStillUrl(images.get(row.id))
  }
  const layout = !isMenu && organization.vertical === 'lodging' && (kind === 'stay' || kind === 'all' && products.every(product => product.kind === 'stay')) ? 'listings' : 'catalog'
  const listing_context = organization.vertical === 'lodging' ? await data.listingContext(organization) : null
  return { screen, filters, kind, can_create, has_stays: offers('stay'), layout, listing_context }
}

export function prepareDashboardCatalog(scope: { organizationId: string | { sql: string }; assignedUserId?: OfferingReadScope }, query: Record<string, unknown>) {
  const kind = query.kind === undefined || query.kind === 'all' ? 'all' : kinds.find(item => item.value === query.kind)?.value
  if (!kind) throw new HTTPError({ statusCode: 400, message: 'Choose a valid catalog kind', data: { code: 'INVALID_CATALOG_FILTER', field: 'kind' } })
  const isMenu = query.view === 'menu' || query.view === 'section'
  const offeringRead = isMenu || kind !== 'menu' ? prepareCatalogOfferings({
    ...scope, kind: isMenu ? 'dish' : kind === 'all' ? undefined : kind as Product['kind'], includeDishes: isMenu,
    locationId: typeof query.location_id === 'string' ? query.location_id : undefined,
  }) : null
  const collectionRead = prepareCollectionList(scope)
  const locationRead = prepareDashboardLocations(scope.organizationId, scope.assignedUserId, true)
  const assignment = scope.assignedUserId ? assignedOfferingCondition(scope.assignedUserId) : null
  const org = typeof scope.organizationId === 'string' ? '?' : scope.organizationId.sql
  const homes = prepareDashboardStayHomes()
  const kitchenOrganization = `CASE WHEN ${roleMatchesSql(BATCH_VIEWER.role!, rolesAllowing({ menu: ['read'] }))} THEN ${BATCH_VIEWER.organization} END`
  const kitchenPlaces = `SELECT DISTINCT pl.location_id FROM product_locations pl JOIN products p ON p.organization_id = pl.organization_id AND p.id = pl.product_id
    WHERE pl.organization_id = ${kitchenOrganization} AND p.kind = 'table' AND ${listingGrantSql('pl.organization_id', 'pl.product_id', BATCH_VIEWER.member, 'task')}`
  const selected = typeof query.location_id === 'string' ? query.location_id : null
  const queries: BatchQuery[] = [
    { query: kitchenPlaces, params: [] },
    { query: `SELECT p.id, p.name, p.description FROM products p JOIN product_publications pub ON pub.product_id = p.id AND pub.organization_id = p.organization_id
      WHERE p.organization_id = ${kitchenOrganization} AND p.kind = 'dish' AND ${PUBLIC_PRODUCT_SQL}
        AND EXISTS (SELECT 1 FROM (${kitchenPlaces}) place WHERE (? IS NULL OR place.location_id = ?)
          AND (NOT EXISTS (SELECT 1 FROM product_locations pl WHERE pl.organization_id = p.organization_id AND pl.product_id = p.id)
            OR EXISTS (SELECT 1 FROM product_locations pl WHERE pl.organization_id = p.organization_id AND pl.product_id = p.id AND pl.location_id = place.location_id)))
      ORDER BY p.name, p.id`, params: [selected, selected] },
    { query: `
      SELECT p.id, p.kind,
        EXISTS (SELECT 1 FROM product_locations pl WHERE pl.organization_id = p.organization_id AND pl.product_id = p.id) AS has_location,
        EXISTS (SELECT 1 FROM product_locations pl WHERE pl.organization_id = p.organization_id AND pl.product_id = p.id AND pl.location_id = ?) AS at_location,
        (SELECT json_group_array(cp.collection_id) FROM collection_products cp WHERE cp.organization_id = p.organization_id AND cp.product_id = p.id) AS collection_ids
      FROM products p WHERE p.organization_id = ${org}${assignment ? ` AND (${assignment.unrestricted} OR (${assignment.sql}))` : ''}`,
    params: [typeof query.location_id === 'string' ? query.location_id : null, ...(typeof scope.organizationId === 'string' ? [scope.organizationId] : []), ...assignment?.params ?? []] },
    ...collectionRead.queries,
    ...locationRead.queries,
    ...offeringRead?.queries ?? [],
    ...homes.queries,
  ]
  return { queries, read }

  function read([kitchenLocationRows, kitchenDishRows, identityRows, ...catalogRows]: D1Result[], organizationId: string) {
    const identities = identityRows!.results as { id: string; kind: Product['kind']; has_location: number; at_location: number; collection_ids: string }[]
    const collections = collectionRead.read(catalogRows.slice(0, collectionRead.queries.length))
    const offeringStart = collectionRead.queries.length + locationRead.queries.length
    const { locations } = locationRead.read(catalogRows.slice(collectionRead.queries.length, offeringStart), organizationId)
    const offerings = offeringRead?.read(catalogRows.slice(offeringStart, offeringStart + offeringRead.queries.length)) ?? []
    return { identities, collections, locations, offerings,
      listingContext: (organization: DashboardOrganizationRow) => homes.read(catalogRows.slice(offeringStart + (offeringRead?.queries.length ?? 0)), organization),
      kitchenLocations: kitchenLocationRows!.results as Array<{ location_id: string }>,
      kitchenDishes: kitchenDishRows!.results as Array<{ id: string; name: string; description: string }> }
  }
}
