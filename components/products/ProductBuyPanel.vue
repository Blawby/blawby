<template>
  <!--
    A physical item's buy box, as Shopify's product form: one choice per option,
    what is in stock or made to order, the quantity, and Add to cart.
  -->
  <div class="space-y-6">
    <fieldset v-for="(option, index) in product.options" :key="option.name" class="space-y-2">
      <legend class="text-sm text-muted">{{ option.name }}</legend>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="value in option.values" :key="value" type="button"
          class="rounded-full px-5 py-2 text-sm ring-1 transition"
          :class="[chosen[index] === value ? 'bg-[var(--site-action)] text-[var(--site-on-action,#fff)] ring-[var(--site-action)]' : 'ring-default text-default hover:ring-[var(--site-action)]', unavailable(index, value) ? 'line-through opacity-60' : undefined]"
          :aria-pressed="chosen[index] === value"
          @click="choose(index, value)"
        >{{ value }}</button>
      </div>
    </fieldset>
    <p v-if="stockLine" class="text-sm text-muted">{{ stockLine }}</p>
    <div class="space-y-2">
      <label class="block text-sm text-muted" :for="quantityId">{{ t('shop.quantity') }}</label>
      <UInputNumber :id="quantityId" v-model="quantity" :min="1" :max="Math.max(maxQuantity, 1)" :focus-on-change="false" class="w-40 shrink-0" />
    </div>
    <div class="space-y-3">
      <TenantButton block variant="outline" :disabled="!variant || soldOut || maxQuantity === 0" @click="addToCart">{{ soldOut ? t('shop.sold_out') : t('shop.add_to_cart') }}</TenantButton>
      <TenantButton v-if="!soldOut" block :disabled="!variant || maxQuantity === 0" @click="buyNow">{{ t('shop.buy_now') }}</TenantButton>
    </div>
    <p v-if="added" class="text-sm text-default">
      <NuxtLink :to="localePath('/cart')" class="underline">{{ t('shop.cart') }} ({{ cart.count.value }}) · {{ t('shop.checkout') }} →</NuxtLink>
    </p>
  </div>
</template>

<script setup lang="ts">
import type { PublicProduct } from '~/server/types/products'
import { purchasableQuantity } from '~/shared/goods'

const props = defineProps<{ product: PublicProduct; locationId: string | null }>()
const emit = defineEmits<{ variant: [variantId: string | null] }>()
const { t, localePath } = useI18n()
const cart = useCart(useTenantOrganization().organization.id)
const quantityId = useId()

const sellable = computed(() => props.product.variants.filter(variant => variant.active))
// The chosen variant is in the address, as Shopify's ?variant= is, so a shared link opens on it.
const route = useRoute()
const linked = sellable.value.find(entry => entry.id === route.query.variant)
const chosen = ref<string[]>((linked ?? sellable.value[0])?.option_values.slice() ?? [])
const variant = computed(() => props.product.options.length
  ? sellable.value.find(entry => JSON.stringify(entry.option_values) === JSON.stringify(chosen.value)) ?? null
  : sellable.value[0] ?? null)
watch(variant, value => emit('variant', value?.id ?? null), { immediate: true })
function choose(index: number, value: string) {
  const next = chosen.value.slice()
  next[index] = value
  chosen.value = next
  if (variant.value) void navigateTo({ query: { ...route.query, variant: variant.value.id } }, { replace: true })
}

// An order is sent from one location, so the most one order can take is the stock at the best-stocked location offering the item (or the one this page is for).
const available = computed(() => {
  const current = variant.value
  if (!current?.inventory_tracked) return null
  const offering = new Set(props.product.locations.filter(entry => entry.active).map(entry => entry.location_id))
  return Math.max(0, ...current.inventory_levels.filter(level => offering.has(level.location_id) && (props.locationId === null || level.location_id === props.locationId)).map(level => level.available))
})
/** A value is struck through, as Shopify strikes it, when choosing it with the other choices kept gives no variant that can be bought. */
function unavailable(index: number, value: string): boolean {
  const wanted = chosen.value.map((current, position) => position === index ? value : current)
  const match = sellable.value.find(entry => JSON.stringify(entry.option_values) === JSON.stringify(wanted))
  if (!match) return true
  if (!match.inventory_tracked || match.inventory_policy === 'continue') return false
  const offering = new Set(props.product.locations.filter(entry => entry.active).map(entry => entry.location_id))
  return !match.inventory_levels.some(level => offering.has(level.location_id) && (props.locationId === null || level.location_id === props.locationId) && level.available > 0)
}
const limit = computed(() => variant.value ? purchasableQuantity({ inventory_tracked: variant.value.inventory_tracked, inventory_policy: variant.value.inventory_policy, available: available.value }) : 0)
const soldOut = computed(() => limit.value === 0)
// What is already in the cart counts against the stock.
const inCart = computed(() => cart.lines.value.find(line => line.product_variant_id === variant.value?.id)?.quantity ?? 0)
const maxQuantity = computed(() => Math.max(Math.min(limit.value ?? 99, 99) - inCart.value, 0))
const quantity = ref(1)
watch(maxQuantity, max => { if (quantity.value > max) quantity.value = Math.max(max, 1) })

const stockLine = computed(() => {
  const current = variant.value
  if (!current) return ''
  const days = (value: number | null) => value === null ? null : t('shop.ships_in', { days: value })
  // Asking for more than is on hand of a make-to-order item: the rest is made, and the order ships on the make-to-order time.
  if (available.value !== null && available.value > 0 && current.inventory_policy === 'continue' && quantity.value > available.value) {
    return [t('shop.partly_made_to_order', { stock: available.value, made: quantity.value - available.value }), days(props.product.made_to_order_days)].filter(Boolean).join(' · ')
  }
  if (available.value !== null && available.value > 0) return [t('shop.in_stock', { count: available.value }), days(props.product.processing_days)].filter(Boolean).join(' · ')
  if (current.inventory_tracked && current.inventory_policy === 'continue') return [t('shop.made_to_order'), days(props.product.made_to_order_days)].filter(Boolean).join(' · ')
  if (current.inventory_tracked) return t('shop.sold_out')
  return days(props.product.processing_days) ?? ''
})

const added = ref(false)
function addToCart() {
  if (!variant.value || soldOut.value || maxQuantity.value === 0) return
  cart.add(variant.value.id, quantity.value)
  added.value = true
}
// Shopify's "Buy it now": this item, straight to checkout.
async function buyNow() {
  addToCart()
  if (added.value) await navigateTo(localePath('/cart'))
}
</script>
