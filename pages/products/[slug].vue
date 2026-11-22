<template>
  <NuxtLayout :name="site.layout">
    <ProductDetailPage :key="`${detail.product.id}:${detail.location?.id ?? 'online'}`" :organization-id="organizationId" :vertical="detail.vertical" :product="detail.product" :location="detail.location" :organization-name="detail.organization_name" :reviews="detail.reviews" :booking="detail.booking" :sessions="detail.sessions" :collection-name="detail.collection_name" :collection-siblings="detail.collection_siblings" :currency="detail.currency" :presentation="presentation" :scope-required="detail.scope_required" :locations="detail.locations" :online-available="detail.online_available" :stay-checkout-available="detail.stay_checkout_available" :stay-confirmation-mode="detail.stay_confirmation_mode" />
  </NuxtLayout>
</template>

<script setup lang="ts">
// A physical item's page is the site's own on every vertical and theme, wherever it is stocked.
import ProductDetailPage from '~/components/products/ProductDetailPage.vue'
import { ITEM_PRESENTATION } from '~/utils/product-presentation'
import { composeProductSeoDescription } from '~/utils/product-seo'

definePageMeta({ layout: false })
const { site } = useTenantOrganization().organization
const resolved = await usePublicProductDetail('products')
const organizationId = resolved.organizationId
const detail = computed(() => resolved.detail.value)
const presentation = ITEM_PRESENTATION
const { t } = useI18n()
const priceSelection = computed(() => ({ currency: detail.value.currency, location_id: detail.value.location?.id ?? null, at: new Date().toISOString() }))
useSocialMetadata(() => ({
  path: presentation.productPath('', detail.value.product.slug),
  title: detail.value.product.name,
  description: composeProductSeoDescription({
    product: detail.value.product,
    locationTitle: detail.value.location?.title ?? detail.value.organization_name,
    priceSelection: priceSelection.value,
  }, t),
  socialImage: detail.value.product.social_image,
  breadcrumbs: [
    { name: 'Products', url: '/products' },
    { name: detail.value.product.name, url: presentation.productPath('', detail.value.product.slug) },
  ],
}))
</script>
