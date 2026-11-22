import { isRecord } from '~/utils/api-clients'

export interface ShippingRateDraft { id?: string; name: string; currency?: string; amount: number; min_weight_grams: number | null; max_weight_grams: number | null; min_subtotal: number | null; delivery_days_min: number | null; delivery_days_max: number | null }
export interface ShippingZoneView { id: string; location_id: string; name: string; countries: string[]; updated_at: string; rates: Array<ShippingRateDraft & { id: string }> }
export interface ShippingSettings { zones: ShippingZoneView[]; locations: Array<{ id: string; title: string; pickup_enabled: boolean }> }

export const isShippingSettings = (value: unknown): value is ShippingSettings => isRecord(value) && Array.isArray(value.zones) && Array.isArray(value.locations)

/** Where the business ships and where buyers collect, read once for the index and its leaves. */
export function useShippingSettings() {
  const dashboardApi = useDashboardApi()
  const scope = useDashboardRouteScope()
  return useAsyncData(() => `shipping-settings:${unref(scope)?.orgSlug ?? ''}`, () => dashboardApi('/api/dashboard/shipping', { validate: isShippingSettings }))
}
