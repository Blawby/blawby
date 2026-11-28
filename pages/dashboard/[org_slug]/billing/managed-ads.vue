<template>
  <DashboardLeafPanel
    id="organization-managed-ads"
    :title="SERVICES.managed_ads.name"
    :footer="!!screen && (screen.can_end || screen.can_agree || next?.id === 'payment_method')"
    :saving="busy"
    :disabled="!services"
    :error="error || (servicesError ? getErrorMessage(servicesError, 'The service could not be loaded') : '')"
    :save-label="on ? 'Turn off' : next?.id === 'payment_method' ? next.label : 'Agree and turn on'"
    @save="next?.id === 'payment_method' && !on ? addPaymentMethod() : toggle()"
  >
    <div v-if="services && screen" class="mx-auto max-w-2xl space-y-6 pb-6">
      <UAlert v-if="success" color="success" variant="soft" icon="i-lucide-circle-check" :description="success" />
      <BillingServiceIntro :offer="serviceOffer" :price="priceLine" />
      <p v-if="canUpdate === false" class="text-sm text-muted">Owners turn services on and off.</p>
      <ul v-if="screen" class="space-y-2 text-sm text-toned">
        <li v-for="requirement in screen.requirements" :key="requirement.id" class="flex items-center gap-2">
          <UIcon :name="requirement.met ? 'i-lucide-circle-check' : 'i-lucide-circle'" class="size-4" />{{ requirement.label }}
        </li>
      </ul>
      <div v-if="on" class="space-y-3 rounded-2xl border border-default p-5 text-sm text-toned">
        <p class="font-semibold text-highlighted">On since {{ formatExactDateTime(services!.managed_ads!.agreed_at) }}</p>
        <p>{{ SERVICES.managed_ads.ending }}</p>
      </div>
      <template v-else-if="canUpdate">
        <div v-if="next" class="space-y-3 rounded-2xl border border-default p-5">
          <p class="text-sm text-toned">{{ next.detail }}</p>
          <UButton v-if="next.to" :to="next.to" :label="next.label" trailing-icon="i-lucide-arrow-right" />
        </div>
        <p v-else-if="met" class="text-sm text-toned">{{ SERVICES.managed_ads.consent }}</p>
      </template>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import BillingServiceIntro from '~/components/dashboard/BillingServiceIntro.vue'
import { offer } from '~/shared/offers'
import { SERVICES } from '~/shared/billing-model'
import { isServices, useOrganizationServices } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Managed ads | Blawby', robots: 'noindex, nofollow' })


const route = useRoute()
const serviceOffer = offer('managed_ads')
const dashboardApi = useDashboardApi()
const { openBillingPortal } = useOrganizationSubscription()
const { formatExactDateTime } = useHumanTime()
const { servicesResource, services, refreshServices, servicesError } = await useOrganizationServices('managed_ads')
const screen = computed(() => servicesResource.value?.screen)
const canUpdate = computed(() => servicesResource.value?.can_update)
const on = computed(() => !!services.value?.managed_ads)
const met = computed(() => screen.value?.can_agree)
const priceLine = `${SERVICES.managed_ads.price[0]!.toUpperCase()}${SERVICES.managed_ads.price.slice(1)}, added to your plan's invoice.`
const next = computed(() => screen.value?.next_action)
const busy = ref(false)
const error = ref('')
const success = ref('')
async function addPaymentMethod() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await openBillingPortal()
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Stripe’s billing portal could not be opened')
  } finally {
    busy.value = false
  }
}
async function toggle() {
  if (!services.value || busy.value) return
  busy.value = true
  error.value = ''
  success.value = ''
  try {
    const updated = await dashboardApi('/api/dashboard/services', { method: 'POST', body: { service: 'managed_ads', action: services.value.managed_ads ? 'end' : 'agree' }, validate: isServices })
    servicesResource.value = updated
    clearNuxtData(`dashboard-integrations:${String(route.params.org_slug)}`)
    await refreshServices()
    if (servicesError.value) {
      // Nuxt records refresh errors instead of rejecting. Keep the actual write
      // result visible, and report the failed independent read before success.
      servicesResource.value = updated
      throw new Error(`Managed ads was turned ${updated.services.managed_ads ? 'on' : 'off'}, but its status could not be refreshed. ${getErrorMessage(servicesError.value, 'Reload to check its status.')}`)
    }
    success.value = updated.services.managed_ads ? 'Managed ads is on. Chris will be in touch to set up your weekly meeting.' : 'Managed ads is off.'
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Managed ads could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
