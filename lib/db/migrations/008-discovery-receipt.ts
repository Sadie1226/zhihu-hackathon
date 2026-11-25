// Also declared in contracts/schema.sql for fresh databases.
export const DISCOVERY_RECEIPT_V8_SQL = `
CREATE TABLE IF NOT EXISTS trip_discovery_receipt (
  trip_id       TEXT    NOT NULL PRIMARY KEY REFERENCES trip(id),
  dog_id        TEXT    NOT NULL REFERENCES dog(id),
  owner_id      TEXT    REFERENCES owner(id),
  intent_id     TEXT    NOT NULL CHECK (
    length(intent_id) BETWEEN 1 AND 128 AND substr(intent_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND intent_id NOT GLOB '*[^A-Za-z0-9._:-]*'
  ),
  completed_at  TEXT    NOT NULL CHECK (
    length(completed_at) = 24 AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) IS NOT NULL
    AND strftime('%Y-%m-%dT%H:%M:%fZ', completed_at) = completed_at
  ),
  hash_version  INTEGER NOT NULL CHECK (hash_version = 1),
  members_json  TEXT    NOT NULL CHECK (
    CASE WHEN json_valid(members_json) THEN
      json_type(members_json) = 'array' AND json_array_length(members_json) BETWEEN 3 AND 5
    ELSE 0 END
  ),
  receipt_hash  TEXT    NOT NULL CHECK (length(receipt_hash) = 64 AND receipt_hash NOT GLOB '*[^0-9a-f]*')
) STRICT;

CREATE TRIGGER IF NOT EXISTS trip_discovery_receipt_v8_insert_guard BEFORE INSERT ON trip_discovery_receipt
BEGIN
  SELECT RAISE(ABORT, 'trip discovery receipt already exists')
  WHERE EXISTS (SELECT 1 FROM trip_discovery_receipt WHERE trip_id = NEW.trip_id);
  SELECT RAISE(ABORT, 'trip discovery receipt requires matching running scope')
  WHERE NOT EXISTS (
    SELECT 1 FROM trip t JOIN dog d ON d.id = t.dog_id
    WHERE t.id = NEW.trip_id AND t.dog_id = NEW.dog_id AND t.status = 'running'
      AND d.owner_id IS NEW.owner_id AND d.is_sample = (NEW.owner_id IS NULL)
      AND julianday(NEW.completed_at) >= julianday(t.started_at)
  );
END;

CREATE TRIGGER IF NOT EXISTS trip_discovery_receipt_v8_no_update BEFORE UPDATE ON trip_discovery_receipt
BEGIN SELECT RAISE(ABORT, 'trip discovery receipt is immutable'); END;

CREATE TRIGGER IF NOT EXISTS trip_discovery_receipt_v8_no_delete BEFORE DELETE ON trip_discovery_receipt
BEGIN SELECT RAISE(ABORT, 'trip discovery receipt is immutable'); END;
`
