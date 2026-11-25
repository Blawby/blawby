import { defineHandler } from 'nitro'
import { getRouterParam } from 'nitro/h3'
import { jsonResponse, readRequiredBody } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { memberAccessPrincipal } from '~/server/utils/member-access'
import { stayAccessFor } from '~/server/domain/stays'
import { copyHomeChecklist } from '~/server/domain/home-checklists'

// Copy this home's turnover checklist to other homes: { product_ids: [...] }. Owners and admins.
export default defineHandler(async (event) => {
  const { env, db, organization } = await getDashboardMemberContext(event, {})
  const access = await stayAccessFor(memberAccessPrincipal(organization, { env, event }))
  const body = await readRequiredBody<Record<string, unknown>>(event)
  return jsonResponse(await copyHomeChecklist(db, env, access, getRouterParam(event, 'product_id') ?? '', body))
})
