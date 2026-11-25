<template>
  <DashboardLeafPanel
    id="product-team"
    :title="p.product.value?.kind === 'stay' ? p.sectionLabels.team : 'Listing access'"
    :lead="p.product.value?.kind === 'stay' ? 'Choose the host responsible for this home’s stays and guest conversations.' : undefined"
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :save-label="p.saveLabel.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <ResponsibilityPicker v-if="p.isNew.value || p.product.value?.kind === 'stay'" v-model:member-id="p.form.stay_member_id" :organization-id="p.organizationId" :disabled="p.saving.value" required />
    <section v-if="canManageAccess" class="mt-8 space-y-4 border-t border-default pt-6" aria-labelledby="guest-messaging-access">
      <h2 id="guest-messaging-access" class="font-semibold text-highlighted">Listing access</h2>
      <UAlert v-if="accessError || saveAccessError" color="error" variant="soft" :description="saveAccessError || getErrorMessage(accessError, 'Listing access could not be loaded')" />
      <p v-else-if="accessPending" class="text-sm text-muted" role="status">Loading access…</p>
      <ul v-if="access" class="divide-y divide-default">
        <li v-for="member in cohosts" :key="member.member_id" class="py-3">
          <UFormField :label="member.name" :description="member.email">
            <USelect
              :model-value="access.grants.find(grant => grant.member_id === member.member_id)?.access ?? 'none'"
              :items="accessChoices(member)"
              :loading="savingAccess === member.member_id"
              :disabled="savingAccess !== null"
              @update:model-value="value => setAccess(member.member_id, value)"
            />
          </UFormField>
        </li>
      </ul>
    </section>
    <!-- Who cleans this home: its cleaners in order (#2091). A new clean goes to the first; Can't do it hands it to the next, then to the host. -->
    <section v-if="cleaning" class="mt-8 space-y-4 border-t border-default pt-6" aria-labelledby="home-cleaning" data-testid="home-cleaning">
      <h2 id="home-cleaning" class="font-semibold text-highlighted">Cleaning</h2>
      <UAlert v-if="cleaningError" color="error" variant="soft" :description="cleaningError" />
      <p v-if="!cleaning.cleaner_ids.length" class="text-sm text-muted">No cleaner on this home’s team yet: cleans go to {{ cleaning.host.name }}. Give a member with the Cleaner role Tasks access above.</p>
      <template v-else>
        <ol class="divide-y divide-default">
          <li v-for="(id, index) in cleaning.cleaner_ids" :key="id" class="flex items-center gap-3 py-3">
            <span class="w-6 text-sm text-muted">{{ index + 1 }}</span>
            <span class="flex-1 text-base text-highlighted">{{ cleaning.members.find(member => member.member_id === id)?.name ?? id }}</span>
            <UButton icon="i-lucide-arrow-up" color="neutral" variant="ghost" square size="sm" :disabled="index === 0 || savingCleaning" :aria-label="`Move up`" @click="moveCleaner(index, -1)" />
            <UButton icon="i-lucide-arrow-down" color="neutral" variant="ghost" square size="sm" :disabled="index === cleaning.cleaner_ids.length - 1 || savingCleaning" :aria-label="`Move down`" @click="moveCleaner(index, 1)" />
          </li>
        </ol>
        <p class="text-sm text-muted">Each clean goes to the first. Can’t do it hands it to the next, then to {{ cleaning.host.name }}.</p>
        <SettingRow :model-value="cleaning.offer_cleans_to_all" label="Offer each clean to all cleaners" description="The first to accept takes it" :disabled="savingCleaning" @update:model-value="(value: boolean) => saveCleaning({ offer_cleans_to_all: value })" />
      </template>
    </section>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import ResponsibilityPicker from '~/components/dashboard/ResponsibilityPicker.vue'
import { getErrorMessage } from '~/utils/errors'
import { isOrganizationRole, listingAccessLevels, organizationRoleCards, type StoredListingAccess } from '~/utils/organization-access'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const dashboard = useDashboardOrganization()
const listingId = computed(() => p.product.value?.id)
const canManageAccess = computed(() => Boolean(p.product.value && ['stay', 'table', 'service', 'experience'].includes(p.product.value.kind)) && (dashboard.organization.value?.role ?? '').split(',').includes('owner'))
const grantPath = computed(() => `/api/messages/listings/${encodeURIComponent(listingId.value ?? '')}/participants`)
const grantQuery = computed(() => ({ organization_id: dashboard.organizationId.value }))
const { data: people, error: peopleError } = await useMemberSchedulingList(() => p.organizationId)

function isGrantList(value: unknown): value is { staff_access_writes: boolean; grants: Array<{ member_id: string; access: StoredListingAccess }> } {
  return isRecord(value) && typeof value.staff_access_writes === 'boolean' && Array.isArray(value.grants) && value.grants.every(grant => isRecord(grant) && typeof grant.member_id === 'string'
    && typeof grant.access === 'string' && (grant.access === 'messaging' || Object.hasOwn(listingAccessLevels, grant.access)))
}

const { data: access, pending: accessPending, error: accessError } = await useWebsiteIndexData(
  () => `listing-messaging-access:${grantQuery.value.organization_id}:${listingId.value}`,
  async (signal) => {
    if (!canManageAccess.value || !listingId.value) return null
    const grants = await applicationFetch(grantPath.value, { query: grantQuery.value, signal, validate: isGrantList })
    if (peopleError.value) throw peopleError.value
    if (!people.value) throw new Error('Listing access members could not be read')
    return { ...grants, members: people.value.members.map(member => ({ member_id: member.id, id: member.user_id,
      name: member.user_name, email: member.email, image: member.image, role: member.role })) }
  },
)
const cohosts = computed(() => access.value?.members.filter(member => accessChoices(member).length > 1) ?? [])
function accessChoices(member: { member_id: string; role: string }) {
  const saved = access.value?.grants.find(grant => grant.member_id === member.member_id)?.access
  const roles = member.role.split(',').map(role => role.trim()).filter(isOrganizationRole)
  const writes = access.value?.staff_access_writes
  const levels = new Set(writes ? roles.flatMap(role => organizationRoleCards[role].access) : [])
  const messaging = saved === 'messaging' || (!writes && roles.some(role => role === 'owner' || role === 'admin' || role === 'member'))
  return [{ value: 'none', label: 'No additional access' }, ...[...levels].map(value => ({ value, label: listingAccessLevels[value] })),
    ...(messaging ? [{ value: 'messaging', label: 'Messaging' }] : []),
    ...(!writes && saved && saved !== 'messaging' ? [{ value: saved, label: listingAccessLevels[saved] }] : [])]
}
// Who cleans the home, for its owners and admins.
type HomeTeam = { host: { name: string }; members: Array<{ member_id: string; name: string }>; cleaner_ids: string[]; offer_cleans_to_all: boolean }
const isHomeTeam = (value: unknown): value is { team: HomeTeam } => isRecord(value) && isRecord(value.team) && Array.isArray(value.team.cleaner_ids) && typeof value.team.offer_cleans_to_all === 'boolean'
const dashboardApi = useDashboardApi()
const cleaningPath = computed(() => `/api/dashboard/stay-homes/${encodeURIComponent(listingId.value ?? '')}/cleaning`)
const { data: cleaningRead, error: cleaningReadError } = await useAsyncData(() => `home-cleaning:${listingId.value}`,
  async () => p.product.value?.kind === 'stay' && listingId.value ? (await dashboardApi(cleaningPath.value, { validate: isHomeTeam })).team : null)
const cleaning = ref<HomeTeam | null>(null)
watch(cleaningRead, value => { cleaning.value = value ?? null }, { immediate: true })
const savingCleaning = ref(false)
const cleaningError = ref(cleaningReadError.value ? getErrorMessage(cleaningReadError.value, 'Who cleans this home could not be loaded') : '')
async function saveCleaning(body: { cleaner_ids?: string[]; offer_cleans_to_all?: boolean }) {
  savingCleaning.value = true
  cleaningError.value = ''
  try {
    cleaning.value = (await dashboardApi(cleaningPath.value, { method: 'PUT', body, validate: isHomeTeam })).team
  } catch (cause) {
    cleaningError.value = getErrorMessage(cause, 'Who cleans this home could not be saved')
  } finally {
    savingCleaning.value = false
  }
}
function moveCleaner(index: number, by: number) {
  if (!cleaning.value) return
  const order = [...cleaning.value.cleaner_ids]
  const [moved] = order.splice(index, 1)
  order.splice(index + by, 0, moved!)
  void saveCleaning({ cleaner_ids: order })
}
const savingAccess = ref<string | null>(null)
const saveAccessError = ref('')
async function setAccess(memberId: string, value: string) {
  if (!access.value || savingAccess.value !== null) return
  savingAccess.value = memberId
  saveAccessError.value = ''
  try {
    const saved = await applicationFetch(grantPath.value, {
      method: 'PUT', query: grantQuery.value, body: { member_id: memberId, access: value === 'none' ? null : value },
      validate: isGrantList,
    })
    if ((saved.grants.find(grant => grant.member_id === memberId)?.access ?? 'none') !== value) throw new Error('The server did not confirm the access change')
    Object.assign(access.value, saved)
    // A cleaner added or removed changes who cleans the home.
    if (cleaning.value) cleaning.value = (await dashboardApi(cleaningPath.value, { validate: isHomeTeam })).team
  } catch (cause) {
    saveAccessError.value = getErrorMessage(cause, 'Listing access could not be saved')
  } finally {
    savingAccess.value = null
  }
}
</script>
