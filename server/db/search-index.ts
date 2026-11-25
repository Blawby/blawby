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
  const statements = ["CREATE VIRTUAL TABLE search_index USING fts5(text, short_grams, scope, kind, tokenize='trigram case_sensitive 1');"]
  for (const [index, source] of SEARCH_SOURCES.entries()) {
    const row = (alias: string) => `${alias}.rowid * ${SEARCH_ROW_STRIDE} + ${index}`
    const raw = source.fields.map(field => `COALESCE(${field}, '')`).join(' || char(10) || ')
    // Keep the whole pipeline uncorrelated: a per-row scalar CTE is rebuilt
    // inside every recursive n-gram step even when declared MATERIALIZED.
    const insert = (alias?: string) => `INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, ${raw} FROM ${source.table}${alias ? ` WHERE rowid = ${alias}.rowid` : ''}
      ), folds(codepoint, folded) AS MATERIALIZED (
        SELECT CAST(key AS INTEGER), value FROM json_each((SELECT characters FROM search_character_folds))
      ), characters(id, position, character) AS (
        SELECT id, 1, substr(value, 1, 1) FROM inputs WHERE length(CAST(value AS BLOB)) > length(value)
        UNION ALL SELECT characters.id, position + 1, substr(inputs.value, position + 1, 1)
        FROM characters JOIN inputs USING (id) WHERE position < length(inputs.value)
      ), normalized(id, organization_id, value) AS MATERIALIZED (
        SELECT id, organization_id, lower(value) FROM inputs WHERE length(CAST(value AS BLOB)) = length(value)
        UNION ALL SELECT characters.id, inputs.organization_id,
          group_concat(COALESCE(folds.folded, lower(characters.character)), '' ORDER BY position)
        FROM characters JOIN inputs USING (id)
        LEFT JOIN folds ON folds.codepoint = unicode(characters.character) GROUP BY characters.id
      ), positions(id, position) AS (
        SELECT id, 1 FROM normalized WHERE length(value) > 0
        UNION ALL SELECT positions.id, position + 1 FROM positions JOIN normalized USING (id)
        WHERE position < length(normalized.value)
      ), terms(id, value) AS (
        SELECT id, 'u' || printf('%06x', unicode(substr(normalized.value, position, 1))) || ';'
        FROM positions JOIN normalized USING (id)
        UNION ALL SELECT id, 'b' || printf('%06x', unicode(substr(normalized.value, position, 1))) || printf('%06x', unicode(substr(normalized.value, position + 1, 1))) || ';'
        FROM positions JOIN normalized USING (id) WHERE position < length(normalized.value)
      ), short_terms(id, value) AS MATERIALIZED (
        SELECT id, group_concat(value, ' ') FROM (SELECT DISTINCT id, value FROM terms) GROUP BY id
      ) SELECT normalized.id * ${SEARCH_ROW_STRIDE} + ${index}, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't${String(index).padStart(2, '0')};'
      FROM normalized LEFT JOIN short_terms USING (id);`
    statements.push(`CREATE TRIGGER search_index_${source.table}_insert AFTER INSERT ON ${source.table} BEGIN ${insert('new')} END;`)
    statements.push(`CREATE TRIGGER search_index_${source.table}_update AFTER UPDATE OF organization_id, ${source.columns} ON ${source.table} BEGIN DELETE FROM search_index WHERE rowid = ${row('old')}; ${insert('new')} END;`)
    statements.push(`CREATE TRIGGER search_index_${source.table}_delete AFTER DELETE ON ${source.table} BEGIN DELETE FROM search_index WHERE rowid = ${row('old')}; END;`)
    statements.push(insert())
  }
  if (statements.some(statement => new TextEncoder().encode(statement).byteLength > 95_000)) throw new Error('Search schema exceeds D1 SQL statement limit')
  return statements.join('\n--> statement-breakpoint\n') + '\n'
}
