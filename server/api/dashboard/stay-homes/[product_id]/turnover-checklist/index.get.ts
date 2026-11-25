import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { readHomeChecklist } from '~/server/domain/home-checklists'

// A home's turnover checklist, for the people who can see the home.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  return jsonResponse({ checklist: await readHomeChecklist(db, env, access, getRouterParam(event, 'product_id') ?? '') }, { headers: { 'cache-control': 'private, no-store' } })
})
