import type { Migration } from '../migrations.ts'

export const CHAT_MESSAGE_V9_SQL = `
CREATE TABLE IF NOT EXISTS chat_message (
  id                TEXT NOT NULL PRIMARY KEY CHECK (id <> ''),
  owner_id          TEXT NOT NULL REFERENCES owner(id),
  client_message_id TEXT NOT NULL COLLATE BINARY CHECK (
    instr(client_message_id, char(0)) = 0
    AND length(client_message_id) BETWEEN 1 AND 128
    AND substr(client_message_id, 1, 1) GLOB '[A-Za-z0-9]'
    AND client_message_id NOT GLOB '*[^A-Za-z0-9_-]*'
  ),
  dog_id            TEXT NOT NULL,
  text              TEXT NOT NULL CHECK (text <> ''),
  created_at        TEXT NOT NULL,
  UNIQUE (owner_id, client_message_id),
  FOREIGN KEY (dog_id, owner_id) REFERENCES dog(id, owner_id)
) STRICT;

CREATE TRIGGER IF NOT EXISTS chat_message_v9_insert_guard BEFORE INSERT ON chat_message
BEGIN
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: chat_message.id')
  WHERE EXISTS (SELECT 1 FROM chat_message WHERE id = NEW.id);
  SELECT RAISE(ABORT, 'UNIQUE constraint failed: chat_message.owner_id, chat_message.client_message_id')
  WHERE EXISTS (
    SELECT 1 FROM chat_message WHERE owner_id = NEW.owner_id AND client_message_id = NEW.client_message_id
  );
END;
`

export const chatMessageMigration: Migration = {
  version: 9,
  name: 'private chat messages and owner-scoped idempotency keys',
  sql: CHAT_MESSAGE_V9_SQL,
}
