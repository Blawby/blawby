import { HTTPError } from 'nitro'
import { SEARCH_ROW_STRIDE, SEARCH_SOURCES } from '~/server/db/search-index'
import { searchWords } from '~/shared/search'

/** Every word must match a canonical row through the same derived FTS index. */
export function searchMatchSql(query: string, match: (term: string) => string): { sql: string; params: string[] } | null {
  if (query.length > 200 || query.includes('\0')) throw new HTTPError({ statusCode: 422, message: 'Search for up to 200 characters without null characters', data: { code: 'INVALID_SEARCH', field: 'q' } })
  const words = searchWords(query)
  if (!words.length) return null
  const terms = words.map(word => {
    const points = Array.from(word)
    if (points.length < 3) {
      const token = `${points.length === 1 ? 'u' : 'b'}${points.map(point => point.codePointAt(0)!.toString(16).padStart(6, '0')).join('')};`
      return `short_grams : "${token}"`
    }
    return `text : "${word.replaceAll('"', '""')}"`
  })
  // A constant MATCH subquery is read once by SQLite. Correlating it through
  // json_each would rerun the full-text lookup for each candidate source row.
  return {
    sql: `(${terms.map(term => `COALESCE(${match(`'${term.replaceAll("'", "''")}'`)}, 0)`).join(' AND ')})`,
    params: [],
  }
}

export function searchIndexMatch(table: typeof SEARCH_SOURCES[number]['table'], alias: string, term: string): string {
  const lane = SEARCH_SOURCES.findIndex(source => source.table === table)
  return `${alias}.rowid IN (SELECT rowid / ${SEARCH_ROW_STRIDE} FROM search_index WHERE search_index MATCH ${term} AND rowid % ${SEARCH_ROW_STRIDE} = ${lane})`
}
