import { HTTPError } from 'nitro'
import { SEARCH_ROW_STRIDE, SEARCH_SOURCES } from '~/server/db/search-index'
import { d1JsonStringSet } from '~/server/db/d1-limits'
import { searchWords } from '~/shared/search'

type Source = typeof SEARCH_SOURCES[number]['table']

/** FTS runs once per query word; canonical row lookups start from those hits. */
export function searchMatchSql(query: string, matchingRows: (hits: string) => string, scope: {
  sources: readonly Source[]; organization: string | { sql: string } | null
}): { sql: string; params: Array<string | number> } | null {
  if (query.length > 200 || query.includes('\0')) throw new HTTPError({ statusCode: 422, message: 'Search for up to 200 characters without null characters', data: { code: 'INVALID_SEARCH', field: 'q' } })
  const words = searchWords(query)
  if (!words.length) return null
  const kinds = scope.sources.map(table => `kind : "t${String(SEARCH_SOURCES.findIndex(source => source.table === table)).padStart(2, '0')};"`).join(' OR ')
  const terms = words.map(word => {
    const points = Array.from(word)
    const term = points.length < 3
      ? `short_grams : "${points.length === 1 ? 'u' : 'b'}${points.map(point => point.codePointAt(0)!.toString(16).padStart(6, '0')).join('')};"`
      : `text : "${word.replaceAll('"', '""')}"`
    const organization = typeof scope.organization === 'string'
      ? ` AND scope : "o${Array.from(new TextEncoder().encode(scope.organization), byte => byte.toString(16).padStart(2, '0')).join('')};"` : ''
    return `(${term}) AND (${kinds})${organization}`
  })
  const expression = scope.organization && typeof scope.organization !== 'string'
    ? `search_word.value || ' AND scope : "o' || lower(hex(${scope.organization.sql})) || ';"'` : 'search_word.value'
  return {
    sql: `WITH search_hits AS MATERIALIZED (
      SELECT search_index.rowid, search_word.key AS word FROM json_each(?) search_word
      CROSS JOIN search_index WHERE search_index MATCH (${expression})
    ), matched AS (${matchingRows('search_hits')})
    SELECT id FROM matched GROUP BY id HAVING count(DISTINCT word) = ?`,
    params: [d1JsonStringSet(terms), words.length],
  }
}

export function searchIndexMatch(table: Source, alias: string, hit: string): string {
  const lane = SEARCH_SOURCES.findIndex(source => source.table === table)
  return `${alias}.rowid = ${hit}.rowid / ${SEARCH_ROW_STRIDE} AND ${hit}.rowid % ${SEARCH_ROW_STRIDE} = ${lane}`
}
