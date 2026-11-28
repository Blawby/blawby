import { getQuery } from 'nitro/h3'
import { onboardingAnswers, readOnboardingFlow } from '~/server/utils/onboarding-flow'
// The owner's unfinished draft, so reloading /dashboard/onboarding picks up
// where they left off instead of asking every question again. An abandoned
// draft resumes only the cleanup its owner already requested.
import { cloudflareEnv, jsonResponse } from '~/server/utils/api-response'
import { getAuthSession, dashboardSessionUserQuery, type DashboardAuthRead } from '~/server/utils/auth'
import { executeBatch } from '~/server/db'
import { getDraftMedia, parseStoredOnboardingDraftPayload, prepareActiveOnboardingDraft } from '~/server/utils/onboarding-drafts'
import { createPreviewToken, PREVIEW_TOKEN_TTL_MS, previewSecretOf } from '~/server/utils/preview-token'
import { defineHandler, HTTPError } from 'nitro'
import { deleteAbandonedDraftTenant } from '~/server/utils/tenant-deletion'
import { WEBSITE_ONBOARDING_RESUME_ACTION } from '~/shared/onboarding-flow'

const noDraft = { success: true, draft: null, resume_action: null }


export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const db = env.DB
  if (!db) return jsonResponse({ error: 'Database not available' }, { status: 500 })

  let plan: ReturnType<typeof prepareActiveOnboardingDraft> | undefined
  const auth: DashboardAuthRead = { queries(token) { plan = prepareActiveOnboardingDraft(dashboardSessionUserQuery(token), true); return [plan.query] } }
  const session = await getAuthSession(event, env, { document: auth, forwardCookies: true })
  if (!session?.user?.id) return jsonResponse({ error: 'Authentication required' }, { status: 401 })

  plan ??= prepareActiveOnboardingDraft(session.user.id, true)
  const row = plan.read((auth.results ?? await executeBatch(db, [plan.query]))[0]!)

  const screen = getQuery(event).view === 'screen'
  const initial = () => readOnboardingFlow(env, onboardingAnswers.parse({ vertical: null, source: null, placeId: null, name: '', sourceLocale: null, country: '', timezone: '', currency: null }), { validateSubdomain: false })
  if (!row) return jsonResponse({ ...noDraft, ...(screen ? { flow: await initial() } : {}) })
  if (row.status === 'abandoned') {
    if (!row.organization_id || !row.subdomain_candidate) throw new HTTPError({ statusCode: 409, statusMessage: 'Website draft cleanup has no recorded organization or address. Its native ownership must be verified.', data: { code: 'ONBOARDING_DRAFT_DISCARD_INCOMPLETE', draft_id: row.id } })
    const outcome = await deleteAbandonedDraftTenant(env, {
      draftId: row.id,
      updated_at: row.updated_at, organizationId: row.organization_id,
      subdomain: row.subdomain_candidate, userId: session.user.id,
    })
    if ('refused' in outcome) throw new HTTPError({
      statusCode: outcome.refused === 'not_owner' ? 403 : outcome.refused === 'delete_incomplete' ? 500 : 409,
      statusMessage: outcome.refused === 'organization_is_live' ? 'This site is already live. Delete it from its dashboard instead.' : 'Website draft cleanup is incomplete. Retry discarding this draft.',
      data: { code: 'ONBOARDING_DRAFT_DISCARD_INCOMPLETE', draft_id: row.id, organization_id: row.organization_id },
    })
    return jsonResponse({ ...noDraft, ...(screen ? { flow: await initial() } : {}) })
  }

  const payload = parseStoredOnboardingDraftPayload(row.payload_json)

  const organization = row.resolved_organization_id ? { id: row.resolved_organization_id, subdomain: row.resolved_subdomain } : null

  // A draft older than the token's lifetime is still resumable; the token is
  // minted fresh on every read rather than stored with the draft.
  const previewSecret = previewSecretOf(env)
  const previewToken = organization?.subdomain && previewSecret
    ? await createPreviewToken(previewSecret, organization.id, Date.now() + PREVIEW_TOKEN_TTL_MS)
    : null

  const flow = screen ? await readOnboardingFlow(env, onboardingAnswers.parse({
    vertical: row.vertical, source: row.source_type, placeId: payload.source.placeId, name: row.name,
    subdomain: organization ? undefined : payload.partial && payload.preview ? payload.subdomain_answer ?? undefined : row.subdomain_candidate ?? undefined,
    savedSubdomain: organization?.subdomain ?? null, sourceLocale: payload.source.details.source_locale,
    country: payload.source.details.country ?? '', timezone: payload.source.details.timezone ?? '',
    timezoneStepVisited: payload.timezone_step_visited ?? false, pausedStep: payload.partial ? payload.paused_step : undefined,
    currency: payload.source.details.currency, confirmationMode: payload.source.details.confirmation_mode,
  }), { validateSubdomain: false }) : null
  return jsonResponse({
    ...(screen ? { flow } : {}),
    success: true,
    resume_action: WEBSITE_ONBOARDING_RESUME_ACTION,
    draft: {
      draft_id: row.id,
      updated_at: row.updated_at,
      name: row.name,
      source_type: row.source_type,
      google_place_id: payload.source.placeId,
      vertical: row.vertical,
      details: payload.source.details,
      timezone_step_visited: payload.timezone_step_visited ?? false,
      paused_step: payload.partial ? payload.paused_step ?? null : null,
      config: payload.preview?.config ?? null,
      logo_image: getDraftMedia(payload, 'logo'),
      hero_image: getDraftMedia(payload, 'hero'),
      products: (payload.preview?.vertical === row.vertical ? payload.preview.products : []).map(product => ({
        name: product.name,
        category: product.collection,
        unit_amount: product.price === null ? null : product.price.unit_amount,
      })),
      organization_id: organization?.id ?? null,
      subdomain_candidate: organization?.subdomain ?? (payload.partial && payload.preview ? payload.subdomain_answer ?? null : row.subdomain_candidate),
      preview_token: previewToken,
    },
  })
})
