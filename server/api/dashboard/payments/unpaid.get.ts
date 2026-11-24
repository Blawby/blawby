import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { readUnpaid } from '~/server/domain/unpaid'

/** Who owes the business: each booking with rent, a balance or a deposit due and unpaid, oldest first (server/domain/unpaid.ts). */
export default defineHandler(async (event) => {
  const { db, organization } = await getDashboardContext(event)
  return jsonResponse(await readUnpaid(db, { organizationId: organization.id, role: organization.role }), { headers: { 'cache-control': 'private, no-store' } })
})
