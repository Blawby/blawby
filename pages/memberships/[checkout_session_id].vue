<template>
  <NuxtLayout :name="site.layout">
  <div class="min-h-screen bg-default text-default">
    <div v-if="pending" class="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <TenantIcon name="arrow-path" class="size-12 animate-spin text-muted" />
      <p v-if="state === 'processing'" class="text-muted">{{ t('membership.processing') }}</p>
    </div>
    <!-- Stripe has not reported the first payment yet (a bank debit can take days): the member is told where it will appear, never that it was paid. -->
    <div v-else-if="state === 'processing' && !membership" class="mx-auto max-w-xl px-4 pt-24 pb-24 text-center sm:px-6 lg:px-8">
      <h2 class="text-xl font-bold">{{ t('membership.processing') }}</h2>
      <p class="mt-2 text-muted">{{ t('membership.processing_later') }}</p>
      <p v-if="loadError" class="mt-2 text-error">{{ loadError }}</p>
      <TenantButton :to="localePath('/')" variant="soft" class="mt-10">{{ t('site_pages.home') }}</TenantButton>
    </div>
    <BookingConfirmation
      v-else-if="membership"
      :kicker="t('membership.welcome')"
      :cancelled="membership.state === 'ended'"
      :item-title="membership.title"
      :item-subtitle="organization.name"
      :image-url="null"
      :receipt-rows="receiptRows"
      :next-steps="[]"
      next-steps-kicker=""
      :guest-email="membership.member_email"
    >
      <template #title>{{ t('membership.joined', { title: membership.title }) }}</template>
      <template #subtitle>{{ membership.terms }}</template>
      <template #actions>
        <TenantButton v-if="owned" variant="outline" :loading="opening" data-testid="membership-manage" @click="manage">{{ t('membership.manage') }}</TenantButton>
        <p v-else class="w-full text-sm text-muted">{{ t('payment.receipt_elsewhere') }}</p>
        <p v-if="manageError" role="alert" class="w-full text-sm text-error">{{ manageError }}</p>
        <TenantButton v-if="membership.payments[0]?.receipt_url" :href="membership.payments[0]!.receipt_url!" variant="outline" target="_blank" rel="noopener noreferrer">{{ t('shop.receipt') }}</TenantButton>
      </template>
    </BookingConfirmation>
    <div v-else class="mx-auto max-w-xl px-4 pt-24 pb-24 text-center sm:px-6 lg:px-8">
      <TenantIcon name="exclamation-triangle" class="mx-auto size-12 text-error" />
      <h2 class="mt-6 text-xl font-bold">{{ t(loadError ? 'booking.receipt_failed' : 'membership.not_completed') }}</h2>
      <p v-if="loadError" class="mt-2 text-muted">{{ loadError }}</p>
      <TenantButton :to="localePath('/')" variant="soft" class="mt-10">{{ t('site_pages.home') }}</TenantButton>
    </div>
  </div>
  </NuxtLayout>
</template>

<script setup lang="ts">
// Where Stripe returns a member after Checkout: the membership it started, read from Stripe.
import BookingConfirmation from '~/components/booking/BookingConfirmation.vue'
import { MEMBERSHIP_STATE_LABELS, type Membership } from '~/shared/memberships'
import { formatCalendarDate } from '~/utils/timezone'
import { publicApiRequest, publicApiMutation, isRecord } from '~/utils/api-clients'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: false })
useResponseHeader('cache-control').value = 'private, no-store'

type Return = { state: 'open' | 'processing' | 'paid'; membership: Membership | null; owned: boolean }
const { locale, localePath, t } = useI18n()
const route = useRoute()
const { organization } = useTenantOrganization()
const { site } = organization
const membership = ref<Membership | null>(null)
const state = ref<Return['state'] | null>(null)
// Paid from a browser signed in as someone else, the payer sees the confirmation; managing it is for the account that joined.
const owned = ref(false)
const pending = ref(true)
const loadError = ref<string | null>(null)
const sessionId = String(route.params.checkout_session_id ?? '')

async function load() {
  const result = await publicApiRequest<Return>(`/api/public/memberships/${encodeURIComponent(sessionId)}`, {
    validate: (value): value is Return => isRecord(value) && (value.state === 'open' || value.state === 'processing' || value.state === 'paid'),
  })
  state.value = result.state
  membership.value = result.membership
  owned.value = result.owned
  return result.state
}
onMounted(async () => {
  try {
    // Stripe reports the first payment to the business moments after Checkout returns; the page waits for it.
    for (let attempt = 0; attempt < 20 && await load() === 'processing'; attempt++) await new Promise(resolve => setTimeout(resolve, 1500))
  } catch (cause) {
    loadError.value = getErrorMessage(cause, t('booking.receipt_failed'))
  } finally {
    pending.value = false
  }
})

const day = (at: string) => formatCalendarDate(at.slice(0, 10), locale.value, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
const receiptRows = computed(() => {
  const value = membership.value
  if (!value) return []
  return [
    { label: t('membership.status'), value: MEMBERSHIP_STATE_LABELS[value.state] },
    { label: t('membership.price'), value: value.terms },
    ...(value.current_period_end ? [{ label: t(value.state === 'cancelling' ? 'membership.access_until' : 'membership.next_payment'), value: day(value.current_period_end) }] : []),
  ]
})

const opening = ref(false)
const manageError = ref('')
async function manage() {
  if (!membership.value) return
  opening.value = true
  manageError.value = ''
  try {
    const { url } = await publicApiMutation(`/api/account/memberships/${encodeURIComponent(membership.value.id)}/portal`, {
      method: 'POST', body: { return_path: route.fullPath },
      validate: (value): value is { url: string } => isRecord(value) && typeof value.url === 'string' && value.url.startsWith('https://billing.stripe.com/'),
    })
    window.location.assign(url)
  } catch (cause) {
    manageError.value = getErrorMessage(cause, t('membership.manage'))
    opening.value = false
  }
}
useSocialMetadata(() => ({ path: localePath(`/memberships/${sessionId}`), title: t('membership.join'), description: t('membership.join'), socialImage: null, discoverability: 'private' }))
</script>
