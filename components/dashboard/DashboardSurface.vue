<template>
  <component :is="as" class="dashboard-surface" :class="{ 'dashboard-surface-raised': elevated }" :style="variables"><slot /></component>
</template>

<script setup lang="ts">
import type { DashboardPresentation } from '~/shared/dashboard-presentation'
const props = withDefaults(defineProps<{ presentation: DashboardPresentation; elevated?: boolean; as?: string }>(), { elevated: true, as: 'section' })
const variables = computed(() => {
  const p = props.presentation
  return {
    '--surface-light': p.light.card, '--surface-dark': p.dark.card,
    '--surface-border-light': p.light.card_border, '--surface-border-dark': p.dark.card_border,
    '--surface-text-light': p.light.text, '--surface-text-dark': p.dark.text,
    '--surface-secondary-light': p.light.secondary, '--surface-secondary-dark': p.dark.secondary,
    '--surface-accent-light': p.light.accent, '--surface-accent-dark': p.dark.accent,
    '--surface-rating-light': p.light.rating_accent, '--surface-rating-dark': p.dark.rating_accent,
    '--surface-radius': `${p.corner_radius}px`, '--surface-padding': `${p.card_padding}px`, '--surface-width': `${p.card_border_width}px`,
    '--surface-shadow': `0 ${p.shadow_offset_y}px ${p.shadow_radius}px rgb(0 0 0 / ${p.shadow_opacity})`,
  }
})
</script>

<style>
.dashboard-surface { --surface-accent: var(--surface-accent-light); --surface-rating: var(--surface-rating-light); --ui-text-muted: var(--surface-secondary-light); background: var(--surface-light); color: var(--surface-text-light); border: var(--surface-width) solid var(--surface-border-light); border-radius: var(--surface-radius); padding: var(--surface-padding); }
.dashboard-surface-raised { box-shadow: var(--surface-shadow); }
.dark .dashboard-surface { --surface-accent: var(--surface-accent-dark); --surface-rating: var(--surface-rating-dark); --ui-text-muted: var(--surface-secondary-dark); background: var(--surface-dark); color: var(--surface-text-dark); border-color: var(--surface-border-dark); }
.dashboard-themed { --ui-bg: var(--dashboard-background-light); --ui-bg-elevated: var(--dashboard-card-light); --ui-bg-muted: var(--dashboard-card-light); --ui-text: var(--dashboard-text-light); --ui-text-highlighted: var(--dashboard-text-light); --ui-text-muted: var(--dashboard-secondary-light); --ui-border: var(--dashboard-border-light); background: var(--ui-bg); color: var(--ui-text); }
.dark .dashboard-themed { --ui-bg: var(--dashboard-background-dark); --ui-bg-elevated: var(--dashboard-card-dark); --ui-bg-muted: var(--dashboard-card-dark); --ui-text: var(--dashboard-text-dark); --ui-text-highlighted: var(--dashboard-text-dark); --ui-text-muted: var(--dashboard-secondary-dark); --ui-border: var(--dashboard-border-dark); }
</style>
