<template>
  <!--
    Shopify's Shipping and delivery: the zones each location ships to with the
    rates buyers choose from, and where buyers can collect. A Menu row; each row
    is a leaf beside this column.
  -->
  <DashboardIndexPanel id="organization-shipping" title="Shipping and pickup" :auto-open="firstRow">
    <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(error, 'Shipping could not be loaded')" />
    <p v-else-if="pending" role="status" class="text-muted">Loading shipping…</p>
    <EditorNavigationList v-else :groups="groups" :active-item="level.child.value === 'zones' ? String(route.params.zone_id ?? '') : level.child.value" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { formatMinorAmount } from '~/shared/prices'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Shipping and pickup | Blawby', robots: 'noindex, nofollow' })

const level = useRouteLevel()
const route = useRoute()
const { data, pending, error } = await useShippingSettings()
const to = (leaf: string) => `${level.path.value}/${leaf}`
const rateSummary = (zone: { rates: Array<{ name: string; amount: number; currency?: string }> }) => zone.rates.length
  ? zone.rates.map(rate => `${rate.name} ${rate.currency ? formatMinorAmount(rate.amount, rate.currency) : rate.amount}`).join(' · ') : 'No rates yet'
const groups = computed<EditorNavigationGroup[]>(() => {
  const settings = data.value
  if (!settings) return []
  return [
    ...settings.locations.map(location => ({
      id: `zones-${location.id}`, title: settings.locations.length > 1 ? `Ships from ${location.title}` : 'Shipping zones',
      items: [
        ...settings.zones.filter(zone => zone.location_id === location.id).map(zone => ({ id: zone.id, label: zone.name, icon: 'i-lucide-globe', summary: `${zone.countries.join(', ')} · ${rateSummary(zone)}`, to: to(`zones/${zone.id}`) })),
        { id: `new-${location.id}`, label: `Add zone for ${location.title}`, icon: 'i-lucide-plus', to: `${to('zones/new')}?location_id=${encodeURIComponent(location.id)}` },
      ],
    })),
    { id: 'pickup', title: 'Pickup', items: [{ id: 'pickup', label: 'Local pickup', icon: 'i-lucide-store',
      summary: settings.locations.filter(location => location.pickup_enabled).map(location => location.title).join(', ') || 'Off', to: to('pickup') }] },
  ]
})
// Opens a saved zone or pickup, never a blank Add form the owner did not ask for.
const firstRow = computed(() => groups.value.flatMap(group => group.items).find(item => !item.id.startsWith('new-'))?.to ?? null)
</script>
