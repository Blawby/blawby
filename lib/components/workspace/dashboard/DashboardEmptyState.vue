<template>
  <UEmpty>
    <template v-if="illustration" #leading>
      <img :src="illustration" alt="" aria-hidden="true" width="112" height="112" class="size-28 object-contain" decoding="async">
    </template>
    <template v-if="$slots.actions" #actions><slot name="actions" /></template>
    <template v-if="$slots.body" #body><slot name="body" /></template>
    <template v-if="$slots.footer" #footer><slot name="footer" /></template>
  </UEmpty>
</template>

<script setup lang="ts">
// The owning screen chooses the concept; an empty search or failed read has no art.
defineProps<{ illustration?: string }>()
</script>
