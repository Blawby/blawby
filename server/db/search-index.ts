import folds from '../../shared/search-character-folds.json' with { type: 'json' }

/** Derived indexes of canonical rows; source rowids occupy disjoint lanes. */
export const SEARCH_SOURCES = [
  { table: 'conversations', columns: 'id, name, payload_json', fields: ["name", "json_extract(payload_json, '$.guest.name')", "json_extract(payload_json, '$.guest.email')", "json_extract(payload_json, '$.guest.phone')", "replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', '')", "json_extract(payload_json, '$.participant.title')"] },
  { table: 'messages', columns: 'id, body, payload_json', fields: ["body", "json_extract(payload_json, '$.meta.name')"] },
  { table: 'products', columns: 'id, name', fields: ['name'] },
  { table: 'product_stay_configs', columns: 'product_id, internal_name', fields: ['internal_name'] },
  { table: 'business_locations', columns: 'id, title', fields: ['title'] },
  { table: 'bookings', columns: 'id, channel_booking_id, external_booking_id', fields: ['id', 'channel_booking_id', 'external_booking_id'] },
] as const
export const SEARCH_ROW_STRIDE = 8

/** The migration's DDL comes from this schema, not a separate writer or backfill service. */
export function searchCharacterMapSql(): string {
  return `SELECT '${JSON.stringify(folds).replaceAll("'", "''")}' AS characters`
}

export function searchIndexSchema(): string {
  // FTS's trigram tokenizer indexes the folded text. Encoded one/two-character
  // terms give short searches an index too, without changing substring semantics.
  const values = (raw: string) => `WITH RECURSIVE input_text(value) AS (SELECT ${raw}),
    characters(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM characters, input_text WHERE position < length(input_text.value)),
    text(value) AS MATERIALIZED (
      SELECT COALESCE(group_concat(CASE WHEN unicode(substr(input_text.value, position, 1)) < 128
        THEN lower(substr(input_text.value, position, 1))
        ELSE COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1)) END, ''), '')
      FROM characters, input_text
    ),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text`
  const statements = ["CREATE VIRTUAL TABLE search_index USING fts5(text, short_grams, tokenize='trigram case_sensitive 1');"]
  for (const [index, source] of SEARCH_SOURCES.entries()) {
    const row = (alias: string) => `${alias}.rowid * ${SEARCH_ROW_STRIDE} + ${index}`
    const raw = source.fields.map(field => `COALESCE(${field}, '')`).join(' || char(10) || ')
    const insert = (alias: string) => `INSERT INTO search_index(rowid, text, short_grams) SELECT ${row(alias)}, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (${values(`(SELECT ${raw} FROM ${source.table} WHERE rowid = ${alias}.rowid)`)}) normalized;`
    statements.push(`CREATE TRIGGER search_index_${source.table}_insert AFTER INSERT ON ${source.table} BEGIN ${insert('new')} END;`)
    statements.push(`CREATE TRIGGER search_index_${source.table}_update AFTER UPDATE OF ${source.columns} ON ${source.table} BEGIN DELETE FROM search_index WHERE rowid = ${row('old')}; ${insert('new')} END;`)
    statements.push(`CREATE TRIGGER search_index_${source.table}_delete AFTER DELETE ON ${source.table} BEGIN DELETE FROM search_index WHERE rowid = ${row('old')}; END;`)
    statements.push(`INSERT INTO search_index(rowid, text, short_grams)
      WITH entries AS MATERIALIZED (SELECT rowid, (${values(raw)}) AS entry FROM ${source.table})
      SELECT rowid * ${SEARCH_ROW_STRIDE} + ${index}, json_extract(entry, '$[0]'), json_extract(entry, '$[1]') FROM entries;`)
  }
  if (statements.some(statement => new TextEncoder().encode(statement).byteLength > 95_000)) throw new Error('Search schema exceeds D1 SQL statement limit')
  return statements.join('\n--> statement-breakpoint\n') + '\n'
}
