<template>
  <!--
    Who has joined this membership: one row per member, with Stripe's state of
    their membership and its price, each opening the membership on the record
    of its latest payment, where it can be cancelled.
  -->
  <DashboardIndexPanel id="product-members" title="Members">
    <UAlert v-if="error" color="error" variant="soft" icon="i-lucide-triangle-alert" :description="getErrorMessage(error, 'Members could not be loaded')" />
    <UEmpty v-else-if="data && !data.memberships.length" icon="i-lucide-users" title="No members yet" description="Members appear here once Stripe takes their first payment." />
    <EditorNavigationList v-else :groups="groups" />
  </DashboardIndexPanel>
</template>

<script setup lang="ts">
import EditorNavigationList, { type EditorNavigationGroup } from '~/components/dashboard/EditorNavigationList.vue'
import { MEMBERSHIP_STATE_LABELS, type Membership } from '~/shared/memberships'
import { formatCalendarDate } from '~/utils/timezone'
import { getErrorMessage } from '~/utils/errors'
import { isRecord } from '~/utils/api-clients'

definePageMeta({ layout: 'dashboard' })

const route = useRoute()
const dashboardApi = useDashboardApi()
const productId = computed(() => String(route.params.product_id))
const { data, error } = await useAsyncData(() => `product-members:${productId.value}`, () => dashboardApi('/api/dashboard/memberships', {
  query: { product_id: productId.value },
  validate: (value): value is { memberships: Membership[] } => isRecord(value) && Array.isArray(value.memberships),
}))
const day = (at: string) => formatCalendarDate(at.slice(0, 10), 'en', { month: 'short', day: 'numeric', year: 'numeric' })
const groups = computed<EditorNavigationGroup[]>(() => [{
  id: 'members',
  items: (data.value?.memberships ?? []).map(membership => ({
    id: membership.id,
    label: membership.member_name ?? membership.member_email ?? 'Member',
    icon: 'i-lucide-user',
    summary: [MEMBERSHIP_STATE_LABELS[membership.state], membership.terms,
      membership.current_period_end ? `${membership.state === 'cancelling' ? 'Access until' : 'Next payment'} ${day(membership.current_period_end)}` : null].filter(Boolean).join(' · '),
    to: `/dashboard/${encodeURIComponent(String(route.params.org_slug))}/bookings/payment/${encodeURIComponent(membership.payments[0]!.id)}`,
  })),
}])
</script>
