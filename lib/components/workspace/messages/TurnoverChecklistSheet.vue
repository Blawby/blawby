<template>
  <!-- Done on a turnover with a checklist: each item, its reference photo, a yes/no or a number, and a photo where required. -->
  <DashboardListItemDialog v-model:open="open" title="Turnover checklist" :saving="submitting" save-label="Done" :error="error" data-testid="turnover-checklist-sheet" @save="submit">
    <p class="mb-4 text-sm text-muted">{{ checklist.arrival_label }}</p>
    <ul class="divide-y divide-default">
      <li v-for="item in checklist.items" :key="item.id" class="py-5" :data-checklist-item="item.id">
        <div class="flex items-start gap-3">
          <button v-if="item.reference_photo" type="button" class="shrink-0" :aria-label="`How ${item.title} should look`" @click="viewer = { photos: [{ url: item.reference_photo.url }], at: 0 }">
            <img :src="item.reference_photo.thumbnail_url" alt="" class="size-16 rounded-lg object-cover">
          </button>
          <div class="min-w-0 flex-1">
            <p class="text-base font-medium text-highlighted">{{ item.title }}</p>
            <p v-if="item.instructions" class="mt-1 whitespace-pre-line text-sm text-muted">{{ item.instructions }}</p>
          </div>
        </div>
        <div class="mt-3 flex flex-wrap items-center gap-3">
          <template v-if="item.type === 'confirm'">
            <UButton label="Done" color="neutral" :variant="answers[item.id]?.confirmed === true ? 'solid' : 'outline'" @click="answers[item.id] = { confirmed: true }" />
            <UButton label="Not done" color="neutral" :variant="answers[item.id]?.confirmed === false ? 'solid' : 'outline'" @click="answers[item.id] = { confirmed: false }" />
          </template>
          <template v-else>
            <UInputNumber :model-value="answers[item.id]?.counted ?? undefined" :min="0" :max="9999" :aria-label="`${item.title} counted`" class="w-36" @update:model-value="value => answers[item.id] = { counted: value ?? undefined }" />
            <span class="text-sm text-muted">of {{ item.required }} required</span>
            <span v-if="shortage(item) > 0" class="text-sm font-medium text-error">Short by {{ shortage(item) }}</span>
          </template>
          <span class="ms-auto flex items-center gap-2">
            <img v-if="previews[item.id]" :src="previews[item.id]" alt="" class="size-12 rounded-lg object-cover">
            <UButton :label="photos[item.id] ? 'Replace photo' : item.photo_required ? 'Add photo' : 'Photo'" icon="i-lucide-camera" color="neutral" :variant="item.photo_required && !photos[item.id] ? 'solid' : 'ghost'" size="sm" @click="pick(item.id)" />
          </span>
        </div>
      </li>
    </ul>
    <UFormField label="Note" hint="Optional" class="mt-4">
      <UTextarea v-model="note" variant="none" :rows="2" placeholder="Anything the host should know" class="w-full" />
    </UFormField>
    <UButton v-if="checklist.close_without" label="Close without the checklist" color="neutral" variant="link" class="mt-4 px-0" :disabled="submitting" data-testid="turnover-checklist-close-without" @click="closeWithout" />
    <input ref="fileInput" type="file" accept="image/*" capture="environment" class="hidden" @change="chosen">
    <MessagePhotoViewer v-model="viewer" />
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'
import MessagePhotoViewer, { type MessagePhotoViewerState } from './MessagePhotoViewer.vue'
import type { TaskChecklist } from '~/shared/turnover-checklist'
import { getErrorMessage } from '~/utils/errors'

const props = defineProps<{ checklist: TaskChecklist; path: string }>()
const emit = defineEmits<{ done: [] }>()
const open = defineModel<boolean>('open', { default: false })

const answers = reactive<Record<string, { confirmed?: boolean; counted?: number }>>({})
const photos = reactive<Record<string, File>>({})
const previews = reactive<Record<string, string>>({})
const note = ref('')
const viewer = ref<MessagePhotoViewerState | null>(null)
const submitting = ref(false)
const error = ref<string | null>(null)

const shortage = (item: TaskChecklist['items'][number]) => {
  const counted = answers[item.id]?.counted
  return counted === undefined || item.required === null ? 0 : Math.max(0, item.required - counted)
}

const fileInput = useTemplateRef<HTMLInputElement>('fileInput')
let picking: string | null = null
function pick(id: string) {
  picking = id
  fileInput.value?.click()
}

/** A phone photo, made small enough to send: at most 1600px on its long side, as JPEG. */
async function shrink(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(bitmap.width * scale)
  canvas.height = Math.round(bitmap.height * scale)
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85))
  if (!blob) throw new Error(`${file.name} could not be read as a photo`)
  return new File([blob], file.name.replace(/\.[^.]+$/, '') + '.jpg', { type: 'image/jpeg' })
}

async function chosen(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file || !picking) return
  const id = picking
  error.value = null
  try {
    photos[id] = await shrink(file)
    if (previews[id]) URL.revokeObjectURL(previews[id])
    previews[id] = URL.createObjectURL(photos[id])
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The photo could not be read')
  }
}
onBeforeUnmount(() => Object.values(previews).forEach(url => URL.revokeObjectURL(url)))

async function closeWithout() {
  if (submitting.value) return
  submitting.value = true
  error.value = null
  try {
    await applicationFetch(props.path, { method: 'POST', body: note.value.trim() ? { note: note.value.trim() } : {}, validate: (value: unknown): value is { task: { status: string } } => isRecord(value) && isRecord(value.task) && value.task.status === 'done' })
    open.value = false
    emit('done')
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Done could not be saved')
  } finally {
    submitting.value = false
  }
}

// The server checks every answer and photo and names what is missing; the sheet sends what was entered.
async function submit() {
  if (submitting.value) return
  submitting.value = true
  error.value = null
  try {
    const form = new FormData()
    form.append('checklist', JSON.stringify({ items: props.checklist.items.filter(item => answers[item.id] && Object.values(answers[item.id]!).some(value => value !== undefined)).map(item => ({ id: item.id, ...answers[item.id] })) }))
    for (const [id, file] of Object.entries(photos)) form.append(`photo:${id}`, file)
    if (note.value.trim()) form.append('note', note.value.trim())
    await applicationFetch(props.path, { method: 'POST', body: form, validate: (value: unknown): value is { task: { status: string } } => isRecord(value) && isRecord(value.task) && value.task.status === 'done' })
    open.value = false
    emit('done')
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Done could not be saved')
  } finally {
    submitting.value = false
  }
}
</script>
