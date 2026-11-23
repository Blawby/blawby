<template>
  <!--
    A membership's buy box: the option, who is joining, the recurring terms in
    Stripe's words, and Join, which hands the member to Stripe Checkout on the
    business's own Stripe account. There is no date to pick: nothing is booked.
  -->
  <form class="space-y-5" @submit.prevent="join">
    <fieldset v-if="sellable.length > 1" class="space-y-2">
      <legend class="text-sm font-semibold text-default">{{ t('membership.option') }}</legend>
      <div class="flex flex-wrap gap-2">
        <button
          v-for="entry in sellable" :key="entry.id" type="button"
          class="rounded-xl px-4 py-2 text-sm ring-1 transition"
          :class="variantId === entry.id ? 'ring-2 ring-[var(--ui-text-highlighted)] text-default' : 'ring-default text-muted hover:text-default'"
          :aria-pressed="variantId === entry.id"
          @click="variantId = entry.id"
        >{{ entry.name }}</button>
      </div>
    </fieldset>
    <UFormField :label="t('forms.name')"><UInput v-model="guest.name" autocomplete="name" class="w-full" /></UFormField>
    <UFormField :label="t('forms.email')"><UInput v-model="guest.email" type="email" autocomplete="email" class="w-full" /></UFormField>
    <UFormField :label="t('forms.phone')"><UInput v-model="guest.phone" type="tel" autocomplete="tel" class="w-full" /></UFormField>
    <p v-if="terms" class="text-sm text-muted" data-testid="membership-terms">{{ t('membership.recurring_terms', { terms }) }}</p>
    <p v-if="error" role="alert" class="text-sm text-error">{{ error }}</p>
    <TenantButton type="submit" block size="lg" :disabled="!ready || submitting" data-testid="membership-join">{{ terms ? t('membership.join') : t('site.common.temporarily_unavailable') }}</TenantButton>
  </form>
</template>

<script setup lang="ts">
import type { PublicProduct } from '~/server/types/products'
import { membershipPrice } from '~/shared/memberships'
import { formatProductMoney } from '~/utils/product-money'
import { isRecord, publicApiMutation } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ product: PublicProduct; locationId: string | null; currency: string }>()
const { t } = useI18n()

const sellable = computed(() => props.product.variants.filter(variant => variant.active))
const variantId = ref(sellable.value[0]?.id ?? null)
const variant = computed(() => sellable.value.find(entry => entry.id === variantId.value) ?? null)
const terms = computed(() => {
  const offer = variant.value ? membershipPrice(variant.value.prices, { currency: props.currency as Parameters<typeof membershipPrice>[1]['currency'], location_id: props.locationId }) : null
  return formatProductMoney(offer)
})
const guest = reactive({ name: '', email: '', phone: '' })
const ready = computed(() => Boolean(terms.value && guest.name.trim() && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(guest.email.trim())))
const submitting = ref(false)
const error = ref('')
const requestKey = ref<string | null>(null)

async function join() {
  if (!ready.value || !variant.value) return
  submitting.value = true
  error.value = ''
  requestKey.value ??= crypto.randomUUID()
  try {
    const response = await publicApiMutation('/api/public/memberships', {
      method: 'POST',
      body: {
        product_id: props.product.id, product_variant_id: variant.value.id, location_id: props.locationId, idempotency_key: requestKey.value,
        guest_name: guest.name.trim(), guest_email: guest.email.trim(), guest_phone: guest.phone.trim() || null,
      },
      validate: (value): value is { checkout_url: string } => isRecord(value) && typeof value.checkout_url === 'string' && value.checkout_url.startsWith('https://checkout.stripe.com/'),
    })
    window.location.assign(response.checkout_url)
  } catch (cause) {
    error.value = getErrorMessage(cause, t('membership.join'))
    requestKey.value = null
    submitting.value = false
  }
}
</script>
