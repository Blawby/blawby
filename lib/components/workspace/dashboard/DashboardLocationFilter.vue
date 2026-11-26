<template>
  <!-- Which locations a level shows: one outlined pill in the filter row under its title, as Airbnb's listing filters. -->
  <USelect
    v-model="model"
    :items="options"
    icon="i-lucide-map-pin"
    class="h-10 min-w-48 rounded-full"
    :aria-label="legal ? 'Office' : 'Location'"
  />
</template>

<script setup lang="ts">
const props = defineProps<{
  /** "All locations" first, then each location; a picture where the location has one. */
  items: { label: string; value: string; avatar?: { src: string } }[]
}>()

const { organization } = useDashboardOrganization()
const legal = computed(() => organization.value?.vertical === 'service')
const options = computed(() => props.items.map(item => legal.value && item.value === AGENDA_FILTER_ALL ? { ...item, label: 'All offices' } : item))

const model = defineModel<string>({ required: true })
</script>
