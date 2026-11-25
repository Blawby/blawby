import { defineHandler } from 'nitro'
import { queryFirst } from '~/server/db'
import { getDashboardContext } from '~/server/utils/dashboard-context'
import { assertRoleAllows } from '~/server/utils/member-access'
import { jsonResponse } from '~/server/utils/api-response'
import { STRIPE_CONNECT_ONBOARDING_COUNTRIES } from '~/server/utils/stripe-connect'

/**
 * Use Stripe’s published merchant-onboarding countries, not transfer country specifications. The completed onboarding answer can suggest
 * a selection before a connected account exists.
 */
export default defineHandler(async (event) => {
  const { db, organization } = await getDashboardContext(event, {})
  await assertRoleAllows({ organizationId: organization.id, role: organization.role, permissions: { payments: ['integration'] } })
  const onboarding = await queryFirst<{ country: string | null }>(db, `
      SELECT json_extract(payload_json, '$.source.details.country') AS country
      FROM onboarding_drafts
      WHERE organization_id = ? AND status = 'committed'
      ORDER BY committed_at DESC, id DESC
      LIMIT 1
    `, [organization.id])
  const countries = STRIPE_CONNECT_ONBOARDING_COUNTRIES
  const answer = onboarding?.country
  return jsonResponse({ success: true, countries, suggested_country: answer && countries.includes(answer) ? answer : null })
})
