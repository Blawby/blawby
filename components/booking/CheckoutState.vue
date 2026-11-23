<template>
  <!--
    Every moment of the buyer's checkout that is not the form itself, on every
    theme: the business's name, one picture, one sentence, one line of help and
    at most one button, filling the screen. A confirmed or stopped checkout is
    this and nothing else; the site's theme supplies the fonts and the button.
  -->
  <section class="flex min-h-[70dvh] flex-col items-center justify-center px-5 py-16 text-center" :aria-busy="live || undefined" role="status" :data-checkout-state="state">
    <p v-if="business" class="mb-10 text-sm text-muted">{{ business }}</p>
    <div class="relative mb-8 grid size-32 place-items-center rounded-full" :class="TONES[tone ?? PICTURES[state].tone]">
      <img v-if="shown.image" :src="shown.image" alt="" class="size-28 object-contain" :class="live ? 'motion-safe:animate-[checkout-breathe_2.4s_ease-in-out_infinite]' : undefined">
      <UIcon v-else :name="shown.icon!" class="size-14 text-highlighted" :class="live ? 'motion-safe:animate-[checkout-breathe_2.4s_ease-in-out_infinite]' : undefined" />
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
  /** Blawby's cut-paper picture for this moment, or the icon that stands in until it is made; each state has its own. */
  picture?: CheckoutPicture | null
  tone?: 'neutral' | 'good' | 'warn' | null
  title: string
  help?: string | null
  where?: string | null
  action?: CheckoutStateAction | null
  /** Waiting on something: the picture breathes and a stroke travels around it, unless the buyer asked for less motion. */
  live?: boolean
}>(), { business: null, picture: null, tone: null, help: null, where: null, action: null, live: false })
const shown = computed(() => props.picture ?? PICTURES[props.state])
</script>

<script lang="ts">
/** The moments a checkout can be in, besides showing its form. */
export type CheckoutStateKey = 'reviewing' | 'processing' | 'bank_verification' | 'confirmed' | 'order_confirmed' | 'membership_active'
  | 'already_paid' | 'not_completed' | 'expired' | 'taken' | 'unavailable'

export interface CheckoutStateAction { label: string; to?: string; href?: string; quiet?: boolean; loading?: boolean; onClick?: () => void }

export type CheckoutPicture = { image: string; icon?: undefined } | { icon: string; image?: undefined }

const TONES = { neutral: 'bg-elevated', good: 'bg-primary/10', warn: 'bg-error/10' } as const

// Blawby's cut-paper pieces where they exist; the rest stand in with an icon until theirs are made.
const PICTURES: Record<CheckoutStateKey, CheckoutPicture & { tone: keyof typeof TONES }> = {
  reviewing: { icon: 'i-lucide-credit-card', tone: 'neutral' },
  processing: { icon: 'i-lucide-mail', tone: 'neutral' },
  bank_verification: { icon: 'i-lucide-landmark', tone: 'neutral' },
  // The page names what was booked with the picture prop: a home, a briefcase, or a stand-in.
  confirmed: { icon: 'i-lucide-calendar-check', tone: 'good' },
  order_confirmed: { icon: 'i-lucide-package-check', tone: 'good' },
  membership_active: { icon: 'i-lucide-badge-check', tone: 'good' },
  already_paid: { image: '/images/offers/card.webp', tone: 'good' },
  not_completed: { icon: 'i-lucide-circle-x', tone: 'warn' },
  expired: { icon: 'i-lucide-timer-off', tone: 'warn' },
  taken: { image: '/images/offers/calendar.webp', tone: 'warn' },
  unavailable: { icon: 'i-lucide-link-2-off', tone: 'neutral' },
}
</script>

<style>
@keyframes checkout-breathe { 0%, 100% { transform: scale(1) } 50% { transform: scale(1.06) } }
@keyframes checkout-sweep { to { stroke-dashoffset: -88 } }
</style>
