<template>
  <p v-if="failure" role="alert" class="tenant-container py-4 text-error">{{ failure }}</p>
  <TenantFeaturedContent v-if="!recentlyViewed || items.length" :data="featured" :data-recently-viewed="recentlyViewed ? true : undefined" />
</template>

<script setup lang="ts">
import type { PublicTenantPage } from '~/server/utils/public-tenant-pages'
import type { TenantPageBlock } from '~/utils/tenant-page-blocks'
import { blockText, blockRecords } from '~/utils/tenant-page-block-data'
import { presentationForProduct, productCtaKey, resolveProductPresentation } from '~/utils/product-presentation'
import { assertProductKind } from '~/shared/product-details'
import { resolveSocialImageUrl } from '~/utils/social-metadata'
import { getVerticalCopy } from '~/utils/vertical-copy'
import { publicApiRequest, isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'
import { readAnalyticsConsent } from '~/utils/zaraz-consent'

const props = defineProps<{ block?: TenantPageBlock; page?: PublicTenantPage; recentlyViewed?: boolean; excludeProductId?: string }>()
if (!props.block && !props.recentlyViewed) throw new Error('A product grid requires its block or the recently viewed source')
const data = computed(() => props.block?.data ?? {})
const recentlyViewed = computed(() => props.recentlyViewed || data.value.source === 'recently_viewed')
const { locale, t } = useI18n()
const { organization } = useTenantOrganization()

const homeCopy = computed(() => getVerticalCopy(organization.vertical, locale.value))
const brandName = organization.name
const cart = useCart(organization.id)
const consented = ref(false)
const exclude = computed(() => props.excludeProductId ?? props.page?.product_id)
const key = computed(() => `recently-viewed:${organization.id}:${locale.value}:${exclude.value ?? ''}:${Boolean(recentlyViewed.value)}:${consented.value}:${JSON.stringify(cart.lines.value)}`)
const response = useAsyncData(key, (_app, { signal }) => {
  if (!recentlyViewed.value || !consented.value) return Promise.resolve({ items: [] as Record<string, unknown>[] })
  return publicApiRequest('/api/public/products', {
    signal,
    query: { recently_viewed: 'true', locale: locale.value, ...(exclude.value ? { exclude_product_id: exclude.value } : {}) },
    validate: (value): value is { items: Record<string, unknown>[] } => isRecord(value) && Array.isArray(value.items)
      && value.items.every(item => isRecord(item) && typeof item.id === 'string' && typeof item.title === 'string' && typeof item.url === 'string' && typeof item.kind === 'string'),
  })
}, { server: false, immediate: false, dedupe: 'defer', default: () => ({ items: [] as Record<string, unknown>[] }) })
const personalized = computed(() => consented.value ? response.data.value.items : [])
const failure = computed(() => consented.value && response.error.value ? getErrorMessage(response.error.value, t('shop.recently_viewed_failed')) : '')
function refresh() {
  consented.value = readAnalyticsConsent(document.cookie) === 'accepted'
  if (!recentlyViewed.value || !consented.value) response.clear()
  else void response.execute({ dedupe: 'defer' })
}
onMounted(() => {
  document.addEventListener('zarazConsentAPIReady', refresh)
  document.addEventListener('zarazConsentChoicesUpdated', refresh)
  watch([recentlyViewed, locale, () => JSON.stringify(cart.lines.value), exclude], refresh, { immediate: true })
})
onBeforeUnmount(() => {
  document.removeEventListener('zarazConsentAPIReady', refresh)
  document.removeEventListener('zarazConsentChoicesUpdated', refresh)
})

const items = computed(() => (recentlyViewed.value ? personalized.value : blockRecords(data.value.items)).map((item) => {
  const media = blockRecords(item.media)[0] ?? null
  const url = blockText(item.url)
  return {
    kind: blockText(item.kind),
    name: blockText(item.title),
    description: blockText(item.description),
    price: blockText(item.value) || null,
    compareAtPrice: blockText(item.compare_at) || null,
    image: resolveSocialImageUrl(media && {
      kind: blockText(media.kind) || null,
      public_url: blockText(media.public_url) || null,
      thumbnail_url: blockText(media.thumbnail_url) || null,
    }),
    alt: blockText(media?.alt_text) || blockText(item.title),
    href: url || null,
    ctaText: item.cart_recovery === true ? t('shop.checkout') : t(productCtaKey(blockText(item.kind))),
    unavailable: item.unavailable === true,
    featured: item.featured === true,
    category: blockText(item.category) || null,
  }
}).filter(item => item.name))

const presentation = computed(() => {
  const first = items.value[0]
  return first && items.value.every(item => item.kind === first.kind)
    ? presentationForProduct({ kind: assertProductKind(first.kind) }, organization.theme_id)
    : resolveProductPresentation(organization.vertical)
})
const allExperiences = computed(() => items.value.length > 0 && items.value.every(item => item.kind === 'experience'))
const allFeatured = computed(() => items.value.length > 0 && items.value.every(item => item.featured))
const featured = computed(() => ({
  items: items.value,
  kicker: blockText(data.value.description)
    || (recentlyViewed.value ? t('shop.continue_shopping') : allExperiences.value ? homeCopy.value.experiencesPageTitle : presentation.value?.locationCollectionSegment === 'menu' ? t('site.footer.menu') : t('site.footer.products')),
  heading: blockText(data.value.title)
    || (recentlyViewed.value ? t('shop.recently_viewed') : allFeatured.value ? t('site.posts.featured') : allExperiences.value ? t('site.experiences.collection_title', { organization: brandName }) : presentation.value?.locationCollectionSegment === 'menu' ? t('site.footer.menu') : t('site.products.collection_title', { organization: brandName })),
  linkTarget: recentlyViewed.value ? null : presentation.value?.collectionPath ?? null,
}))
</script>
