<template>
  <!--
    One shipping zone: the countries it covers and the rates buyers choose
    from, each a price for a weight band or for orders over an amount.
  -->
  <DashboardLeafPanel id="shipping-zone" :title="creating ? 'Add zone' : form.name || 'Shipping zone'" lead="Buyers choose one rate at checkout. Weight is the order's packed weight."
    :saving="saving" :disabled="saving || Boolean(invalid)" :error="error || invalid || ''" save-label="Save" @save="save" @cancel="reset">
    <div class="space-y-6">
      <UFormField label="Zone name"><UInput v-model="form.name" placeholder="Laos" maxlength="100" class="w-full" /></UFormField>
      <UFormField label="Countries" description="Two-letter codes, separated by commas, such as LA, VN, KH.">
        <UInput v-model="form.countries" placeholder="LA" class="w-full uppercase" />
      </UFormField>
      <section aria-label="Rates" class="space-y-3">
        <h2 class="text-sm font-semibold text-muted">Rates</h2>
        <div v-for="(rate, index) in form.rates" :key="index" class="space-y-3 rounded-xl p-4 ring-1 ring-default">
          <div class="flex items-center gap-3">
            <UInput v-model="rate.name" :aria-label="`Rate ${index + 1} name`" placeholder="Thailand Post EMS" class="min-w-0 flex-1" />
            <UInput v-model="rate.amount" :aria-label="`Rate ${index + 1} price`" :placeholder="currency" inputmode="decimal" class="w-32" />
            <UButton color="neutral" variant="ghost" icon="i-lucide-x" :aria-label="`Remove ${rate.name || 'rate'}`" @click="form.rates.splice(index, 1)" />
          </div>
          <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <UInput v-model="rate.min_kg" :aria-label="`Rate ${index + 1} from kg`" placeholder="From kg" inputmode="decimal" />
            <UInput v-model="rate.max_kg" :aria-label="`Rate ${index + 1} under kg`" placeholder="Under kg" inputmode="decimal" />
            <UInput v-model="rate.min_subtotal" :aria-label="`Rate ${index + 1} orders over`" placeholder="Orders over" inputmode="decimal" />
            <UInput v-model="rate.days" :aria-label="`Rate ${index + 1} delivery days`" placeholder="Days, e.g. 7-14" />
          </div>
        </div>
        <UButton color="neutral" variant="link" class="px-0" @click="form.rates.push(blankRate())">Add rate</UButton>
      </section>
      <UButton v-if="!creating" color="error" variant="outline" :loading="deleting" @click="remove">Delete zone</UButton>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { majorAmountToMinor, minorAmountToMajor } from '~/shared/prices'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Shipping zone | Blawby', robots: 'noindex, nofollow' })

const route = useRoute()
const dashboardApi = useDashboardApi()
const dashboard = useDashboardOrganization()
const shippingPath = computed(() => `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/shipping`)
const { data, refresh, error: settingsError } = await useShippingSettings()
const zoneId = computed(() => String(route.params.zone_id))
const creating = computed(() => zoneId.value === 'new')
const zone = computed(() => data.value?.zones.find(entry => entry.id === zoneId.value) ?? null)
const currency = computed(() => dashboard.organization.value?.default_currency ?? '')
// A failed read is that failure, not a missing zone.
if (settingsError.value) throw createError({ statusCode: 500, statusMessage: getErrorMessage(settingsError.value, 'Shipping settings could not be read') })
if (!creating.value && !zone.value) throw createError({ statusCode: 404, statusMessage: 'Shipping zone not found' })

type RateForm = { id: string | null; name: string; amount: string; min_kg: string; max_kg: string; min_subtotal: string; days: string }
const blankRate = (): RateForm => ({ id: null, name: '', amount: '', min_kg: '', max_kg: '', min_subtotal: '', days: '' })
const form = reactive({ name: '', countries: '', rates: [] as RateForm[] })
const kg = (grams: number | null) => grams === null ? '' : String(grams / 1000)
// Either bound may stand alone: "7" is exactly 7 days, "7-14" a range, "7-" at least 7, "-14" at most 14.
function deliveryDays(min: number | null, max: number | null) {
  if (min !== null && min === max) return String(min)
  return min === null && max === null ? '' : `${min ?? ''}-${max ?? ''}`
}
function reset() {
  error.value = ''
  const saved = zone.value
  form.name = saved?.name ?? ''
  form.countries = saved?.countries.join(', ') ?? ''
  form.rates = saved ? saved.rates.map(rate => ({ id: rate.id, name: rate.name, amount: minorAmountToMajor(rate.amount, rate.currency ?? currency.value), min_kg: kg(rate.min_weight_grams), max_kg: kg(rate.max_weight_grams),
    min_subtotal: rate.min_subtotal === null ? '' : minorAmountToMajor(rate.min_subtotal, rate.currency ?? currency.value),
    days: deliveryDays(rate.delivery_days_min, rate.delivery_days_max) })) : [blankRate()]
}
const error = ref('')
// A refresh that failed leaves no zone to read: the draft stays rather than resetting to blank.
watch(zone, () => { if (!settingsError.value) reset() }, { immediate: true })

function grams(value: string) {
  if (!value.trim()) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('Weights are positive numbers of kilograms')
  return Math.round(parsed * 1000)
}
function payload() {
  const countries = form.countries.split(',').map(value => value.trim().toUpperCase()).filter(Boolean)
  if (!form.name.trim()) throw new Error('Name the zone')
  if (!countries.length || countries.some(code => !/^[A-Z]{2}$/u.test(code))) throw new Error('List two-letter country codes')
  const rates = form.rates.filter(rate => rate.name.trim() || rate.amount.trim()).map(rate => {
    if (!rate.name.trim()) throw new Error('Name every rate')
    const days = rate.days.trim() ? /^(\d{1,3})?\s*(-)?\s*(\d{1,3})?$/u.exec(rate.days.trim()) : null
    // Two bounds are a range only with a hyphen between them: "7 14" is not read as 7–14.
    if (rate.days.trim() && (!days || (!days[1] && !days[3]) || (days[1] && days[3] && !days[2]))) throw new Error('Delivery days are a number or a range, such as 7-14')
    return { ...(rate.id ? { id: rate.id } : {}), name: rate.name.trim(), amount: majorAmountToMinor(rate.amount.trim(), currency.value), min_weight_grams: grams(rate.min_kg), max_weight_grams: grams(rate.max_kg),
      min_subtotal: rate.min_subtotal.trim() ? majorAmountToMinor(rate.min_subtotal.trim(), currency.value) : null,
      delivery_days_min: days?.[1] ? Number(days[1]) : null, delivery_days_max: days?.[3] ? Number(days[3]) : days?.[1] && !days[2] ? Number(days[1]) : null }
  })
  const locationId = creating.value ? String(route.query.location_id ?? '') : zone.value!.location_id
  if (!locationId) throw new Error('Choose the location this zone ships from')
  return { location_id: locationId, name: form.name.trim(), countries, rates }
}
const invalid = computed(() => { try { payload(); return null } catch (cause) { return getErrorMessage(cause, 'Check the zone') } })

const saving = ref(false)
const deleting = ref(false)
const isZone = (value: unknown): value is { zone: { id: string } } => isRecord(value) && isRecord(value.zone) && typeof value.zone.id === 'string'
async function save() {
  saving.value = true
  error.value = ''
  try {
    const saved = await dashboardApi(creating.value ? '/api/dashboard/shipping/zones' : `/api/dashboard/shipping/zones/${encodeURIComponent(zoneId.value)}`,
      { method: creating.value ? 'POST' : 'PUT', body: payload(), validate: isZone })
    await refresh()
    // useAsyncData records a failed refresh instead of rejecting it.
    if (settingsError.value) throw new Error(`The zone was saved, but it could not be read back: ${getErrorMessage(settingsError.value, 'reload the page')}`)
    if (creating.value) await navigateTo(`${shippingPath.value}/zones/${saved.zone.id}`, { replace: true })
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The zone could not be saved')
  } finally {
    saving.value = false
  }
}
async function remove() {
  deleting.value = true
  error.value = ''
  try {
    await dashboardApi(`/api/dashboard/shipping/zones/${encodeURIComponent(zoneId.value)}`, { method: 'DELETE', validate: (body): body is { success: true } => isRecord(body) && body.success === true })
    await refresh()
    await navigateTo(shippingPath.value, { replace: true })
  } catch (cause) {
    error.value = getErrorMessage(cause, 'The zone could not be deleted')
  } finally {
    deleting.value = false
  }
}
</script>
