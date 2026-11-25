CREATE VIRTUAL TABLE search_index USING fts5(text, short_grams, scope, kind, tokenize='trigram case_sensitive 1');
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_insert AFTER INSERT ON conversations BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 0, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM conversations WHERE rowid = new.rowid), 't00;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(name, '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.name'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.email'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.phone'), '') || char(10) || COALESCE(replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), '') || char(10) || COALESCE(json_extract(payload_json, '$.participant.title'), '') FROM conversations WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_update AFTER UPDATE OF organization_id, id, name, payload_json ON conversations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 0; INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 0, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM conversations WHERE rowid = new.rowid), 't00;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(name, '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.name'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.email'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.phone'), '') || char(10) || COALESCE(replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), '') || char(10) || COALESCE(json_extract(payload_json, '$.participant.title'), '') FROM conversations WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_delete AFTER DELETE ON conversations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 0; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH entries AS MATERIALIZED (SELECT rowid, organization_id, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(name, '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.name'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.email'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.phone'), '') || char(10) || COALESCE(replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), '') || char(10) || COALESCE(json_extract(payload_json, '$.participant.title'), '')),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM conversations)
      SELECT rowid * 8 + 0, json_extract(entry, '$[0]'), json_extract(entry, '$[1]'), 'o' || lower(hex(organization_id)) || ';', 't00;' FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_insert AFTER INSERT ON messages BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 1, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM messages WHERE rowid = new.rowid), 't01;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(body, '') || char(10) || COALESCE(json_extract(payload_json, '$.meta.name'), '') FROM messages WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_update AFTER UPDATE OF organization_id, id, body, payload_json ON messages BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 1; INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 1, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM messages WHERE rowid = new.rowid), 't01;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(body, '') || char(10) || COALESCE(json_extract(payload_json, '$.meta.name'), '') FROM messages WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_delete AFTER DELETE ON messages BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 1; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH entries AS MATERIALIZED (SELECT rowid, organization_id, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(body, '') || char(10) || COALESCE(json_extract(payload_json, '$.meta.name'), '')),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM messages)
      SELECT rowid * 8 + 1, json_extract(entry, '$[0]'), json_extract(entry, '$[1]'), 'o' || lower(hex(organization_id)) || ';', 't01;' FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_products_insert AFTER INSERT ON products BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 2, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM products WHERE rowid = new.rowid), 't02;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(name, '') FROM products WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_products_update AFTER UPDATE OF organization_id, id, name ON products BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 2; INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 2, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM products WHERE rowid = new.rowid), 't02;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(name, '') FROM products WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_products_delete AFTER DELETE ON products BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 2; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH entries AS MATERIALIZED (SELECT rowid, organization_id, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(name, '')),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM products)
      SELECT rowid * 8 + 2, json_extract(entry, '$[0]'), json_extract(entry, '$[1]'), 'o' || lower(hex(organization_id)) || ';', 't02;' FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_product_stay_configs_insert AFTER INSERT ON product_stay_configs BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 3, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM product_stay_configs WHERE rowid = new.rowid), 't03;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(internal_name, '') FROM product_stay_configs WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_product_stay_configs_update AFTER UPDATE OF organization_id, product_id, internal_name ON product_stay_configs BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 3; INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 3, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM product_stay_configs WHERE rowid = new.rowid), 't03;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(internal_name, '') FROM product_stay_configs WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_product_stay_configs_delete AFTER DELETE ON product_stay_configs BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 3; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH entries AS MATERIALIZED (SELECT rowid, organization_id, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(internal_name, '')),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM product_stay_configs)
      SELECT rowid * 8 + 3, json_extract(entry, '$[0]'), json_extract(entry, '$[1]'), 'o' || lower(hex(organization_id)) || ';', 't03;' FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_business_locations_insert AFTER INSERT ON business_locations BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 4, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM business_locations WHERE rowid = new.rowid), 't04;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(title, '') FROM business_locations WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_business_locations_update AFTER UPDATE OF organization_id, id, title ON business_locations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 4; INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 4, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM business_locations WHERE rowid = new.rowid), 't04;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(title, '') FROM business_locations WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_business_locations_delete AFTER DELETE ON business_locations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 4; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH entries AS MATERIALIZED (SELECT rowid, organization_id, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(title, '')),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM business_locations)
      SELECT rowid * 8 + 4, json_extract(entry, '$[0]'), json_extract(entry, '$[1]'), 'o' || lower(hex(organization_id)) || ';', 't04;' FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_bookings_insert AFTER INSERT ON bookings BEGIN INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 5, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM bookings WHERE rowid = new.rowid), 't05;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(id, '') || char(10) || COALESCE(channel_booking_id, '') || char(10) || COALESCE(external_booking_id, '') FROM bookings WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_bookings_update AFTER UPDATE OF organization_id, id, channel_booking_id, external_booking_id ON bookings BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 5; INSERT INTO search_index(rowid, text, short_grams, scope, kind) SELECT new.rowid * 8 + 5, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]'), (SELECT 'o' || lower(hex(organization_id)) || ';' FROM bookings WHERE rowid = new.rowid), 't05;' FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(id, '') || char(10) || COALESCE(channel_booking_id, '') || char(10) || COALESCE(external_booking_id, '') FROM bookings WHERE rowid = new.rowid)),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_bookings_delete AFTER DELETE ON bookings BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 5; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams, scope, kind)
      WITH entries AS MATERIALIZED (SELECT rowid, organization_id, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(id, '') || char(10) || COALESCE(channel_booking_id, '') || char(10) || COALESCE(external_booking_id, '')),
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
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM bookings)
      SELECT rowid * 8 + 5, json_extract(entry, '$[0]'), json_extract(entry, '$[1]'), 'o' || lower(hex(organization_id)) || ';', 't05;' FROM entries;
