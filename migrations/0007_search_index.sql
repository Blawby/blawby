CREATE VIRTUAL TABLE search_index USING fts5(text, short_grams, tokenize='trigram case_sensitive 1');
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_insert AFTER INSERT ON conversations BEGIN INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 0, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(name, '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.name'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.email'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.phone'), '') || char(10) || COALESCE(replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), '') || char(10) || COALESCE(json_extract(payload_json, '$.participant.title'), '') FROM conversations WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_update AFTER UPDATE OF id, name, payload_json ON conversations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 0; INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 0, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(name, '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.name'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.email'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.phone'), '') || char(10) || COALESCE(replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), '') || char(10) || COALESCE(json_extract(payload_json, '$.participant.title'), '') FROM conversations WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_conversations_delete AFTER DELETE ON conversations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 0; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams)
      WITH entries AS MATERIALIZED (SELECT rowid, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(name, '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.name'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.email'), '') || char(10) || COALESCE(json_extract(payload_json, '$.guest.phone'), '') || char(10) || COALESCE(replace(replace(replace(replace(replace(replace(json_extract(payload_json, '$.guest.phone'), ' ', ''), '-', ''), '(', ''), ')', ''), '.', ''), '+', ''), '') || char(10) || COALESCE(json_extract(payload_json, '$.participant.title'), '')),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM conversations)
      SELECT rowid * 8 + 0, json_extract(entry, '$[0]'), json_extract(entry, '$[1]') FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_insert AFTER INSERT ON messages BEGIN INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 1, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(body, '') || char(10) || COALESCE(json_extract(payload_json, '$.meta.name'), '') FROM messages WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_update AFTER UPDATE OF id, body, payload_json ON messages BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 1; INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 1, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(body, '') || char(10) || COALESCE(json_extract(payload_json, '$.meta.name'), '') FROM messages WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_messages_delete AFTER DELETE ON messages BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 1; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams)
      WITH entries AS MATERIALIZED (SELECT rowid, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(body, '') || char(10) || COALESCE(json_extract(payload_json, '$.meta.name'), '')),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM messages)
      SELECT rowid * 8 + 1, json_extract(entry, '$[0]'), json_extract(entry, '$[1]') FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_products_insert AFTER INSERT ON products BEGIN INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 2, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(name, '') FROM products WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_products_update AFTER UPDATE OF id, name ON products BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 2; INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 2, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(name, '') FROM products WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_products_delete AFTER DELETE ON products BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 2; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams)
      WITH entries AS MATERIALIZED (SELECT rowid, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(name, '')),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM products)
      SELECT rowid * 8 + 2, json_extract(entry, '$[0]'), json_extract(entry, '$[1]') FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_product_stay_configs_insert AFTER INSERT ON product_stay_configs BEGIN INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 3, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(internal_name, '') FROM product_stay_configs WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_product_stay_configs_update AFTER UPDATE OF product_id, internal_name ON product_stay_configs BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 3; INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 3, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(internal_name, '') FROM product_stay_configs WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_product_stay_configs_delete AFTER DELETE ON product_stay_configs BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 3; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams)
      WITH entries AS MATERIALIZED (SELECT rowid, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(internal_name, '')),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM product_stay_configs)
      SELECT rowid * 8 + 3, json_extract(entry, '$[0]'), json_extract(entry, '$[1]') FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_business_locations_insert AFTER INSERT ON business_locations BEGIN INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 4, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(title, '') FROM business_locations WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_business_locations_update AFTER UPDATE OF id, title ON business_locations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 4; INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 4, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(title, '') FROM business_locations WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_business_locations_delete AFTER DELETE ON business_locations BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 4; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams)
      WITH entries AS MATERIALIZED (SELECT rowid, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(title, '')),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM business_locations)
      SELECT rowid * 8 + 4, json_extract(entry, '$[0]'), json_extract(entry, '$[1]') FROM entries;
--> statement-breakpoint
CREATE TRIGGER search_index_bookings_insert AFTER INSERT ON bookings BEGIN INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 5, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(id, '') || char(10) || COALESCE(channel_booking_id, '') || char(10) || COALESCE(external_booking_id, '') FROM bookings WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_bookings_update AFTER UPDATE OF id, channel_booking_id, external_booking_id ON bookings BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 5; INSERT INTO search_index(rowid, text, short_grams) SELECT new.rowid * 8 + 5, json_extract(normalized.entry, '$[0]'), json_extract(normalized.entry, '$[1]') FROM (WITH RECURSIVE input_text(value) AS (SELECT (SELECT COALESCE(id, '') || char(10) || COALESCE(channel_booking_id, '') || char(10) || COALESCE(external_booking_id, '') FROM bookings WHERE rowid = new.rowid)),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) normalized; END;
--> statement-breakpoint
CREATE TRIGGER search_index_bookings_delete AFTER DELETE ON bookings BEGIN DELETE FROM search_index WHERE rowid = old.rowid * 8 + 5; END;
--> statement-breakpoint
INSERT INTO search_index(rowid, text, short_grams)
      WITH entries AS MATERIALIZED (SELECT rowid, (WITH RECURSIVE input_text(value) AS (SELECT COALESCE(id, '') || char(10) || COALESCE(channel_booking_id, '') || char(10) || COALESCE(external_booking_id, '')),
    folded(position, value) AS (
      SELECT 1, '' UNION ALL
      SELECT position + 1, folded.value || COALESCE(json_extract((SELECT characters FROM search_character_folds), '$."' || unicode(substr(input_text.value, position, 1)) || '"'), substr(input_text.value, position, 1))
      FROM folded, input_text WHERE position <= length(input_text.value)
    ), text(value) AS (SELECT value FROM folded ORDER BY position DESC LIMIT 1),
    positions(position) AS (SELECT 1 UNION ALL SELECT position + 1 FROM positions, text WHERE position < length(text.value)),
    terms(value) AS (
      SELECT 'u' || printf('%06x', unicode(substr(text.value, position, 1))) || ';' FROM positions, text WHERE position <= length(text.value)
      UNION ALL
      SELECT 'b' || printf('%06x', unicode(substr(text.value, position, 1))) || printf('%06x', unicode(substr(text.value, position + 1, 1))) || ';' FROM positions, text WHERE position < length(text.value)
    ) SELECT json_array(text.value, COALESCE((SELECT group_concat(value, ' ') FROM (SELECT DISTINCT value FROM terms)), '')) AS entry FROM text) AS entry FROM bookings)
      SELECT rowid * 8 + 5, json_extract(entry, '$[0]'), json_extract(entry, '$[1]') FROM entries;
