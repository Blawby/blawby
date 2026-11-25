CREATE VIRTUAL TABLE search_index USING fts5(text, short_grams, scope, kind, tokenize='trigram case_sensitive 1');
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_insert AFTER INSERT ON conversations BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(name, '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.name'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.email'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.phone'), '') || char(10) || COALESCE(replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), '') || char(10) || COALESCE(json_extract(payload_json, '$.participant.title'), '') FROM conversations WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 0, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't00;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_update AFTER UPDATE OF organization_id, id, name, payload_json ON conversations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 0; INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(name, '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.name'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.email'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.phone'), '') || char(10) || COALESCE(replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), '') || char(10) || COALESCE(json_extract(payload_json, '$.participant.title'), '') FROM conversations WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 0, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't00;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_delete AFTER DELETE ON conversations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 0; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(name, '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.name'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.email'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.phone'), '') || char(10) || COALESCE(replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), '') || char(10) || COALESCE(json_extract(payload_json, '$.participant.title'), '') FROM conversations
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
      ) SELECT normalized.id * 8 + 0, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't00;'
      FROM normalized LEFT JOIN short_terms USING (id);
--> statement-breakpoint
CREATE TRIGGER search_index_messages_insert AFTER INSERT ON messages BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(body, '') || char(10) || COALESCE(json_extract(payload_json, '$.meta.name'), '') FROM messages WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 1, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't01;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_update AFTER UPDATE OF organization_id, id, body, payload_json ON messages BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 1; INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(body, '') || char(10) || COALESCE(json_extract(payload_json, '$.meta.name'), '') FROM messages WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 1, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't01;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_delete AFTER DELETE ON messages BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 1; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(body, '') || char(10) || COALESCE(json_extract(payload_json, '$.meta.name'), '') FROM messages
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
      ) SELECT normalized.id * 8 + 1, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't01;'
      FROM normalized LEFT JOIN short_terms USING (id);
--> statement-breakpoint
CREATE TRIGGER search_index_products_insert AFTER INSERT ON products BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(name, '') FROM products WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 2, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't02;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_products_update AFTER UPDATE OF organization_id, id, name ON products BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 2; INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(name, '') FROM products WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 2, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't02;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_products_delete AFTER DELETE ON products BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 2; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(name, '') FROM products
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
      ) SELECT normalized.id * 8 + 2, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't02;'
      FROM normalized LEFT JOIN short_terms USING (id);
--> statement-breakpoint
CREATE TRIGGER search_index_product_stay_configs_insert AFTER INSERT ON product_stay_configs BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(internal_name, '') FROM product_stay_configs WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 3, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't03;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_product_stay_configs_update AFTER UPDATE OF organization_id, product_id, internal_name ON product_stay_configs BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 3; INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(internal_name, '') FROM product_stay_configs WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 3, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't03;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_product_stay_configs_delete AFTER DELETE ON product_stay_configs BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 3; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(internal_name, '') FROM product_stay_configs
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
      ) SELECT normalized.id * 8 + 3, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't03;'
      FROM normalized LEFT JOIN short_terms USING (id);
--> statement-breakpoint
CREATE TRIGGER search_index_business_locations_insert AFTER INSERT ON business_locations BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(title, '') FROM business_locations WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 4, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't04;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_business_locations_update AFTER UPDATE OF organization_id, id, title ON business_locations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 4; INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(title, '') FROM business_locations WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 4, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't04;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_business_locations_delete AFTER DELETE ON business_locations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 4; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(title, '') FROM business_locations
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
      ) SELECT normalized.id * 8 + 4, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't04;'
      FROM normalized LEFT JOIN short_terms USING (id);
--> statement-breakpoint
CREATE TRIGGER search_index_bookings_insert AFTER INSERT ON bookings BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(id, '') || char(10) || COALESCE(channel_booking_id, '') || char(10) || COALESCE(external_booking_id, '') FROM bookings WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 5, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't05;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_bookings_update AFTER UPDATE OF organization_id, id, channel_booking_id, external_booking_id ON bookings BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 5; INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(id, '') || char(10) || COALESCE(channel_booking_id, '') || char(10) || COALESCE(external_booking_id, '') FROM bookings WHERE rowid = new.rowid
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
      ) SELECT normalized.id * 8 + 5, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't05;'
      FROM normalized LEFT JOIN short_terms USING (id); END;
--> statement-breakpoint
CREATE TRIGGER search_index_bookings_delete AFTER DELETE ON bookings BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 5; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH RECURSIVE inputs(id, organization_id, value) AS MATERIALIZED (
        SELECT rowid, organization_id, COALESCE(id, '') || char(10) || COALESCE(channel_booking_id, '') || char(10) || COALESCE(external_booking_id, '') FROM bookings
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
      ) SELECT normalized.id * 8 + 5, normalized.value, COALESCE(short_terms.value, ''),
        'o' || lower(hex(normalized.organization_id)) || ';', 't05;'
      FROM normalized LEFT JOIN short_terms USING (id);
