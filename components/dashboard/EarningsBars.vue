<template>
  <div class="grid gap-3" :class="preview ? 'mx-auto max-w-44 grid-cols-1' : 'grid-cols-[minmax(0,1fr)_auto]'" :style="{ '--earnings-accent': presentation.light.accent, '--earnings-accent-dark': presentation.dark.accent }">
    <div class="flex items-end justify-center gap-2 border-b border-default pb-2" :class="preview ? 'h-36' : 'h-56'" role="group" aria-label="Earnings by month">
      <button v-for="row in visibleMonths" :key="row.month" type="button" class="group flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-2 rounded-lg px-0.5" :class="preview ? 'max-w-16' : ''" :aria-pressed="row.month === selected" :aria-label="`${monthLabel(row.month)} ${row.amount === null ? 'Future value hidden' : paymentMoney(row.amount, currency)}`" @click="$emit('select', row.month)">
        <span class="relative w-full flex-1"><span class="absolute inset-x-0 border-t border-default" :style="{top:`${zero}%`}" /><span v-if="row.amount !== null" class="earnings-bar absolute inset-x-0 rounded-md" :class="row.month > currentMonth ? 'opacity-20' : ''" :style="barStyle(row.amount)" /></span>
        <span v-if="!preview" class="text-[10px] sm:text-xs" :class="row.month === selected ? 'rounded-full bg-inverted px-1 py-0.5 font-semibold text-inverted' : 'text-muted'">{{ monthLabel(row.month) }}</span>
      </button>
    </div>
    <div v-if="!preview" class="flex h-48 flex-col justify-between text-right text-xs text-muted"><span v-for="tick in ticks" :key="tick">{{ compact(tick) }}</span></div>
    <div v-if="mobile && !preview && months.length > 5" class="col-span-full flex justify-between"><button type="button" class="p-2" aria-label="Previous month" :disabled="selected === months[0]?.month" @click="step(-1)"><UIcon name="i-lucide-chevron-left" /></button><button type="button" class="p-2" aria-label="Next month" :disabled="selected === months.at(-1)?.month" @click="step(1)"><UIcon name="i-lucide-chevron-right" /></button></div>
  </div>
</template>

<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import { paymentMoney } from '~/shared/payment-display'
import { formatCalendarDate } from '~/utils/timezone'
import { minorAmountToMajor } from '~/shared/prices'
import type { CurrencyCode } from '~/shared/currencies'
import type { DashboardPresentation } from '~/shared/dashboard-presentation'
const props = defineProps<{ months: Array<{ month: string; amount: number | null }>; selected: string; currency: string; presentation: DashboardPresentation; preview?: boolean }>()
const emit = defineEmits<{ select: [month: string] }>()
const mobile = useMediaQuery('(max-width: 639px)')
const selectedIndex = computed(()=>props.months.findIndex(row=>row.month===props.selected))
const visibleMonths = computed(()=>{const first=Math.max(0,Math.min(props.months.length-5,selectedIndex.value-3));return mobile.value&&!props.preview&&props.months.length>5?props.months.slice(first,first+5):props.months})
const step=(direction:number)=>{const row=props.months[selectedIndex.value+direction];if(row)emit('select',row.month)}
const currentMonth = new Date().toISOString().slice(0, 7)
const top = computed(() => Math.max(1, ...visibleMonths.value.map(row => row.amount ?? 0)))
const bottom = computed(() => Math.min(0,...visibleMonths.value.map(row=>row.amount??0)))
const zero = computed(()=>top.value/(top.value-bottom.value)*100)
const ticks = computed(() => [top.value, top.value-(top.value-bottom.value)/3, top.value-(top.value-bottom.value)*2/3, bottom.value])
const compact = (amount: number) => new Intl.NumberFormat('en', { style: 'currency', currency: props.currency, notation: 'compact', maximumFractionDigits: 0 }).format(Math.sign(amount)*Number(minorAmountToMajor(Math.abs(Math.round(amount)), props.currency as CurrencyCode)))
const barStyle = (amount:number)=>({top:`${amount>=0?(top.value-amount)/(top.value-bottom.value)*100:zero.value}%`,height:`max(1px, ${Math.abs(amount)/(top.value-bottom.value)*100}%)`})
const monthLabel = (month: string) => formatCalendarDate(`${month}-01`, 'en', { month: 'short' })
</script>

<style>
.earnings-bar { background: linear-gradient(color-mix(in srgb, var(--earnings-accent) 70%, transparent), var(--earnings-accent)); }
.dark .earnings-bar { background: linear-gradient(color-mix(in srgb, var(--earnings-accent-dark) 70%, transparent), var(--earnings-accent-dark)); }
</style>
