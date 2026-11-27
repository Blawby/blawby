<template>
  <!--
    Airbnb's Paid list: every payout, "Sent · date" under the day, the amount
    on the right, a total and Export CSV at the foot. Upcoming payouts head the
    list. A payout opens as a leaf of this level.
  -->
  <DashboardIndexPanel id="earnings-payouts" title="Payout history" column="reading">
    <div>
      <p class="mb-6 text-sm text-muted">Transfers from your connected Stripe account. Channel payouts are managed by each channel.</p>
      <div class="mb-6 flex flex-wrap gap-3">
        <label class="text-sm">Payouts<select v-model="filterStatus" class="ml-2 rounded-full border border-default bg-default px-3 py-2"><option value="all">All payouts</option><option value="upcoming">Upcoming</option><option value="paid">Paid</option><option value="failed">Failed</option><option value="canceled">Cancelled</option></select></label>
        <label class="text-sm">Arrival from<input v-model="from" type="date" class="ml-2 rounded-full border border-default bg-default px-3 py-2"></label>
        <label class="text-sm">Arrival through<input v-model="through" type="date" :min="from || undefined" class="ml-2 rounded-full border border-default bg-default px-3 py-2"></label>
      </div>
      <UAlert v-if="exportError" color="error" title="Export could not be completed" :description="exportError" class="mb-4" />
      <UAlert v-if="error" color="error" :description="error.message" />
      <template v-else-if="data">
        <DashboardEmptyState v-if="data.configured === false && status === 'success'" illustration="/images/offers/card.webp" title="Payouts start once your business is connected to Stripe.">
          <template #actions><UButton label="Add payout method" :to="`/dashboard/${route.params.org_slug}/payments`" /></template>
        </DashboardEmptyState>
        <template v-else>
          <section v-if="clearing.length" class="my-6">
            <h2 class="text-base font-semibold text-highlighted">Stripe balance</h2>
            <dl class="mt-4 space-y-3">
              <div v-for="row in clearing" :key="row.currency + row.label" class="flex items-center justify-between gap-4">
                <dt class="text-sm text-muted">{{ row.label }}</dt>
                <dd class="font-medium">{{ paymentMoney(row.amount, row.currency) }}</dd>
              </div>
            </dl>
          </section>
          <section v-if="upcoming.length" class="mb-8">
            <h2 class="text-base font-semibold text-highlighted">Upcoming</h2>
            <div class="divide-y divide-default border-b border-default">
              <NuxtLink v-for="row in upcoming" :key="row.id" :to="`${level.path.value}/${encodeURIComponent(row.id)}`" class="flex items-center gap-4 py-5">
                <span class="min-w-0 flex-1"><span class="block text-base font-medium text-highlighted">{{ payoutDate(row.created) }}</span><span class="block text-sm text-muted">{{ payoutStatusLabel(row.status) }} · {{ payoutDate(row.arrival_date, { month: 'long', day: 'numeric', year: 'numeric' }) }}</span></span>
                <span class="text-base font-medium tabular-nums text-highlighted">{{ paymentMoney(row.amount, row.currency.toUpperCase()) }}</span>
                <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
              </NuxtLink>
            </div>
          </section>

          <div v-if="paid.length" class="divide-y divide-default border-y border-default">
            <NuxtLink v-for="row in paid" :key="row.id" :to="`${level.path.value}/${encodeURIComponent(row.id)}`" class="flex items-center gap-4 py-5" :data-testid="`payout-${row.id}`">
              <span class="min-w-0 flex-1"><span class="block text-base font-medium text-highlighted">{{ payoutDate(row.created) }}</span><span class="block text-sm text-muted">Sent · Arrival {{ payoutDate(row.arrival_date, { month: 'long', day: 'numeric', year: 'numeric' }) }}</span></span>
              <span class="text-base font-medium tabular-nums text-highlighted">{{ paymentMoney(row.amount, row.currency.toUpperCase()) }}</span>
              <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
            </NuxtLink>
          </div>
          <DashboardEmptyState v-else-if="status === 'success' && !loaded.length" illustration="/images/offers/card.webp" title="No matching payouts on this page." />
          <section v-if="other.length" class="mt-8">
            <h2 class="text-base font-semibold text-highlighted">Failed and cancelled</h2>
            <div class="divide-y divide-default">
              <NuxtLink v-for="row in other" :key="row.id" :to="`${level.path.value}/${encodeURIComponent(row.id)}`" class="flex items-center justify-between gap-4 py-5">
                <span><span class="block font-medium">{{ payoutStatusLabel(row.status) }}</span><span class="text-sm text-muted">Arrival {{ payoutDate(row.arrival_date) }}</span></span>
                <span class="font-medium">{{ paymentMoney(row.amount, row.currency.toUpperCase()) }}</span>
              </NuxtLink>
            </div>
          </section>
          <UButton v-if="data.next_cursor" class="mt-4" color="neutral" variant="soft" label="Show more" @click="after = data.next_cursor" />
        </template>
      </template>
      <PaymentsHelp class="mt-8" />
    </div>

    <template v-if="data?.configured" #footer>
      <div class="flex items-center justify-between gap-4">
        <div><p class="text-sm text-muted">Loaded payouts total</p><p v-if="loaded.length" class="text-lg font-semibold text-highlighted">{{ total }}</p></div>
        <UButton label="Export CSV" size="lg" :loading="exporting" @click="exportCsv" />
      </div>
    </template>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import PaymentsHelp from '~/components/dashboard/PaymentsHelp.vue'
import { paymentMoney } from '~/shared/payment-display'
import { downloadCsvText, isPayoutsView, payoutDate, payoutStatusLabel, type PayoutRow, type PayoutsView } from '~/shared/earnings-display'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Stripe payout history | Blawby', robots: 'noindex, nofollow' })

const route = useRoute()
const api = useDashboardApi()
const level = useRouteLevel()
const router = useRouter()
const queryText = (name: string) => typeof route.query[name] === 'string' ? route.query[name] as string : ''
const setFilter = (name: string, value: string) => { void router.replace({ query: { ...route.query, [name]: value || undefined } }) }
const filterStatus = computed({ get: () => queryText('status') || 'all', set: value => setFilter('status', value === 'all' ? '' : value) })
const from = computed({ get: () => queryText('arrival_from'), set: value => setFilter('arrival_from', value) })
const through = computed({ get: () => queryText('arrival_to'), set: value => setFilter('arrival_to', value) })
const filters = computed(() => ({ ...(filterStatus.value !== 'all' ? { status: filterStatus.value } : {}), ...(from.value ? { arrival_from: from.value } : {}), ...(through.value ? { arrival_to: through.value } : {}) }))
const exporting = ref(false), exportError = ref<string | null>(null)
const after = ref<string | null>(null)
const loaded = ref<PayoutRow[]>([])
watch(filters, () => { after.value = null; loaded.value = [] })
const { data, error, status } = await useAsyncData(
  () => `earnings-paid:${route.params.org_slug}:${JSON.stringify(filters.value)}:${after.value ?? ''}`,
  async () => {
    const page = await api<PayoutsView>('/api/dashboard/payments', { query: { view: 'payouts', ...filters.value, ...(after.value ? { after: after.value } : {}) }, validate: isPayoutsView })
    return page
  },
  { watch: [after, filters] },
)
// Pages accumulate, as Airbnb's "Show more" does. Watched rather than written in
// the handler, which does not run again when the server-rendered page hydrates.
watch(data, (page) => { if (page) loaded.value = after.value ? [...loaded.value, ...page.payouts] : page.payouts }, { immediate: true })
const clearing = computed(() => [
  ...(data.value?.balance?.available ?? []).map(row => ({ amount: row.amount, currency: row.currency.toUpperCase(), label: 'Ready to send' })),
  ...(data.value?.balance?.pending ?? []).map(row => ({ amount: row.amount, currency: row.currency.toUpperCase(), label: 'Clearing' })),
].filter(row => row.amount !== 0))
const upcoming = computed(() => loaded.value.filter(row => row.status === 'pending' || row.status === 'in_transit'))
const paid = computed(() => loaded.value.filter(row => row.status === 'paid'))
const other = computed(() => loaded.value.filter(row => row.status === 'failed' || row.status === 'canceled'))
const total = computed(() => {
  const totals = new Map<string, number>()
  for (const row of loaded.value) totals.set(row.currency.toUpperCase(), (totals.get(row.currency.toUpperCase()) ?? 0) + row.amount)
  return [...totals].map(([code, amount]) => paymentMoney(amount, code)).join(' · ')
})
async function exportCsv() {
  exporting.value = true
  exportError.value = null
  try {
    const csv = await api<string>('/api/dashboard/payments', { query: { view: 'payout_export', ...filters.value }, validate: (value): value is string => typeof value === 'string'  })
    downloadCsvText(`payouts-${String(route.params.org_slug)}.csv`, csv)
  } catch (failure) { exportError.value = getErrorMessage(failure, 'Payout export failed') }
  finally { exporting.value = false }
}

</script>
