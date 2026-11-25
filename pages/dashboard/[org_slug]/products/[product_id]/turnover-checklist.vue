<template>
  <DashboardLeafPanel
    id="product-turnover-checklist"
    title="Turnover checklist"
    lead="What a clean must leave. Done asks the cleaner for each item, with a photo where you need one."
    desktop-cancel
    :saving="saving"
    :disabled="!manage || !changed || saving"
    :error="error ?? ''"
    @cancel="revert"
    @save="save"
  >
    <template v-if="draft">
      <ul v-if="draft.length" class="divide-y divide-default">
        <li v-for="(item, index) in draft" :key="item.key" class="flex items-start gap-4 py-5" data-testid="turnover-checklist-item">
          <img v-if="item.reference_photo" :src="item.reference_photo.thumbnail_url" alt="" class="size-14 shrink-0 rounded-lg object-cover">
          <span v-else class="flex size-14 shrink-0 items-center justify-center rounded-lg bg-elevated"><UIcon :name="item.type === 'count' ? 'i-lucide-hash' : 'i-lucide-check'" class="size-6 text-muted" /></span>
          <button type="button" class="min-w-0 flex-1 text-left" :disabled="!manage || saving" @click="openItem(index)">
            <p class="text-base font-medium text-highlighted">{{ item.title }}</p>
            <p class="mt-1 text-sm text-muted">{{ itemSummary(item) }}</p>
          </button>
          <div v-if="manage" class="flex shrink-0 gap-1">
            <UButton icon="i-lucide-arrow-up" color="neutral" variant="ghost" square size="sm" :disabled="index === 0 || saving" :aria-label="`Move ${item.title} up`" @click="move(index, -1)" />
            <UButton icon="i-lucide-arrow-down" color="neutral" variant="ghost" square size="sm" :disabled="index === draft.length - 1 || saving" :aria-label="`Move ${item.title} down`" @click="move(index, 1)" />
          </div>
        </li>
      </ul>
      <p v-else class="text-base text-muted">No checklist yet. Done stays one tap until you add an item.</p>
      <div v-if="manage" class="mt-6 flex flex-col gap-3">
        <UButton label="Add item" icon="i-lucide-plus" color="neutral" variant="outline" class="w-full justify-center rounded-xl py-4" :disabled="saving || draft.length >= CHECKLIST_LIMITS.items" data-testid="turnover-checklist-add" @click="openItem(null)" />
        <UButton v-if="saved?.items.length && otherHomes.length" label="Copy to other homes" icon="i-lucide-copy" color="neutral" variant="ghost" class="w-full justify-center" :disabled="saving || changed" @click="copyOpen = true" />
      </div>
    </template>

    <DashboardListItemDialog v-model:open="itemOpen" :title="editing === null ? 'Add item' : 'Edit item'" :removable="editing !== null" :save-disabled="!itemValid || uploading" :error="itemError" save-label="Done" @save="commitItem" @remove="removeItem">
      <div v-if="item" class="flex flex-col gap-5">
        <UFormField label="Item" required>
          <UInput v-model="item.title" :maxlength="CHECKLIST_LIMITS.title" placeholder="Bath towels" class="w-full" autofocus />
        </UFormField>
        <UFormField label="Instructions" hint="Optional">
          <UTextarea :model-value="item.instructions ?? ''" variant="none" :maxlength="CHECKLIST_LIMITS.instructions" placeholder="Folded on the bed, one set per guest" :rows="2" class="w-full" @update:model-value="value => item!.instructions = value ? String(value) : null" />
        </UFormField>
        <URadioGroup v-model="item.type" variant="card" :items="[{ value: 'confirm', label: 'Done or not' }, { value: 'count', label: 'A number to count' }]" />
        <template v-if="item.type === 'count'">
          <SettingRow v-model="item.per_guest" label="Per arriving guest" description="Counted against the guests arriving next" />
          <UFormField :label="item.per_guest ? 'Per guest' : 'At least'">
            <UInputNumber v-model="item.minimum" :min="0" :max="CHECKLIST_LIMITS.count" class="w-full" />
          </UFormField>
          <UFormField v-if="item.per_guest" label="When no arrival is booked">
            <UInputNumber v-model="item.baseline" :min="0" :max="CHECKLIST_LIMITS.count" class="w-full" />
          </UFormField>
        </template>
        <SettingRow v-model="item.photo_required" label="Photo required" description="Done waits for a photo of this item" />
        <div>
          <p class="text-base font-medium text-highlighted">Reference photo</p>
          <p class="mt-1 text-sm text-muted">How it should look. Only your team sees it.</p>
          <div class="mt-3 flex items-center gap-3">
            <img v-if="item.reference_photo" :src="item.reference_photo.thumbnail_url" alt="" class="size-20 rounded-lg object-cover">
            <UButton :label="item.reference_photo ? 'Replace' : 'Add photo'" icon="i-lucide-image-plus" color="neutral" variant="outline" :loading="uploading" @click="pickReference" />
            <UButton v-if="item.reference_photo" label="Remove" color="neutral" variant="ghost" @click="item.reference_photo = null" />
            <input ref="referenceInput" type="file" accept="image/*" class="hidden" @change="uploadReference">
          </div>
        </div>
      </div>
    </DashboardListItemDialog>

    <DashboardListItemDialog v-model:open="copyOpen" title="Copy checklist" :saving="copying" :save-disabled="!copyTargets.length" save-label="Copy" :error="copyError" @save="copy">
      <p class="mb-4 text-sm text-muted">Each home you choose gets this checklist in place of its own.</p>
      <UCheckboxGroup v-model="copyTargets" :items="otherHomes" />
    </DashboardListItemDialog>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { CHECKLIST_LIMITS, isHomeTurnoverChecklist, type ChecklistPhoto, type HomeTurnoverChecklist } from '~/shared/turnover-checklist'
import { getErrorMessage } from '~/utils/errors'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
const route = useRoute()
const toast = useToast()
const dashboardApi = useDashboardApi()
const productId = computed(() => String(route.params.product_id))
const org = computed(() => String(route.params.org_slug))
const url = computed(() => `/api/dashboard/stay-homes/${encodeURIComponent(productId.value)}/turnover-checklist`)
const isRead = (value: unknown): value is { checklist: HomeTurnoverChecklist } => isRecord(value) && isHomeTurnoverChecklist(value.checklist)
const { data, error: readError } = await useAsyncData(`turnover-checklist:${org.value}:${productId.value}`, () => dashboardApi(url.value, { validate: isRead }))
const isHomes = (value: unknown): value is { homes: Array<{ product_id: string; internal_name: string }>; manage: boolean } =>
  isRecord(value) && Array.isArray(value.homes) && value.homes.every(home => isRecord(home) && typeof home.product_id === 'string' && typeof home.internal_name === 'string')
const { data: homes } = await useAsyncData(`turnover-checklist-homes:${org.value}`, () => dashboardApi('/api/dashboard/stay-homes', { query: { view: 'calendar' }, validate: isHomes }))

const manage = computed(() => p.arrivalManage.value)
const saved = computed(() => data.value?.checklist ?? null)
const otherHomes = computed(() => (homes.value?.homes ?? []).filter(home => home.product_id !== productId.value).map(home => ({ value: home.product_id, label: home.internal_name })))

type DraftItem = Omit<HomeTurnoverChecklist['items'][number], 'id'> & { id?: string; key: string }
const draft = ref<DraftItem[] | null>(null)
function revert() {
  draft.value = saved.value ? saved.value.items.map(item => ({ ...item, key: item.id })) : null
}
watch(saved, revert, { immediate: true })
const toWrite = (items: DraftItem[]) => items.map(({ key: _key, reference_photo, ...item }) => ({ ...item, instructions: item.instructions?.trim() || null, reference_photo_id: reference_photo?.id ?? null }))
const changed = computed(() => Boolean(saved.value && draft.value && JSON.stringify(toWrite(draft.value)) !== JSON.stringify(toWrite(saved.value.items.map(item => ({ ...item, key: item.id }))))))

function itemSummary(item: DraftItem): string {
  const count = item.type === 'confirm' ? 'Done or not'
    : item.per_guest ? `${item.minimum} per arriving guest · ${item.baseline} when none booked` : `At least ${item.minimum}`
  return [count, item.photo_required ? 'Photo required' : null].filter(Boolean).join(' · ')
}

const saving = ref(false)
const error = ref<string | null>(readError.value ? getErrorMessage(readError.value, 'The checklist could not be loaded') : null)
async function save() {
  if (!draft.value || saving.value) return
  saving.value = true
  error.value = null
  try {
    data.value = await dashboardApi(url.value, { method: 'PUT', body: { items: toWrite(draft.value), expected_revision: saved.value!.revision }, validate: isRead })
    await p.refreshArrival()
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The checklist could not be saved')
  } finally {
    saving.value = false
  }
}

function move(index: number, by: number) {
  if (!draft.value) return
  const items = [...draft.value]
  const [moved] = items.splice(index, 1)
  items.splice(index + by, 0, moved!)
  draft.value = items
}

// One item at a time in a sheet; it joins the draft, which Save commits whole.
const itemOpen = ref(false)
const editing = ref<number | null>(null)
const item = ref<DraftItem | null>(null)
const itemError = ref<string | null>(null)
function openItem(index: number | null) {
  editing.value = index
  item.value = index === null
    ? { key: crypto.randomUUID(), title: '', instructions: null, type: 'confirm', minimum: null, per_guest: false, baseline: null, photo_required: false, reference_photo: null }
    : { ...draft.value![index]! }
  itemError.value = null
  itemOpen.value = true
}
const itemValid = computed(() => {
  const value = item.value
  if (!value?.title.trim()) return false
  if (value.type === 'confirm') return true
  return value.minimum !== null && (!value.per_guest || value.baseline !== null)
})
function commitItem() {
  if (!item.value || !draft.value || !itemValid.value) return
  const value = item.value
  const next: DraftItem = { ...value, title: value.title.trim(), minimum: value.type === 'count' ? value.minimum : null, per_guest: value.type === 'count' && value.per_guest, baseline: value.type === 'count' && value.per_guest ? value.baseline : null }
  draft.value = editing.value === null ? [...draft.value, next] : draft.value.map((existing, index) => index === editing.value ? next : existing)
  itemOpen.value = false
}
function removeItem() {
  if (editing.value === null || !draft.value) return
  draft.value = draft.value.filter((_, index) => index !== editing.value)
  itemOpen.value = false
}

const referenceInput = useTemplateRef<HTMLInputElement>('referenceInput')
const { upload, uploading } = useMediaUpload(`/api/editor/organizations/${p.organizationId}`)
const pickReference = () => referenceInput.value?.click()
async function uploadReference(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !item.value) return
  itemError.value = null
  try {
    const uploaded = await upload(file)
    if (!uploaded) throw new Error('Only an image can be a reference photo')
    const photo: ChecklistPhoto = { id: uploaded.asset_id, url: uploaded.public_url ?? '', thumbnail_url: uploaded.thumbnail_url ?? uploaded.public_url ?? '' }
    item.value.reference_photo = photo
  } catch (cause) {
    itemError.value = getErrorMessage(cause, 'The photo could not be uploaded')
  }
}

const copyOpen = ref(false)
const copyTargets = ref<string[]>([])
const copying = ref(false)
const copyError = ref<string | null>(null)
async function copy() {
  copying.value = true
  copyError.value = null
  try {
    const result = await dashboardApi(`${url.value}/copy`, { method: 'POST', body: { product_ids: copyTargets.value },
      validate: (value: unknown): value is { product_ids: string[] } => isRecord(value) && Array.isArray(value.product_ids) })
    toast.add({ title: `Copied to ${result.product_ids.length} ${result.product_ids.length === 1 ? 'home' : 'homes'}`, color: 'success' })
    copyOpen.value = false
    copyTargets.value = []
  } catch (cause) {
    copyError.value = getErrorMessage(cause, 'The checklist could not be copied')
  } finally {
    copying.value = false
  }
}
onBeforeRouteLeave(() => revert())
</script>
