import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { queryAll } from '~/server/db'
import { requireRequestedOrganizationWideAccess } from '~/server/utils/location-access'
import { listShippingZones } from '~/server/domain/goods'

/** Where the business ships from and to, and where buyers can collect. */
export default defineHandler(async event => {
  const { db, organization } = await requireRequestedOrganizationWideAccess(event)
  const [zones, locations] = await Promise.all([
    listShippingZones(db, organization.id),
    queryAll<{ id: string; title: string; pickup_enabled: number }>(db, "SELECT id, title, pickup_enabled FROM business_locations WHERE organization_id = ? AND status = 'active' ORDER BY created_at, id", [organization.id]),
  ])
  return jsonResponse({ zones, locations: locations.map(location => ({ ...location, pickup_enabled: location.pickup_enabled === 1 })) })
})
