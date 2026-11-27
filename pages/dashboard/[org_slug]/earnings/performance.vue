<template>
  <!--
    Airbnb's Performance: the year's bars with the chosen month lit, that
    month's paid and refunded earnings and what they were earned on. One screen under Earnings.
  -->
  <DashboardLeafPanel id="earnings-performance" class="dashboard-themed" title="Performance" :footer="false" :style="data ? dashboardThemeStyle(data.presentation) : undefined">
    <UAlert v-if="error" color="error" variant="soft" title="Performance could not be loaded" :description="getErrorMessage(error, 'Performance request failed')" />
    <template v-else-if="status === 'success'">
      <section>
        <div class="flex items-center justify-between gap-4">
          <div>
            <h2 class="text-xl font-semibold text-highlighted">Summary</h2>
            <button class="mt-2 text-sm underline" @click="summaryTable = !summaryTable">{{ summaryTable ? 'Show chart' : 'Show table' }}</button>
            <p class="text-sm text-muted">Monthly view · {{ year }}</p>
          </div>
          <div class="flex items-center rounded-md ring ring-default">
            <UButton icon="i-lucide-chevron-left" color="neutral" variant="ghost" square aria-label="Previous year" :disabled="year <= 2000" @click="year -= 1" />
            <UButton icon="i-lucide-chevron-right" color="neutral" variant="ghost" square aria-label="Next year" :disabled="year >= thisYear" @click="year += 1" />
          </div>
        </div>
        <EarningsBars v-if="data && !summaryTable" class="mt-6" :months="data.months.map(row=>({month:row.month,amount:row.month > currentMonth ? null : row.paid-row.refunded}))" :selected="month" :currency="data.currency" :presentation="data.presentation" @select="month = $event" />
        <table v-if="data && summaryTable" class="mt-6 w-full text-sm"><thead><tr><th class="py-3 text-left">Month</th><th class="text-right">Total ({{ data.currency }})</th></tr></thead><tbody><tr v-for="row in data.months" :key="row.month" class="border-t border-default"><th class="py-3 text-left font-normal"><button class="underline" @click="month = row.month">{{ formatCalendarDate(`${row.month}-01`, 'en', { month: 'long' }) }}</button></th><td class="text-right">{{ row.month > currentMonth ? 'Not yet reported' : money(row.paid-row.refunded) }}</td></tr></tbody></table>
      </section>

      <DashboardSurface v-if="data && selected && status === 'success'" :presentation="data.presentation" :elevated="false" class="mt-8">
        <h3 class="font-semibold">{{ monthTitle }}</h3>
        <dl class="mt-4 space-y-3"><div v-for="row in data.breakdown" :key="row.key" class="flex flex-wrap justify-between gap-2 text-sm"><dt class="text-muted">{{ row.label }}</dt><dd class="font-semibold">{{ row.display }}</dd></div></dl>
        <details class="mt-5 border-t border-default pt-4"><summary class="cursor-pointer text-sm font-semibold">Paid breakdown</summary><NuxtLink :to="{ path: `/dashboard/${route.params.org_slug}/earnings/transactions`, query: { from: `${month}-01`, through: lastDayOf(month) } }" class="mt-3 block text-sm underline">View transactions</NuxtLink></details>
        <details class="mt-4 border-t border-default pt-4"><summary class="cursor-pointer text-sm font-semibold">Performance stats</summary><dl class="mt-4 space-y-3"><div v-for="row in data.statistics" :key="row.key" class="flex flex-wrap justify-between gap-2 text-sm"><dt class="text-muted">{{ row.label }}</dt><dd>{{ row.display }}</dd></div></dl></details>
      </DashboardSurface>
      <p v-if="data && year === 2000" class="mt-10 text-sm text-muted">Year comparison is available from 2001.</p>
      <EarningsComparison v-if="data?.comparison" class="mt-10" :performance="data" :selected="month" @select="month = $event" />

      <section v-if="data && status === 'success'" class="mt-10">
        <h2 class="text-xl font-semibold text-highlighted">Direct payments by offering</h2>
        <p class="text-sm text-muted">{{ monthTitle }}</p>
        <div v-if="data.items.length" class="mt-4 space-y-5">
          <div v-for="item in data.items" :key="item.title" class="flex items-center gap-4">
            <span class="flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-elevated">
              <img v-if="item.image_url" :src="item.image_url" alt="" class="size-full object-cover">
              <UIcon v-else name="i-lucide-package" class="size-5 text-dimmed" />
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center justify-between gap-4">
                <span class="truncate text-sm font-medium text-highlighted">{{ item.title }}</span>
                <span class="shrink-0 text-sm"><span class="text-muted">{{ share(item.paid) }}</span> <span class="ml-2 font-semibold text-highlighted">{{ money(item.paid) }}</span></span>
              </span>
              <span class="mt-2 block h-1 w-full rounded-full bg-elevated"><span class="block h-1 rounded-full bg-primary" :style="{ width: share(item.paid) }" /></span>
            </span>
          </div>
        </div>
        <DashboardEmptyState v-else-if="status === 'success'" illustration="/images/offers/chart.webp" :title="`Nothing was earned in ${monthTitle}.`" />
        <p class="mt-4 text-xs text-muted">Stripe payments captured in the selected period, less refunds; channel reservation amounts are separate.</p>
      </section>

      <ChannelReservationSummary v-if="data && status === 'success' && dashboard.hasFeature('stays')" class="mt-10" :rows="data.channel_reservations" :month="monthTitle" />
    </template>
    <p v-else role="status" class="text-sm text-muted">Loading performance…</p>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { dashboardThemeStyle } from '~/shared/dashboard-presentation'
import ChannelReservationSummary from '~/components/dashboard/ChannelReservationSummary.vue'
import EarningsComparison from '~/components/dashboard/EarningsComparison.vue'
import DashboardSurface from '~/components/dashboard/DashboardSurface.vue'
import EarningsBars from '~/components/dashboard/EarningsBars.vue'
import { paymentMoney } from '~/shared/payment-display'
import { isEarningsPerformance, type EarningsPerformance } from '~/shared/earnings-display'
import { formatCalendarDate } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Performance | Blawby', robots: 'noindex, nofollow' })

const route = useRoute()
const dashboard = useDashboardOrganization()
const router = useRouter()
const api = useDashboardApi()
const now = new Date()
const thisYear = now.getUTCFullYear()
const initial = typeof route.query.month === 'string' && /^\d{4}-\d{2}$/.test(route.query.month) ? route.query.month : `${thisYear}-${String(now.getUTCMonth() + 1).padStart(2, '0')}`
const month = ref(initial)
const summaryTable = ref(false)
const currentMonth = now.toISOString().slice(0,7)
const year = computed({
  get: () => Number(month.value.slice(0, 4)),
  set: (next) => { month.value = `${next}-${month.value.slice(5)}` },
})
watch(month, (next) => { void router.replace({ query: { ...route.query, month: next } }) })

const { data, error, status } = await useAsyncData(
  () => `earnings-performance:${route.params.org_slug}:${month.value}`,
  async () => {
    const requestedMonth = month.value
    const performance = await api<EarningsPerformance>('/api/dashboard/payments', { query: { view: 'performance', ...(Number(requestedMonth.slice(0, 4)) > 2000 ? { comparison: 'previous_year' } : {}), year: Number(requestedMonth.slice(0, 4)), month: requestedMonth }, validate: isEarningsPerformance })
    if (!performance.months.some(row => row.month === requestedMonth)) {
      throw createError({ statusCode: 502, message: `Earnings are missing for ${requestedMonth}`, data: { code: 'EARNINGS_MONTH_MISSING', field: `months.${requestedMonth}` } })
    }
    return performance
  },
)
const money = (amount: number) => paymentMoney(amount, data.value!.currency)
const selected = computed(() => data.value?.months.find(row => row.month === month.value))
const monthTitle = computed(() => formatCalendarDate(`${month.value}-01`, 'en', { month: 'long', year: 'numeric' }))
const monthTotal = computed(() => data.value?.items.reduce((sum, item) => sum + item.paid, 0) ?? 0)
const share = (paid: number) => `${monthTotal.value ? Math.round((paid / monthTotal.value) * 1000) / 10 : 0}%`
function lastDayOf(key: string): string {
  const [y, m] = key.split('-').map(Number)
  return new Date(Date.UTC(y!, m!, 0)).toISOString().slice(0, 10)
}
</script>
