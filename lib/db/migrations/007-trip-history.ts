// Register after the authorized K v6 migration. Existing occurrences have no recovered text.
export const TRIP_HISTORY_V7_SQL = `
CREATE TABLE trip_event_fact (
  trip_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_code_at_occurrence TEXT,
  public_text_at_occurrence TEXT,
  CHECK ((event_code_at_occurrence IS NULL AND public_text_at_occurrence IS NULL)
    OR (event_code_at_occurrence IS NOT NULL AND public_text_at_occurrence IS NOT NULL
      AND length(event_code_at_occurrence) > 0 AND length(trim(public_text_at_occurrence)) BETWEEN 1 AND 40)),
  PRIMARY KEY (trip_id, event_id),
  FOREIGN KEY (trip_id, event_id) REFERENCES trip_event(trip_id, event_id)
) STRICT;

INSERT INTO trip_event_fact(trip_id, event_id, event_code_at_occurrence, public_text_at_occurrence)
SELECT trip_id, event_id, NULL, NULL FROM trip_event;

CREATE TRIGGER trip_event_v7_insert_guard BEFORE INSERT ON trip_event
BEGIN
  SELECT RAISE(ABORT, 'trip event occurrence already exists')
  WHERE EXISTS (SELECT 1 FROM trip_event WHERE trip_id = NEW.trip_id AND event_id = NEW.event_id);
  SELECT RAISE(ABORT, 'trip event requires matching running trip and enabled event')
  WHERE NOT EXISTS (SELECT 1 FROM trip JOIN event ON event.id = NEW.event_id AND event.enabled = 1
    WHERE trip.id = NEW.trip_id AND trip.dog_id = NEW.dog_id AND trip.status = 'running'
      AND julianday(NEW.happened_at) >= julianday(trip.started_at)
      AND substr(NEW.happened_at, -1) = 'Z');
END;

CREATE TRIGGER trip_event_v7_capture AFTER INSERT ON trip_event
BEGIN
  INSERT INTO trip_event_fact(trip_id, event_id, event_code_at_occurrence, public_text_at_occurrence)
  SELECT NEW.trip_id, NEW.event_id, code, text FROM event WHERE id = NEW.event_id;
  SELECT RAISE(ABORT, 'trip event fact missing')
  WHERE NOT EXISTS (SELECT 1 FROM trip_event_fact WHERE trip_id = NEW.trip_id AND event_id = NEW.event_id);
END;

CREATE TRIGGER trip_event_fact_v7_insert_guard BEFORE INSERT ON trip_event_fact
BEGIN
  SELECT RAISE(ABORT, 'trip event fact already exists')
  WHERE EXISTS (SELECT 1 FROM trip_event_fact WHERE trip_id = NEW.trip_id AND event_id = NEW.event_id);
  SELECT RAISE(ABORT, 'trip event fact requires the current occurrence and template')
  WHERE NOT EXISTS (SELECT 1 FROM trip_event te JOIN event ON event.id = te.event_id
    WHERE te.trip_id = NEW.trip_id AND te.event_id = NEW.event_id
      AND event.code = NEW.event_code_at_occurrence AND event.text = NEW.public_text_at_occurrence);
END;

CREATE TRIGGER trip_event_v7_no_update BEFORE UPDATE ON trip_event
BEGIN SELECT RAISE(ABORT, 'trip event is immutable'); END;

CREATE TRIGGER trip_event_v7_no_delete BEFORE DELETE ON trip_event
BEGIN SELECT RAISE(ABORT, 'trip event is immutable'); END;

CREATE TRIGGER trip_event_fact_v7_no_update BEFORE UPDATE ON trip_event_fact
BEGIN SELECT RAISE(ABORT, 'trip event fact is immutable'); END;

CREATE TRIGGER trip_event_fact_v7_no_delete BEFORE DELETE ON trip_event_fact
BEGIN SELECT RAISE(ABORT, 'trip event fact is immutable'); END;

CREATE VIEW v_trip_event_history AS
SELECT te.trip_id, te.event_id, te.dog_id, te.happened_at,
  f.event_code_at_occurrence, f.public_text_at_occurrence,
  CASE WHEN f.public_text_at_occurrence IS NULL THEN 'unverifiable' ELSE 'frozen' END AS history_status
FROM trip_event AS te LEFT JOIN trip_event_fact AS f
  ON f.trip_id = te.trip_id AND f.event_id = te.event_id;

CREATE TABLE trip_snapshot (
  trip_id TEXT PRIMARY KEY REFERENCES trip(id),
  dog_id TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL CHECK (snapshot_version > 0),
  UNIQUE (dog_id, snapshot_version),
  FOREIGN KEY (dog_id, snapshot_version) REFERENCES snapshot(dog_id, version)
) STRICT;

CREATE TRIGGER trip_snapshot_v7_insert_guard BEFORE INSERT ON trip_snapshot
BEGIN
  SELECT RAISE(ABORT, 'trip snapshot binding already exists')
  WHERE EXISTS (SELECT 1 FROM trip_snapshot WHERE trip_id = NEW.trip_id
    OR (dog_id = NEW.dog_id AND snapshot_version = NEW.snapshot_version));
  SELECT RAISE(ABORT, 'trip snapshot requires matching pending trip')
  WHERE NOT EXISTS (SELECT 1 FROM trip WHERE id = NEW.trip_id AND dog_id = NEW.dog_id AND status = 'pending');
END;

CREATE TRIGGER trip_snapshot_v7_no_update BEFORE UPDATE ON trip_snapshot
BEGIN SELECT RAISE(ABORT, 'trip snapshot binding is immutable'); END;

CREATE TRIGGER trip_snapshot_v7_no_delete BEFORE DELETE ON trip_snapshot
BEGIN SELECT RAISE(ABORT, 'trip snapshot binding is immutable'); END;

CREATE TRIGGER snapshot_v7_no_replace BEFORE INSERT ON snapshot
BEGIN
  SELECT RAISE(ABORT, 'snapshot version already exists')
  WHERE EXISTS (SELECT 1 FROM snapshot WHERE dog_id = NEW.dog_id AND version = NEW.version);
END;

CREATE TRIGGER snapshot_v7_no_update BEFORE UPDATE ON snapshot
BEGIN SELECT RAISE(ABORT, 'snapshot version is immutable'); END;

CREATE TRIGGER snapshot_v7_no_delete BEFORE DELETE ON snapshot
BEGIN SELECT RAISE(ABORT, 'snapshot version is immutable'); END;

CREATE TRIGGER trip_v7_preserve_history_dog BEFORE UPDATE OF dog_id ON trip
WHEN NEW.dog_id IS NOT OLD.dog_id AND (
  EXISTS (SELECT 1 FROM trip_event WHERE trip_id = OLD.id)
  OR EXISTS (SELECT 1 FROM trip_snapshot WHERE trip_id = OLD.id)
)
BEGIN SELECT RAISE(ABORT, 'trip history dog is immutable'); END;

CREATE TRIGGER trip_v7_no_replace_history BEFORE INSERT ON trip
WHEN EXISTS (SELECT 1 FROM trip_event WHERE trip_id = NEW.id)
  OR EXISTS (SELECT 1 FROM trip_snapshot WHERE trip_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'trip with recorded history cannot be replaced'); END;
`
