<template>
  <!--
    The order a buyer's conversation is about, as Shopify's order page shows
    it: what was bought, where it goes and by when, what was paid, and the one
    action left — mark it shipped with its tracking, or collected. It folds to
    its one-line summary so the conversation stays in reach on a short screen.
  -->
  <UAlert v-if="!order" color="error" variant="soft" :description="error" class="shrink-0" />
  <UCollapsible v-else v-model:open="open" class="shrink-0 rounded-lg bg-elevated/50 ring ring-default">
    <button type="button" class="flex w-full items-center justify-between gap-4 p-4 text-left">
      <span class="min-w-0">
        <span class="block text-base font-semibold text-highlighted">Order #{{ order.number }}</span>
        <span class="block truncate text-sm text-muted">{{ statusLine }}<template v-if="order.fulfilled_at">{{ ' ' }}<NuxtTime :datetime="order.fulfilled_at" locale="en" weekday="short" month="short" day="numeric" /></template></span>
      </span>
      <span class="flex shrink-0 items-center gap-2">
        <span class="text-base font-semibold text-highlighted">{{ money(total) }}</span>
        <UIcon name="i-lucide-chevron-down" class="size-5 text-muted transition-transform" :class="open ? 'rotate-180' : undefined" />
      </span>
    </button>
    <template #content>
      <div class="max-h-[45dvh] space-y-4 overflow-y-auto px-4 pb-4">
        <UAlert v-if="error" color="error" variant="soft" :description="error" />
        <ul class="space-y-1 text-sm">
          <li v-for="line in order.lines" :key="line.id" class="flex justify-between gap-4">
            <span class="text-highlighted">{{ line.title }}<span v-if="line.variant_title" class="text-muted"> · {{ line.variant_title }}</span> × {{ line.quantity }}<span v-if="line.made_to_order_quantity" class="text-muted"> · {{ line.made_to_order_quantity }} made to order</span></span>
            <span>{{ money(line.unit_amount * line.quantity) }}</span>
          </li>
          <li v-if="order.delivery_method === 'shipping'" class="flex justify-between gap-4 text-muted"><span>Shipping · {{ order.shipping_rate_name }}</span><span>{{ money(order.shipping_amount) }}</span></li>
          <li v-if="order.payment?.refunded_amount" class="flex justify-between gap-4 font-medium text-highlighted"><span>Refunded</span><span>−{{ money(order.payment.refunded_amount) }}</span></li>
        </ul>
        <p v-if="address" class="whitespace-pre-line text-sm"><span class="font-medium text-highlighted">Ship to</span>{{ '\n' + address }}</p>
        <p v-else class="text-sm"><span class="font-medium text-highlighted">Pickup at</span> {{ order.location_title }}<template v-if="order.location_address"><br><span class="text-muted">{{ order.location_address }}</span></template></p>
        <p v-if="order.fulfilled_at && order.delivery_method === 'shipping'" class="text-sm text-muted">
          {{ order.carrier }}<template v-if="order.tracking_number"> · <a v-if="order.tracking_url" :href="order.tracking_url" target="_blank" rel="noopener noreferrer" class="font-medium text-highlighted underline">{{ order.tracking_number }}</a><template v-else>{{ order.tracking_number }}</template></template>
        </p>
        <form v-else-if="!order.fulfilled_at && order.status === 'paid'" class="space-y-3" @submit.prevent="fulfil">
          <template v-if="order.delivery_method === 'shipping'">
            <UFormField :error="fieldErrors.carrier">
              <UInput v-model="carrier" placeholder="Carrier, such as Thailand Post EMS" aria-label="Carrier" class="w-full" @update:model-value="fieldErrors.carrier = undefined" />
            </UFormField>
            <UFormField :error="fieldErrors.tracking_number">
              <UInput v-model="tracking" placeholder="Tracking number" aria-label="Tracking number" class="w-full" @update:model-value="fieldErrors.tracking_number = undefined" />
            </UFormField>
            <UFormField :error="fieldErrors.tracking_url">
              <UInput v-model="trackingUrl" inputmode="url" placeholder="Tracking link (optional)" aria-label="Tracking link" class="w-full" @update:model-value="fieldErrors.tracking_url = undefined" />
            </UFormField>
          </template>
          <UButton type="submit" size="xl" block :loading="saving" :disabled="order.delivery_method === 'shipping' && !carrier.trim()">
            {{ order.delivery_method === 'shipping' ? 'Mark as shipped' : 'Mark as collected' }}
          </UButton>
        </form>
        <div v-if="order.payment && !paymentPage" class="border-t border-default pt-2">
          <a v-if="order.payment.receipt_url" :href="order.payment.receipt_url" target="_blank" rel="noopener noreferrer" class="flex items-center gap-3 py-2 text-sm font-medium text-highlighted">
            <UIcon name="i-lucide-receipt" class="size-4 shrink-0" /><span class="min-w-0 flex-1">Get receipt</span><UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-muted" />
          </a>
          <NuxtLink :to="paymentPath" class="flex items-center gap-3 py-2 text-sm font-medium text-highlighted">
            <UIcon name="i-lucide-undo-2" class="size-4 shrink-0" /><span class="min-w-0 flex-1">Payment and refunds</span><UIcon name="i-lucide-chevron-right" class="size-4 shrink-0 text-muted" />
          </NuxtLink>
        </div>
      </div>
    </template>
  </UCollapsible>
</template>

<script setup lang="ts">
import { formatMinorAmount } from '~/shared/prices'
import { shippingAddressLines } from '~/shared/goods'
import { formatCalendarDate } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import { ApiClientError, isRecord } from '~/utils/api-clients'

interface Order {
  id: string; number: number; status: string; location_title: string; location_address: string | null; delivery_method: 'shipping' | 'pickup'
  shipping_details: { name: string; phone: string | null; address: { line1: string; line2: string | null; city: string | null; state: string | null; postal_code: string | null; country: string } } | null
  shipping_rate_name: string | null; shipping_amount: number; currency: string; subtotal_amount: number; ship_by: string | null
  carrier: string | null; tracking_number: string | null; tracking_url: string | null; fulfilled_at: string | null
  payment: { id: string; captured_amount: number; refunded_amount: number; receipt_url: string | null } | null
  lines: Array<{ id: string; title: string; variant_title: string | null; quantity: number; unit_amount: number; made_to_order_quantity: number }>
}
// On its payment page the order opens in full and leaves the receipt and refund to that page.
const props = defineProps<{ conversationId: string; paymentPage?: boolean }>()
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
// In a conversation it is open while there is something left to do; a shipped, collected or cancelled order folds to its summary line.
const open = ref(props.paymentPage || Boolean(order.value && order.value.status === 'paid' && !order.value.fulfilled_at))
const route = useRoute()
const paymentPath = computed(() => order.value?.payment ? `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/bookings/payment/${encodeURIComponent(order.value.payment.id)}` : '')

const money = (amount: number) => order.value ? formatMinorAmount(amount, order.value.currency) : ''
// The order's total, as the Transactions row shows it; a refund is said beneath it, never netted into it.
const total = computed(() => order.value?.payment?.captured_amount || ((order.value?.subtotal_amount ?? 0) + (order.value?.shipping_amount ?? 0)))
const day = (date: string) => formatCalendarDate(date, 'en', { weekday: 'short', month: 'short', day: 'numeric' })
const statusLine = computed(() => {
  const current = order.value
  if (!current) return ''
  if (current.status === 'cancelled') return ['Cancelled', current.payment?.refunded_amount ? `Refunded ${money(current.payment.refunded_amount)}` : null].filter(Boolean).join(' · ')
  if (current.fulfilled_at) return current.delivery_method === 'shipping' ? 'Shipped' : 'Collected'
  return ['Paid', current.ship_by ? `${current.delivery_method === 'shipping' ? 'Ship' : 'Ready'} by ${day(current.ship_by)}` : null].filter(Boolean).join(' · ')
})
const address = computed(() => {
  const details = order.value?.shipping_details
  if (!details) return null
  return [...shippingAddressLines(details), details.phone].filter(Boolean).join('\n')
})

const carrier = ref('')
const tracking = ref('')
const trackingUrl = ref('')
const saving = ref(false)
// A field the server refused is said under that field until it is edited.
const fieldErrors = reactive<Partial<Record<'carrier' | 'tracking_number' | 'tracking_url', string>>>({})
async function fulfil() {
  if (!order.value) return
  // Checked here in the page's own words; the browser's "Please enter a URL." says nothing about https.
  if (trackingUrl.value.trim() && !/^https:\/\/[^\s/]+\.[^\s]+$/u.test(trackingUrl.value.trim())) {
    fieldErrors.tracking_url = 'Enter a tracking link that starts with https://'
    return
  }
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
    const field = cause instanceof ApiClientError && cause.code === 'VALIDATION_ERROR' && isRecord(cause.data.data) ? cause.data.data.field : null
    const message = getErrorMessage(cause, 'The order could not be updated')
    if (field === 'carrier' || field === 'tracking_number' || field === 'tracking_url') fieldErrors[field] = message
    else error.value = message
  } finally {
    saving.value = false
  }
}
</script>
