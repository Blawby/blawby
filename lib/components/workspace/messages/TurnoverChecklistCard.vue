<template>
  <!-- A submitted turnover checklist: progress, what is short first, each photo beside how it should look. -->
  <div class="w-full max-w-md rounded-3xl bg-default p-4 shadow-sm ring-1 ring-default" data-testid="turnover-checklist-card">
    <p class="text-sm text-muted">Turnover checklist · {{ checklist.arrival_label }}</p>
    <p class="mt-0.5 text-base font-semibold text-highlighted">{{ checklist.summary }}</p>
    <UProgress :model-value="done" :max="checklist.items.length" size="sm" class="mt-3" :color="done === checklist.items.length ? 'success' : 'warning'" />
    <ul class="mt-3 divide-y divide-default">
      <li v-for="item in checklist.items" :key="item.id" class="py-3" :data-checklist-item="item.id" :data-flagged="item.flagged || undefined">
        <div class="flex items-start justify-between gap-3">
          <p class="text-sm font-medium text-highlighted">{{ item.title }}</p>
          <p class="shrink-0 text-sm" :class="item.flagged ? 'font-medium text-error' : 'text-muted'">{{ result(item) }}</p>
        </div>
        <div v-if="item.photo || item.reference_photo" class="mt-2 grid grid-cols-2 gap-2">
          <figure>
            <button v-if="item.photo" type="button" class="block w-full overflow-hidden rounded-xl bg-accented" :aria-label="`Open the photo of ${item.title}`" @click="emit('view', [item.photo, item.reference_photo].filter(isPhoto), 0)">
              <img :src="item.photo.thumbnail_url" alt="" loading="lazy" class="aspect-square w-full object-cover">
            </button>
            <div v-else class="flex aspect-square items-center justify-center rounded-xl bg-elevated text-xs text-muted">No photo</div>
            <figcaption class="mt-1 text-xs text-muted">{{ item.photo ? `Taken ${taken}` : '' }}</figcaption>
          </figure>
          <figure v-if="item.reference_photo">
            <button type="button" class="block w-full overflow-hidden rounded-xl bg-accented" :aria-label="`How ${item.title} should look`" @click="emit('view', [item.photo, item.reference_photo].filter(isPhoto), item.photo ? 1 : 0)">
              <img :src="item.reference_photo.thumbnail_url" alt="" loading="lazy" class="aspect-square w-full object-cover">
            </button>
            <figcaption class="mt-1 text-xs text-muted">Reference</figcaption>
          </figure>
        </div>
      </li>
    </ul>
    <p v-if="checklist.note" class="mt-2 whitespace-pre-wrap break-words text-sm text-highlighted">{{ checklist.note }}</p>
  </div>
</template>

<script setup lang="ts">
import type { ChecklistPhoto, ChecklistSubmissionView } from '~/shared/turnover-checklist'

const props = defineProps<{ checklist: ChecklistSubmissionView; sentAt: string }>()
const emit = defineEmits<{ view: [photos: ChecklistPhoto[], at: number] }>()
const isPhoto = (photo: ChecklistPhoto | null): photo is ChecklistPhoto => photo !== null
const done = computed(() => props.checklist.items.filter(item => !item.flagged).length)
// The photos arrive with Done: when they were taken is when it was submitted.
const taken = computed(() => new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(props.sentAt)))
function result(item: ChecklistSubmissionView['items'][number]): string {
  if (item.type === 'confirm') return item.confirmed ? 'Done' : 'Not done'
  return `${item.counted} of ${item.required}${item.shortage ? ` · short by ${item.shortage}` : ''}`
}
</script>
