<template>
  <!-- The home's refundable security deposit, as Vrbo and Zillow state one on a listing: every new direct stay asks for it, and each stay keeps its own amount. -->
  <DashboardLeafPanel
    id="product-security-deposit"
    title="Security deposit"
    lead="The refundable deposit each new stay asks for. You receive, keep part of and return it on each stay; it is never part of the rent."
    desktop-cancel
    :saving="p.saving.value"
    :disabled="p.saveDisabled.value"
    :error="p.loadError.value || p.saveError.value || ''"
    @cancel="p.revert"
    @save="p.save"
  >
    <UFormField v-if="p.product.value && !p.loadError.value" :label="`Amount (${p.currency})`" hint="Leave empty for none">
      <UInput v-model="p.form.deposit_major" inputmode="decimal" autofocus class="w-full" data-testid="product-security-deposit" />
    </UFormField>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'

definePageMeta({ layout: 'dashboard' })
const p = inject(productEditorKey)!
onBeforeRouteLeave(() => p.revert())
</script>
