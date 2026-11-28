<template>
  <DashboardLeafPanel
    id="organization-strategy"
    :title="SERVICES.strategy.name"
    :footer="!!screen && (screen.can_end || screen.can_agree || next?.id === 'payment_method')"
    :saving="busy"
    :error="error || (servicesError ? getErrorMessage(servicesError, 'The service could not be loaded') : '')"
    :disabled="!services"
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
        <p class="font-semibold text-highlighted">On since {{ formatExactDateTime(services!.strategy!.since) }}</p>
        <p>{{ SERVICES.strategy.ending }}</p>
      </div>
      <template v-else-if="canUpdate">
        <div v-if="next" class="space-y-3 rounded-2xl border border-default p-5">
          <p class="text-sm text-toned">{{ next.detail }}</p>
          <UButton v-if="next.to" :to="next.to" :label="next.label" trailing-icon="i-lucide-arrow-right" />
        </div>
        <p v-else-if="screen?.can_agree" class="text-sm text-toned">{{ SERVICES.strategy.consent }}</p>
      </template>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import BillingServiceIntro from '~/components/dashboard/BillingServiceIntro.vue'
import { offer } from '~/shared/offers'
import { SERVICES, SERVICE_PRICES, formatPlanPrice, formatPlanRecurring } from '~/shared/billing-model'
import { isServices, useOrganizationServices } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'SEO and marketing strategy | Blawby', robots: 'noindex, nofollow' })

const serviceOffer = offer('strategy')
const dashboardApi = useDashboardApi()
const { formatExactDateTime } = useHumanTime()
const { openBillingPortal } = useOrganizationSubscription()
const { servicesResource, services, servicesError, refreshServices } = await useOrganizationServices('strategy')
const screen = computed(() => servicesResource.value?.screen)
const next = computed(() => screen.value?.next_action)
const canUpdate = computed(() => servicesResource.value?.can_update)
const on = computed(() => !!services.value?.strategy)
const priceLine = computed(() => services.value?.strategy
  ? formatPlanRecurring(services.value.strategy.amount, services.value.strategy.currency)
  : `${formatPlanPrice(SERVICE_PRICES.strategy.monthly)} per month, added to your plan and billed with it.`)

const busy = ref(false)
const error = ref('')
const success = ref('')
// One attempt per consent: a retried submit deduplicates at Stripe, a later consent does not.
let attempt = crypto.randomUUID()
async function addPaymentMethod() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try { await openBillingPortal() }
  catch (cause) { error.value = getErrorMessage(cause, 'Stripe’s billing portal could not be opened') }
  finally { busy.value = false }
}
async function toggle() {
  if (!services.value || busy.value) return
  busy.value = true
  error.value = ''
  success.value = ''
  try {
    const updated = await dashboardApi('/api/dashboard/services', { method: 'POST', body: { service: 'strategy', action: services.value.strategy ? 'end' : 'agree', attempt }, validate: isServices })
    servicesResource.value = updated
    attempt = crypto.randomUUID()
    await refreshServices()
    if (servicesError.value) throw new Error(`The service changed, but its current requirements could not be read. ${getErrorMessage(servicesError.value, 'Reopen the service before another change.')}`)
    success.value = updated.services.strategy ? 'The strategy service is on. Julia will be in touch to set up your weekly meeting and chat.' : 'The strategy service is off.'
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The strategy service could not be changed')
  } finally {
    busy.value = false
  }
}
</script>
