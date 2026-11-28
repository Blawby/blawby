import { defineHandler } from 'nitro'
import { jsonResponse } from '~/server/utils/api-response'
import { getDashboardMemberContext } from '~/server/utils/dashboard-context'
import { STAY_HOME_VOCABULARY } from '~/server/domain/stays'

export default defineHandler(async event => {
  await getDashboardMemberContext(event, {})
  return jsonResponse(STAY_HOME_VOCABULARY)
})
