import type { EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import type { DashboardScopeHeaderModel } from '~/lib/components/workspace/dashboard/DashboardScopeHeader.vue'
import { dashboardMenuSchema, type DashboardMenu } from '~/shared/dashboard-menu'
import { dashboardFetch } from '~/composables/dashboardFetch'
import { onboardingLink } from '~/composables/useOnboardingFlow'
import type { WebsiteOnboardingResumeAction } from '~/shared/onboarding-flow'

// The rows on Menu. Menu is a launcher: every row is a destination of its own
// — Website, Posts, Locations, Team, Plan and billing — or an action, with no headings. The Menu
// page and the desktop slideover render this one list, so a row exists in one
// place. A destination is not nested under Menu; it names Menu as its tab.
//
// The organization is the shell's (useDashboardMenu): the route's, otherwise
// Better Auth's active one, so Account settings opened from inside an
// organization keeps that organization's Menu.
export function useOrganizationSettingsNavigation(
  organization: Ref<{ id: string; slug: string } | null>,
  scopeModel: Readonly<Ref<DashboardScopeHeaderModel | null>>,
  resumeAction?: Readonly<Ref<WebsiteOnboardingResumeAction | null | undefined>>,
) {
  const route = useRoute()
  const router = useRouter()

  const base = computed(() => organization.value ? `/dashboard/${encodeURIComponent(organization.value.slug)}` : null)

  const permissionLoad = useAsyncData(
    () => `dashboard-menu:${organization.value?.id ?? ''}`,
    async (_app, { signal }) => {
      const target = organization.value
      if (!target) return null
      return { ...await dashboardFetch<DashboardMenu>('/api/dashboard/menu', { orgSlug: target.slug }, { signal, validate: (value): value is DashboardMenu => dashboardMenuSchema.safeParse(value).success }), organizationId: target.id }
    }, { dedupe: 'defer' },
  )
  const permissions = computed(() => permissionLoad.data.value?.organizationId === organization.value?.id ? permissionLoad.data.value?.permissions ?? null : null)

  // Airbnb's "Switch to hosting": one organization switches straight to it;
  // several open the list under Account settings; none offers to start one.
  const switchRow = computed(() => {
    const organizations = (scopeModel.value?.peers ?? []).filter(peer => peer.id)
    if (organizations.length === 1) return organizations[0]!.to ? { id: 'switch-organization', icon: 'i-lucide-repeat-2', label: `Switch to ${organizations[0]!.label}`, to: organizations[0]!.to } : { id: 'switch-organization', icon: 'i-lucide-repeat-2', label: `Switch to ${organizations[0]!.label}`, action: {} }
    if (organizations.length > 1) return { id: 'switch-organization', icon: 'i-lucide-repeat-2', label: 'Switch to an organization', to: '/dashboard/account/profile/organizations' }
    const action = resumeAction?.value ?? scopeModel.value?.createAction
    return action ? { id: 'switch-organization', icon: resumeAction?.value ? 'i-lucide-arrow-right' : 'i-lucide-plus', label: action.label, to: onboardingLink(action.to, route.fullPath) } : null
  })

  const items = computed(() => {
    if (!base.value) return [
      { id: 'account', icon: 'i-lucide-user-round-cog', label: 'Account settings', to: '/dashboard/account/profile' },
      ...(switchRow.value ? [switchRow.value] : []),
      { id: 'log-out', icon: 'i-lucide-log-out', label: 'Log out', action: {} },
    ]
    const loaded = permissionLoad.data.value
    return loaded && loaded.organizationId === organization.value?.id ? loaded.navigation : []
  })

  const groups = computed<EditorNavigationGroup[]>(() => [{ id: organization.value ? 'organization' : 'account', items: items.value }])

  /** The row whose destination is open, for the slideover's current row. */
  const activeItem = computed(() => {
    const open = new Set(route.matched.map(record => routeRecordPath(router, record, route.params)))
    return items.value.find(item => item.to && open.has(item.to))?.id ?? null
  })

  return { groups, activeItem, permissions, error: permissionLoad.error, pending: permissionLoad.pending, ready: permissionLoad, menu: permissionLoad.data, menuStatus: permissionLoad.status }
}
