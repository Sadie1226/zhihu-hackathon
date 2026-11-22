import type { DatabaseSync } from 'node:sqlite'

// v5 definitions are frozen independently of the fresh-install contract.
const schema = `
CREATE TABLE IF NOT EXISTS owner (
  id TEXT NOT NULL PRIMARY KEY,
  namespace TEXT NOT NULL CHECK (namespace IN ('zhihu', 'development')),
  provider TEXT NOT NULL CHECK (provider = namespace),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) > 0),
  created_at TEXT NOT NULL,
  UNIQUE (namespace, provider, provider_subject)
) STRICT;

CREATE TABLE IF NOT EXISTS owner_session (
  token_hash TEXT NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES owner(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER CHECK (revoked_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_dog_owner ON dog(owner_id) WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_dog_id_owner ON dog(id, owner_id);

CREATE TABLE IF NOT EXISTS adoption_receipt (
  owner_id TEXT NOT NULL REFERENCES owner(id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  dog_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, request_id),
  FOREIGN KEY (dog_id, owner_id) REFERENCES dog(id, owner_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS owner_legacy_key_guard BEFORE INSERT ON owner
WHEN EXISTS (SELECT 1 FROM dog WHERE session_id = NEW.id AND owner_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'owner: legacy dog key collision');
END;

CREATE TRIGGER IF NOT EXISTS dog_owner_guard_insert BEFORE INSERT ON dog
WHEN (NEW.owner_id IS NOT NULL AND (NEW.is_sample <> 0 OR NEW.session_id <> NEW.owner_id))
  OR (NEW.owner_id IS NULL AND EXISTS (SELECT 1 FROM owner WHERE id = NEW.session_id))
BEGIN
  SELECT RAISE(ABORT, 'dog: invalid owner association');
END;

CREATE TRIGGER IF NOT EXISTS dog_owner_guard_update BEFORE UPDATE OF owner_id, session_id, is_sample ON dog
WHEN (OLD.owner_id IS NOT NULL AND OLD.owner_id IS NOT NEW.owner_id)
  OR (NEW.owner_id IS NOT NULL AND (NEW.is_sample <> 0 OR NEW.session_id <> NEW.owner_id))
  OR (NEW.owner_id IS NULL AND EXISTS (SELECT 1 FROM owner WHERE id = NEW.session_id))
BEGIN
  SELECT RAISE(ABORT, 'dog: invalid owner association');
END;
`

/** Bootstrap holds the transaction for the DDL, FK check and version stamp. */
export function ownerSessionMigration(db: DatabaseSync): string {
  const existing = db.prepare("SELECT 1 FROM pragma_table_info('dog') WHERE name = 'owner_id'").get()
  if (!existing) db.exec('ALTER TABLE dog ADD COLUMN owner_id TEXT REFERENCES owner(id)')
  db.exec(schema)
  if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('Owner session v5 foreign key check failed')
  return 'SELECT 1;'
}
