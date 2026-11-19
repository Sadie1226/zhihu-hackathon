import type { DatabaseSync } from 'node:sqlite'

// Frozen version 3. Do not import mutable application validators into migrations.
export const WISH_SOURCE_COLUMN = "source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','collection'))"
export const WISH_URL_COLUMN = `source_url TEXT CHECK (
  (source = 'owner' AND source_url IS NULL) OR
  (source = 'collection' AND source_url IS NOT NULL AND length(source_url) > 0)
)`
export const TRIP_WISH_COLUMN = 'wish_id TEXT REFERENCES wish(id)'

const positiveId = (value: string) =>
  `(length(${value}) > 0 AND ${value} NOT GLOB '*[^0-9]*' AND substr(${value},1,1) <> '0')`
const questionPath = "substr(NEW.source_url,32)"
const answerSeparator = `instr(${questionPath},'/answer/')`
const questionId = `substr(${questionPath},1,${answerSeparator}-1)`
const answerId = `substr(${questionPath},${answerSeparator}+8)`
const canonicalUrl = `(
  (substr(NEW.source_url,1,31) = 'https://www.zhihu.com/question/' || '' AND (
    ${positiveId(questionPath)} OR (${answerSeparator} > 1 AND ${positiveId(questionId)} AND ${positiveId(answerId)})
  )) OR
  (substr(NEW.source_url,1,29) = 'https://zhuanlan.zhihu.com/p/' || '' AND ${positiveId('substr(NEW.source_url,30)')})
)`

export const WISH_SCHEMA_V3_SQL = `
CREATE VIEW IF NOT EXISTS v_wish_active AS
SELECT id,dog_id,text,category,created_at,revoked_at,source,source_url
FROM wish WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_wish_active_collection ON wish(dog_id)
WHERE source = 'collection' AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wish_collection_content ON wish(dog_id,source_url)
WHERE source = 'collection';
CREATE INDEX IF NOT EXISTS idx_trip_wish ON trip(wish_id);

${['INSERT', 'UPDATE'].map(operation => `CREATE TRIGGER IF NOT EXISTS wish_url_${operation.toLowerCase()} BEFORE ${operation} ON wish
BEGIN
  SELECT RAISE(ABORT, 'wish: canonical HTTPS Zhihu content URL required')
  WHERE NEW.source = 'collection' AND NOT ${canonicalUrl};
END;`).join('\n')}

CREATE TRIGGER IF NOT EXISTS wish_identity_immutable BEFORE UPDATE ON wish
WHEN NEW.id IS NOT OLD.id OR NEW.dog_id IS NOT OLD.dog_id
  OR NEW.source IS NOT OLD.source OR NEW.source_url IS NOT OLD.source_url
BEGIN
  SELECT RAISE(ABORT, 'wish: provenance is immutable');
END;
CREATE TRIGGER IF NOT EXISTS wish_revoke_once BEFORE UPDATE OF revoked_at ON wish
WHEN OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at
BEGIN
  SELECT RAISE(ABORT, 'wish: first revocation timestamp is immutable');
END;
CREATE TRIGGER IF NOT EXISTS wish_keep_history BEFORE DELETE ON wish
BEGIN
  SELECT RAISE(ABORT, 'wish: revoke instead of delete');
END;

${['INSERT', 'UPDATE'].map(operation => `CREATE TRIGGER IF NOT EXISTS trip_wish_${operation.toLowerCase()} BEFORE ${operation} ON trip
WHEN NEW.wish_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'trip: wish must belong to the same dog')
  WHERE NOT EXISTS (SELECT 1 FROM wish WHERE id = NEW.wish_id AND dog_id = NEW.dog_id);
END;`).join('\n')}
CREATE TRIGGER IF NOT EXISTS trip_wish_history BEFORE UPDATE OF wish_id ON trip
WHEN OLD.started_at IS NOT NULL AND NEW.wish_id IS NOT OLD.wish_id
BEGIN
  SELECT RAISE(ABORT, 'trip: started trip wish association is immutable');
END;
`

/** Called only inside bootstrap's BEGIN IMMEDIATE transaction, including on fresh DBs. */
export function wishMigrationSql(db: DatabaseSync): string {
  const columns = (table: string) => db.prepare('SELECT name FROM pragma_table_info(?)').all(table).map(row => row.name)
  const wish = columns('wish')
  const trip = columns('trip')
  if (!wish.length || !trip.length) throw new Error('Wish migration requires the existing wish and trip tables')
  return [
    ...(!wish.includes('source') ? [`ALTER TABLE wish ADD COLUMN ${WISH_SOURCE_COLUMN};`] : []),
    ...(!wish.includes('source_url') ? [`ALTER TABLE wish ADD COLUMN ${WISH_URL_COLUMN};`] : []),
    ...(!trip.includes('wish_id') ? [`ALTER TABLE trip ADD COLUMN ${TRIP_WISH_COLUMN};`] : []),
    WISH_SCHEMA_V3_SQL,
  ].join('\n')
}
