<template>
  <!-- Shopify's local pickup: buyers collect an order free at a location that offers its items. -->
  <DashboardLeafPanel id="shipping-pickup" title="Local pickup" lead="Buyers can choose free pickup at these locations." :footer="false">
    <UAlert v-if="saveError" color="error" variant="soft" :description="saveError" class="mb-4" />
    <SettingRow v-for="location in locations" :key="location.id" :model-value="location.pickup_enabled" :label="location.title" :disabled="saving !== null" @update:model-value="value => setPickup(location.id, value)" />
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Local pickup | Blawby', robots: 'noindex, nofollow' })

const dashboardApi = useDashboardApi()
const { data, refresh } = await useShippingSettings()
const locations = computed(() => data.value?.locations ?? [])
const saving = ref<string | null>(null)
const saveError = ref('')
async function setPickup(locationId: string, value: boolean) {
  saving.value = locationId
  saveError.value = ''
  try {
    await dashboardApi('/api/dashboard/shipping/pickup', { method: 'PUT', body: { location_id: locationId, pickup_enabled: value }, validate: (body): body is { success: true } => isRecord(body) && body.success === true })
    await refresh()
  } catch (cause) {
    saveError.value = getErrorMessage(cause, 'Pickup could not be saved')
  } finally {
    saving.value = null
  }
}
</script>
