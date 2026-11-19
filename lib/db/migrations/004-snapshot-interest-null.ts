import type { DatabaseSync } from 'node:sqlite'

// Frozen v4 definitions. Keep independent from future schema or application helpers.
export const SNAPSHOT_V4_TABLE_SQL = `CREATE TABLE snapshot (
  dog_id TEXT NOT NULL REFERENCES dog(id),
  version INTEGER NOT NULL,
  personality_tags TEXT NOT NULL CHECK (json_valid(personality_tags) AND json_array_length(personality_tags) = 3),
  interest_categories TEXT CHECK (interest_categories IS NULL OR
    CASE WHEN json_valid(interest_categories) THEN
      json_type(interest_categories) = 'array' AND json_array_length(interest_categories) BETWEEN 2 AND 3
    ELSE 0 END),
  recent_trips TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(recent_trips) AND json_array_length(recent_trips) <= 3),
  waiting_for TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (dog_id, version)
);`
export const SNAPSHOT_V4_TRIGGERS_SQL = ['INSERT', 'UPDATE OF interest_categories'].map(operation => `
CREATE TRIGGER IF NOT EXISTS snapshot_interest_${operation === 'INSERT' ? 'ins' : 'upd'} BEFORE ${operation} ON snapshot
WHEN NEW.interest_categories IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'snapshot: invalid interest category')
  WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.interest_categories) THEN NEW.interest_categories ELSE '[]' END)
    WHERE type <> 'text' OR value NOT IN ('自然风景','城市角落','手作与食物','人与故事','动物与植物','冷知识'));
END;`).join('\n')

/** Bootstrap already holds BEGIN IMMEDIATE. Never nest transactions or toggle foreign_keys. */
export function snapshotInterestNullMigration(db: DatabaseSync): string {
  const column = db.prepare("SELECT * FROM pragma_table_info('snapshot') WHERE name='interest_categories'").get()
  if (!column) throw new Error('Snapshot v4 requires the existing snapshot table')
  if (db.prepare('PRAGMA foreign_keys').get()?.foreign_keys !== 1) throw new Error('Snapshot v4 requires foreign keys enabled')
  if (column.notnull === 1) {
    // Baseline: snapshot -> dog; no application table references snapshot. Refuse
    // unexpected incoming FKs rather than risk an implicit cascade on DROP TABLE.
    const inbound = db.prepare(`SELECT m.name FROM sqlite_schema m, pragma_foreign_key_list(m.name) f
      WHERE m.type='table' AND f."table"='snapshot'`).all()
    if (inbound.length) throw new Error('Snapshot v4 requires review of incoming foreign keys')
    const objects = db.prepare(`SELECT sql FROM sqlite_schema WHERE tbl_name='snapshot'
      AND type IN ('index','trigger') AND sql IS NOT NULL ORDER BY type,name`).all()
    const columns = 'dog_id,version,personality_tags,interest_categories,recent_trips,waiting_for,created_at'
    // Recreate the same name directly (no ALTER RENAME) so existing views and
    // triggers on other tables keep their references. Restore local objects.
    db.exec(`CREATE TEMP TABLE snapshot_v4_backup AS SELECT ${columns} FROM snapshot;
      DROP TABLE snapshot;
      ${SNAPSHOT_V4_TABLE_SQL}
      ${SNAPSHOT_V4_TRIGGERS_SQL}
      INSERT INTO snapshot(${columns}) SELECT ${columns} FROM snapshot_v4_backup;
      DROP TABLE temp.snapshot_v4_backup;
      ${objects.map(row => String(row.sql) + ';').join('\n')}`)
  } else {
    // Current fresh schema already has the nullable column; do not rebuild it.
    db.exec(SNAPSHOT_V4_TRIGGERS_SQL)
  }
  if (db.prepare('PRAGMA foreign_key_check').all().length) throw new Error('Snapshot v4 foreign key check failed')
  return 'SELECT 1;'
}
