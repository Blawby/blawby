import { d1JsonStringSet } from '~/server/db/d1-limits'
import { SEARCH_ROW_STRIDE, SEARCH_SOURCES } from '~/server/db/search-index'
import { searchWords } from '~/shared/search'

/** Every word must match a canonical row through the same derived FTS index. */
export function searchMatchSql(query: string, match: (term: string) => string): { sql: string; params: string[] } | null {
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
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) search_word WHERE NOT COALESCE(${match('search_word.value')}, 0))`,
    params: [d1JsonStringSet(terms)],
  }
}

export function searchIndexMatch(table: typeof SEARCH_SOURCES[number]['table'], alias: string, term: string): string {
  const lane = SEARCH_SOURCES.findIndex(source => source.table === table)
  return `${alias}.rowid * ${SEARCH_ROW_STRIDE} + ${lane} IN (SELECT rowid FROM search_index WHERE search_index MATCH ${term})`
}
