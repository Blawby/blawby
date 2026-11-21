import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { requireProductAccess } from '~/server/utils/location-access'
import { setInventoryLevels } from '~/server/domain/goods'

/** Sets stock counts for this product's variants at the locations that offer it. */
export default defineHandler(async event => {
  const organizationId = getRouterParam(event, 'organization_id')!
  const productId = getRouterParam(event, 'product_id')!
  const body = await readRequiredBody<{ levels?: unknown }>(event)
  const { db, session, organization } = await requireProductAccess(event, organizationId, productId, body as Record<string, unknown>)
  return jsonResponse({ levels: await setInventoryLevels(db, { organizationId: organization.id, productId, actorId: session.user.id, levels: body.levels as never }) })
})
