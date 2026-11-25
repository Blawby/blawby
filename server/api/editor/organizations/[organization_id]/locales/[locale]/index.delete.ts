import { defineHandler, HTTPError } from 'nitro'
import { getRouterParam } from 'nitro/h3'

import { requireOrganizationAccess } from '~/server/utils/location-access'
import { deleteDisabledOrganizationLanguageContent } from '~/server/utils/organization-languages'
import { isDemoOrganization } from '~/shared/demo'
import { hasPlatformEventPermission } from '~/server/utils/platform-admin-users'

export default defineHandler(async (event) => {
  const organizationId = getRouterParam(event, 'organization_id')
  const locale = getRouterParam(event, 'locale')
  if (!organizationId || !locale) throw new HTTPError({ status: 400, message: 'Organization ID and locale are required', data: { code: 'INVALID_ROUTE_PARAMETERS' } })
  const { env, db, organization } = await requireOrganizationAccess(event, organizationId)
  if (isDemoOrganization(organization) && !(await hasPlatformEventPermission(event, env, { platform: ['access'] }))) {
    throw new HTTPError({ status: 403, message: 'Demo organization is read-only', data: { code: 'DEMO_ORGANIZATION_READ_ONLY' } })
  }
  return await deleteDisabledOrganizationLanguageContent(db, { organizationId: organization.id, locale })
})
