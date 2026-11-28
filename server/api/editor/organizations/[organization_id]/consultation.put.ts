import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { requireOrganizationAccess } from '~/server/utils/location-access'
import { setPublicConsultationMode } from '~/server/utils/professional-services'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { purgePublicResourceCacheNow } from '~/server/utils/public-resource-cache'
import { loadSettingsPayload } from '~/server/utils/organization-settings'

export default defineHandler(async event => {
  const { env, db, organization } = await requireOrganizationAccess(event, getRouterParam(event, 'organization_id')!)
  const view = getQuery(event).view
  if (view !== undefined && view !== 'settings') throw new HTTPError({ statusCode: 400, message: 'Choose a valid consultation view', data: { code: 'INVALID_QUERY', field: 'view' } })
  const body = await readStrictBody<{ mode: unknown; external_url?: unknown }>(event, { mode: 'unknown', external_url: 'unknown' })
  const settings = await setPublicConsultationMode(db, organization.id, body.mode as 'native' | 'external_url' | 'native_disabled', body.external_url)
  await purgePublicResourceCacheNow(env, organization.id)
  return jsonResponse(view === 'settings' ? { ...settings, settings: await loadSettingsPayload(db, env, organization.id) } : settings)
})
