<template>
  <div class="space-y-6">

    <!--
      Airbnb's hosting Menu leads with two square cards — Earnings and Insights,
      each a title, a subline and one figure. The account's Menu carries Past
      activity the same way, as its profile carries Past trips.
    -->
    <UAlert v-if="cardsError" color="error" variant="soft" :title="cardsError" data-testid="dashboard-menu-error" />

    <div v-if="cards.length" class="flex flex-wrap gap-3">
      <DashboardSurface
        v-for="card in cards"
        :key="card.testId"
        as="div"
        :presentation="menu?.presentation ?? dashboardPresentation"
        class="relative flex min-h-46 min-w-min max-w-full flex-[1_1_160px] flex-col gap-1"
        :data-testid="card.testId"
      >
        <NuxtLink :to="card.to" prefetch-on="interaction" class="font-semibold after:absolute after:inset-0 after:rounded-2xl">{{ card.label }}</NuxtLink>
        <p class="mt-1 text-sm text-muted">{{ card.subline }}</p>
        <p v-if="card.figure" class="mt-auto break-normal font-semibold tracking-tight text-highlighted" :style="{ fontSize: `${(menu?.presentation ?? dashboardPresentation).value_size}px` }">{{ card.figure }}</p>
        <!-- Airbnb stacks the listings' photos in the card's corner; the organization's places, or the account's past visits. -->
        <span v-if="card.photos.length" class="mt-auto flex items-center">
          <img v-for="(photo, index) in card.photos.slice(0, 3)" :key="photo" :src="photo" alt="" class="size-12 rounded-xl border-2 border-elevated object-cover" :class="index ? '-ml-3' : ''">
          <span v-if="card.photos.length > 3" class="-ml-3 flex size-12 items-center justify-center rounded-xl border-2 border-elevated bg-default text-sm font-semibold text-highlighted">+{{ card.photos.length - 3 }}</span>
        </span>
        <div v-else-if="card.bars.length" class="mt-auto flex h-10 items-end gap-1" aria-hidden="true"><span v-for="(amount, index) in card.bars" :key="index" class="min-w-0 flex-1 rounded-t-sm" :style="{ height: `${Math.max(1, amount / Math.max(1, ...card.bars) * 100)}%`, background: 'var(--surface-accent)' }" /></div>
        <UIcon v-else-if="!card.figure" :name="card.icon" class="mt-auto size-7 text-muted" />
      </DashboardSurface>
    </div>

    <!-- Airbnb's "Create a new listing": the first thing the plan lacks, offered once, to someone who can take it. -->
    <OfferCard v-if="offer" :offer="offer" />

    <!-- PWA install banner: shown only on browsers offering an install prompt -->
    <div
      v-if="canInstall"
      class="flex items-center justify-between gap-4 rounded-2xl bg-elevated p-5 sm:p-6"
      data-testid="pwa-install-banner"
    >
      <div class="flex min-w-0 items-center gap-4">
        <span class="flex size-12 shrink-0 items-center justify-center rounded-xl bg-accented" aria-hidden="true">
          <UIcon name="i-lucide-smartphone" class="size-6 text-highlighted" />
        </span>
        <div class="min-w-0">
          <p class="text-base font-semibold text-highlighted">Install Blawby app</p>
          <p class="mt-0.5 text-sm text-muted">Add to home screen for full-screen access</p>
        </div>
      </div>
      <UButton
        size="md"
        color="neutral"
        variant="solid"
        label="Install"
        data-testid="pwa-install-button"
        @click="promptInstall"
      />
    </div>

    <EditorNavigationList :groups="groups" :active-item="activeItem" @act="onAct" />
  </div>
</template>

<script setup lang="ts">
import DashboardSurface from '~/components/dashboard/DashboardSurface.vue'
import { dashboardPresentation } from '~/shared/dashboard-presentation'
import EditorNavigationList from '~/components/dashboard/EditorNavigationList.vue'
import OfferCard from '~/components/dashboard/OfferCard.vue'
import { planOffers } from '~/shared/offers'
import { isAccountActivityResponse, type AccountActivityResponse } from '~/shared/account-activity'
import { readActiveWebsiteDraft } from '~/composables/useOnboardingDraft'

// Rendered by both the desktop slideover and the mobile menu page, off one
// model, so the two surfaces cannot show different menus.
const { scopeModel, logOut, personal, organization } = useDashboardMenu()
const { canInstall, promptInstall } = usePwaInstall()
const dashboard = useDashboardOrganization()
// Only the routed organization's plan is loaded here; the active one reached from Account settings is not offered anything.
const offer = computed(() => dashboard.organization.value && dashboard.canUpdateBilling.value ? planOffers(dashboard.entitlements.value)[0] ?? null : null)
// The shell's organization, whichever route it is drawn on — Account settings included.
const orgBase = computed(() => organization.value ? `/dashboard/${encodeURIComponent(organization.value.slug)}` : null)
const inOrganization = computed(() => Boolean(orgBase.value))
const setup = useAsyncData('personal-menu-website-setup', () => readActiveWebsiteDraft(), { enabled: personal })
const resumeAction = computed(() => setup.data.value?.resume_action)
const organizationSettings = useOrganizationSettingsNavigation(organization, scopeModel, resumeAction)
const { groups, activeItem } = organizationSettings
await Promise.all([organizationSettings.ready, setup])
// Menu cards, ratings and chart context arrive in one authorized D1 batch.
const { menu, menuStatus, error: menuError } = organizationSettings
const { data: activity, error: activityError } = await useAsyncData(
  () => `menu-activity:${personal.value}`,
  async () => personal.value ? await applicationFetch<AccountActivityResponse>('/api/account', { validate: isAccountActivityResponse }) : null,
)
// A card whose figure or photos could not be read says so, never an empty card standing in for one.
const cardsError = computed(() => {
  const error = organizationSettings.error.value ?? setup.error.value ?? menuError.value ?? activityError.value
  return error ? getErrorMessage(error, 'The Menu could not be loaded.') : null
})
const visitPhotos = computed(() => (activity.value?.activities ?? []).filter(item => item.image_url && (item.status === 'cancelled' || (item.ends_at && Date.parse(item.ends_at) < Date.now()) || item.kind === 'payment')).map(item => item.image_url as string))
const cards = computed(() => personal.value
  ? [
      { to: '/dashboard/account/activity', label: 'Past activity', subline: 'Visits and purchases', icon: 'i-lucide-history', figure: '', photos: visitPhotos.value, bars: [] as number[], testId: 'dashboard-menu-past-activity' },
      { to: '/dashboard/account/profile/payments', label: 'Payments', subline: 'Payments and refunds', icon: 'i-lucide-credit-card', figure: '', photos: [] as string[], bars: [] as number[], testId: 'dashboard-menu-payments' },
    ]
  : inOrganization.value
    ? (menuStatus.value === 'success' && menu.value && menu.value.organizationId === organization.value?.id ? menu.value.cards : []).map(card => ({ to: `${orgBase.value}/${card.id}`, label: card.title, subline: card.detail, icon: card.id === 'earnings' ? 'i-lucide-chart-no-axes-column' : 'i-lucide-star', figure: card.value, photos: card.photos, bars: card.bars, testId: `dashboard-menu-${card.id}` }))
    : [])

// Airbnb's "Switch to hosting" / "Switch to travelling" is a row above Log out, not a picker.
function onAct(id: string) {
  if (id === 'log-out') void logOut()
  // Personal is the one peer without an organization id.
  if (id === 'switch-personal') scopeModel.value?.peers.find(peer => !peer.id)?.onSelect?.()
  if (id === 'switch-organization') scopeModel.value?.peers.find(peer => peer.id)?.onSelect?.()
}


</script>
