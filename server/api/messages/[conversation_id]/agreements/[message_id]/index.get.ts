import { defineHandler, HTTPError } from 'nitro'
import { getQuery, getRouterParam } from 'nitro/h3'
import { agreementDocument } from '~/server/domain/agreements'
import { agreementRequest, pdfResponse, requireAgreementReader } from '~/server/utils/agreement-request'

/** A booking's document, for its guests and the business that manages it. */
export default defineHandler(async event => {
  const { env, conversation, role, viewer } = await agreementRequest(event)
  requireAgreementReader(role, viewer)
  const messageId = getRouterParam(event, 'message_id', { decode: true })
  if (!messageId) throw new HTTPError({ statusCode: 400, message: 'A document is required', data: { code: 'VALIDATION_ERROR', field: 'message_id' } })
  const document = await agreementDocument(env, conversation, messageId)
  return pdfResponse(document.bytes, document.fileName, getQuery(event).download === '1')
})
