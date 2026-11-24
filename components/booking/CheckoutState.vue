<template>
  <!--
    Every moment of the buyer's checkout that is not the form itself, on every
    theme: the business's name, one picture, one sentence, one line of help and
    at most one button, filling the screen. A confirmed or stopped checkout is
    this and nothing else; the site's theme supplies the fonts and the button.
  -->
  <section class="flex min-h-[70dvh] flex-col items-center justify-center px-5 py-16 text-center" :aria-busy="live || undefined" role="status" :data-checkout-state="state">
    <p v-if="business" class="mb-10 text-sm text-muted">{{ business }}</p>
    <div v-if="shown || live" class="relative mb-8 grid size-32 place-items-center rounded-full" :class="TONES[tone ?? PICTURES[state].tone]">
      <img v-if="shown" :key="shown" :src="shown" alt="" class="size-28 object-contain"
        :class="{ 'motion-safe:animate-[checkout-settle_360ms_cubic-bezier(.2,.72,.27,1)_both]': !live }">
      <!-- While it waits, a stroke travels around the picture's own circle, never across it. -->
      <svg v-if="live" class="pointer-events-none absolute -inset-2.5 size-[calc(100%+1.25rem)] -rotate-90" viewBox="0 0 100 100" aria-hidden="true">
        <circle cx="50" cy="50" r="48" fill="none" stroke="var(--ui-border)" stroke-width="2.5" />
        <circle cx="50" cy="50" r="48" fill="none" stroke="var(--ui-primary)" stroke-width="2.5" stroke-linecap="round" pathLength="88" stroke-dasharray="22 66"
          class="motion-safe:animate-[checkout-sweep_1.6s_linear_infinite]" />
      </svg>
    </div>
    <h1 class="tenant-display max-w-md text-2xl font-semibold leading-tight text-highlighted text-balance sm:text-3xl">{{ title }}</h1>
    <p v-if="help" class="mt-3 max-w-sm text-muted">{{ help }}</p>
    <p v-if="where" class="mt-1 text-sm text-muted">{{ where }}</p>
    <div v-if="action" class="mt-8 w-full max-w-xs">
      <TenantButton block size="lg" :variant="action.quiet ? 'outline' : 'solid'" :to="action.to" :href="action.href" :target="action.href ? '_blank' : undefined" :loading="action.loading" data-checkout-action @click="action.onClick?.()">
        {{ action.label }}
      </TenantButton>
    </div>
  </section>
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  state: CheckoutStateKey
  business?: string | null
  /** Artwork for the kind of booking the buyer confirmed. */
  picture?: string | null
  tone?: 'neutral' | 'good' | 'warn' | null
  title: string
  help?: string | null
  where?: string | null
  action?: CheckoutStateAction | null
  live?: boolean
}>(), { business: null, picture: null, tone: null, help: null, where: null, action: null, live: false })
const shown = computed(() => props.picture ?? PICTURES[props.state].image)
</script>

<script lang="ts">
/** The moments a checkout can be in, besides showing its form. */
export type CheckoutStateKey = 'reviewing' | 'processing' | 'bank_verification' | 'confirmed' | 'order_confirmed' | 'membership_active'
  | 'already_paid' | 'not_completed' | 'expired' | 'taken' | 'unavailable'

export interface CheckoutStateAction { label: string; to?: string; href?: string; quiet?: boolean; loading?: boolean; onClick?: () => void }

const TONES = { neutral: 'bg-accented', good: 'bg-primary/10', warn: 'bg-error/10' } as const

const PICTURES: Record<CheckoutStateKey, { image: string | null; tone: keyof typeof TONES }> = {
  reviewing: { image: '/images/offers/checkout-card-reader.webp', tone: 'neutral' },
  processing: { image: '/images/offers/checkout-processing.webp', tone: 'neutral' },
  bank_verification: { image: '/images/offers/checkout-bank.webp', tone: 'neutral' },
  confirmed: { image: null, tone: 'good' },
  order_confirmed: { image: '/images/offers/checkout-order.webp', tone: 'good' },
  membership_active: { image: '/images/offers/checkout-membership.webp', tone: 'good' },
  already_paid: { image: '/images/offers/card.webp', tone: 'good' },
  not_completed: { image: '/images/offers/checkout-not-completed.webp', tone: 'warn' },
  expired: { image: '/images/offers/checkout-expired.webp', tone: 'warn' },
  taken: { image: '/images/offers/calendar.webp', tone: 'warn' },
  unavailable: { image: '/images/offers/checkout-unavailable.webp', tone: 'neutral' },
}
</script>

<style>
@keyframes checkout-settle {
  from { transform: translateY(7px) scale(.96); opacity: .45; }
  to { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes checkout-sweep { to { stroke-dashoffset: -88 } }
</style>
