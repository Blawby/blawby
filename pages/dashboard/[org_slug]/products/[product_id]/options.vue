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

      <section class="mt-8">
        <div class="mb-2 flex items-center justify-between gap-4">
          <h2 class="text-sm font-semibold text-muted">Variants</h2>
          <USelect v-if="tracked && locations.length > 1" :model-value="stockLocationId ?? undefined" @update:model-value="value => stockLocationId = value ?? null" :items="locations.map(location => ({ value: location.id, label: location.title }))" aria-label="Stock at" class="w-56" />
          <span v-else-if="tracked && locations.length" class="text-sm text-muted">Stock at {{ locations[0]!.title }}</span>
        </div>
        <ul class="divide-y divide-default">
          <li v-for="row in rows" :key="row.key" class="flex items-center gap-3 py-3">
            <USelect v-model="row.media_asset_id" :items="photoChoices" :aria-label="`${row.title} photo`" class="w-28" placeholder="Photo" />
            <span class="min-w-0 flex-1 truncate text-highlighted">{{ row.title }}</span>
            <UInput v-model="row.price" :aria-label="`${row.title} price`" :placeholder="p.currency" inputmode="decimal" class="w-28" />
            <UInput v-model="row.sku" :aria-label="`${row.title} SKU`" placeholder="SKU" class="w-32" />
            <UInput v-if="tracked && stockLocationId" v-model="row.available" :aria-label="`${row.title} in stock`" inputmode="numeric" class="w-20" />
          </li>
        </ul>
        <p v-if="tracked && !locations.length" class="mt-2 text-sm text-muted">Offer this item at a location before counting its stock.</p>
      </section>

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

// `price_id` and `opened_price` are the price as the page opened: an unchanged price is not written, an edited one only onto that same offer.
interface Row { key: string; id: string | null; option_values: string[]; title: string; price: string; price_id: string | null; opened_price: string; sku: string; available: string; media_asset_id: string | undefined }
const options = ref<Array<{ name: string; values: string }>>([])
const tracked = ref(false)
const madeToOrder = ref(false)
const rows = ref<Row[]>([])
const levels = ref<Array<{ product_variant_id: string; location_id: string; available: number }>>([])
const saving = ref(false)
const error = ref('')
// Stock that could not be read is not shown as zero and saved over the real count.
const levelsError = ref('')
// Set while the product is re-read after a save whose stock step failed, so the typed draft survives the new version.
let keepDraft = false

const isLevels = (value: unknown): value is { levels: typeof levels.value } => isRecord(value) && Array.isArray(value.levels)
const inventoryPath = computed(() => `/api/editor/organizations/${encodeURIComponent(p.organizationId)}/products/${encodeURIComponent(product.value?.id ?? '')}/inventory`)
async function loadLevels() {
  if (!product.value) return
  levels.value = (await applicationFetch(inventoryPath.value, { validate: isLevels })).levels
  levelsError.value = ''
}

const parsedOptions = computed<ProductOption[]>(() => options.value.map(option => ({ name: option.name.trim(), values: [...new Set(option.values.split(',').map(value => value.trim()).filter(Boolean))] })).filter(option => option.name && option.values.length))
const neutralPrice = (variant: NonNullable<typeof product.value>['variants'][number]) => selectPrice(variant.prices, { currency: p.currency, location_id: null })

function savedRow(optionValues: string[]): Row {
  const variant = product.value?.variants.find(entry => JSON.stringify(entry.option_values) === JSON.stringify(optionValues)) ?? (optionValues.length === 0 ? product.value?.variants[0] : undefined)
  const price = variant ? neutralPrice(variant) : null
  const level = variant ? levels.value.find(entry => entry.product_variant_id === variant.id && entry.location_id === stockLocationId.value) : undefined
  return {
    key: JSON.stringify(optionValues), id: variant?.id ?? null, option_values: optionValues, title: optionValues.length ? variantTitle(optionValues) : product.value?.name ?? '',
    price: price ? minorAmountToMajor(price.unit_amount, price.currency) : '', price_id: price?.id ?? null, opened_price: price ? minorAmountToMajor(price.unit_amount, price.currency) : '', sku: variant?.sku ?? '', available: level ? String(level.available) : '0', media_asset_id: variant?.media_asset_id ?? undefined,
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

// The switches as they opened: until the merchant flips one, each saved variant keeps its own tracking and policy.
const openedSwitches = { tracked: false, madeToOrder: false }
function reset() {
  error.value = ''
  options.value = (product.value?.options ?? []).map(option => ({ name: option.name, values: option.values.join(', ') }))
  tracked.value = product.value?.variants.some(variant => variant.inventory_tracked) ?? false
  madeToOrder.value = product.value?.variants.some(variant => variant.inventory_policy === 'continue') ?? false
  Object.assign(openedSwitches, { tracked: tracked.value, madeToOrder: madeToOrder.value })
  rows.value = []
  rebuild()
}
// Synchronous, so the draft flag is still set when the re-read product arrives.
watch(product, () => { if (!keepDraft) reset() }, { immediate: true, flush: 'sync' })
await loadLevels().catch(cause => { levelsError.value = getErrorMessage(cause, 'Stock could not be read') })

const photoChoices = computed(() => (p.photoAssets.value ?? []).map((asset, index) => ({ value: asset.asset_id, label: `Photo ${index + 1}` })))
// Options whose values make more variants than allowed cannot be saved: the rows on screen would not match them.
const matrixError = computed(() => { try { optionCombinations(parsedOptions.value); return null } catch (cause) { return getErrorMessage(cause, 'Too many variants') } })
const invalid = computed(() => {
  if (matrixError.value) return matrixError.value
  if (levelsError.value) return `${levelsError.value}. Reload the page before saving.`
  for (const row of rows.value) {
    if (row.price.trim()) { try { majorAmountToMinor(row.price.trim(), p.currency) } catch { return `Enter a price for ${row.title}` } }
    // A saved price is changed, not cleared: a variant without a price could not be sold.
    else if (savedRow(row.option_values).price) return `Enter a price for ${row.title}`
    // The inventory endpoint's range, checked before either write.
    if (tracked.value && (!/^-?\d+$/u.test(row.available.trim()) || Number(row.available) < -100000 || Number(row.available) > 1000000)) return `Enter how many ${row.title} are in stock, up to 1,000,000`
  }
  return null
})
async function save() {
  const current = product.value
  if (!current || invalid.value) return
  saving.value = true
  error.value = ''
  // The location the counts were typed for, fixed now: the selector stays live while the product saves.
  const stockLocation = stockLocationId.value
  // Only counts the merchant changed are written: an order taken since the page opened keeps its effect on the others.
  // By combination and count, read now: rows are replaced while the save is in flight, and new variants get their ids from its answer.
  const changedStock = tracked.value && stockLocation ? rows.value.filter(row => row.available.trim() !== savedRow(row.option_values).available).map(row => ({ key: row.key, available: Number(row.available.trim()) })) : []
  let committed = false
  const switched = tracked.value !== openedSwitches.tracked || madeToOrder.value !== openedSwitches.madeToOrder
  try {
    const variants = rows.value.map((row, index) => {
      const saved = row.id ? current.variants.find(variant => variant.id === row.id) : undefined
      const price = saved ? neutralPrice(saved) : null
      if (row.price.trim() !== row.opened_price && (price?.id ?? null) !== row.price_id) throw new Error(`The price of ${row.title} changed since this page opened. Reload it before changing the price.`)
      const amount = row.price.trim() && row.price.trim() !== row.opened_price ? majorAmountToMinor(row.price.trim(), p.currency) : null
      const prices = amount === null ? [] : price ? [{ id: price.id, unit_amount: amount }] : [{ unit_amount: amount, currency: p.currency, location_id: null }]
      return { ...(row.id ? { id: row.id } : {}), name: row.title, sku: row.sku.trim() || null, sort_order: index, option_values: row.option_values,
        media_asset_id: row.media_asset_id ?? null, prices, prices_mode: 'merge' as const,
        // A saved variant keeps its own stock settings unless a switch was flipped; new variants take the switches.
        ...(saved && !switched ? { inventory_tracked: saved.inventory_tracked, inventory_policy: saved.inventory_policy }
          : { inventory_tracked: tracked.value, inventory_policy: tracked.value && madeToOrder.value ? 'continue' : 'deny' }) }
    })
    const saved = await applicationFetch(`/api/editor/organizations/${encodeURIComponent(p.organizationId)}/products/${encodeURIComponent(current.id)}`, {
      method: 'PATCH', body: { updated_at: current.updated_at, options: parsedOptions.value, variants, variants_mode: 'replace' },
      validate: (value): value is { product: { variants: Array<{ id: string; option_values: string[] }> } } => isRecord(value) && isRecord(value.product) && Array.isArray(value.product.variants),
    })
    committed = true
    const savedId = (key: string) => saved.product.variants.find(variant => JSON.stringify(variant.option_values) === key)?.id ?? null
    // New variants now have ids; the draft keeps them so a retry updates rather than adds.
    for (const row of rows.value) row.id = savedId(row.key)
    if (changedStock.length) {
      const levelsToWrite = changedStock.map(entry => ({ product_variant_id: savedId(entry.key), location_id: stockLocation, available: entry.available }))
      if (levelsToWrite.some(level => !level.product_variant_id)) throw new Error('A saved variant was not read back')
      await applicationFetch(inventoryPath.value, { method: 'PUT', validate: isLevels, body: { levels: levelsToWrite } })
    }
    await p.reload()
    // A failed re-read blocks the next save rather than comparing against counts that may be stale.
    await loadLevels().catch(cause => { levelsError.value = getErrorMessage(cause, 'Stock could not be read') })
  } catch (cause) {
    error.value = getErrorMessage(cause, 'Options and stock could not be saved')
    // The options were saved; read the new version so the next save is not refused, keeping the typed stock to retry.
    if (committed) {
      keepDraft = true
      try { await p.reload() }
      catch (reloadCause) { error.value = `${error.value}. ${getErrorMessage(reloadCause, 'Reload the page before saving again')}` }
      finally { keepDraft = false }
    }
  } finally {
    saving.value = false
  }
}
</script>
