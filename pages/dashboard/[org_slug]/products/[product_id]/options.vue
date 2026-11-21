<template>
  <!--
    Shopify's options and variants for a physical item: up to three options,
    whose values multiply into variants, each with its photo, price, SKU and
    stock at the location chosen; and whether stock is counted and what happens
    at zero (stop selling, or keep selling made to order).
  -->
  <DashboardLeafPanel
    id="product-options"
    :title="p.sectionLabels.options"
    lead="Each combination is a variant with its own photo, price, SKU and stock."
    :saving="saving"
    :disabled="saving || Boolean(invalid)"
    save-label="Save"
    :error="p.loadError.value || error || invalid || ''"
    @cancel="reset"
    @save="save"
  >
    <template v-if="product">
      <section class="space-y-3" aria-label="Options">
        <div v-for="(option, index) in options" :key="index" class="rounded-xl p-4 ring-1 ring-default">
          <div class="flex items-center gap-3">
            <UInput v-model="option.name" :aria-label="`Option ${index + 1} name`" placeholder="Colour" class="min-w-0 flex-1" maxlength="50" />
            <UButton color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="`Remove ${option.name || 'option'}`" @click="options.splice(index, 1)" />
          </div>
          <UInput v-model="option.values" :aria-label="`${option.name || 'Option'} values`" placeholder="Ruby reds, Celadon, Tenmoku" class="mt-3 w-full" />
          <p class="mt-1 text-sm text-muted">Separate values with commas.</p>
        </div>
        <UButton v-if="options.length < 3" color="neutral" variant="link" class="px-0" @click="options.push({ name: '', values: '' })">Add option, such as Size or Colour</UButton>
      </section>

      <section v-if="locations.length" class="mt-8">
        <div class="mb-2 flex items-center justify-between gap-4">
          <h2 class="text-sm font-semibold text-muted">Variants</h2>
          <USelect v-if="locations.length > 1" :model-value="stockLocationId ?? undefined" @update:model-value="value => stockLocationId = value ?? null" :items="locations.map(location => ({ value: location.id, label: location.title }))" aria-label="Stock at" class="w-56" />
          <span v-else class="text-sm text-muted">Stock at {{ locations[0]!.title }}</span>
        </div>
        <ul class="divide-y divide-default">
          <li v-for="row in rows" :key="row.key" class="flex items-center gap-3 py-3">
            <USelect v-model="row.media_asset_id" :items="photoChoices" :aria-label="`${row.title} photo`" class="w-28" placeholder="Photo" />
            <span class="min-w-0 flex-1 truncate text-highlighted">{{ row.title }}</span>
            <UInput v-model="row.price" :aria-label="`${row.title} price`" :placeholder="p.currency" inputmode="decimal" class="w-28" />
            <UInput v-model="row.sku" :aria-label="`${row.title} SKU`" placeholder="SKU" class="w-32" />
            <UInput v-if="tracked" v-model="row.available" :aria-label="`${row.title} in stock`" type="number" inputmode="numeric" class="w-20" />
          </li>
        </ul>
      </section>
      <p v-else class="mt-8 text-sm text-muted">Offer this item at a location before counting its stock.</p>

      <div class="mt-6">
        <SettingRow v-model="tracked" label="Track stock" description="Count how many are on hand at each location." />
        <SettingRow v-if="tracked" v-model="madeToOrder" label="Make to order when out of stock" description="Buyers can still order. It ships after the made-to-order time." />
      </div>
    </template>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { productEditorKey } from '~/components/dashboard/ProductEditorPage.vue'
import SettingRow from '~/components/dashboard/SettingRow.vue'
import { applicationFetch } from '~/composables/dashboardFetch'
import { optionCombinations, variantTitle, type ProductOption } from '~/shared/goods'
import { majorAmountToMinor, minorAmountToMajor, selectPrice } from '~/shared/prices'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'

definePageMeta({ layout: 'dashboard' })

const p = inject(productEditorKey)!
const product = computed(() => p.product.value)
const locations = computed(() => p.allOrganizationLocations.value.filter(location => product.value?.locations.some(entry => entry.location_id === location.id)))
const stockLocationId = ref<string | null>(null)
watchEffect(() => { if (!stockLocationId.value || !locations.value.some(location => location.id === stockLocationId.value)) stockLocationId.value = locations.value[0]?.id ?? null })

interface Row { key: string; id: string | null; option_values: string[]; title: string; price: string; sku: string; available: string; media_asset_id: string | undefined }
const options = ref<Array<{ name: string; values: string }>>([])
const tracked = ref(false)
const madeToOrder = ref(false)
const rows = ref<Row[]>([])
const levels = ref<Array<{ product_variant_id: string; location_id: string; available: number }>>([])
const saving = ref(false)
const error = ref('')

const isLevels = (value: unknown): value is { levels: typeof levels.value } => isRecord(value) && Array.isArray(value.levels)
const inventoryPath = computed(() => `/api/editor/organizations/${encodeURIComponent(p.organizationId)}/products/${encodeURIComponent(product.value?.id ?? '')}/inventory`)
async function loadLevels() {
  if (!product.value) return
  levels.value = (await applicationFetch(inventoryPath.value, { validate: isLevels })).levels
}

const parsedOptions = computed<ProductOption[]>(() => options.value.map(option => ({ name: option.name.trim(), values: [...new Set(option.values.split(',').map(value => value.trim()).filter(Boolean))] })).filter(option => option.name && option.values.length))
const neutralPrice = (variant: NonNullable<typeof product.value>['variants'][number]) => selectPrice(variant.prices, { currency: p.currency, location_id: null })

function savedRow(optionValues: string[]): Row {
  const variant = product.value?.variants.find(entry => JSON.stringify(entry.option_values) === JSON.stringify(optionValues)) ?? (optionValues.length === 0 ? product.value?.variants[0] : undefined)
  const price = variant ? neutralPrice(variant) : null
  const level = variant ? levels.value.find(entry => entry.product_variant_id === variant.id && entry.location_id === stockLocationId.value) : undefined
  return {
    key: JSON.stringify(optionValues), id: variant?.id ?? null, option_values: optionValues, title: optionValues.length ? variantTitle(optionValues) : product.value?.name ?? '',
    price: price ? minorAmountToMajor(price.unit_amount, price.currency) : '', sku: variant?.sku ?? '', available: level ? String(level.available) : '0', media_asset_id: variant?.media_asset_id ?? undefined,
  }
}

// The variant list follows the options: a combination keeps what was typed for it, a new one starts from what is saved.
function rebuild() {
  let combinations: string[][]
  try { combinations = optionCombinations(parsedOptions.value) }
  catch (cause) { error.value = getErrorMessage(cause, 'Too many variants'); return }
  const typed = new Map(rows.value.map(row => [row.key, row]))
  rows.value = (combinations.length ? combinations : [[]]).map(values => typed.get(JSON.stringify(values)) ?? savedRow(values))
}
watch(parsedOptions, rebuild, { deep: true })
// Another location's stock is that location's saved count.
watch([stockLocationId, levels], () => { rows.value = rows.value.map(row => ({ ...row, available: savedRow(row.option_values).available })) })

function reset() {
  error.value = ''
  options.value = (product.value?.options ?? []).map(option => ({ name: option.name, values: option.values.join(', ') }))
  tracked.value = product.value?.variants.some(variant => variant.inventory_tracked) ?? false
  madeToOrder.value = product.value?.variants.some(variant => variant.inventory_policy === 'continue') ?? false
  rows.value = []
  rebuild()
}
watch(product, () => reset(), { immediate: true })
await loadLevels().catch(cause => { error.value = getErrorMessage(cause, 'Stock could not be read') })

const photoChoices = computed(() => (p.photoAssets.value ?? []).map((asset, index) => ({ value: asset.asset_id, label: `Photo ${index + 1}` })))
const invalid = computed(() => {
  for (const row of rows.value) {
    if (row.price.trim()) { try { majorAmountToMinor(row.price.trim(), p.currency) } catch { return `Enter a price for ${row.title}` } }
    if (tracked.value && !/^-?\d+$/u.test(row.available.trim())) return `Enter how many ${row.title} are in stock`
  }
  return null
})
async function save() {
  const current = product.value
  if (!current || invalid.value) return
  saving.value = true
  error.value = ''
  try {
    const variants = rows.value.map((row, index) => {
      const saved = row.id ? current.variants.find(variant => variant.id === row.id) : undefined
      const price = saved ? neutralPrice(saved) : null
      const amount = row.price.trim() ? majorAmountToMinor(row.price.trim(), p.currency) : null
      const prices = amount === null ? [] : price ? [{ id: price.id, unit_amount: amount }] : [{ unit_amount: amount, currency: p.currency, location_id: null }]
      return { ...(row.id ? { id: row.id } : {}), name: row.title, sku: row.sku.trim() || null, sort_order: index, option_values: row.option_values,
        media_asset_id: row.media_asset_id ?? null, inventory_tracked: tracked.value, inventory_policy: tracked.value && madeToOrder.value ? 'continue' : 'deny', prices, prices_mode: 'merge' as const }
    })
    const saved = await applicationFetch(`/api/editor/organizations/${encodeURIComponent(p.organizationId)}/products/${encodeURIComponent(current.id)}`, {
      method: 'PATCH', body: { updated_at: current.updated_at, options: parsedOptions.value, variants, variants_mode: 'replace' },
      validate: (value): value is { product: { variants: Array<{ id: string; option_values: string[] }> } } => isRecord(value) && isRecord(value.product) && Array.isArray(value.product.variants),
    })
    if (tracked.value && stockLocationId.value) {
      const stock = rows.value.map(row => ({ row, id: saved.product.variants.find(variant => JSON.stringify(variant.option_values) === row.key)?.id }))
      if (stock.some(entry => !entry.id)) throw new Error('A saved variant was not read back')
      await applicationFetch(inventoryPath.value, { method: 'PUT', validate: isLevels,
        body: { levels: stock.map(({ row, id }) => ({ product_variant_id: id, location_id: stockLocationId.value, available: Number(row.available.trim()) })) } })
    }
    await p.reload()
    await loadLevels()
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Options and stock could not be saved')
  } finally {
    saving.value = false
  }
}
</script>
