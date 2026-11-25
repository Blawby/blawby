<template>
  <NuxtLayout :name="site.layout">
    <!-- A cart that cannot go on to payment is the whole screen, as every stopped checkout is. -->
    <CheckoutState v-if="stopped" v-bind="stopped" :business="organization.name" />
    <div v-else class="tenant-container py-12 sm:py-16">
      <h1 class="tenant-display text-3xl sm:text-4xl text-default">{{ t('shop.cart') }}</h1>
      <div v-if="!cart.lines.value.length" class="mt-8 space-y-4">
        <p class="text-muted">{{ t('shop.cart_empty') }}</p>
        <NuxtLink :to="localePath('/products')" class="text-sm font-semibold text-default underline">{{ t('shop.continue_shopping') }}</NuxtLink>
      </div>
      <div v-else-if="quote" class="mt-8 grid min-w-0 gap-10 lg:grid-cols-12">
        <form class="min-w-0 space-y-8 lg:col-span-7" @submit.prevent="checkout">
          <section class="space-y-3">
            <h2 class="text-lg font-semibold text-default">{{ t('shop.delivery') }}</h2>
            <div class="grid grid-cols-2 gap-3">
              <button v-if="quote.ship_to_countries.length" type="button" class="rounded-xl p-4 text-left ring-1" :class="method === 'shipping' ? 'ring-2 ring-[var(--ui-text-highlighted)]' : 'ring-default'" :aria-pressed="method === 'shipping'" :aria-label="t('shop.ship')" @click="method = 'shipping'">
                <span class="block font-medium text-default">{{ t('shop.ship') }}</span>
              </button>
              <button v-if="quote.pickup_locations.length" type="button" class="rounded-xl p-4 text-left ring-1" :class="method === 'pickup' ? 'ring-2 ring-[var(--ui-text-highlighted)]' : 'ring-default'" :aria-pressed="method === 'pickup'" :aria-label="t('shop.pickup_free', { place: quote.pickup_locations[0]!.title })" @click="method = 'pickup'">
                <span class="block font-medium text-default">{{ t('shop.pickup') }}</span>
                <span class="block text-sm text-muted">{{ t('shop.pickup_free', { place: quote.pickup_locations[0]!.title }) }}</span>
                <span v-if="quote.pickup_locations[0]!.address" class="block text-sm text-muted">{{ quote.pickup_locations[0]!.address }}</span>
              </button>
            </div>
            <p v-if="method === 'pickup' && rateError" class="text-sm text-error">{{ rateError }}</p>
          </section>

          <section v-if="method === 'shipping'" class="space-y-3">
            <h2 class="text-lg font-semibold text-default">{{ t('shop.shipping_address') }}</h2>
            <p v-if="!countries.length" class="text-sm text-muted">{{ t('shop.no_shipping') }}</p>
            <UFormField v-else :label="t('shop.country')"><CountrySelect v-model="address.country" :items="countries" class="w-full" /></UFormField>
            <UFormField :label="t('shop.recipient_name')"><UInput v-model="recipient" autocomplete="shipping name" class="w-full" /></UFormField>
            <UFormField :label="t('shop.address_line1')"><UInput v-model="address.line1" autocomplete="address-line1" class="w-full" /></UFormField>
            <UFormField :label="t('shop.address_line2')"><UInput v-model="address.line2" autocomplete="address-line2" class="w-full" /></UFormField>
            <div class="grid grid-cols-2 gap-3">
              <UFormField :label="t('shop.city')"><UInput v-model="address.city" autocomplete="address-level2" class="w-full" /></UFormField>
              <UFormField :label="t('shop.postal_code')"><UInput v-model="address.postal_code" autocomplete="postal-code" class="w-full" /></UFormField>
            </div>
            <UFormField :label="t('shop.state')"><UInput v-model="address.state" autocomplete="address-level1" class="w-full" /></UFormField>
            <p v-if="rateError" class="text-sm text-error">{{ rateError }}</p>
            <div v-else-if="deliveryQuote" class="space-y-2">
              <h3 class="text-sm font-semibold text-default">{{ t('shop.shipping_method') }}</h3>
              <button v-for="rate in deliveryQuote.shipping_rates" :key="rate.id" type="button" class="flex w-full justify-between rounded-xl p-4 text-left ring-1" :class="rateId === rate.id ? 'ring-2 ring-[var(--ui-text-highlighted)]' : 'ring-default'" :aria-pressed="rateId === rate.id" @click="rateId = rate.id">
                <span><span class="block font-medium text-default">{{ rate.name }}</span><span v-if="rate.delivery_days_min !== null" class="block text-sm text-muted">{{ t('shop.arrives_in', { days: rate.delivery_days_max && rate.delivery_days_max !== rate.delivery_days_min ? `${rate.delivery_days_min}–${rate.delivery_days_max}` : rate.delivery_days_min }) }}</span></span>
                <span class="font-medium text-default">{{ money(rate.amount) }}</span>
              </button>
            </div>
          </section>

          <section class="space-y-3">
            <h2 class="text-lg font-semibold text-default">{{ t('shop.your_details') }}</h2>
            <UFormField :label="t('forms.name')"><UInput v-model="guest.name" autocomplete="name" class="w-full" /></UFormField>
            <UFormField :label="t('forms.email')"><UInput v-model="guest.email" type="email" autocomplete="email" class="w-full" /></UFormField>
            <UFormField :label="t('forms.phone')"><UInput v-model="guest.phone" type="tel" autocomplete="tel" class="w-full" /></UFormField>
            <UFormField :label="t('shop.note')"><UTextarea v-model="note" :rows="3" class="w-full" /></UFormField>
          </section>
          <TenantButton type="submit" class="w-full" :disabled="!ready || submitting">{{ t('shop.continue_to_payment') }}</TenantButton>
          <!-- What still stops the order, said on the page rather than left to the browser. -->
          <p v-if="missing.length" class="text-sm text-muted">{{ t('shop.still_needed', { fields: missing.join(', ') }) }}</p>
        </form>

        <!-- On a phone the order and its total come before the form and its button. -->
        <aside class="order-first min-w-0 h-fit space-y-4 rounded-2xl bg-elevated p-4 sm:p-6 lg:order-last lg:col-span-5">
          <div v-for="line in (deliveryQuote ?? quote).lines" :key="line.product_variant_id" class="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2">
            <img v-if="line.image_url" :src="line.image_url" alt="" class="size-14 shrink-0 rounded-xl object-cover">
            <div class="min-w-0 col-start-2">
              <p class="break-words font-medium text-default">{{ line.title }}</p>
              <p v-if="line.variant_title" class="break-words text-sm text-muted">{{ line.variant_title }}</p>
              <p class="text-sm text-muted">{{ lineStock(line) }}</p>
              <p class="mt-1 font-medium text-default">{{ money(line.amount) }}</p>
            </div>
            <div class="col-span-2 flex flex-wrap items-center gap-3">
              <UInputNumber :model-value="line.quantity" :min="1" :max="99" :focus-on-change="false" class="w-40 shrink-0" :disabled="submitting" :aria-label="t('shop.quantity')" @update:model-value="value => cart.set(line.product_variant_id, value ?? 1)" />
              <button type="button" class="min-h-11 text-sm text-muted underline" :disabled="submitting" @click="cart.set(line.product_variant_id, 0)">{{ t('shop.remove') }}</button>
            </div>
          </div>
          <div class="space-y-2 border-t border-default pt-4 text-sm">
            <div class="flex justify-between"><span>{{ t('shop.subtotal') }}</span><span>{{ money(summary.subtotal) }}</span></div>
            <div v-if="method === 'shipping' && chosenRate" class="flex justify-between"><span>{{ t('shop.shipping') }}</span><span>{{ money(chosenRate.amount) }}</span></div>
            <div v-else-if="method === 'pickup' && deliveryQuote" class="flex justify-between"><span>{{ t('shop.pickup') }}</span><span>{{ t('shop.free') }}</span></div>
            <div class="flex justify-between pt-2 text-base font-semibold text-default"><span>{{ t('shop.total') }}</span><span>{{ money(summary.subtotal + (method === 'shipping' ? chosenRate?.amount ?? 0 : 0)) }}</span></div>
            <p v-if="summary.ship_by" class="text-muted">{{ t(method === 'pickup' ? 'order.ready_by' : 'order.ships_by') }} {{ formatCalendarDate(summary.ship_by, locale, { weekday: 'short', month: 'short', day: 'numeric' }) }}</p>
            <p class="text-muted">{{ t('shop.taxes_at_payment') }}</p>
          </div>
        </aside>
      </div>
    </div>
  </NuxtLayout>
</template>

<script setup lang="ts">
import { formatMinorAmount } from '~/shared/prices'
import { formatCalendarDate } from '~/utils/timezone'
import { ApiClientError, publicApiMutation, isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'
import CheckoutState from '~/components/booking/CheckoutState.vue'
import type { OrderQuote } from '~/server/domain/goods'

definePageMeta({ layout: false })
useResponseHeader('cache-control').value = 'private, no-store'

const { t, locale, localePath } = useI18n()
const { organization } = useTenantOrganization()
const { site } = organization
const cart = useCart(organization.id)

const isQuote = (value: unknown): value is OrderQuote => isRecord(value) && Array.isArray(value.lines) && typeof value.subtotal === 'number'
const money = (amount: number) => quote.value ? formatMinorAmount(amount, quote.value.currency, locale.value) : ''

const quote = ref<OrderQuote | null>(null)
const quoteFailure = ref<{ message: string; product_variant_id: string | null } | null>(null)
/** Nothing was paid yet, so a cart that stops says so: the item it cannot sell (with the way to take it out), or why checkout did not start. */
const stopped = computed<InstanceType<typeof CheckoutState>['$props'] | null>(() => {
  if (cart.lines.value.length && quoteFailure.value) {
    const variantId = quoteFailure.value.product_variant_id
    return { state: 'not_completed', title: t('checkout_state.not_completed'), help: quoteFailure.value.message,
      action: variantId ? { label: t('shop.remove'), quiet: true, onClick: () => cart.set(variantId, 0) } : null }
  }
  if (submitError.value) return { state: 'not_completed', title: t('checkout_state.not_completed'), help: `${submitError.value} ${t('checkout_state.not_charged')}`, action: { label: t('checkout_state.try_again'), onClick: () => { submitError.value = '' } } }
  return null
})
// Only the newest request's answer is shown: an earlier cart's quote can arrive after a later one.
let priceRequest = 0
async function price() {
  const request = ++priceRequest
  quoteFailure.value = null
  if (!cart.lines.value.length) { quote.value = null; return }
  try {
    const next = await publicApiMutation('/api/public/orders/quote', { method: 'POST', body: { lines: cart.lines.value }, validate: isQuote })
    if (request === priceRequest) quote.value = next
  } catch (cause) {
    if (request !== priceRequest) return
    quote.value = null
    // The item the quote names (the error's data), else the one added last, whose arrival made the cart unsellable together.
    const detail = cause instanceof ApiClientError && isRecord(cause.data.data) ? cause.data.data : {}
    const variantId = typeof detail.product_variant_id === 'string' ? detail.product_variant_id : cart.lines.value.at(-1)?.product_variant_id ?? null
    quoteFailure.value = { message: getErrorMessage(cause, t('shop.cart')), product_variant_id: variantId }
  }
}
// Priced in the browser only: the cart is the buyer's cookie, and the server's first render and the browser's must match.
onMounted(() => watch(() => JSON.stringify(cart.lines.value), price, { immediate: true }))
// A line can be part from stock and part made to order: both are said, not the second alone.
function lineStock(line: OrderQuote['lines'][number]) {
  const made = line.made_to_order_quantity
  if (made && made < line.quantity) return t('shop.partly_made_to_order', { stock: line.quantity - made, made })
  if (made) return t('shop.made_to_order')
  return line.available !== null ? t('shop.in_stock', { count: line.available }) : ''
}

const method = ref<'shipping' | 'pickup'>('shipping')
watch(quote, value => { if (value && !value.ship_to_countries.length && value.pickup_locations.length) method.value = 'pickup' })
const address = reactive({ country: '', line1: '', line2: '', city: '', state: '', postal_code: '' })
const countries = computed(() => {
  const names = new Intl.DisplayNames([locale.value], { type: 'region' })
  return (quote.value?.ship_to_countries ?? []).map(code => ({ code, name: names.of(code) ?? code })).sort((a, b) => a.name.localeCompare(b.name))
})
watch(countries, list => { if (!address.country && list.length === 1) address.country = list[0]!.code }, { immediate: true })
const deliveryQuote = ref<OrderQuote | null>(null)
const rateError = ref('')
const rateId = ref<string | null>(null)
const chosenRate = computed(() => deliveryQuote.value?.shipping_rates.find(rate => rate.id === rateId.value) ?? null)
// The cart priced for the chosen delivery: shipping at the location that ships to the buyer, pickup at the studio collected from.
// Either may price the items differently from the first location offering them, and checkout charges this price.
let deliveryRequest = 0
const pickupLocationId = computed(() => quote.value?.pickup_locations[0]?.id ?? null)
watch([() => address.country, () => JSON.stringify(cart.lines.value), method, pickupLocationId], async () => {
  const request = ++deliveryRequest
  deliveryQuote.value = null
  rateId.value = null
  rateError.value = ''
  if (!cart.lines.value.length) return
  const delivery = method.value === 'pickup' ? (pickupLocationId.value ? { method: 'pickup', location_id: pickupLocationId.value } : null)
    : address.country ? { method: 'shipping', country: address.country } : null
  if (!delivery) return
  try {
    const next = await publicApiMutation('/api/public/orders/quote', { method: 'POST', body: { lines: cart.lines.value, delivery }, validate: isQuote })
    if (request !== deliveryRequest) return
    deliveryQuote.value = next
    rateId.value = next.shipping_rates[0]?.id ?? null
  } catch (cause) { if (request === deliveryRequest) rateError.value = getErrorMessage(cause, t(method.value === 'pickup' ? 'shop.cart' : 'shop.no_shipping')) }
})
const summary = computed(() => deliveryQuote.value ?? quote.value!)

const guest = reactive({ name: '', email: '', phone: '' })
const recipient = ref('')
const note = ref('')
const missing = computed(() => [
  ...(guest.name.trim() ? [] : [t('forms.name')]),
  ...(/^[^\s@]+@[^\s@]+$/u.test(guest.email.trim()) ? [] : [t('forms.email')]),
  ...(method.value === 'shipping' ? [
    ...(address.country ? [] : [t('shop.country')]),
    ...(recipient.value.trim() ? [] : [t('shop.recipient_name')]),
    ...(address.line1.trim() ? [] : [t('shop.address_line1')]),
    ...(address.country && !chosenRate.value && !rateError.value ? [t('shop.shipping_method')] : []),
  ] : []),
])
const ready = computed(() => !missing.value.length
  && (method.value === 'pickup' ? deliveryQuote.value?.delivery_method === 'pickup' : Boolean(chosenRate.value)))
const submitting = ref(false)
const submitError = ref('')
const requestKey = ref<string | null>(null)
async function checkout() {
  if (!ready.value || !quote.value) return
  submitting.value = true
  submitError.value = ''
  requestKey.value ??= crypto.randomUUID()
  try {
    const delivery = method.value === 'pickup'
      ? { method: 'pickup', location_id: quote.value.pickup_locations[0]!.id }
      : { method: 'shipping', country: address.country, shipping_rate_id: rateId.value }
    const response = await publicApiMutation('/api/public/orders', {
      method: 'POST',
      body: {
        lines: cart.lines.value, delivery, note: note.value.trim() || null, idempotency_key: requestKey.value,
        guest_name: guest.name.trim(), guest_email: guest.email.trim(), guest_phone: guest.phone.trim() || null,
        shipping_details: method.value === 'shipping' ? { name: recipient.value.trim(), phone: guest.phone.trim() || null, address: { ...address, line2: address.line2 || null, city: address.city || null, state: address.state || null, postal_code: address.postal_code || null } } : undefined,
      },
      validate: (value): value is { pay_path: string; purchase_claim: string } => isRecord(value) && typeof value.pay_path === 'string' && value.pay_path.startsWith('/pay/') && typeof value.purchase_claim === 'string',
    })
    cart.clear()
    await navigateTo({ path: response.pay_path, hash: `#${response.purchase_claim}` })
  } catch (cause) {
    submitError.value = getErrorMessage(cause, t('shop.checkout'))
    requestKey.value = null
  } finally {
    submitting.value = false
  }
}

useSocialMetadata(() => ({ path: localePath('/cart'), title: t('shop.cart'), description: t('shop.cart'), socialImage: null, discoverability: 'private' }))
</script>
