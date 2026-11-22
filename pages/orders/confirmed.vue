<template>
  <NuxtLayout :name="site.layout">
  <div class="min-h-screen bg-default text-default">
    <div v-if="pending" class="flex min-h-screen items-center justify-center">
      <TenantIcon name="arrow-path" class="size-12 animate-spin text-muted" />
    </div>
    <BookingConfirmation
      v-else-if="order"
      :kicker="order.fulfilled_at ? t(order.delivery_method === 'pickup' ? 'shop.order_collected' : 'shop.order_shipped') : t('reservations.confirmed')"
      :cancelled="order.status === 'cancelled'"
      :item-title="order.lines[0]?.title ?? organization.name"
      :item-subtitle="organization.name"
      :image-url="null"
      :receipt-rows="receiptRows"
      :next-steps="[]"
      next-steps-kicker=""
      :guest-email="order.guest?.email ?? null"
    >
      <template #title>{{ order.status === 'cancelled' ? t('email.subject.order_cancelled', { number: order.number }) : t('shop.order_confirmed', { number: order.number }) }}</template>
      <template #subtitle>{{ order.status !== 'cancelled' && order.ship_by ? `${t(order.delivery_method === 'pickup' ? 'order.ready_by' : 'order.ships_by')} ${day(order.ship_by)}` : '' }}</template>
      <template #actions>
        <TenantButton v-if="order.tracking_url" :href="order.tracking_url" variant="outline" target="_blank" rel="noopener noreferrer">{{ t('order.track') }}</TenantButton>
        <TenantButton v-if="order.receipt_url" :href="order.receipt_url" variant="outline" target="_blank" rel="noopener noreferrer">{{ t('shop.receipt') }}</TenantButton>
      </template>
    </BookingConfirmation>
    <div v-else class="mx-auto max-w-xl px-4 pt-24 pb-24 text-center sm:px-6 lg:px-8">
      <TenantIcon name="exclamation-triangle" class="mx-auto size-12 text-error" />
      <h2 class="mt-6 text-xl font-bold">{{ t(loadError ? 'booking.receipt_failed' : 'booking.receipt_missing') }}</h2>
      <p v-if="loadError" class="mt-2 text-muted">{{ loadError }}</p>
      <TenantButton :to="localePath('/')" variant="soft" class="mt-10">{{ t('site_pages.home') }}</TenantButton>
    </div>
  </div>
  </NuxtLayout>
</template>

<script setup lang="ts">
// The buyer's own order, opened by the confirmation link that names and signs it.
import BookingConfirmation from '~/components/booking/BookingConfirmation.vue'
import { formatMinorAmount } from '~/shared/prices'
import { formatCalendarDate } from '~/utils/timezone'
import { publicApiRequest, isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: false })
useResponseHeader('cache-control').value = 'private, no-store'

interface BuyerOrder {
  number: number; status: string; ship_by: string | null; fulfilled_at: string | null; tracking_url: string | null; receipt_url: string | null; currency: string
  delivery_method: 'shipping' | 'pickup'; location_title: string; shipping_rate_name: string | null; shipping_amount: number; total: number | null; carrier: string | null; tracking_number: string | null
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
const money = (amount: number) => formatMinorAmount(amount, order.value!.currency, locale.value)
const receiptRows = computed(() => {
  const value = order.value
  if (!value) return []
  const address = value.shipping_details ? [value.shipping_details.name, value.shipping_details.address.line1, value.shipping_details.address.line2,
    [value.shipping_details.address.postal_code, value.shipping_details.address.city].filter(Boolean).join(' '), value.shipping_details.address.state, value.shipping_details.address.country].filter(Boolean).join(', ') : null
  return [
    ...value.lines.map(line => ({ label: `${line.title}${line.variant_title ? ` · ${line.variant_title}` : ''} × ${line.quantity}`, value: money(line.unit_amount * line.quantity) })),
    ...(value.delivery_method === 'shipping' ? [{ label: `${t('shop.shipping')} · ${value.shipping_rate_name}`, value: money(value.shipping_amount) }] : []),
    ...(value.total !== null ? [{ label: t('payment.paid'), value: money(value.total) }] : []),
    ...(address ? [{ label: t('order.ship_to'), value: address, wide: true }] : [{ label: t('order.pickup_at'), value: value.location_title }]),
    ...(value.carrier ? [{ label: t('order.carrier'), value: [value.carrier, value.tracking_number].filter(Boolean).join(' · ') }] : []),
  ]
})
useSocialMetadata(() => ({ path: localePath('/orders/confirmed'), title: t('shop.checkout'), description: t('shop.checkout'), socialImage: null, discoverability: 'private' }))
</script>
