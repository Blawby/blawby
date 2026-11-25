<template>
  <!--
    Airbnb's Payouts: how the money the organization takes in reaches it. Its
    plan and what it pays Blawby are Plan and billing, a Menu row of its
    own. Reached from the Earnings cog; each row is a leaf beside this column,
    and the first opens on arrival where there is a pane.
  -->
  <DashboardIndexPanel id="organization-payments" title="Payments" :auto-open="firstRow">
    <div class="pb-10">
      <UAlert v-if="connectError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" title="Payment settings could not be loaded" :description="getErrorMessage(connectError, 'Stripe Connect status could not be loaded')" />
      <p v-if="connectPending" role="status" class="mb-6 text-muted">Loading payment settings…</p>
      <UAlert v-if="unpaidError" class="mb-6" color="error" :description="getErrorMessage(unpaidError, 'Payments to collect could not be loaded')" />
      <p v-else-if="unpaidPending" role="status" class="mb-6 text-muted">Loading payments to collect…</p>
      <!-- Who owes is the business's own records, so it stays reachable when Stripe is not. -->
      <EditorNavigationList :groups="groups" :active-item="level.child.value" />
      <UButton class="mt-8" label="View pricing and fees" to="/pricing" external color="neutral" variant="link" />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup, type EditorNavigationItem } from '~/components/dashboard/EditorNavigationList.vue'
import { connectStatusPresentation, useConnectAccount, useUnpaid } from '~/composables/usePaymentsSettings'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'dashboard-org_slug-earnings' })
useSeoMeta({ title: 'Payments | Blawby', robots: 'noindex, nofollow' })

const level = useRouteLevel()
const { account, payout, connectError, connectPending } = useConnectAccount()
const to = (leaf: string) => `${level.path.value}/${leaf}`

const { unpaid, unpaidError, unpaidPending } = useUnpaid()
const rows = computed<EditorNavigationItem[]>(() => [
  ...(connectPending.value || connectError.value ? [] : [{ id: 'payout-method', label: account.value ? 'How you get paid' : 'Accept online payments', to: to('payout-method'), ...(payout.value
    ? { summary: `${payout.value.bank_name ?? 'Bank account'}, ••••${payout.value.last4} (${payout.value.currency})`, status: 'success' as const }
    : { summary: connectStatusPresentation(account.value?.status).description, status: account.value ? 'neutral' as const : undefined }) }]),
  ...(account.value?.status === 'ready' ? [{ id: 'surcharge', label: 'Card surcharge', to: to('surcharge'), summary: account.value.surcharge_basis_points === null ? 'Off. Pass credit card fees on to the buyer.' : `On at ${account.value.surcharge_basis_points / 100}%.` }] : []),
  // Who still has to pay: rent past its day, a stay begun and not paid, a deposit or retainer not received.
  ...(unpaid.value?.length ? [{ id: 'unpaid', label: 'Payments to collect', to: to('unpaid'), summary: `${unpaid.value.length} ${unpaid.value.length === 1 ? 'booking has' : 'bookings have'} an overdue payment` }] : []),
])
const groups = computed<EditorNavigationGroup[]>(() => [{ id: 'payouts', items: rows.value }])
const firstRow = computed(() => connectPending.value ? null : rows.value[0]?.to ?? null)
</script>
