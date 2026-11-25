export interface McpStructuredResponse {
  __mcpStructuredResponse: true
  structuredContent: unknown
  modelText?: string
  privateMeta?: Record<string, unknown>
  isError?: boolean
  /** Pictures the model should see, sent as MCP image content after the text. */
  images?: Array<{ data: string; mimeType: string }>
}

export function withMcpLink(message: string, label: string, url: string | null | undefined): string {
  if (!url || !/^https?:\/\//i.test(url) || !URL.canParse(url)) return message
  return `${message} [${label}](<${new URL(url).href}>)`
}

export function renderStructuredResponse(
  structuredContent: unknown,
  modelText?: string,
  privateMeta?: Record<string, unknown>,
  isError = false,
  images?: McpStructuredResponse['images'],
): McpStructuredResponse {
  return { __mcpStructuredResponse: true, structuredContent, modelText, privateMeta, isError, ...(images?.length ? { images } : {}) }
}

export function isMcpRenderResponse(value: unknown): value is McpStructuredResponse {
  return (
    typeof value === 'object'
    && value !== null
    && (value as Record<string, unknown>).__mcpStructuredResponse === true
    && 'structuredContent' in value
  )
}
