<template>
  <section class="earnings-comparison space-y-5" :style="{ '--comparison-current-light': performance.presentation.light.accent, '--comparison-current-dark': performance.presentation.dark.accent, '--comparison-previous-light': performance.presentation.light.comparison_accent, '--comparison-previous-dark': performance.presentation.dark.comparison_accent }">
    <div class="flex items-center justify-between gap-4"><div><h2 class="text-xl font-semibold">Earnings comparison</h2><p class="text-xs text-muted">{{ year }} vs. {{ performance.comparison!.year }}</p></div><button class="rounded-full p-3 hover:bg-elevated" :aria-label="table ? 'Show comparison chart' : 'Show comparison table'" @click="table = !table"><UIcon :name="table ? 'i-lucide-chart-line' : 'i-lucide-table'" /></button></div>
    <p v-if="performance.comparison!.currency !== performance.currency" class="text-sm text-muted">These years use different currencies and cannot be compared on one chart.</p>
    <div v-else-if="table" class="overflow-x-auto"><table class="w-full text-sm"><thead><tr><th class="py-3 text-left">Month</th><th>{{ year }}</th><th>{{ performance.comparison!.year }}</th></tr></thead><tbody><tr v-for="(row, index) in performance.months" :key="row.month" class="border-t border-default"><th class="py-3 text-left font-normal"><button class="underline" @click="$emit('select', row.month)">{{ monthLabel(row.month) }}</button></th><td class="text-right">{{ row.month > currentMonth ? 'Not yet reported' : money(net(row)) }}</td><td class="text-right">{{ performance.comparison!.months[index]!.month > currentMonth ? 'Not yet reported' : comparisonMoney(net(performance.comparison!.months[index]!)) }}</td></tr></tbody></table></div>
<div v-else>
      <svg :viewBox="mobile ? '0 0 320 240' : '0 0 640 240'" class="h-auto w-full overflow-visible" role="img" :aria-label="`Monthly earnings comparison, ${year} and ${performance.comparison!.year}`">
        <line x1="12" y1="210" :x2="mobile ? 232 : 570" y2="210" stroke="currentColor" opacity=".15" />
        <line :x1="x(selectedIndex)" y1="12" :x2="x(selectedIndex)" y2="210" stroke="currentColor" opacity=".15" />
        <polyline :points="points(performance.comparison!.months, false)" fill="none" stroke="var(--comparison-previous)" stroke-width="3" />
        <polyline :points="points(performance.months, true)" fill="none" stroke="var(--comparison-current)" stroke-width="3" />
        <circle v-if="selected <= currentMonth" :cx="x(selectedIndex)" :cy="y(major(net(performance.months[selectedIndex]!), performance.currency))" r="5" fill="var(--comparison-current)" stroke="white" stroke-width="2" />
        <rect v-if="performance.comparison!.months[selectedIndex]!.month <= currentMonth" :x="x(selectedIndex)-5" :y="y(major(net(performance.comparison!.months[selectedIndex]!), performance.comparison!.currency))-5" width="10" height="10" fill="var(--comparison-previous)" stroke="white" stroke-width="2" />
        <text v-for="(tick, index) in ticks" :key="index" :x="mobile ? 248 : 585" :y="20 + index * 190 / 3" font-size="12" fill="currentColor" opacity=".65">{{ compact(tick) }}</text>
      </svg>
      <div class="relative h-10"><button v-for="row in visibleMonths" :key="row.month" class="absolute -translate-x-1/2 rounded-full px-2 py-1 text-xs" :style="{left:`${x(performance.months.indexOf(row))/(mobile?320:640)*100}%`,...(row.month===selected?{background:'var(--ui-text)',color:'var(--ui-bg)'}:{})}" :aria-pressed="row.month===selected" @click="$emit('select', row.month)">{{ monthLabel(row.month) }}</button></div>
      <div v-if="mobile" class="flex justify-between"><button class="p-2" :disabled="selectedIndex===0" aria-label="Previous comparison month" @click="step(-1)"><UIcon name="i-lucide-chevron-left" /></button><button class="p-2" :disabled="selectedIndex===11" aria-label="Next comparison month" @click="step(1)"><UIcon name="i-lucide-chevron-right" /></button></div>
    </div>
    <DashboardSurface :presentation="performance.presentation" :elevated="false"><dl class="space-y-4 text-sm"><div class="flex flex-wrap justify-between gap-2"><dt><span style="color:var(--comparison-current)">●</span> {{ monthLabel(selected) }} {{ year }}</dt><dd class="font-semibold">{{ selected > currentMonth ? 'Not yet reported' : money(net(performance.months[selectedIndex]!)) }}</dd></div><div class="flex flex-wrap justify-between gap-2"><dt><span style="color:var(--comparison-previous)">■</span> {{ monthLabel(selected) }} {{ performance.comparison!.year }}</dt><dd class="font-semibold">{{ performance.comparison!.months[selectedIndex]!.month > currentMonth ? 'Not yet reported' : comparisonMoney(net(performance.comparison!.months[selectedIndex]!)) }}</dd></div></dl></DashboardSurface>
  </section>
</template>

<script setup lang="ts">
import { useMediaQuery } from '@vueuse/core'
import DashboardSurface from '~/components/dashboard/DashboardSurface.vue'
import type { EarningsPerformance } from '~/shared/earnings-display'
import { paymentMoney } from '~/shared/payment-display'
import { minorAmountToMajor } from '~/shared/prices'
import type { CurrencyCode } from '~/shared/currencies'
import { formatCalendarDate } from '~/utils/timezone'
const props = defineProps<{ performance: EarningsPerformance; selected: string }>()
const emit = defineEmits<{ select: [month: string] }>()
const mobile=useMediaQuery('(max-width: 639px)')
const table = ref(false)
const currentMonth = new Date().toISOString().slice(0,7)
const year = computed(() => props.selected.slice(0,4))
const selectedIndex = computed(() => Number(props.selected.slice(5))-1)
const first=computed(()=>mobile.value?Math.max(0,Math.min(7,selectedIndex.value-3)):0)
const visibleMonths=computed(()=>props.performance.months.slice(first.value,first.value+(mobile.value?5:12)))
const step=(direction:number)=>{const row=props.performance.months[selectedIndex.value+direction];if(row)emit('select',row.month)}
const net = (row: {paid:number; refunded:number}) => row.paid-row.refunded
const major = (amount:number, currency:string) => Math.sign(amount) * Number(minorAmountToMajor(Math.abs(amount), currency as CurrencyCode))
const maximum = computed(() => Math.max(1,...props.performance.months.filter(row=>row.month<=currentMonth).map(net).map(n=>major(n,props.performance.currency)),...props.performance.comparison!.months.map(net).map(n=>major(n,props.performance.comparison!.currency))))
const minimum = computed(() => Math.min(0,...props.performance.months.filter(row=>row.month<=currentMonth).map(net).map(n=>major(n,props.performance.currency)),...props.performance.comparison!.months.map(net).map(n=>major(n,props.performance.comparison!.currency))))
const x=(index:number)=>12+(index-first.value)*(mobile.value?55:50)
const y=(value:number)=>210-(value-minimum.value)/(maximum.value-minimum.value)*190
const points=(rows:EarningsPerformance['months'],current:boolean)=>rows.flatMap((row,index)=>index<first.value||index>=first.value+(mobile.value?5:12)||row.month>currentMonth?[]:[`${x(index)},${y(major(net(row),current?props.performance.currency:props.performance.comparison!.currency))}`]).join(' ')
const ticks=computed(()=>[maximum.value,maximum.value-(maximum.value-minimum.value)/3,maximum.value-(maximum.value-minimum.value)*2/3,minimum.value])
const compact=(amount:number)=>new Intl.NumberFormat('en',{notation:'compact',maximumFractionDigits:0}).format(amount)
const money=(amount:number)=>paymentMoney(amount,props.performance.currency)
const comparisonMoney=(amount:number)=>paymentMoney(amount,props.performance.comparison!.currency)
const monthLabel=(month:string)=>formatCalendarDate(`${month}-01`,'en',{month:'short'})
</script>

<style>
.earnings-comparison { --comparison-current: var(--comparison-current-light); --comparison-previous: var(--comparison-previous-light); }
.dark .earnings-comparison { --comparison-current: var(--comparison-current-dark); --comparison-previous: var(--comparison-previous-dark); }
</style>
