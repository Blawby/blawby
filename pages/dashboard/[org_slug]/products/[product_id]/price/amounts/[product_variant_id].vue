<template>
  <DashboardLeafPanel
    id="product-amount"
    :title="p.locationId.value ? priceLocation ? `Price at ${priceLocation.title}` : 'Price' : p.form.variants.length === 1 ? 'Price' : variant?.name ?? ''"
    :lead="p.locationId.value ? priceLocation ? `Set the price at ${priceLocation.title}.` : undefined : p.form.variants.length === 1 ? `Set an amount, or use price wording such as ${priceExample}. Leave both empty to show no price.` : undefined"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value || Boolean(priceScopeError)"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || priceScopeError || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save(level.to.value ?? undefined)"
  >
    <UButton v-if="p.saveError.value" label="Use saved details" color="neutral" variant="outline" :disabled="p.saving.value" class="mb-5" @click="p.revert()" />
    <div v-if="variant && !priceScopeError" class="space-y-5">
      <UFormField :label="`Amount (${p.currency})`">
        <UInput v-model="variant.price_major" inputmode="decimal" autofocus class="w-full" data-testid="product-price" />
      </UFormField>
      <!-- Something not booked can be sold as a membership: Stripe charges the amount again every period until it is cancelled. -->
      <UFormField v-if="billingChoices.length > 1" label="Charged" :description="variant.billing.type === 'recurring' ? 'Bought as a membership on your website, with no date to book. Stripe charges it again each period until the member or you cancel.' : undefined">
        <URadioGroup :model-value="billingKey(variant.billing)" :items="billingChoices" data-testid="product-price-billing" @update:model-value="value => variant!.billing = billingChoices.find(choice => choice.value === value)!.billing" />
      </UFormField>
      <UFormField v-if="p.form.kind !== 'stay' && p.form.variants.length === 1" :label="p.locationId.value ? 'Price wording (all locations)' : 'Price wording'" hint="Optional">
        <UInput :model-value="p.textValue(priceWording)" :placeholder="priceExample" class="w-full" @update:model-value="p.setDetail(priceWording, $event)" />
      </UFormField>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { PRODUCT_DETAIL_FIELDS } from '~/shared/product-details'
import { MEMBERSHIP_KINDS, billingCadence } from '~/shared/memberships'
import type { PriceBilling } from '~/shared/prices'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const route = useRoute()
const level = useRouteLevel()
const variant = computed(() => p.form.variants.find(entry => entry.id === String(route.params.product_variant_id)) ?? null)
const priceLocation = computed(() => p.allOrganizationLocations.value.find(location => location.id === p.locationId.value) ?? null)
const priceScopeError = computed(() => p.locationId.value ? p.organizationLocationsError.value || (!priceLocation.value ? 'The price location could not be loaded.' : '') : '')
const priceExample = computed(() => p.form.kind === 'dish' ? 'Market price' : 'Price on request')
const priceWording = PRODUCT_DETAIL_FIELDS.find(field => field.key === 'pricing_note')!

// Only an offering taken with no booking — an experience, practice area or restaurant offer — can be a membership; a booked one is paid once per booking.
const billingKey = (billing: PriceBilling) => billing.type === 'one_time' ? 'one_time' : `${billing.interval}:${billing.interval_count}`
const billingChoices = computed(() => {
  const product = p.product.value
  if (!product || !variant.value || product.booking || product.order_url || !(MEMBERSHIP_KINDS as readonly string[]).includes(product.kind)) return []
  const choices: Array<{ value: string; label: string; billing: PriceBilling }> = [
    { value: 'one_time', label: 'Once', billing: { type: 'one_time' } },
    { value: 'month:1', label: 'Every month', billing: { type: 'recurring', interval: 'month', interval_count: 1 } },
  ]
  const loaded = variant.value.loaded_billing
  if (!choices.some(choice => choice.value === billingKey(loaded)) && loaded.type === 'recurring') {
    choices.push({ value: billingKey(loaded), label: `Every ${billingCadence({ recurring_interval: loaded.interval, recurring_interval_count: loaded.interval_count })}`, billing: loaded })
  }
  return choices
})

watchEffect(() => {
  if (p.product.value && !p.loadError.value && !variant.value) showError(createError({ statusCode: 404, statusMessage: 'Price not found' }))
})
</script>
