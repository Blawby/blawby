<template>
  <div class="performance-overview mx-auto w-full max-w-4xl space-y-8 px-4 py-6 sm:px-8" :style="data ? { '--overview-light': data.presentation.light.background, '--overview-dark': data.presentation.dark.background, '--overview-text-light': data.presentation.light.text, '--overview-text-dark': data.presentation.dark.text, '--overview-secondary-light': data.presentation.light.secondary, '--overview-secondary-dark': data.presentation.dark.secondary } : undefined">
    <div class="flex items-center justify-between gap-4"><h1 class="text-3xl font-bold tracking-tight">Performance</h1><span v-if="status === 'pending' && data" class="text-xs text-muted" role="status">Updating…</span></div>
    <UAlert v-if="error" color="error" title="Performance could not be loaded" :description="getErrorMessage(error, 'Performance request failed')" />
    <template v-if="data">
      <section v-if="data.opportunities.length">
        <div class="mb-4 flex items-center justify-between gap-4"><h2 class="text-lg font-semibold">Opportunities</h2><button class="text-sm underline underline-offset-4" @click="showAll = true">Show all</button></div>
        <div class="-mx-4 flex snap-x scroll-px-4 gap-3 overflow-x-auto px-4 py-3 [scrollbar-width:none]">
          <DashboardSurface v-for="item in data.opportunities" :key="item.id" :presentation="data.presentation" as="article" class="relative w-64 shrink-0 snap-start">
            <NuxtLink :to="item.path" class="font-semibold after:absolute after:inset-0 after:rounded-2xl">{{ item.title }}</NuxtLink>
            <p class="mt-2 text-sm text-muted">{{ item.detail }}</p>
            <div v-if="item.progress" class="mt-4"><progress class="h-1 w-full" :value="item.progress.completed" :max="item.progress.total" :aria-label="item.progress.label" :style="{ accentColor: data.presentation.light.rating_accent }" /><p class="mt-1 flex justify-between text-xs text-muted"><span>{{ item.progress.label }}</span><span>{{ item.progress.completed }}/{{ item.progress.total }}</span></p></div>
          </DashboardSurface>
        </div>
      </section>
      <section>
        <div class="mb-5 flex gap-5 border-b border-default" aria-label="Performance date range">
          <button v-for="option in ranges" :key="option.days" class="border-b-2 py-3 text-sm" :class="days === option.days ? 'border-current font-semibold' : 'border-transparent text-muted'" :aria-pressed="days === option.days" @click="days = option.days">{{ option.label }}</button>
        </div>
        <dl class="grid grid-cols-3 gap-4"><div v-for="metric in data.summary" :key="`${metric.page}:${metric.key}`"><dd class="text-2xl font-bold tabular-nums">{{ metric.display }}</dd><dt class="mt-1 text-xs text-muted">{{ metric.label }}</dt></div></dl>
      </section>
      <DashboardSurface v-for="section in data.sections" :key="section.id" :presentation="data.presentation">
        <h2 class="mb-6 text-lg font-semibold">{{ section.title }}</h2>
        <template v-if="section.id === 'quality'">
          <h3 class="mb-4 font-semibold">Overview</h3>
          <NuxtLink :to="metricLink('quality/overall-rating')" class="flex items-center gap-4">
            <span class="flex size-16 shrink-0 items-center justify-center rounded-full border-2 border-default text-xs tracking-tight" :style="{ color: data.presentation.light.rating_accent }" aria-hidden="true">★★★★★</span>
            <span><strong class="block text-2xl">{{ section.metrics[0]?.display }}</strong><span class="text-xs text-muted">Overall rating</span></span>
            <UIcon name="i-lucide-chevron-right" class="ml-auto" />
          </NuxtLink>
          <h3 class="mb-3 mt-6 text-sm">Ratings</h3>
          <dl class="space-y-3"><div v-for="rating in section.rating_counts" :key="rating.label" class="flex items-center gap-3"><dd class="text-2xl font-semibold">{{ rating.count }}</dd><dt class="text-xs text-muted">{{ rating.label }}<span class="block" :style="{ color: data.presentation.light.rating_accent }" aria-hidden="true">★★★★★</span></dt></div></dl>
          <p class="mt-5 text-xs text-muted">{{ data.range.label }}</p>
          <div class="mt-6 border-t border-default pt-4"><h3 class="text-sm">Recent issues</h3><button class="mt-2 text-sm underline" @click="showIssues = true">View recent issues</button></div>
        </template>
        <dl v-else class="grid grid-cols-2 gap-x-6 gap-y-6"><div v-for="metric in section.metrics" :key="`${metric.page}:${metric.key}`"><NuxtLink :to="metricLink(metric.page)"><dd class="text-lg font-semibold tabular-nums">{{ metric.display }}</dd><dt class="mt-1 text-xs text-muted">{{ metric.label }}</dt></NuxtLink></div></dl>
        <p v-if="section.id !== 'quality'" class="mt-5 text-xs text-muted">{{ data.range.label }}</p>
      </DashboardSurface>
      <button class="text-sm font-semibold underline" @click="showIndex = true">All insights</button>
      <UModal v-model:open="showIndex" title="All insights"><template #body><nav class="space-y-6"><section v-for="section in data.index.sections" :key="section.id"><h2 class="mb-3 font-semibold">{{ section.title }}</h2><NuxtLink v-for="item in section.pages" :key="item.id" :to="metricLink(item.id)" class="block py-3 text-sm underline">{{ item.title }}</NuxtLink></section></nav></template></UModal>
      <UModal v-model:open="showAll" title="Opportunities"><template #body><div class="space-y-4"><DashboardSurface v-for="item in data.opportunities" :key="item.id" :presentation="data.presentation" class="relative"><NuxtLink :to="item.path" class="font-semibold after:absolute after:inset-0">{{ item.title }}</NuxtLink><p class="mt-2 text-sm text-muted">{{ item.detail }}</p>
            <div v-if="item.progress" class="mt-4"><progress class="h-1 w-full" :value="item.progress.completed" :max="item.progress.total" :aria-label="item.progress.label" :style="{ accentColor: data.presentation.light.rating_accent }" /><p class="mt-1 flex justify-between text-xs text-muted"><span>{{ item.progress.label }}</span><span>{{ item.progress.completed }}/{{ item.progress.total }}</span></p></div></DashboardSurface></div></template></UModal>
      <UModal v-model:open="showIssues" title="Recent issues"><template #body><div v-if="data.recent_issues.length" class="divide-y divide-default"><NuxtLink v-for="issue in data.recent_issues" :key="issue.id" :to="{ path: metricLink('quality/overall-rating'), query: { review: issue.id } }" class="block py-4"><p class="font-semibold">{{ issue.line }}</p><p class="text-sm text-muted">{{ issue.author }} · {{ issue.rating }} stars</p><p v-if="issue.content" class="mt-2 text-sm">{{ issue.content }}</p></NuxtLink></div><p v-else class="text-muted">No recent issues in this period.</p></template></UModal>
    </template>
  </div>
</template>

<script setup lang="ts">
import DashboardSurface from '~/components/dashboard/DashboardSurface.vue'
import { insightsOverviewSchema, type InsightsOverview } from '~/shared/insights'
const route = useRoute()
const api = useDashboardApi()
const days = ref('7')
const ranges = [{ days: '7', label: 'Last 7 days' }, { days: '30', label: 'Last 30 days' }, { days: '365', label: 'Last 365 days' }]
const showAll = ref(false), showIssues = ref(false), showIndex = ref(false)
const { data: reading, error, status } = await useAsyncData(() => `insights-overview:${route.params.org_slug}:${days.value}`, async () => {
  const organization = String(route.params.org_slug)
  const overview = await api<InsightsOverview>('/api/dashboard/insights/overview', { query: { days: days.value }, validate: (value): value is InsightsOverview => insightsOverviewSchema.safeParse(value).success })
  return { organization, overview }
})
const data = computed(() => reading.value?.organization === String(route.params.org_slug) ? reading.value.overview : null)
const metricLink = (page: string) => `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/insights/${page}`
</script>

<style>
.performance-overview { background: var(--overview-light); color: var(--overview-text-light); --ui-text-muted: var(--overview-secondary-light); }
.dark .performance-overview { background: var(--overview-dark); color: var(--overview-text-dark); --ui-text-muted: var(--overview-secondary-dark); }
</style>
