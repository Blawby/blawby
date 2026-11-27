<template>
  <!--
    Airbnb's Performance: the list of pages on the left and the page beside it,
    one screen. The list never closes; on a narrow screen it opens from the
    page's ≡ button. It lists every page the business's offerings support,
    whatever the filters are.
  -->
  <UDashboardPanel id="organization-insights" class="dashboard-themed" :style="dashboardThemeStyle(dashboardPresentation)" :ui="{ body: 'p-0 sm:p-0 gap-0' }">
    <template #body>
      <InsightsOverview v-if="!current" />
      <template v-else>
      <DefineList>
        <UAlert v-if="error" color="error" variant="soft" title="Insights could not be loaded" :description="getErrorMessage(error, 'Insights request failed')" />
        <nav v-else aria-label="Insights pages" class="space-y-3" data-testid="insights-pages">
          <div v-for="section in sections" :key="section.id">
            <p class="px-3 py-2 font-medium text-highlighted">{{ section.title }}</p>
            <ul class="space-y-1">
              <li v-for="page in section.pages" :key="page.id">
                <NuxtLink
                  :to="pageLink(page.id)"
                  class="block rounded-full px-4 py-2 text-sm"
                  :class="current === page.id ? 'bg-inverted text-inverted' : 'text-muted hover:bg-elevated hover:text-highlighted'"
                  :aria-current="current === page.id ? 'page' : undefined"
                  :data-testid="`insights-page-${page.id.replace('/', '-')}`"
                  @click="listOpen = false"
                >
                  {{ page.title }}
                </NuxtLink>
              </li>
            </ul>
          </div>
        </nav>
      </DefineList>
      <div class="grid min-h-full" :class="sections.length ? 'md:grid-cols-[16rem_minmax(0,1fr)]' : undefined">
        <aside v-if="sections.length" class="hidden border-e border-default px-3 py-6 md:block">
          <NuxtLink :to="`/dashboard/${route.params.org_slug}/insights`" class="mb-4 block px-3 text-2xl font-semibold text-highlighted">Performance</NuxtLink>
          <ReuseList />
        </aside>
        <div class="min-w-0">
          <NuxtPage :document="document" :failure="error" />
        </div>
      </div>
      <USlideover v-model:open="listOpen" side="left" title="Insights" :ui="{ content: 'max-w-xs' }">
        <template #body>
          <ReuseList />
        </template>
      </USlideover>
      </template>
    </template>
  </UDashboardPanel>
</template>

<script setup lang="ts">
import { dashboardPresentation, dashboardThemeStyle } from '~/shared/dashboard-presentation'
import InsightsOverview from '~/components/dashboard/InsightsOverview.vue'
import { createReusableTemplate } from '@vueuse/core'
import { insightsPageSchema, type InsightsPage, type InsightsPageId } from '~/shared/insights'
import { insightsListKey } from '~/composables/useInsightsRead'

definePageMeta({ layout: 'dashboard', tab: 'menu', back: 'menu' })

const [DefineList, ReuseList] = createReusableTemplate()
const route = useRoute()
const dashboardApi = useDashboardApi()
const recentOrRead = useInsightsRead()
const current = computed(() => route.params.section && route.params.page ? `${String(route.params.section)}/${String(route.params.page)}` : null)
const queryText = (name: string) => typeof route.query[name] === 'string' && route.query[name] ? route.query[name] as string : undefined
const filters = computed(() => ({ kind: queryText('kind'), location_id: queryText('location_id'), start_date: queryText('start_date'), end_date: queryText('end_date') }))
const readKey = computed(() => `${String(route.params.org_slug)}:${current.value}:${JSON.stringify(filters.value)}`)
const isPage = (value: unknown): value is InsightsPage => insightsPageSchema.safeParse(value).success
const { data, error, status } = await useAsyncData(
  () => `insights-detail:${readKey.value}`,
  async () => {
    const key = readKey.value
    const page = await recentOrRead(key, () => dashboardApi<InsightsPage>(`/api/dashboard/insights/${current.value}`, { query: filters.value, validate: isPage }), isPage)
    return { key, page }
  },
  { enabled: () => Boolean(current.value), watch: [current] },
)
const document = computed(() => status.value === 'success' && data.value?.key === readKey.value ? data.value.page : null)

const listOpen = ref(false)
provide(insightsListKey, () => { listOpen.value = true })


const sections = computed(() => document.value?.index?.sections ?? [])

/** A page keeps the date range; the offering chosen and the number shown belong to the page left. */
function pageLink(id: InsightsPageId) {
  return { path: `/dashboard/${String(route.params.org_slug)}/insights/${id}`, query: { start_date: route.query.start_date, end_date: route.query.end_date } }
}

useSeoMeta({ title: 'Insights', robots: 'noindex, nofollow' })
</script>
