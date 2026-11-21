<template>
  <!--
    A physical item's buy box, as Shopify's product form: one choice per option,
    what is in stock or made to order, the quantity, and Add to cart.
  -->
  <div class="space-y-6">
    <fieldset v-for="(option, index) in product.options" :key="option.name" class="space-y-2">
      <legend class="text-sm font-semibold text-default">{{ option.name }}</legend>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="value in option.values" :key="value" type="button"
          class="rounded-xl px-4 py-2 text-sm ring-1 transition"
          :class="chosen[index] === value ? 'ring-2 ring-[var(--ui-text-highlighted)] text-default' : 'ring-default text-muted hover:text-default'"
          :aria-pressed="chosen[index] === value"
          @click="choose(index, value)"
        >{{ value }}</button>
      </div>
    </fieldset>
    <p class="text-sm text-muted">{{ stockLine }}</p>
    <div class="flex items-center gap-3">
      <label class="sr-only" :for="quantityId">{{ t('shop.quantity') }}</label>
      <UInputNumber :id="quantityId" v-model="quantity" :min="1" :max="maxQuantity" class="w-32" />
      <TenantButton :disabled="!variant || soldOut" class="flex-1" @click="addToCart">{{ soldOut ? t('shop.sold_out') : t('shop.add_to_cart') }}</TenantButton>
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
const chosen = ref<string[]>(sellable.value[0]?.option_values.slice() ?? [])
const variant = computed(() => props.product.options.length
  ? sellable.value.find(entry => JSON.stringify(entry.option_values) === JSON.stringify(chosen.value)) ?? null
  : sellable.value[0] ?? null)
watch(variant, value => emit('variant', value?.id ?? null), { immediate: true })
function choose(index: number, value: string) {
  const next = chosen.value.slice()
  next[index] = value
  chosen.value = next
}

// Stock counted at the locations offering the item, or the one this page is for.
const available = computed(() => {
  const current = variant.value
  if (!current?.inventory_tracked) return null
  return current.inventory_levels.filter(level => props.locationId === null || level.location_id === props.locationId).reduce((sum, level) => sum + Math.max(level.available, 0), 0)
})
const limit = computed(() => variant.value ? purchasableQuantity({ inventory_tracked: variant.value.inventory_tracked, inventory_policy: variant.value.inventory_policy, available: available.value }) : 0)
const soldOut = computed(() => limit.value === 0)
const maxQuantity = computed(() => Math.min(limit.value ?? 99, 99))
const quantity = ref(1)
watch(maxQuantity, max => { if (quantity.value > max) quantity.value = Math.max(max, 1) })

const stockLine = computed(() => {
  const current = variant.value
  if (!current) return ''
  const days = (value: number | null) => value === null ? null : t('shop.ships_in', { days: value })
  if (available.value !== null && available.value > 0) return [t('shop.in_stock', { count: available.value }), days(props.product.processing_days)].filter(Boolean).join(' · ')
  if (current.inventory_tracked && current.inventory_policy === 'continue') return [t('shop.made_to_order'), days(props.product.made_to_order_days)].filter(Boolean).join(' · ')
  if (current.inventory_tracked) return t('shop.sold_out')
  return days(props.product.processing_days) ?? ''
})

const added = ref(false)
function addToCart() {
  if (!variant.value || soldOut.value) return
  cart.add(variant.value.id, quantity.value)
  added.value = true
}
</script>
