import { businessChanged } from '~/composables/useDashboardInvalidations'
import { computed, type Ref } from 'vue'
import type { Collection, CatalogProduct } from '~/server/types/products'
import { groupProductsByCollection } from '~/utils/product-presentation'
import { getErrorMessage } from '~/utils/errors'
import { ApiClientError } from '~/utils/api-clients'

export type CatalogCollection = Collection & { product_count: number; dish_count: number }

export function useProductCatalog(organizationId: string, locationId: Ref<string | null>, immediate = true) {
  const dashboardApi = useDashboardApi()
  const realtime = useDashboardInvalidations()
  type Catalog = { collections: CatalogCollection[]; products: CatalogProduct[] }
  const key = `product-catalog:${organizationId}`
  const load = useWebsiteIndexData(
    key,
    signal => dashboardApi(`/api/editor/organizations/${organizationId}/products`, {
      signal,
      query: { include: 'collections' },
      validate: (value: unknown): value is Catalog => isRecord(value) && Array.isArray(value.collections) && Array.isArray(value.products),
    }),
    { immediate, lazy: true },
  )
  const { data, pending, error } = load
  function updateReads(project: (current: Catalog) => Catalog) {
    if (!data.value) return
    const updated = project(data.value)
    data.value = updated
    const held = realtime.held.begin(`website:${key}`, businessChanged)
    realtime.held.hold(held, updated, Date.now() + 30_000, 16)
  }

  const collections = computed(() => data.value?.collections ?? [])
  const products = computed(() => (data.value?.products ?? []).filter(product =>
    !locationId.value || product.locations.some(location => location.location_id === locationId.value)))

  // Every projection shares Nuxt's entry, including its initial failure state.
  async function refresh() {
    await load.refresh()
    if (error.value) throw error.value
  }

  /** Membership always reads the complete organization catalog, regardless of price scope. */
  function collectionProductIds(collectionId: string): string[] {
    if (error.value) throw error.value
    if (!data.value) throw new Error('The catalog has not been loaded')
    if (!data.value.collections.some(collection => collection.id === collectionId)) throw new Error('This section no longer exists.')
    return groupProductsByCollection(data.value.products, data.value.collections).find(group => group.id === collectionId)?.products.map(product => product.id) ?? []
  }

  async function setCollectionProducts(collectionId: string, productIds: string[], expected: string[], move?: { collection_id: string; expected_product_ids: string[] }) {
    const before = data.value
    const { memberships } = await dashboardApi(`/api/editor/organizations/${organizationId}/collections/${collectionId}/products`, {
      method: 'PUT', body: { product_ids: productIds, expected_product_ids: expected, ...(move ? { move_to: move } : {}) },
      validate: (value: unknown): value is { success: true; memberships: { collection_id: string; product_ids: string[] }[] } =>
        isRecord(value) && value.success === true && Array.isArray(value.memberships) && value.memberships.every(membership =>
          isRecord(membership) && typeof membership.collection_id === 'string' && Array.isArray(membership.product_ids)
          && membership.product_ids.every(id => typeof id === 'string')),
    }).catch(async (failure: unknown) => {
      if (failure instanceof ApiClientError && failure.statusCode === 409) {
        try { await refresh() } catch (error) {
          throw new Error(`${failure.message} ${getErrorMessage(error, 'The current section could not be read.')}`, { cause: error })
        }
      }
      throw failure
    })
    if (!before || data.value !== before) {
      await refresh()
      return
    }
    const positions = new Map(memberships.map(({ collection_id, product_ids }) => [collection_id, new Map(product_ids.map((id, index) => [id, index]))]))
    const kinds = new Map(before.products.map(product => [product.id, product.kind]))
    updateReads(current => ({
      collections: current.collections.map(row => {
        const ids = positions.get(row.id)
        return ids ? { ...row, product_count: ids.size, dish_count: [...ids.keys()].filter(id => kinds.get(id) === 'dish').length } : row
      }),
      products: current.products.map(product => ({
        ...product,
        collections: product.collections.filter(membership => !positions.has(membership.collection_id)).concat(
          [...positions].flatMap(([collection_id, order]) => {
            const sort_order = order.get(product.id)
            return sort_order === undefined ? [] : [{ collection_id, sort_order }]
          }),
        ),
      })),
    }))
  }

  function applyProduct(product: CatalogProduct) {
    updateReads(current => {
      const previous = current.products.find(row => row.id === product.id)
      if (!previous) return current
      return {
        collections: current.collections.map(collection => {
          const delta = Number(product.collections.some(row => row.collection_id === collection.id))
            - Number(previous.collections.some(row => row.collection_id === collection.id))
          return { ...collection, product_count: collection.product_count + delta,
            dish_count: collection.dish_count
              + Number(product.kind === 'dish' && product.collections.some(row => row.collection_id === collection.id))
              - Number(previous.kind === 'dish' && previous.collections.some(row => row.collection_id === collection.id)) }
        }),
        products: current.products.map(row => row.id === product.id ? product : row),
      }
    })
  }

  function applyCollections(replacements: readonly Collection[], remove?: string) {
    updateReads(current => {
      const collections = new Map(current.collections.map(row => [row.id, row]))
      if (remove) collections.delete(remove)
      for (const row of replacements) {
        collections.set(row.id, { product_count: 0, dish_count: 0, ...collections.get(row.id), ...row })
      }
      return {
        collections: [...collections.values()].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
        products: remove ? current.products.map(product => ({ ...product, collections: product.collections.filter(row => row.collection_id !== remove) })) : current.products,
      }
    })
  }

  return { load, applyProduct, applyCollections, collections, products, pending, error, refresh, collectionProductIds, setCollectionProducts }
}
