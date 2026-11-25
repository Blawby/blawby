import type { GuestMessageSchedule } from '~/server/domain/guest-message-schedule'
import { resolveAggregateBookingPresentation } from '~/utils/booking-presentation'

/**
 * The words a schedule is described with. A place to stay checks in and out
 * in its home's time zone; anything else is the booking's own noun
 * (consultation, reservation, booking) starting and ending: a restaurant's
 * bookings are mostly its tables, so it says reservation.
 */
export function scheduleVocabulary(vertical: string | null) {
  if (vertical === 'lodging') return { received: 'a new reservation', check_in: 'check-in', check_out: 'checkout', start_label: 'Check-in', end_label: 'Checkout', checkInDay: 'On check-in day', checkOutDay: 'On checkout day', zone: 'home’s time zone', scope: 'Homes' }
  const { noun } = resolveAggregateBookingPresentation([{ kind: vertical === 'restaurant' ? 'table' : 'experience', vertical }])
  return { received: `a new ${noun}`, check_in: `the ${noun} starts`, check_out: `the ${noun} ends`, start_label: `${noun.charAt(0).toUpperCase() + noun.slice(1)} start`, end_label: `${noun.charAt(0).toUpperCase() + noun.slice(1)} end`,
    checkInDay: `On the day the ${noun} starts`, checkOutDay: `On the day the ${noun} ends`, zone: `${noun}’s time zone`, scope: vertical === 'restaurant' ? 'Tables' : vertical === 'service' ? 'Consultations' : 'Experiences' }
}

export function messageScheduleLabel(schedule: GuestMessageSchedule, vertical: string | null): string {
  const words = scheduleVocabulary(vertical)
  if (schedule.trigger === 'booking_received') return `5 minutes after ${words.received}`
  const event = words[schedule.trigger]
  const count = (amount: number, unit: string) => `${Math.abs(amount)} ${unit}${Math.abs(amount) === 1 ? '' : 's'} ${amount < 0 ? 'before' : 'after'} ${event}`
  if ('offset_hours' in schedule) return schedule.offset_hours ? count(schedule.offset_hours, 'hour') : `When ${event}`
  return `${schedule.offset_days ? count(schedule.offset_days, 'day') : schedule.trigger === 'check_in' ? words.checkInDay : words.checkOutDay} at ${schedule.local_time} · ${words.zone}`
}
