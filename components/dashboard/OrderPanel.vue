<template>
  <!--
    The order a buyer's conversation is about, as Shopify's order page shows
    it: what was bought, where it goes and by when, what was paid, and the one
    action left — mark it shipped with its tracking, or collected.
  -->
  <UCard variant="subtle" class="mx-4 mb-3" :ui="{ body: 'space-y-4' }">
    <UAlert v-if="error" color="error" variant="soft" :description="error" />
    <p v-if="!order && !error" role="status" class="text-sm text-muted">Loading order…</p>
    <template v-if="order">
      <div class="flex items-start justify-between gap-4">
        <div>
          <p class="text-base font-semibold text-highlighted">Order #{{ order.number }}</p>
          <p class="text-sm text-muted">{{ statusLine }}</p>
        </div>
        <span class="text-base font-semibold text-highlighted">{{ money(paid) }}</span>
      </div>
      <ul class="space-y-1 text-sm">
        <li v-for="line in order.lines" :key="line.id" class="flex justify-between gap-4">
          <span class="text-highlighted">{{ line.title }}<span v-if="line.variant_title" class="text-muted"> · {{ line.variant_title }}</span> × {{ line.quantity }}<span v-if="line.made_to_order_quantity" class="text-muted"> · {{ line.made_to_order_quantity }} made to order</span></span>
          <span>{{ money(line.unit_amount * line.quantity) }}</span>
        </li>
        <li v-if="order.delivery_method === 'shipping'" class="flex justify-between gap-4 text-muted"><span>Shipping · {{ order.shipping_rate_name }}</span><span>{{ money(order.shipping_amount) }}</span></li>
      </ul>
      <p v-if="address" class="whitespace-pre-line text-sm"><span class="font-medium text-highlighted">Ship to</span>{{ '\n' + address }}</p>
      <p v-else class="text-sm"><span class="font-medium text-highlighted">Pickup at</span> {{ order.location_title }}</p>
      <p v-if="order.fulfilled_at" class="text-sm text-muted">{{ fulfilledLine }}</p>
      <form v-else-if="order.status === 'paid'" class="space-y-3" @submit.prevent="fulfil">
        <template v-if="order.delivery_method === 'shipping'">
          <UInput v-model="carrier" placeholder="Carrier, such as Thailand Post EMS" aria-label="Carrier" class="w-full" />
          <UInput v-model="tracking" placeholder="Tracking number" aria-label="Tracking number" class="w-full" />
          <UInput v-model="trackingUrl" placeholder="Tracking link (optional)" aria-label="Tracking link" class="w-full" />
        </template>
        <UButton type="submit" size="xl" block :loading="saving" :disabled="order.delivery_method === 'shipping' && !carrier.trim()">
          {{ order.delivery_method === 'shipping' ? 'Mark as shipped' : 'Mark as collected' }}
        </UButton>
      </form>
    </template>
  </UCard>
</template>

<script setup lang="ts">
import { formatMinorAmount } from '~/shared/prices'
import { formatCalendarDate } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'

interface Order {
  id: string; number: number; status: string; location_title: string; delivery_method: 'shipping' | 'pickup'
  shipping_details: { name: string; phone: string | null; address: { line1: string; line2: string | null; city: string | null; state: string | null; postal_code: string | null; country: string } } | null
  shipping_rate_name: string | null; shipping_amount: number; currency: string; subtotal_amount: number; ship_by: string | null
  carrier: string | null; tracking_number: string | null; tracking_url: string | null; fulfilled_at: string | null
  payment: { captured_amount: number; refunded_amount: number } | null
  lines: Array<{ id: string; title: string; variant_title: string | null; quantity: number; unit_amount: number; made_to_order_quantity: number }>
}
const props = defineProps<{ conversationId: string }>()
const emit = defineEmits<{ fulfilled: [] }>()
const dashboardApi = useDashboardApi()
const order = ref<Order | null>(null)
const error = ref('')
const isOrder = (value: unknown): value is { order: Order | null } => isRecord(value) && (value.order === null || isRecord(value.order))
async function load() {
  error.value = ''
  try {
    order.value = (await dashboardApi('/api/dashboard/orders', { query: { conversation_id: props.conversationId }, validate: isOrder })).order
    if (!order.value) error.value = 'This order could not be found'
  } catch (cause) { error.value = getErrorMessage(cause, 'The order could not be loaded') }
}
await load()

const money = (amount: number) => order.value ? formatMinorAmount(amount, order.value.currency) : ''
const paid = computed(() => order.value?.payment ? order.value.payment.captured_amount - order.value.payment.refunded_amount : order.value?.subtotal_amount ?? 0)
const day = (date: string) => formatCalendarDate(date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })
const statusLine = computed(() => {
  const current = order.value
  if (!current) return ''
  if (current.status === 'cancelled') return 'Cancelled'
  if (current.fulfilled_at) return current.delivery_method === 'shipping' ? 'Shipped' : 'Collected'
  return ['Paid', current.ship_by ? `${current.delivery_method === 'shipping' ? 'Ship' : 'Ready'} by ${day(current.ship_by)}` : null].filter(Boolean).join(' · ')
})
const address = computed(() => {
  const details = order.value?.shipping_details
  if (!details) return null
  const place = details.address
  return [details.name, place.line1, place.line2, [place.postal_code, place.city].filter(Boolean).join(' '), place.state, place.country, details.phone].filter(Boolean).join('\n')
})
const fulfilledLine = computed(() => {
  const current = order.value
  if (!current?.fulfilled_at) return ''
  return current.delivery_method === 'shipping'
    ? ['Shipped', current.carrier, current.tracking_number].filter(Boolean).join(' · ')
    : 'Collected'
})

const carrier = ref('')
const tracking = ref('')
const trackingUrl = ref('')
const saving = ref(false)
async function fulfil() {
  if (!order.value) return
  saving.value = true
  error.value = ''
  try {
    const saved = await dashboardApi(`/api/dashboard/orders/${encodeURIComponent(order.value.id)}/fulfill`, {
      method: 'POST', body: { carrier: carrier.value.trim() || null, tracking_number: tracking.value.trim() || null, tracking_url: trackingUrl.value.trim() || null },
      validate: (value): value is { order: Order } => isRecord(value) && isRecord(value.order),
    })
    order.value = saved.order
    emit('fulfilled')
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The order could not be updated')
  } finally {
    saving.value = false
  }
}
</script>
