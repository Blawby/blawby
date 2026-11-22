<template>
  <DashboardIndexPanel id="product-publication" :title="draftStay ? 'Complete steps to publish' : isStay ? 'Listing status' : p.sectionLabels.publication" column="leaf">
    <UAlert v-if="p.loadError.value || p.saveError.value" color="error" variant="soft" :description="p.loadError.value || p.saveError.value || ''" class="mb-6" />
    <EditorNavigationList v-if="p.product.value && !p.loadError.value" :groups="groups" :active-item="level.child.value" :variant="isStay ? 'cards' : 'rows'" />
    <!-- The page people are sent to, as text they can read and select, with Open and Copy. -->
    <section v-for="link in p.publicLinks.value" :key="link.key" class="mt-8 space-y-2" data-testid="product-public-link">
      <h2 class="text-sm font-semibold text-highlighted">{{ link.label ? `Link · ${link.label}` : 'Link' }}</h2>
      <p class="select-all break-all rounded-lg bg-elevated px-3 py-2 text-sm">{{ link.url }}</p>
      <div class="flex gap-2">
        <UButton :to="link.url" target="_blank" rel="noopener noreferrer" label="Open" icon="i-lucide-external-link" color="neutral" variant="soft" />
        <UButton :label="copied === link.key ? 'Copied' : 'Copy'" icon="i-lucide-copy" color="neutral" variant="soft" @click="copy(link)" />
      </div>
      <p v-if="copyFailed === link.key" role="alert" class="text-sm text-error">Copy failed: select the link</p>
    </section>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const level = useRouteLevel()
const route = useRoute()
const isStay = computed(() => p.product.value?.kind === 'stay')
const legal = computed(() => p.product.value?.kind === 'service')
const copied = ref<string | null>(null)
const copyFailed = ref<string | null>(null)
// A browser that refuses the clipboard says so beside the link, which stays selectable.
async function copy(link: { key: string; url: string }) {
  copyFailed.value = null
  try {
    await navigator.clipboard.writeText(link.url)
    copied.value = link.key
  } catch {
    copyFailed.value = link.key
  }
}
const draftStay = computed(() => isStay.value && !p.published.value && !p.product.value?.stay?.live)
const groups = computed(() => draftStay.value ? [{ id: 'requirements', items: [
  {
    id: 'price', label: 'Nightly price',
    summary: p.stayHasNightlyPrice.value ? 'Nightly price set' : 'Required to publish',
    mark: p.stayHasNightlyPrice.value ? 'met' as const : 'open' as const,
    to: p.sectionPath('price'),
  },
  {
    id: 'host', label: 'Host profile',
    summary: p.stayHostProfilePublished.value ? 'Profile published' : 'Required to publish',
    mark: p.stayHostProfilePublished.value ? 'met' as const : 'open' as const,
    to: p.product.value?.stay?.assigned_member_id
      ? `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/team/${encodeURIComponent(p.product.value.stay.assigned_member_id)}/profile`
      : p.sectionPath('team'),
  },
  ...(p.stayHasNightlyPrice.value && p.stayHostProfilePublished.value ? [{ id: 'visibility', label: 'Publish listing', summary: 'Show on your website', to: p.sectionPath('publication/visibility') }] : []),
] }] : [{ id: 'website', items: [
  ...(p.managesCatalog.value ? [{ id: 'visibility', label: isStay.value ? 'Listing status' : 'Show on website', summary: isStay.value ? (p.published.value ? 'Listed · Visible on your website' : 'Unlisted · Hidden from your website') : p.published.value ? `Visible to ${legal.value ? 'clients' : 'customers'}` : `Hidden from ${legal.value ? 'clients' : 'customers'}`, status: isStay.value ? (p.published.value ? 'success' as const : 'neutral' as const) : undefined, to: p.sectionPath('publication/visibility') }] : []),
  ...(!legal.value || p.product.value?.booking ? [{ id: 'availability', label: legal.value ? 'Accept consultation requests' : p.bookingOffering.value ? 'Accept bookings' : 'Accept orders', summary: legal.value ? p.product.value?.active ? 'Accepting consultation requests' : 'Consultation requests paused' : p.product.value?.active ? (p.bookingOffering.value ? 'Accepting new bookings' : 'Accepting new orders') : (p.bookingOffering.value ? 'Bookings paused' : 'Orders paused'), to: p.sectionPath('publication/availability') }] : []),
] }])
</script>
