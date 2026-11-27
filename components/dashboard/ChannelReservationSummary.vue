<template>
  <DashboardSurface :presentation="presentation" aria-label="Channel reservations">
    <h2 class="text-xl font-semibold text-highlighted">Channel reservations</h2>
    <p class="mt-2 text-sm text-muted">Arriving in {{ month }}</p>
    <dl class="mt-4 space-y-4">
      <div v-for="row in rows" :key="row.channel + row.currency" class="flex items-center justify-between gap-4">
        <dt><span class="block font-medium text-highlighted">{{ labels[row.channel] }}</span><span class="text-sm text-muted">{{ row.count }} {{ row.count === 1 ? 'reservation' : 'reservations' }}</span></dt>
        <dd class="font-medium text-highlighted">{{ paymentMoney(row.amount, row.currency) }}</dd>
      </div>
    </dl>
    <p class="mt-4 text-sm text-muted">Channel-reported reservation amounts by arrival month. Check the channel for bank payout status.</p>
  </DashboardSurface>
</template>

<script setup lang="ts">
import type { EarningsPerformance } from '~/shared/earnings-display'
import type { DashboardPresentation } from '~/shared/dashboard-presentation'
import DashboardSurface from '~/components/dashboard/DashboardSurface.vue'
import { paymentMoney } from '~/shared/payment-display'
defineProps<{ rows: EarningsPerformance['channel_reservations']; month: string; presentation: DashboardPresentation }>()
const labels: Record<string, string> = { airbnb: 'Airbnb', booking_com: 'Booking.com', vrbo: 'Vrbo' }
</script>
