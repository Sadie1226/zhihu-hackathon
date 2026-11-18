/** Version 2, 2026-11-18. Immutable after deployment; independent of future schema.sql edits. */
export const EVENT_SCHEMA_V2_SQL = `
-- event：D 维护的候选池，不是已经发生的经历。固定 12 列，不含 created_at。
-- place_tags=[] 表示不限场景；非空时与 availablePlaces 有交集才匹配。
-- asset_refs 等 E2c 提供可用引用前保持 {}，不能用清空 place_tags 代替。
CREATE TABLE IF NOT EXISTS event (
  id            TEXT NOT NULL PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE,
  text          TEXT NOT NULL CHECK (length(trim(text)) >= 1 AND length(text) <= 40),
  season        TEXT NOT NULL CHECK (season IN ('spring','summer','autumn','winter','any')),
  weather       TEXT NOT NULL CHECK (weather IN ('any','clear','rain','snow')),
  time_of_day   TEXT NOT NULL CHECK (time_of_day IN ('any','morning','dusk','night')),
  place_tags    TEXT NOT NULL DEFAULT '[]'
                CHECK (CASE WHEN json_valid(place_tags) THEN json_type(place_tags) = 'array' ELSE 0 END),
  match_tags    TEXT NOT NULL DEFAULT '[]'
                CHECK (CASE WHEN json_valid(match_tags) THEN json_type(match_tags) = 'array' ELSE 0 END),
  weight        INTEGER NOT NULL DEFAULT 30 CHECK (typeof(weight) IN ('integer','real') AND weight > 0),
  cooldown_days INTEGER NOT NULL DEFAULT 7 CHECK (typeof(cooldown_days) IN ('integer','real') AND cooldown_days >= 0),
  asset_refs    TEXT NOT NULL DEFAULT '{}'
                CHECK (CASE WHEN json_valid(asset_refs) THEN json_type(asset_refs) = 'object' ELSE 0 END),
  enabled       INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1))
);

-- CHECK 不能用子查询；INSERT 和 UPDATE 都校验元素类型与枚举。
-- 无效 JSON 交给上面的 CHECK 拒绝，避免 json_each 先抛解析错误。
CREATE TRIGGER IF NOT EXISTS event_tags_ins BEFORE INSERT ON event
BEGIN
  SELECT RAISE(ABORT, 'event.place_tags contains an invalid place tag')
  WHERE EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.place_tags) THEN NEW.place_tags ELSE '[]' END)
    WHERE type <> 'text' OR value NOT IN ('street','stall','riverside','bookstore')
  );
  SELECT RAISE(ABORT, 'event.match_tags contains an invalid interest category')
  WHERE EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.match_tags) THEN NEW.match_tags ELSE '[]' END)
    WHERE type <> 'text' OR value NOT IN ('自然风景','城市角落','手作与食物','人与故事','动物与植物','冷知识')
  );
END;

CREATE TRIGGER IF NOT EXISTS event_tags_upd BEFORE UPDATE OF place_tags, match_tags ON event
BEGIN
  SELECT RAISE(ABORT, 'event.place_tags contains an invalid place tag')
  WHERE EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.place_tags) THEN NEW.place_tags ELSE '[]' END)
    WHERE type <> 'text' OR value NOT IN ('street','stall','riverside','bookstore')
  );
  SELECT RAISE(ABORT, 'event.match_tags contains an invalid interest category')
  WHERE EXISTS (
    SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.match_tags) THEN NEW.match_tags ELSE '[]' END)
    WHERE type <> 'text' OR value NOT IN ('自然风景','城市角落','手作与食物','人与故事','动物与植物','冷知识')
  );
END;

-- trip_event：C 独占写入的历史事实，D 只读。时间沿用 UTC ISO-8601。
-- 本任务仅建表；不抽签、不自动创建历史记录，不改变出行状态机。
CREATE TABLE IF NOT EXISTS trip_event (
  trip_id     TEXT NOT NULL REFERENCES trip(id),
  event_id    TEXT NOT NULL REFERENCES event(id),
  dog_id      TEXT NOT NULL REFERENCES dog(id),
  happened_at TEXT NOT NULL,
  PRIMARY KEY (trip_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_trip_event_dog ON trip_event(dog_id, happened_at);
`
