<template>
  <DashboardIndexPanel id="earnings" class="dashboard-themed" title="Earnings" :style="data ? dashboardThemeStyle(data.presentation) : undefined">
    <template #right><UDropdownMenu :items="settingsItems" :content="{ align: 'end' }"><UButton icon="i-lucide-settings" color="neutral" variant="ghost" square aria-label="Settings and documents" /></UDropdownMenu></template>
    <div class="space-y-8 pb-10">
      <UAlert v-if="error" color="error" title="Earnings could not be loaded" :description="getErrorMessage(error, 'Earnings request failed')" />
      <NuxtLink v-if="showingBookingValue" :to="level.path.value" class="block font-medium underline">Earnings overview</NuxtLink>
      <template v-if="data">
        <DashboardSurface :presentation="data.presentation">
          <h2 class="text-center text-sm font-semibold">Performance</h2>
          <p class="mt-3 break-words text-center text-4xl font-semibold tracking-tight">{{ total }}</p>
          <p class="mt-2 text-center text-xs text-muted">Total for {{ monthName }} ({{ data.performance.currency }})</p>
          <EarningsBars preview class="mt-5" :months="[{month: selected!.month, amount: selected!.paid-selected!.refunded}]" :selected="data.month" :currency="data.performance.currency" :presentation="data.presentation" @select="navigateTo(`${level.path.value}/performance`)" />
          <dl class="my-5 space-y-3 text-sm"><div v-for="row in data.performance.breakdown.slice(0, 2)" :key="row.key" class="flex flex-wrap justify-between gap-2"><dt class="text-muted">{{ row.label }}</dt><dd class="font-medium">{{ row.display }}</dd></div></dl>
          <UButton block color="neutral" variant="soft" label="View all details" :to="`${level.path.value}/performance`" />
        </DashboardSurface>
        <template v-if="data.payouts?.configured">
          <section v-for="group in payoutGroups" :key="group.title" class="space-y-4">
            <h2 class="text-xl font-semibold">{{ group.title }}</h2>
            <NuxtLink v-for="row in group.rows.slice(0, 3)" :key="row.id" :to="`${level.path.value}/payouts/${encodeURIComponent(row.id)}`" class="block">
              <DashboardSurface :presentation="data.presentation"><p class="text-xs text-muted">{{ payoutDate(row.created) }}</p><p class="mt-1 text-lg font-semibold">{{ paymentMoney(row.amount, row.currency.toUpperCase()) }}</p><p class="mt-1 text-xs text-muted">{{ payoutStatusLabel(row.status) }} · Arrival {{ payoutDate(row.arrival_date) }}</p></DashboardSurface>
            </NuxtLink>
            <p v-if="!group.rows.length" class="text-sm text-muted">{{ group.empty }}</p>
            <UButton block color="neutral" variant="soft" :label="group.label" :to="{ path: `${level.path.value}/payouts`, query: { status: group.status } }" />
          </section>
        </template>
        <p v-else-if="data.performance.payouts_connected === false" class="text-sm text-muted">Connect Stripe in Payments &amp; payouts to receive online payments.</p>
        <section class="space-y-4"><h2 class="text-xl font-semibold">Reports</h2><NuxtLink :to="`${level.path.value}/booking-value`" class="flex items-center justify-between py-3 font-medium underline">{{ data.performance.booking_value_title }}<UIcon name="i-lucide-chevron-right" /></NuxtLink><NuxtLink :to="`${level.path.value}/performance`" class="flex items-center justify-between py-3 font-medium underline">Monthly earnings report<UIcon name="i-lucide-chevron-right" /></NuxtLink><NuxtLink :to="`${level.path.value}/transactions`" class="flex items-center justify-between py-3 font-medium underline">Transactions and payment history<UIcon name="i-lucide-chevron-right" /></NuxtLink><NuxtLink v-if="data.payouts?.configured" :to="`${level.path.value}/payouts`" class="flex items-center justify-between py-3 font-medium underline">Payout history and CSV export<UIcon name="i-lucide-chevron-right" /></NuxtLink></section>
      </template>
      <PaymentsHelp />
    </div>
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import { dashboardThemeStyle } from '~/shared/dashboard-presentation'
import PaymentsHelp from '~/components/dashboard/PaymentsHelp.vue'
import DashboardSurface from '~/components/dashboard/DashboardSurface.vue'
import EarningsBars from '~/components/dashboard/EarningsBars.vue'
import { paymentMoney } from '~/shared/payment-display'
import { isEarningsOverview, payoutDate, payoutStatusLabel, type EarningsOverview } from '~/shared/earnings-display'
import { formatCalendarDate } from '~/utils/timezone'
definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })
useSeoMeta({ title: 'Earnings | Blawby', robots: 'noindex, nofollow' })
const route = useRoute(), api = useDashboardApi(), level = useRouteLevel()
const showingBookingValue = computed(() => route.path.endsWith('/earnings/booking-value'))
const { data, error } = await useAsyncData(() => `earnings-overview:${route.params.org_slug}:${showingBookingValue.value}`, () => showingBookingValue.value ? Promise.resolve(null) : api<EarningsOverview>('/api/dashboard/payments', { query: { view: 'overview' }, validate: isEarningsOverview }))
const selected = computed(() => data.value?.performance.months.find(row => row.month === data.value?.month))
const monthName = computed(() => data.value ? formatCalendarDate(`${data.value.month}-01`, 'en', { month: 'long' }) : '')
const total = computed(() => selected.value && data.value ? paymentMoney(selected.value.paid - selected.value.refunded, data.value.performance.currency) : '')
const payoutGroups = computed(() => {
  const rows = data.value?.payouts?.payouts ?? []
  const other = rows.filter(row => row.status === 'failed' || row.status === 'canceled')
  return [
    { title: 'Upcoming', label: 'View all upcoming', status: 'upcoming', empty: 'No upcoming payouts.', rows: rows.filter(row => ['pending', 'in_transit'].includes(row.status)) },
    { title: 'Paid', label: 'View all paid', status: 'paid', empty: 'Nothing has been paid out yet.', rows: rows.filter(row => row.status === 'paid') },
    ...(other.length ? [{ title: 'Failed or cancelled', label: 'View all payouts', status: 'all', empty: '', rows: other }] : []),
  ]
})
const settingsItems = computed(() => [[{ label: 'Payout settings', icon: 'i-lucide-landmark', to: `/dashboard/${route.params.org_slug}/payments` }, { label: 'Plan and billing', icon: 'i-lucide-receipt', to: `/dashboard/${route.params.org_slug}/billing` }]])
</script>
