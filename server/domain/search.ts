import { d1JsonStringSet } from '~/server/db/d1-limits'
import { foldSearchText, searchWords } from '~/shared/search'

/**
 * The search rule of `shared/search.ts`, said to the database.
 *
 * D1 is SQLite without ICU: `LOWER` folds ASCII only and nothing strips
 * accents. Each query letter becomes a GLOB class of every letter that folds
 * to it ("e" is `[eEéÉèÈêÊëË…]`), so stored text is matched as written, case
 * and accents ignored, anywhere in a word. An FTS5 index was rejected: D1's
 * export refuses a database holding a virtual table, and the snapshot pull
 * and every epoch transfer read that export.
 */

const SPECIAL = new Set(['*', '?', '['])
const RANGES: Array<[number, number]> = [[0x20, 0x24f], [0x370, 0x52f], [0x1e00, 0x1eff]]

/** Every letter or digit that folds to one character, keyed by what it folds to. */
const FOLDS = (() => {
  const folds = new Map<string, Set<string>>()
  for (const [from, to] of RANGES) {
    for (let code = from; code <= to; code += 1) {
      const char = String.fromCodePoint(code)
      if (!/[\p{L}\p{N}]/u.test(char)) continue
      const folded = foldSearchText(char)
      if ([...folded].length !== 1) continue
      const set = folds.get(folded) ?? new Set<string>()
      set.add(char)
      folds.set(folded, set)
    }
  }
  return folds
})()

function globChar(char: string): string {
  const set = new Set([char, ...FOLDS.get(char) ?? [], char.toUpperCase()].filter(variant => [...variant].length === 1))
  if (set.size === 1) return SPECIAL.has(char) ? `[${char}]` : char
  return `[${[...set].join('')}]`
}

/** A folded word as a GLOB pattern that finds it anywhere in a value. */
function globPattern(word: string): string {
  return `*${[...word].map(globChar).join('')}*`
}

/**
 * The rows where every word of `query` matches: `match` says, for one word's
 * GLOB pattern (an SQL expression), whether the row matches it. Null when the
 * query has no words.
 */
export function searchMatchSql(query: string, match: (pattern: string) => string): { sql: string; params: string[] } | null {
  const words = searchWords(query)
  if (!words.length) return null
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(?) search_word WHERE NOT COALESCE(${match('search_word.value')}, 0))`,
    params: [d1JsonStringSet(words.map(globPattern))],
  }
}

/** Whether any of `columns` matches `pattern`. */
export function globAny(columns: string[], pattern: string): string {
  return `(${columns.map(column => `COALESCE(${column}, '') GLOB ${pattern}`).join(' OR ')})`
}
