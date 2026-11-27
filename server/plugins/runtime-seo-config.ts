import { definePlugin } from 'nitro'

import { isPrivateSeoPath, resolveRuntimeSeoConfig } from '~/server/utils/seo-policy'
import { TENANT_TYPES, type TenantType } from '~/utils/tenant-routing'

export default definePlugin((nitroApp) => {
  nitroApp.hooks.hook('site-config:init', ({ event, siteConfig }) => {
    const requestURL = event.url
    const isPlatform = event.context.tenantType === TENANT_TYPES.PLATFORM
    if (isPrivateSeoPath(requestURL.pathname, { isPlatform })) return

    const organization = event.context.organization as { name?: string | null; subdomain?: string } | undefined

    siteConfig.push({
      _context: 'runtime-tenant',
      ...resolveRuntimeSeoConfig({
        tenantType: event.context.tenantType as TenantType | null | undefined,
        origin: requestURL.origin,
        hostname: requestURL.hostname,
        tenantName: organization?.name,
        tenantSubdomain: organization?.subdomain,
      }),
    })
  })
})
