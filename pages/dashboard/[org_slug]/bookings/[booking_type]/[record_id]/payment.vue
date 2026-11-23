<template>
  <!-- Money the host received or refunded outside Blawby, recorded on the stay. Nothing moves. -->
  <DashboardLeafPanel
    id="booking-payment"
    title="Record a payment"
    lead="Money you received or refunded outside Blawby. Recording it moves no money."
    :saving="saving"
    :disabled="!draft.amount.trim() || !draft.paid_on || (months !== null && !draft.period_start)"
    save-label="Record payment"
    :error="failure"
    @save="record"
  >
    <UFormField v-if="months" label="For" required>
      <USelect v-model="draft.period_start" :items="months" class="w-full" @update:model-value="fillOutstanding" />
    </UFormField>
    <UFormField :label="`Amount (${b.stayPayment.currency.value ?? ''})`" description="Negative for a refund." required>
      <UInput v-model="draft.amount" inputmode="decimal" class="w-full" />
    </UFormField>
    <UFormField label="Method" required>
      <USelect v-model="draft.method" :items="methods" class="w-full" />
    </UFormField>
    <UFormField label="Date" required>
      <UInput v-model="draft.paid_on" type="date" class="w-full" />
    </UFormField>
    <UFormField label="Reference">
      <UInput v-model="draft.reference" class="w-full" />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { bookingEditorKey } from '~/components/dashboard/BookingDetails.vue'
import { STAY_PAYMENT_METHOD_LABELS, type StayPaymentMethod } from '~/shared/bookings'
import { getErrorMessage } from '~/utils/errors'
import { isCurrencyCode } from '~/shared/currencies'
import { formatMinorAmount, minorAmountToMajor } from '~/shared/prices'
import { formatCalendarDate } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })

const b = inject(bookingEditorKey)!
const level = useRouteLevel()
const methods = Object.entries(STAY_PAYMENT_METHOD_LABELS).map(([value, label]) => ({ value, label }))
const draft = reactive({ amount: '', method: 'cash' as StayPaymentMethod, paid_on: b.stayPayment.today(), reference: '', period_start: '', idempotency_key: crypto.randomUUID() })
const currency = computed(() => {
  const code = b.stayPayment.currency.value
  return code && isCurrencyCode(code) ? code : null
})
/** A stay paid monthly: each month with what is left of it; the receipt opens on the first one not paid. */
const months = computed(() => {
  const periods = b.stayPayment.months.value
  if (!periods || !currency.value) return null
  return [...periods.map(period => ({
    value: period.period_start,
    label: `${formatCalendarDate(period.period_start, 'en')} · ${formatMinorAmount(Math.max(period.amount_minor - period.paid_minor, 0), currency.value!)} left`,
  })),
  // One transfer covering several months, as Baselane and Zillow's rent ledgers take it: it pays the oldest months first.
  { value: WHOLE_STAY, label: `Whole stay, oldest months first · ${formatMinorAmount(outstanding(periods), currency.value)} left` }]
})
const WHOLE_STAY = 'whole-stay'
const outstanding = (periods: NonNullable<typeof b.stayPayment.months.value>) => periods.reduce((sum, period) => sum + Math.max(period.amount_minor - period.paid_minor, 0), 0)
function fillOutstanding(start: string) {
  const periods = b.stayPayment.months.value
  if (!periods || !currency.value) return
  if (start === WHOLE_STAY) { draft.amount = minorAmountToMajor(outstanding(periods), currency.value); return }
  const period = periods.find(entry => entry.period_start === start)
  if (period) draft.amount = minorAmountToMajor(Math.max(period.amount_minor - period.paid_minor, 0), currency.value)
}
const firstOpen = b.stayPayment.months.value?.find(period => period.status !== 'paid')
if (firstOpen) {
  draft.period_start = firstOpen.period_start
  fillOutstanding(firstOpen.period_start)
}
const saving = ref(false)
const failure = ref('')

async function record() {
  if (saving.value) return
  saving.value = true
  failure.value = ''
  try {
    // A receipt for the whole stay names no month; the ledger applies it to the oldest months first.
    await b.stayPayment.record({ ...draft, period_start: draft.period_start === WHOLE_STAY ? '' : draft.period_start })
    await navigateTo(level.to.value ?? level.path.value)
  } catch (cause) {
    failure.value = getErrorMessage(cause, 'The payment could not be recorded')
  } finally {
    saving.value = false
  }
}
</script>
