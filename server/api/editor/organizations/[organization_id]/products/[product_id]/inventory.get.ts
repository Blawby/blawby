import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { readInventoryLevels } from '~/server/domain/goods'

export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id')!
  const productId = getRouterParam(event, 'product_id')!
  const { db, organization } = await requireProductAccess(event, organizationId, productId)
  return jsonResponse({ levels: await readInventoryLevels(db, organization.id, productId) })
})
