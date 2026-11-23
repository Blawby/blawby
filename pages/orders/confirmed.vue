<template>
  <NuxtLayout :name="site.layout">
    <!-- The buyer's own order, opened by the confirmation link that names and signs it: one screen, as every checkout moment is. -->
    <CheckoutState v-bind="screen" :business="organization.name" />
  </NuxtLayout>
</template>

<script setup lang="ts">
// The buyer's own order, opened by the confirmation link that names and signs it.
import CheckoutState from '~/components/booking/CheckoutState.vue'
import { formatCalendarDate } from '~/utils/timezone'
import { publicApiRequest, isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: false })
useResponseHeader('cache-control').value = 'private, no-store'

interface BuyerOrder {
  number: number; status: string; ship_by: string | null; fulfilled_at: string | null; tracking_url: string | null; receipt_url: string | null; currency: string
  delivery_method: 'shipping' | 'pickup'; location_title: string; location_address?: string | null; shipping_rate_name: string | null; shipping_amount: number; total: number | null; carrier: string | null; tracking_number: string | null
  shipping_details: { name: string; address: { line1: string; line2: string | null; city: string | null; state: string | null; postal_code: string | null; country: string } } | null
  guest: { email: string | null } | null
  lines: Array<{ title: string; variant_title: string | null; quantity: number; unit_amount: number }>
}
const { locale, localePath, t } = useI18n()
const route = useRoute()
const { organization } = useTenantOrganization()
const { site } = organization
const order = ref<BuyerOrder | null>(null)
const pending = ref(true)
const loadError = ref<string | null>(null)
onMounted(async () => {
  const id = typeof route.query.id === 'string' ? route.query.id : ''
  try {
    if (id) order.value = await publicApiRequest<BuyerOrder>(`/api/public/orders/${encodeURIComponent(id)}`, {
      validate: (value): value is BuyerOrder => isRecord(value) && typeof value.number === 'number' && Array.isArray(value.lines),
      headers: { Authorization: `Bearer ${route.hash.slice(1)}` },
    })
  } catch (cause) {
    loadError.value = getErrorMessage(cause, t('booking.receipt_failed'))
  } finally {
    pending.value = false
  }
})
const day = (date: string) => formatCalendarDate(date, locale.value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const screen = computed<InstanceType<typeof CheckoutState>['$props']>(() => {
  const value = order.value
  if (pending.value) return { state: 'reviewing', live: true, title: t('checkout_state.reviewing'), help: t('checkout_state.keep_open') }
  if (!value) return { state: 'unavailable', title: t('payment.unavailable'), help: t('checkout_state.unavailable_help'), action: { label: t('checkout_state.back_to', { business: organization.name }), to: localePath('/'), quiet: true } }
  // A cancelled order says whether money was taken: a paid one was refunded in full, an unpaid one was never charged.
  if (value.status === 'cancelled') return { state: 'not_completed', title: t('email.subject.order_cancelled', { number: value.number }), help: t(value.receipt_url ? 'order.cancelled_refunded' : 'order.cancelled_unpaid') }
  const sent = value.fulfilled_at ? t(value.delivery_method === 'pickup' ? 'shop.order_collected' : 'shop.order_shipped')
    : value.ship_by ? `${t(value.delivery_method === 'pickup' ? 'order.ready_by' : 'order.ships_by')} ${day(value.ship_by)}` : null
  return { state: 'order_confirmed', title: t('checkout_state.order_confirmed', { number: value.number }), help: sent,
    action: value.tracking_url ? { label: t('order.track'), href: value.tracking_url } : value.receipt_url ? { label: t('checkout_state.view_order'), href: value.receipt_url, quiet: true } : null }
})
useSocialMetadata(() => ({ path: localePath('/orders/confirmed'), title: t('shop.checkout'), description: t('shop.checkout'), socialImage: null, discoverability: 'private' }))
</script>
