<template>
  <!--
    A second listing's price against its home's. Opened through useOverlay;
    closes with the adjustment to save, or undefined when cancelled.
  -->
  <DashboardListItemDialog :title="listing" save-label="Save" :save-disabled="!valid" @update:open="open => { if (!open) emit('close', undefined) }" @save="save">
    <p class="text-sm text-muted">This listing sells the home’s calendar. Its price follows the home’s price, changed by what you set here.</p>
    <UFormField label="Price">
      <USelect v-model="kind" :items="kinds" class="w-full" />
    </UFormField>
    <UFormField v-if="kind !== 'home'" :label="kind.startsWith('percent') ? 'Percent' : `Amount (${currency})`">
      <UInput v-model="value" inputmode="decimal" class="w-full" />
    </UFormField>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { majorAmountToMinor } from '~/shared/prices'
import { currencyFractionDigits, type CurrencyCode } from '~/shared/currencies'

export interface ListingPriceAdjustment { price_adjustment_type: 'percent' | 'amount' | null; price_adjustment: number | null }

const props = defineProps<{ listing: string; currency: CurrencyCode; adjustment: ListingPriceAdjustment }>()
const emit = defineEmits<{ close: [adjustment: ListingPriceAdjustment | undefined] }>()

type Kind = 'home' | 'percent_up' | 'percent_down' | 'amount_up' | 'amount_down'
const kinds: Array<{ label: string; value: Kind }> = [
  { label: 'Same as the home', value: 'home' },
  { label: 'Home price plus a percent', value: 'percent_up' },
  { label: 'Home price minus a percent', value: 'percent_down' },
  { label: 'Home price plus an amount', value: 'amount_up' },
  { label: 'Home price minus an amount', value: 'amount_down' },
]
const { price_adjustment_type: currentType, price_adjustment: currentValue } = props.adjustment
const current = currentValue ?? 0
const kind = ref<Kind>(currentType === null ? 'home' : `${currentType}_${current > 0 ? 'up' : 'down'}` as Kind)
const value = ref(currentType === 'amount'
  ? (Math.abs(current) / 10 ** currencyFractionDigits(props.currency)).toFixed(currencyFractionDigits(props.currency))
  : currentType === 'percent' ? String(Math.abs(current)) : '')

const chosen = computed<ListingPriceAdjustment | null>(() => {
  if (kind.value === 'home') return { price_adjustment_type: null, price_adjustment: null }
  const sign = kind.value.endsWith('_up') ? 1 : -1
  const text = value.value.trim()
  if (kind.value.startsWith('percent')) {
    if (!/^\d+$/.test(text) || Number(text) === 0 || (sign < 0 && Number(text) >= 100) || Number(text) > 1000) return null
    return { price_adjustment_type: 'percent', price_adjustment: sign * Number(text) }
  }
  const digits = currencyFractionDigits(props.currency)
  if (!new RegExp(digits === 0 ? '^(?:0|[1-9]\\d*)$' : `^(?:0|[1-9]\\d*)(?:\\.\\d{1,${digits}})?$`).test(text)) return null
  const minor = majorAmountToMinor(text, props.currency)
  return minor > 0 ? { price_adjustment_type: 'amount', price_adjustment: sign * minor } : null
})
const valid = computed(() => chosen.value !== null)
function save() {
  if (chosen.value) emit('close', chosen.value)
}
</script>
