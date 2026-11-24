<template>
  <!--
    "Use existing home", as the iOS checklist has it: the listing syncs onto a
    home that already syncs, sharing its calendar. Opened through useOverlay;
    closes with the chosen home, 'own' to give a listing sharing a home its own
    home again, null to keep the listing's current home (or import a new one),
    or undefined when cancelled.
  -->
  <DashboardListItemDialog title="Choose an existing home" :show-actions="false" @update:open="open => { if (!open) emit('close', undefined) }">
    <p class="text-sm text-muted">{{ listing }} will share the chosen home’s calendar, price and stay rules.<template v-if="shares"> Or give it its own home again: it takes its reservations that have not ended.</template></p>
    <div class="-mx-2 flex flex-col">
      <UButton v-if="assigned" :label="imported ? 'Keep current home' : 'Import as a new home'" color="neutral" variant="ghost" class="justify-start" @click="emit('close', null)" />
      <UButton v-if="shares && assigned !== 'own'" label="Give it its own home" color="neutral" variant="ghost" class="justify-start" @click="emit('close', 'own')" />
      <UButton v-for="home in homes" :key="home.product_id" :label="home.internal_name" color="neutral" variant="ghost" class="justify-start" :trailing-icon="home.product_id === assigned ? 'i-lucide-check' : undefined" @click="emit('close', home.product_id)" />
    </div>
  </DashboardListItemDialog>
</template>

<script setup lang="ts">
import DashboardListItemDialog from '~/components/dashboard/DashboardListItemDialog.vue'

defineProps<{
  listing: string
  homes: Array<{ product_id: string; internal_name: string }>
  /** The home chosen so far ('own' for a home of its own), if any. */
  assigned: string | null
  /** The listing already has a home. */
  imported: boolean
  /** Another listing is on the listing's home, so it can be given its own. */
  shares: boolean
}>()
const emit = defineEmits<{ close: [productId: string | 'own' | null | undefined] }>()
</script>
