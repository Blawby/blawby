<template>
  <!--
    How a physical item ships: how long it takes to send from stock and to
    make one to order, and the packed parcel every variant ships in, which
    weight-based rates and customs read.
  -->
  <DashboardLeafPanel
    id="product-shipping"
    :title="p.sectionLabels.shipping"
    lead="Shipping times are business days. The parcel is the packed box, used for shipping rates and customs."
    :saving="saving"
    :disabled="saving || Boolean(invalid)"
    save-label="Save"
    :error="p.loadError.value || error || invalid || ''"
    @cancel="reset"
    @save="save"
  >
    <div v-if="product" class="space-y-6">
      <div class="grid grid-cols-2 gap-4">
        <UFormField label="Ships from stock in" hint="Optional">
          <UInput v-model="form.processing_days" inputmode="numeric" placeholder="3" class="w-full"><template #trailing><span class="text-sm text-muted">days</span></template></UInput>
        </UFormField>
        <UFormField label="Made to order in" hint="Optional">
          <UInput v-model="form.made_to_order_days" inputmode="numeric" placeholder="20" class="w-full"><template #trailing><span class="text-sm text-muted">days</span></template></UInput>
        </UFormField>
      </div>
      <UFormField label="Packed weight">
        <UInput v-model="form.weight_kg" inputmode="decimal" placeholder="4.2" class="w-full"><template #trailing><span class="text-sm text-muted">kg</span></template></UInput>
      </UFormField>
      <UFormField label="Packed size" hint="Optional">
        <div class="grid grid-cols-3 gap-3">
          <UInput v-model="form.length_cm" inputmode="decimal" placeholder="Length" aria-label="Length in cm"><template #trailing><span class="text-sm text-muted">cm</span></template></UInput>
          <UInput v-model="form.width_cm" inputmode="decimal" placeholder="Width" aria-label="Width in cm"><template #trailing><span class="text-sm text-muted">cm</span></template></UInput>
          <UInput v-model="form.height_cm" inputmode="decimal" placeholder="Height" aria-label="Height in cm"><template #trailing><span class="text-sm text-muted">cm</span></template></UInput>
        </div>
      </UFormField>
      <div class="grid grid-cols-2 gap-4">
        <UFormField label="Country of origin" hint="Optional">
          <UInput v-model="form.country_of_origin" placeholder="TH" maxlength="2" class="w-full uppercase" />
        </UFormField>
        <UFormField label="HS code" hint="Optional">
          <UInput v-model="form.hs_code" placeholder="6913.90" class="w-full" />
        </UFormField>
      </div>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import { applicationFetch } from '~/composables/dashboardFetch'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const product = computed(() => p.product.value)
const form = reactive({ processing_days: '', made_to_order_days: '', weight_kg: '', length_cm: '', width_cm: '', height_cm: '', country_of_origin: '', hs_code: '' })
const saving = ref(false)
const error = ref('')

const text = (value: number | null, scale = 1) => value === null ? '' : String(value / scale)
function reset() {
  error.value = ''
  const current = product.value
  const variant = current?.variants[0]
  Object.assign(form, {
    processing_days: text(current?.processing_days ?? null), made_to_order_days: text(current?.made_to_order_days ?? null),
    weight_kg: text(variant?.weight_grams ?? null, 1000), length_cm: text(variant?.length_mm ?? null, 10), width_cm: text(variant?.width_mm ?? null, 10), height_cm: text(variant?.height_mm ?? null, 10),
    country_of_origin: variant?.country_of_origin ?? '', hs_code: variant?.hs_code ?? '',
  })
}
watch(product, reset, { immediate: true })

/** A whole number of `unit`s from what was typed in `scale`ths, or null when blank. */
function amount(value: string, scale: number): number | null | undefined {
  if (!value.trim()) return null
  const parsed = Number(value.trim())
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed * scale) : undefined
}
function days(value: string): number | null | undefined {
  if (!value.trim()) return null
  return /^\d{1,3}$/u.test(value.trim()) && Number(value) <= 365 ? Number(value) : undefined
}
const invalid = computed(() => {
  if (days(form.processing_days) === undefined || days(form.made_to_order_days) === undefined) return 'Shipping times are whole business days up to 365'
  if ([form.weight_kg, form.length_cm, form.width_cm, form.height_cm].some((value, index) => amount(value, index ? 10 : 1000) === undefined)) return 'Enter the parcel as positive numbers'
  if (form.country_of_origin.trim() && !/^[A-Za-z]{2}$/u.test(form.country_of_origin.trim())) return 'Use a two-letter country code, such as TH'
  if (form.hs_code.trim() && !/^[0-9.]{6,12}$/u.test(form.hs_code.trim())) return 'An HS code is 6 to 10 digits'
  return null
})

async function save() {
  const current = product.value
  if (!current || invalid.value) return
  saving.value = true
  error.value = ''
  try {
    const parcel = { weight_grams: amount(form.weight_kg, 1000), length_mm: amount(form.length_cm, 10), width_mm: amount(form.width_cm, 10), height_mm: amount(form.height_cm, 10),
      country_of_origin: form.country_of_origin.trim().toUpperCase() || null, hs_code: form.hs_code.trim() || null }
    await applicationFetch(`/api/editor/organizations/${encodeURIComponent(p.organizationId)}/products/${encodeURIComponent(current.id)}`, {
      method: 'PATCH', body: { updated_at: current.updated_at, processing_days: days(form.processing_days), made_to_order_days: days(form.made_to_order_days),
        variants: current.variants.map(variant => ({ id: variant.id, ...parcel })) },
      validate: (value): value is { product: unknown } => isRecord(value) && isRecord(value.product),
    })
    await p.reload()
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Shipping could not be saved')
  } finally {
    saving.value = false
  }
}
</script>
