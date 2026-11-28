import { defineHandler, HTTPError } from 'nitro'
import { readBody } from 'nitro/h3'
import { cloudflareEnv } from '~/server/utils/api-response'
import { getAuthSession } from '~/server/utils/auth'
import { onboardingAnswers, readOnboardingFlow } from '~/server/utils/onboarding-flow'

export default defineHandler(async (event) => {
  const env = cloudflareEnv(event)
  const session = await getAuthSession(event, env)
  if (!session?.user.id) throw new HTTPError({ statusCode: 401, statusMessage: 'Authentication required' })

  const answers = onboardingAnswers.safeParse(await readBody(event))
  if (!answers.success) throw new HTTPError({ statusCode: 400, statusMessage: 'Invalid onboarding answers' })
  if (!env.DB) throw new HTTPError({ statusCode: 503, statusMessage: 'Database not available' })

  return readOnboardingFlow(env, answers.data)
})
