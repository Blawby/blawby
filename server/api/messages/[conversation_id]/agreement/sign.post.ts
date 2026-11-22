import { defineHandler } from 'nitro'
import { signAgreement } from '~/server/domain/agreements'
import { jsonResponse, readStrictBody } from '~/server/utils/api-response'
import { agreementRequest } from '~/server/utils/agreement-request'
import { requireFinancialBrowserOrAppRequest } from '~/server/utils/financial-browser'

/** The viewer signs with the name they typed, having agreed to sign electronically. */
export default defineHandler(async event => {
  requireFinancialBrowserOrAppRequest(event)
  const { env, conversation, viewer } = await agreementRequest(event)
  const body = await readStrictBody<{ typed_name?: string; consent?: boolean; document_id?: string }>(event, { typed_name: 'string', consent: 'boolean', document_id: 'string' })
  await signAgreement(env, conversation, viewer, {
    documentId: body.document_id ?? '', typedName: body.typed_name ?? '', consent: body.consent === true,
    ip: event.req.headers.get('cf-connecting-ip'), userAgent: event.req.headers.get('user-agent'),
  })
  return jsonResponse({ signed: true }, { status: 201 })
})
