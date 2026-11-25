import folds from './search-character-folds.json' with { type: 'json' }

const characterFolds: Readonly<Record<string, string>> = folds

/**
 * The one matching rule for search (Blawby/blawby#2103): every word of the
 * query must match, case and accents are ignored, and a match may start
 * anywhere in a word. "jose" finds "José", "emile" finds "Émile", "4567"
 * finds "+1 555 123 4567".
 *
 * `matchesSearch` is the rule for a list already on screen;
 * `server/domain/search.ts` says the same rule to the database.
 */

/** Unicode 17 full case folding (C/F mappings), then canonical diacritics removed.
 * Data: https://www.unicode.org/Public/17.0.0/ucd/CaseFolding.txt
 * Unicode data © Unicode, Inc., licensed under https://www.unicode.org/license.txt
 */
export function foldSearchText(text: string): string {
  return Array.from(text, character => characterFolds[String(character.codePointAt(0))] ?? character).join('')
}

/** The query's distinct words, folded. */
export function searchWords(query: string): string[] {
  return [...new Set(foldSearchText(query).split(/\s+/).filter(Boolean))]
}

/** Whether every word of `query` is found in at least one of `fields`. An empty query matches everything. */
export function matchesSearch(query: string, fields: ReadonlyArray<string | null | undefined>): boolean {
  const words = searchWords(query)
  if (!words.length) return true
  const folded = fields.filter((field): field is string => Boolean(field)).map(foldSearchText)
  return words.every(word => folded.some(field => field.includes(word)))
}
