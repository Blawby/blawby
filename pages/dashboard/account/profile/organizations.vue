<template>
  <!--
    Every organization this account belongs to. A row puts you in it — Better
    Auth's active organization, then its dashboard — with no screen between.
    Deleting is the list's own edit state, offered on the rows Better Auth lets
    this account delete; a new organization starts here.
  -->
  <DashboardIndexPanel id="account-organizations" title="Organizations">
    <UAlert v-if="marksError" class="mb-6" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(marksError, 'Organization details could not be loaded.')">
      <template #actions><UButton color="error" variant="soft" size="xs" @click="() => refreshOrganizations()">Retry</UButton></template>
    </UAlert>
    <DashboardListEditor v-if="marksData"
      v-model:editing="editing"
      title="Organizations"
      :items="items"
      empty-title="No organizations yet"
      empty-illustration="/images/offers/home.webp"
      :add-label="createAction?.label"
      :addable="Boolean(createAction && !resumeAction)"
      :add-to="createAction?.to"
      :read-only="!deletable.size"
      @remove="openDelete"
    >
      <template #item="{ item }">
        <!-- The organization the session is already in is a link; any other tells Better Auth first. -->
        <component
          :is="item.to ? 'span' : 'button'"
          :type="item.to ? undefined : 'button'"
          :disabled="item.to ? undefined : editing"
          class="flex w-full items-center gap-4 text-left"
          :data-testid="`account-organization-${item.id}`"
          @click="enter(item)"
        >
          <UAvatar :src="item.image ?? undefined" :alt="item.title" icon="i-lucide-building-2" size="lg" />
          <span class="min-w-0">
            <span class="block truncate text-sm font-medium text-highlighted">{{ item.title }}</span>
            <span v-if="item.description" class="block truncate text-sm text-muted">{{ item.description }}</span>
          </span>
        </component>
      </template>
    </DashboardListEditor>
    <UButton v-if="createAction && (resumeAction || !deletable.size)" class="mt-6" color="neutral" variant="soft"
      :icon="resumeAction ? 'i-lucide-arrow-right' : 'i-lucide-plus'" :trailing="Boolean(resumeAction)" :label="createAction.label" :to="createAction.to" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import DashboardListEditor from '~/components/dashboard/DashboardListEditor.vue'
import { dashboardScopeHeaderModelKey } from '~/lib/components/workspace/dashboard/dashboardScopeHeaderContext'
import { organizationRoleLabel } from '~/utils/organization-access'
import { getVerticalLabel } from '~/utils/vertical-copy'
import { WEBSITE_ONBOARDING_PATH, type WebsiteSetupAction } from '~/shared/onboarding-flow'
import { onboardingLink } from '~/composables/useOnboardingFlow'

definePageMeta({ layout: 'dashboard' })

const level = useRouteLevel()
const route = useRoute()
const model = inject(dashboardScopeHeaderModelKey)!
const editing = ref(false)
const organizations = computed(() => model.value.peers.filter((peer): peer is typeof peer & { id: string } => Boolean(peer.id) && marks.value.has(peer.id!)).map(peer => ({...peer,label:marks.value.get(peer.id)!.name})))
// Each organization's mark, as Airbnb's listing rows carry their picture, and what it is to this account: `Vacation rental · Owner`.
type OrganizationMark = { id: string; name: string; image_url: string | null; vertical: string; role: string; can_delete: boolean }
type WorkspaceScreen = { organizations: OrganizationMark[]; website_setup_action: WebsiteSetupAction | null }
const isOrganizationList = (value: unknown): value is WorkspaceScreen => isRecord(value) && Array.isArray(value.organizations)
  && value.organizations.every(row => isRecord(row) && typeof row.id === 'string' && typeof row.name === 'string' && (row.image_url === null || typeof row.image_url === 'string') && typeof row.vertical === 'string' && typeof row.role === 'string' && typeof row.can_delete === 'boolean')
  && (value.website_setup_action === null || isRecord(value.website_setup_action) && typeof value.website_setup_action.label === 'string' && value.website_setup_action.to === WEBSITE_ONBOARDING_PATH && (value.website_setup_action.kind === 'create' || value.website_setup_action.kind === 'resume'))
const {data:marksData,error:marksError,refresh:refreshOrganizations} = await useAsyncData('account-organizations',()=>applicationFetch<WorkspaceScreen>('/api/account/organizations',{query:{view:'workspaces'},validate:isOrganizationList}))
const deletable = computed(()=>new Set(marksData.value?.organizations.filter(row=>row.can_delete).map(row=>row.id) ?? []))
const marks = computed(() => new Map((marksData.value?.organizations ?? []).map(row => [row.id, row])))
const items = computed(() => organizations.value.map(organization => ({
  id: organization.id,
  title: organization.label,
  image: marks.value.get(organization.id)?.image_url ?? null,
  description: describe(marks.value.get(organization.id)),
  to: organization.to,
  select: () => organization.onSelect?.(),
  removable: deletable.value.has(organization.id),
})))
const resumeAction = computed(() => marksData.value?.website_setup_action?.kind === 'resume' ? marksData.value.website_setup_action : null)
const createAction = computed(() => {
  const action = marksData.value?.website_setup_action
  return action ? { ...action, to: onboardingLink(action.to, route.fullPath) } : null
})

function describe(mark: OrganizationMark | undefined) {
  return mark ? `${getVerticalLabel(mark.vertical)} · ${organizationRoleLabel(mark.role)}` : null
}

type Row = (typeof items.value)[number]
function enter(row: Row) {
  if (!row.to && !editing.value) row.select()
}
async function openDelete(row: Row) {
  await navigateTo(`${level.path.value}/${encodeURIComponent(row.id)}/delete`)
}
</script>
