<template>
  <DashboardLeafPanel id="booking-value" :title="data?.title ?? 'Booking value'" :footer="false" class="dashboard-themed" :style="data ? dashboardThemeStyle(data.presentation) : undefined">
    <div class="space-y-7">
      <div class="flex flex-wrap items-center justify-between gap-3"><label class="font-semibold">Year <select v-model="year" class="ml-2 rounded-full border border-default bg-default px-3 py-2"><option v-for="option in years" :key="option" :value="option">{{ option }}</option></select></label><button class="text-sm underline" @click="table = !table">{{ table ? 'Show chart' : 'Show table' }}</button></div>
      <label v-if="data" class="flex items-start gap-3 text-sm"><input v-model="future" type="checkbox" class="mt-1"><span>{{ data.future_label }}<span class="block text-xs text-muted">{{ data.bookings_label }} only</span></span></label>
      <UAlert v-if="error" color="error" title="Booking value could not be loaded" :description="getErrorMessage(error, 'Booking value request failed')" />
      <template v-if="data && status === 'success'">
        <p class="text-sm text-muted">{{ data.note }}</p>
        <p v-if="data.unpriced_bookings" class="text-sm">{{ data.unpriced_label }}: {{ data.unpriced_bookings }}</p>
        <section v-for="report in data.reports" :key="report.currency" class="space-y-5">
          <h2 class="text-xl font-semibold">{{ data.title }} · {{ report.currency }}</h2>
          <table v-if="table" class="w-full text-sm"><thead><tr><th class="py-3 text-left">Month</th><th class="text-right">Booking value</th></tr></thead><tbody><tr v-for="row in visibleMonths(report)" :key="row.month" class="border-t border-default"><th class="py-3 text-left font-normal"><button class="underline" @click="month = row.month">{{ monthTitle(row.month) }}</button></th><td class="text-right">{{ paymentMoney(row.total_minor, report.currency) }}</td></tr></tbody></table>
          <EarningsBars v-else :months="report.months.map(row=>({month:row.month,amount:future || row.month <= currentMonth ? row.total_minor : null}))" :selected="month" :currency="report.currency" :presentation="data.presentation" @select="month = $event" />
          <DashboardSurface :presentation="data.presentation" :elevated="false"><h3 class="font-semibold">{{ monthTitle(month) }}</h3><template v-if="future || month <= currentMonth"><p class="mt-3 text-2xl font-semibold">{{ paymentMoney(selected(report).total_minor, report.currency) }}</p><p class="mt-1 text-sm text-muted">{{ selected(report).bookings }} {{ data.bookings_label.toLowerCase() }}</p></template><p v-else class="mt-3 text-sm text-muted">Turn on {{ data.future_label }} to view this month.</p></DashboardSurface>
          <div v-if="future || month <= currentMonth" class="divide-y divide-default"><div v-for="item in report.items.filter(item=>item.month===month)" :key="item.product_id" class="flex items-center gap-3 py-4"><img v-if="item.image_url" :src="item.image_url" alt="" class="size-12 rounded-lg object-cover"><span class="min-w-0 flex-1 text-sm">{{ item.title }}</span><span class="text-sm font-semibold">{{ paymentMoney(item.total_minor,report.currency) }}</span></div></div>
        </section>
        <p v-if="!data.reports.length" class="text-sm text-muted">{{ data.empty_label }}</p>
      </template>
      <p v-else-if="status === 'pending'" role="status" class="text-sm text-muted">Loading booking value…</p>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import DashboardSurface from '~/components/dashboard/DashboardSurface.vue'
import EarningsBars from '~/components/dashboard/EarningsBars.vue'
import { isBookingValueReport, type BookingValueReport } from '~/shared/earnings-display'
import { dashboardThemeStyle } from '~/shared/dashboard-presentation'
import { paymentMoney } from '~/shared/payment-display'
import { formatCalendarDate } from '~/utils/timezone'
definePageMeta({layout:'dashboard'})
useSeoMeta({title:'Confirmed booking value | Blawby',robots:'noindex, nofollow'})
const route=useRoute(),router=useRouter(),api=useDashboardApi()
const currentMonth=new Date().toISOString().slice(0,7), thisYear=Number(currentMonth.slice(0,4))
const years=Array.from({length:101},(_,index)=>2000+index)
const year=computed({get:()=>Number(route.query.year??thisYear),set:(value:number)=>{void router.replace({query:{...route.query,year:value}})}})
const month=ref(`${year.value}-${currentMonth.slice(5)}`),future=ref(false),table=ref(false)
watch(year,value=>{month.value=`${value}-${month.value.slice(5)}`})
const {data,error,status}=await useAsyncData(()=>`booking-value:${route.params.org_slug}:${year.value}`,()=>api<BookingValueReport>('/api/dashboard/payments',{query:{view:'booking_value',year:year.value},validate:isBookingValueReport}))
const monthTitle=(value:string)=>formatCalendarDate(`${value}-01`,'en',{month:'long',year:'numeric'})
const selected=(report:BookingValueReport['reports'][number])=>report.months[Number(month.value.slice(5))-1]!
const visibleMonths=(report:BookingValueReport['reports'][number])=>report.months.filter(row=>future.value||row.month<=currentMonth)
</script>
