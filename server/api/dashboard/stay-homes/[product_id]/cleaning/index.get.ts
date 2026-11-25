import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { readHomeTeam } from '~/server/domain/home-cleaning'

// A home's team and who cleans it: its cleaners in order and whether cleans are offered to all of them.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  return jsonResponse({ team: await readHomeTeam(db, access, getRouterParam(event, 'product_id') ?? '') }, { headers: { 'cache-control': 'private, no-store' } })
})
