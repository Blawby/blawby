<template>
  <NuxtLayout :name="site.layout">
    <!-- Where Stripe returns a member after Checkout: one screen, as every checkout moment is. -->
    <CheckoutState v-bind="screen" :business="organization.name" />
  </NuxtLayout>
</template>

<script setup lang="ts">
// Where Stripe returns a member after Checkout: the membership it started, read from Stripe.
import CheckoutState from '~/components/booking/CheckoutState.vue'
import type { Membership } from '~/shared/memberships'
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
const screen = computed<InstanceType<typeof CheckoutState>['$props']>(() => {
  const value = membership.value
  if (pending.value) return { state: 'reviewing', live: true, title: t(state.value === 'processing' ? 'membership.processing' : 'checkout_state.reviewing'), help: t('checkout_state.keep_open') }
  // Stripe has not reported the first payment yet (a bank debit can take days): the member is told where it will appear, never that it was paid.
  if (state.value === 'processing' && !value) return { state: 'processing', title: t('membership.processing'), help: loadError.value ?? t('membership.processing_later') }
  if (value) {
    const when = value.current_period_end ? `${t(value.state === 'cancelling' ? 'membership.access_until' : 'membership.next_payment')} ${day(value.current_period_end)}` : null
    return { state: 'membership_active', title: t('checkout_state.membership_active'), help: `${value.title} · ${value.terms}`,
      // Managing it is for the account that joined; a payer signed in as someone else is told where it is.
      where: manageError.value || (owned.value ? when : t('payment.receipt_elsewhere')),
      action: owned.value ? { label: t('membership.manage'), loading: opening.value, onClick: manage } : null }
  }
  // Checkout was left before paying: Stripe took nothing.
  if (state.value === 'open') return { state: 'not_completed', title: t('checkout_state.not_completed'), help: t('checkout_state.not_charged'), action: { label: t('checkout_state.back_to', { business: organization.name }), to: localePath('/'), quiet: true } }
  return { state: 'unavailable', title: t('payment.unavailable'), help: loadError.value ?? t('checkout_state.unavailable_help'), action: { label: t('checkout_state.back_to', { business: organization.name }), to: localePath('/'), quiet: true } }
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
