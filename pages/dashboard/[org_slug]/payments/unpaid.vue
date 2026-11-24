<template>
  <!--
    Who still has to pay (#2079): one row per booking, oldest debt first — who,
    what it is for, since when, and how much. A row opens the booking's
    conversation, where the host asks; nothing here sends a reminder.
  -->
  <DashboardLeafPanel id="organization-unpaid" title="Unpaid" lead="Rent past its due day, stays that began unpaid, and deposits or retainers not received. Airbnb and other channels collect their own." :footer="false">
    <UAlert v-if="unpaidError" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(unpaidError, 'Unpaid bookings could not be loaded')" />
    <p v-else-if="unpaidPending" role="status" class="text-muted">Loading…</p>
    <UEmpty v-else-if="!unpaid?.length" icon="i-lucide-circle-check" title="Nobody owes you money" description="A booking appears here once a payment it owes is overdue." />
    <div v-else class="space-y-6" data-testid="unpaid-bookings">
      <NuxtLink v-for="row in unpaid" :key="row.booking_id" :to="bookingConversationOrRecordPath(slug, row.booking_id, row.conversation_id)" class="flex items-center gap-4" :data-testid="`unpaid-${row.booking_id}`">
        <span class="flex size-12 shrink-0 items-center justify-center rounded-full bg-elevated">
          <UIcon name="i-lucide-credit-card" class="size-5 text-error" />
        </span>
        <span class="min-w-0 flex-1">
          <span class="block truncate text-base font-medium text-highlighted">{{ row.guest_name ?? 'No name recorded' }}</span>
          <span class="block truncate text-sm text-muted">{{ [row.product_name, row.unit === 'slot' ? row.location_title ?? 'Online' : null].filter(Boolean).join(' · ') }}</span>
          <span class="block truncate text-sm text-muted">{{ row.items.map(item => item.label).join(', ') }} · since {{ formatCalendarDate(row.owed_since, 'en', { month: 'short', day: 'numeric' }) }}</span>
        </span>
        <span class="shrink-0 text-right text-base font-medium tabular-nums text-error">{{ paymentMoney(row.owed_minor, row.currency) }}</span>
        <UIcon name="i-lucide-chevron-right" class="size-5 shrink-0 text-muted" />
      </NuxtLink>
    </div>
  </DashboardLeafPanel>
</template>

<script setup lang="ts">
import { useUnpaid } from '~/composables/usePaymentsSettings'
import { bookingConversationOrRecordPath } from '~/shared/messages-contract'
import { paymentMoney } from '~/shared/payment-display'
import { formatCalendarDate } from '~/utils/timezone'

definePageMeta({ layout: 'dashboard' })
useSeoMeta({ title: 'Unpaid | Blawby', robots: 'noindex, nofollow' })

const route = useRoute()
const slug = computed(() => String(route.params.org_slug))
const { unpaid, unpaidError, unpaidPending } = useUnpaid()
</script>
