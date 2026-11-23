<template>
  <!--
    A member's membership, as Stripe has it now: its price, whether it is
    active, cancelling, failing to collect or ended, the next payment or the
    last day of access, every payment it made, and the business's two ways to
    end it. Stripe renews it and retries a failed card; nothing here charges.
  -->
  <UAlert v-if="!membership" color="error" variant="soft" :description="error" />
  <div v-else class="space-y-4" data-testid="membership-panel">
    <div>
      <p class="text-base font-semibold text-highlighted">{{ membership.title }}</p>
      <p class="text-sm text-muted">{{ membership.terms }}</p>
    </div>
    <UAlert v-if="error" color="error" variant="soft" :description="error" />
    <dl class="space-y-2 text-sm">
      <div class="flex justify-between gap-4"><dt class="text-muted">Status</dt><dd class="font-medium text-highlighted" data-testid="membership-state">{{ MEMBERSHIP_STATE_LABELS[membership.state] }}</dd></div>
      <div v-if="membership.member_name" class="flex justify-between gap-4"><dt class="text-muted">Member</dt><dd class="text-highlighted">{{ membership.member_name }}</dd></div>
      <div class="flex justify-between gap-4"><dt class="text-muted">Joined</dt><dd class="text-highlighted">{{ day(membership.started_at) }}</dd></div>
      <div v-if="membership.current_period_end" class="flex justify-between gap-4">
        <dt class="text-muted">{{ membership.state === 'cancelling' ? 'Access until' : membership.state === 'payment_failed' ? 'Payment was due' : 'Next payment' }}</dt>
        <dd class="text-highlighted">{{ day(membership.current_period_end) }}</dd>
      </div>
      <div v-if="membership.ended_at" class="flex justify-between gap-4"><dt class="text-muted">Ended</dt><dd class="text-highlighted">{{ day(membership.ended_at) }}</dd></div>
    </dl>
    <div>
      <p class="text-sm font-medium text-highlighted">Payments</p>
      <ul class="mt-2 space-y-1">
        <li v-for="payment in membership.payments" :key="payment.id">
          <NuxtLink :to="paymentPath(payment.id)" class="flex justify-between gap-4 py-1 text-sm">
            <span class="text-muted">{{ payment.period_start && payment.period_end ? `${day(payment.period_start)} – ${day(payment.period_end)}` : day(payment.created_at) }}</span>
            <span class="text-highlighted">{{ money(payment.amount) }}<template v-if="payment.refunded_amount"> · Refunded {{ money(payment.refunded_amount) }}</template></span>
          </NuxtLink>
        </li>
      </ul>
    </div>
    <div v-if="manage && (membership.state === 'active' || membership.state === 'payment_failed' || membership.state === 'cancelling')" class="space-y-2 border-t border-default pt-4">
      <UButton v-if="membership.state !== 'cancelling'" block color="neutral" variant="outline" label="Cancel at the end of the period" :loading="busy === 'at_period_end'" data-testid="membership-cancel-period-end" @click="confirming = 'at_period_end'" />
      <UButton block color="error" variant="soft" label="End membership now" :loading="busy === 'now'" data-testid="membership-cancel-now" @click="confirming = 'now'" />
    </div>
    <UModal :open="confirming !== null" portal="body" :title="confirming === 'now' ? 'End this membership now?' : 'Cancel at the end of the period?'" @update:open="value => { if (!value) confirming = null }">
      <template #body>
        <p class="text-sm text-muted">
          <template v-if="confirming === 'now'">Access ends today and no more payments are taken. What was already paid is not refunded; refund a payment from its own page.</template>
          <template v-else>No more payments are taken. {{ membership.member_name ?? 'The member' }} keeps access until {{ membership.current_period_end ? day(membership.current_period_end) : 'the end of the period' }}.</template>
        </p>
      </template>
      <template #footer>
        <div class="flex w-full justify-end gap-2">
          <UButton color="neutral" variant="ghost" label="Keep it" @click="confirming = null" />
          <UButton :color="confirming === 'now' ? 'error' : 'primary'" :label="confirming === 'now' ? 'End now' : 'Cancel at period end'" data-testid="membership-cancel-confirm" @click="cancel(confirming!)" />
        </div>
      </template>
    </UModal>
  </div>
</template>

<script setup lang="ts">
import { MEMBERSHIP_STATE_LABELS, type Membership } from '~/shared/memberships'
import { formatMinorAmount } from '~/shared/prices'
import type { CurrencyCode } from '~/shared/currencies'
import { formatCalendarDate } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'

const props = defineProps<{ membershipId: string; manage: boolean }>()
const dashboardApi = useDashboardApi()
const route = useRoute()
const membership = ref<Membership | null>(null)
const error = ref('')
const isMembership = (value: unknown): value is { membership: Membership } => isRecord(value) && isRecord(value.membership) && typeof value.membership.id === 'string'
try {
  membership.value = (await dashboardApi(`/api/dashboard/memberships/${encodeURIComponent(props.membershipId)}`, { validate: isMembership })).membership
} catch (cause) { error.value = getErrorMessage(cause, 'The membership could not be loaded') }

const day = (at: string) => formatCalendarDate(at.slice(0, 10), 'en', { month: 'short', day: 'numeric', year: 'numeric' })
const money = (amount: number) => membership.value ? formatMinorAmount(amount, membership.value.currency as CurrencyCode) : ''
const paymentPath = (paymentId: string) => `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/bookings/payment/${encodeURIComponent(paymentId)}`

const confirming = ref<'at_period_end' | 'now' | null>(null)
const busy = ref<'at_period_end' | 'now' | null>(null)
async function cancel(when: 'at_period_end' | 'now') {
  confirming.value = null
  busy.value = when
  error.value = ''
  try {
    membership.value = (await dashboardApi(`/api/dashboard/memberships/${encodeURIComponent(props.membershipId)}/cancel`, { method: 'POST', body: { when }, validate: isMembership })).membership
  } catch (cause) { error.value = getErrorMessage(cause, 'The membership could not be cancelled') }
  finally { busy.value = null }
}
</script>
