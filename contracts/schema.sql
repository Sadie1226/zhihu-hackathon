-- 看山出门 · K 契约 · schema.sql
-- 出 c，11-16。全队唯一的数据表来源。**别人不许自己建表、自己加字段。**
--
-- 用法：lib/db 打开数据库后，把这个文件整份 exec 一次即可建库。
--   注意 better-sqlite3 / node:sqlite 都要手动 `PRAGMA foreign_keys = ON`（每个连接一次）。
--
-- 三条全局约定：
--   1. 所有时间列都是 TEXT，UTC，ISO-8601，形如 2026-11-16T12:00:00Z。
--      演示用的时间拨盘拨的是「现在」这个值，**不改数据库里已经写下的时间**。
--   2. 所有枚举列都用 CHECK 锁死。拼错一个字符串，插入当场失败，不会静默存进去。
--   3. 每个列上方都写了写入方。**一个事实只有一个写入方**，别人要改就发请求给写入方。
--
-- ============================================================================
-- 【c 相对《给C-契约输入》改了六处，全部是「只加不删」，逐条列在这里，a 可否决】
--
--   改动 1  新增表 invitation（邀请）。a 的输入里 `reply` 提到能吃 `invitation_id`，
--           但八类实体里没有邀请表。邀请和 exchange 结构不同：exchange 是狗→狗、
--           经投递到达；邀请是狗→主人、永不投递、永不过期。塞进 exchange 会毁掉
--           deliver_after_trip_seq 的语义。→ 见本文件 invitation 段。
--
--   改动 2  新增表 relation（邻里关系）。a 的《给D-邻居池》要求「排除已拉黑的关系双方」
--           「优先还没交换过的」「熟悉度」，这些落不了在任何一张已有表上。
--
--   改动 3  exchange.deliver_at → deliver_after_trip_seq（时间戳改成整数）。
--           这是全表最关键的一处。名字叫 `_at` 就一定会有人写成 `now > deliver_at`，
--           而那正是 a 点名的「演示时延后礼物永远不到」。改成「收件狗第几次出行」，
--           判断变成数数，拨一次表就到。
--
--   改动 4  reply.kind（text/photo/none 单值）→ text、photo_url 两列 + 自动推导的 kind。
--           b 今天的交付里第 3 条正常示例是「文字 + 图片」同时存在，单值枚举存不下。
--           另：'none' 不是一种回应，是「没有这条记录」，所以不许插入空回应。
--
--   改动 5  find.source_mode 只对 kind='zhihu' 有意义，scene/moment 必须为 NULL。
--           给自家画的风景打「示例内容」标会让每一程都像假数据；不打又违反不变量四。
--           正确的切法是：这一列只回答「这条知乎内容是不是真的」，其余 kinds 不适用。
--
--   改动 6  dog.personality_tags 的「三个不同维度、不能是互斥对」无法用 CHECK 表达
--           （CHECK 不许写子查询），改由 scripts/check-contracts.mjs 校验。
--           数据库这一层只锁「恰好 3 个、都是 12 个标签之一」。
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- dog · 一只狗
-- 写入方：a（身份、名字、标签、装配单）／b（blocked_topics）／d（is_sample）
-- ---------------------------------------------------------------------------
CREATE TABLE dog (
  id                  TEXT    PRIMARY KEY,

  -- a 写。可空；空则用标签生成的候选名。1–6 字。
  name                TEXT    CHECK (name IS NULL OR length(trim(name)) BETWEEN 1 AND 6),

  -- 历史值保留。v5 已绑定的记录在兼容列保存 owner.id，Cookie 凭据只经 owner_session 验证。
  session_id          TEXT    NOT NULL,

  -- a 写。恰好 3 个，每个都是 12 个标签之一，且来自 3 个不同维度、不能是互斥对的两极。
  -- 库这一层只能锁「3 个且合法」，维度与互斥由 check-contracts.mjs 查。
  personality_tags    TEXT    NOT NULL
                              CHECK (json_valid(personality_tags)
                                     AND json_array_length(personality_tags) = 3),

  -- a 写。2–3 个类目，或为 NULL（NULL = 全都要）。
  interest_categories TEXT    CHECK (interest_categories IS NULL
                                     OR (json_valid(interest_categories)
                                         AND json_array_length(interest_categories) BETWEEN 2 AND 3)),

  -- a 写。v6 新写入为 outfit/cloth/accessory/face；旧记录按原 JSON 读取。
  assembly            TEXT    NOT NULL,

  -- d 写。种子狗为 1。**界面必须据此标「示例伙伴」，这是五种阻断缺陷之一。**
  is_sample           INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0, 1)),

  -- **b 写，不是 a。** 全局最高优先级过滤器，高于心愿、高于朋友牵挂、高于当天事件。
  -- c 的搜索键、d 的交换内容、e 的展示，三处都要过。
  blocked_topics      TEXT    NOT NULL DEFAULT '[]'
                              CHECK (json_valid(blocked_topics)
                                     AND json_type(blocked_topics) = 'array'),

  created_at          TEXT    NOT NULL,
  owner_id            TEXT    REFERENCES owner(id)
);

-- v5 owner 归属。会话日期使用 Unix 毫秒，其余 created_at 延续 ISO 时间。
CREATE TABLE owner (
  id TEXT NOT NULL PRIMARY KEY,
  namespace TEXT NOT NULL CHECK (namespace IN ('zhihu', 'development')),
  provider TEXT NOT NULL CHECK (provider = namespace),
  provider_subject TEXT NOT NULL CHECK (length(provider_subject) > 0),
  created_at TEXT NOT NULL,
  UNIQUE (namespace, provider, provider_subject)
) STRICT;

CREATE TABLE owner_session (
  token_hash TEXT NOT NULL PRIMARY KEY CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  owner_id TEXT NOT NULL REFERENCES owner(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > created_at),
  revoked_at INTEGER CHECK (revoked_at >= created_at)
) STRICT;

CREATE UNIQUE INDEX uniq_dog_owner ON dog(owner_id) WHERE owner_id IS NOT NULL;
CREATE UNIQUE INDEX uniq_dog_id_owner ON dog(id, owner_id);

CREATE TABLE adoption_receipt (
  owner_id TEXT NOT NULL REFERENCES owner(id),
  request_id TEXT NOT NULL,
  request_hash TEXT NOT NULL CHECK (length(request_hash) = 64 AND request_hash NOT GLOB '*[^0-9a-f]*'),
  dog_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, request_id),
  FOREIGN KEY (dog_id, owner_id) REFERENCES dog(id, owner_id)
) STRICT;

CREATE TRIGGER owner_legacy_key_guard BEFORE INSERT ON owner
WHEN EXISTS (SELECT 1 FROM dog WHERE session_id = NEW.id AND owner_id IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'owner: legacy dog key collision');
END;

CREATE TRIGGER dog_owner_guard_insert BEFORE INSERT ON dog
WHEN (NEW.owner_id IS NOT NULL AND (NEW.is_sample <> 0 OR NEW.session_id <> NEW.owner_id))
  OR (NEW.owner_id IS NULL AND EXISTS (SELECT 1 FROM owner WHERE id = NEW.session_id))
BEGIN
  SELECT RAISE(ABORT, 'dog: invalid owner association');
END;

CREATE TRIGGER dog_owner_guard_update BEFORE UPDATE OF owner_id, session_id, is_sample ON dog
WHEN (OLD.owner_id IS NOT NULL AND OLD.owner_id IS NOT NEW.owner_id)
  OR (NEW.owner_id IS NOT NULL AND (NEW.is_sample <> 0 OR NEW.session_id <> NEW.owner_id))
  OR (NEW.owner_id IS NULL AND EXISTS (SELECT 1 FROM owner WHERE id = NEW.session_id))
BEGIN
  SELECT RAISE(ABORT, 'dog: invalid owner association');
END;

-- K v6: adopted r2 whitelist and exclusive T/S/P/F selection.
CREATE TRIGGER dog_assembly_ins BEFORE INSERT ON dog
BEGIN
  SELECT RAISE(ABORT, 'dog.assembly: invalid T/S/P/F') WHERE CASE
    WHEN typeof(NEW.assembly) <> 'text' OR instr(NEW.assembly, char(0)) > 0 OR json_valid(NEW.assembly) <> 1 THEN 1
    ELSE NOT COALESCE(
      json_type(NEW.assembly) = 'object'
      AND (SELECT count(*) FROM json_each(NEW.assembly)) = 4
      AND json_type(NEW.assembly, '$.face') = 'text'
        AND json_extract(NEW.assembly, '$.face') IN ('F01-neutral', 'F02-wink', 'F03-teary', 'F04-smile', 'F05-unimpressed', 'F06-sparkle', 'F07-shiny', 'F08-sleepy', 'F10-closed-smile')
      AND (
        (json_type(NEW.assembly, '$.outfit') = 'text'
        AND json_extract(NEW.assembly, '$.outfit') IN ('T01-frog', 'T02-winter-post', 'T05-cloud-onesie', 'T06-starry-cloak', 'T07-striped-knit', 'T10-cowboy')
          AND json_type(NEW.assembly, '$.cloth') = 'null'
          AND json_type(NEW.assembly, '$.accessory') = 'null')
        OR (json_type(NEW.assembly, '$.outfit') = 'null'
          AND json_type(NEW.assembly, '$.cloth') = 'text'
        AND json_extract(NEW.assembly, '$.cloth') IN ('S01-yellow-cardigan', 'S02-leaf-cape', 'S03-apron', 'S04-olive-vest', 'S05-cream-vest', 'S06-navy-varsity', 'S07-blue-cloud-hoodie', 'S08-blue-check-pajamas', 'S09-seaside-shell-cape')
          AND (json_type(NEW.assembly, '$.accessory') = 'null' OR (json_type(NEW.assembly, '$.accessory') = 'text'
        AND json_extract(NEW.assembly, '$.accessory') IN ('P05-daisy-crown', 'P12-orange-thermos', 'P13-blue-cap', 'P15-star-bag', 'P16-mint-sunglasses', 'P19-blue-wings', 'P22-gold-round-glasses', 'P23-black-sunglasses', 'P25-blue-check-nightcap'))))
      ), 0)
  END;
END;

CREATE TRIGGER dog_assembly_upd BEFORE UPDATE OF assembly ON dog
BEGIN
  SELECT RAISE(ABORT, 'dog.assembly: invalid T/S/P/F') WHERE CASE
    WHEN typeof(NEW.assembly) <> 'text' OR instr(NEW.assembly, char(0)) > 0 OR json_valid(NEW.assembly) <> 1 THEN 1
    ELSE NOT COALESCE(
      json_type(NEW.assembly) = 'object'
      AND (SELECT count(*) FROM json_each(NEW.assembly)) = 4
      AND json_type(NEW.assembly, '$.face') = 'text'
        AND json_extract(NEW.assembly, '$.face') IN ('F01-neutral', 'F02-wink', 'F03-teary', 'F04-smile', 'F05-unimpressed', 'F06-sparkle', 'F07-shiny', 'F08-sleepy', 'F10-closed-smile')
      AND (
        (json_type(NEW.assembly, '$.outfit') = 'text'
        AND json_extract(NEW.assembly, '$.outfit') IN ('T01-frog', 'T02-winter-post', 'T05-cloud-onesie', 'T06-starry-cloak', 'T07-striped-knit', 'T10-cowboy')
          AND json_type(NEW.assembly, '$.cloth') = 'null'
          AND json_type(NEW.assembly, '$.accessory') = 'null')
        OR (json_type(NEW.assembly, '$.outfit') = 'null'
          AND json_type(NEW.assembly, '$.cloth') = 'text'
        AND json_extract(NEW.assembly, '$.cloth') IN ('S01-yellow-cardigan', 'S02-leaf-cape', 'S03-apron', 'S04-olive-vest', 'S05-cream-vest', 'S06-navy-varsity', 'S07-blue-cloud-hoodie', 'S08-blue-check-pajamas', 'S09-seaside-shell-cape')
          AND (json_type(NEW.assembly, '$.accessory') = 'null' OR (json_type(NEW.assembly, '$.accessory') = 'text'
        AND json_extract(NEW.assembly, '$.accessory') IN ('P05-daisy-crown', 'P12-orange-thermos', 'P13-blue-cap', 'P15-star-bag', 'P16-mint-sunglasses', 'P19-blue-wings', 'P22-gold-round-glasses', 'P23-black-sunglasses', 'P25-blue-check-nightcap'))))
      ), 0)
  END;
END;

CREATE INDEX idx_dog_session ON dog(session_id);

-- ---------------------------------------------------------------------------
-- snapshot · 状态快照，给别人家的狗读
-- 写入方：d。**这张表是白名单，不是黑名单。**
--
-- 存在的唯一目的是让别的狗读到这只狗「是什么样」，所以只允许这五样。
-- 聊天原文、主人心愿原文、照片原图，**一个字都不许进这张表**。
-- 有人想加 chat_summary —— 答复是不行，摘要也是原文派生的，一样会串味。
-- ---------------------------------------------------------------------------
CREATE TABLE snapshot (
  dog_id              TEXT    NOT NULL REFERENCES dog(id),
  version             INTEGER NOT NULL,

  -- d 写。以下五项全部来自 dog 表或 c 的 trip 摘要，不来自 b 的聊天。
  personality_tags    TEXT    NOT NULL
                              CHECK (json_valid(personality_tags)
                                     AND json_array_length(personality_tags) = 3),
  -- NULL 表示未选兴趣限制；非 NULL 必须是现有六类中的 2–3 项，[] 不等于 NULL。
  interest_categories TEXT CHECK (interest_categories IS NULL OR
    CASE WHEN json_valid(interest_categories) THEN
      json_type(interest_categories) = 'array' AND json_array_length(interest_categories) BETWEEN 2 AND 3
    ELSE 0 END),

  -- d 写。最多 3 条，**只放摘要**（一句话），不放 find 原文、不放对话。
  recent_trips        TEXT    NOT NULL DEFAULT '[]'
                              CHECK (json_valid(recent_trips)
                                     AND json_array_length(recent_trips) <= 3),

  -- d 写。当前在等什么，人话一句，如「等一条围巾的回音」。可为空。
  waiting_for         TEXT,

  created_at          TEXT    NOT NULL,

  PRIMARY KEY (dog_id, version)
);


CREATE TRIGGER IF NOT EXISTS snapshot_interest_ins BEFORE INSERT ON snapshot
WHEN NEW.interest_categories IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'snapshot: invalid interest category')
  WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.interest_categories) THEN NEW.interest_categories ELSE '[]' END)
    WHERE type <> 'text' OR value NOT IN ('自然风景','城市角落','手作与食物','人与故事','动物与植物','冷知识'));
END;

CREATE TRIGGER IF NOT EXISTS snapshot_interest_upd BEFORE UPDATE OF interest_categories ON snapshot
WHEN NEW.interest_categories IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'snapshot: invalid interest category')
  WHERE EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(NEW.interest_categories) THEN NEW.interest_categories ELSE '[]' END)
    WHERE type <> 'text' OR value NOT IN ('自然风景','城市角落','手作与食物','人与故事','动物与植物','冷知识'));
END;

-- ---------------------------------------------------------------------------
-- wish · 心愿（2.2）
-- 写入方：b。c 只读（拿 category 当搜索入口），a 只读。
-- ---------------------------------------------------------------------------
CREATE TABLE wish (
  id         TEXT PRIMARY KEY,
  dog_id     TEXT NOT NULL REFERENCES dog(id),

  -- b 写。owner 是主人原话；collection 是授权收藏提取的主题。1–200 字，不进 snapshot。
  text       TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 200),

  -- b 写。六类目之一。c 用 CATEGORY_KEYWORDS[category] 做 zhihu_search 的 Query。
  category   TEXT NOT NULL CHECK (category IN
               ('自然风景', '城市角落', '手作与食物', '人与故事', '动物与植物', '冷知识')),

  created_at TEXT NOT NULL,

  -- b 写。撤销就填这一刻，**不物理删除**（手账还要能翻回去）。撤销后 c 不再读它。
  revoked_at TEXT,

  -- b 的可信服务端写；不能来自客户端表单。旧心愿默认 owner。
  source TEXT NOT NULL DEFAULT 'owner' CHECK (source IN ('owner','collection')),
  source_url TEXT CHECK (
    (source = 'owner' AND source_url IS NULL) OR
    (source = 'collection' AND source_url IS NOT NULL AND length(source_url) > 0)
  )
);

CREATE INDEX idx_wish_dog ON wish(dog_id, revoked_at);

-- ---------------------------------------------------------------------------
-- trip · 一次出行（3.1）
-- 写入方：c。a/b/d/e 全部只读。
-- ---------------------------------------------------------------------------
CREATE TABLE trip (
  id         TEXT    PRIMARY KEY,
  dog_id     TEXT    NOT NULL REFERENCES dog(id),

  -- c 写。**这只狗的第几次出行，从 1 开始，只增不减。**
  -- 这是投递机制的计量单位：exchange.deliver_after_trip_seq 就是拿它比的。
  -- 每次创建新 trip，seq 加一。演示可推进服务端时钟供新出行使用，不改历史时间。
  seq        INTEGER NOT NULL CHECK (seq >= 1),

  -- c 写。pending 建立未出发；running 已经在路上；done 正常回来；
  -- failed 出错；timeout 超时收尾（不是空状态，见 errors.md）。
  status     TEXT    NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'timeout')),

  -- c 写。为什么出门。auto 到点自己走；wish 因为心愿；friend 因为朋友的牵挂。
  trigger    TEXT    NOT NULL CHECK (trigger IN ('auto', 'wish', 'friend')),

  -- c 写。created_at 是建这条记录；started_at 是**真正出发那一刻**——
  -- 投递判断只认 started_at，不认 created_at。
  created_at TEXT    NOT NULL,

  -- c 写。这三个时刻都必须有值才允许进入对应状态（约束在下面）。
  started_at TEXT,
  ended_at   TEXT,

  -- c 写，出发时绑定；旧记录为 NULL。撤销不解除历史关联。
  wish_id TEXT REFERENCES wish(id),

  UNIQUE (dog_id, seq)
);

-- 状态和时刻不许打架：running 必须已经有 started_at，结束态必须已经有 ended_at。
CREATE TRIGGER trip_times_ins BEFORE INSERT ON trip
BEGIN
  SELECT RAISE(ABORT, 'trip: running 必须有 started_at，结束态必须有 ended_at')
  WHERE (NEW.status = 'running' AND NEW.started_at IS NULL)
     OR (NEW.status IN ('done', 'failed', 'timeout') AND NEW.ended_at IS NULL)
     OR (NEW.ended_at IS NOT NULL AND NEW.started_at IS NULL);
END;

CREATE TRIGGER trip_times_upd BEFORE UPDATE ON trip
BEGIN
  SELECT RAISE(ABORT, 'trip: running 必须有 started_at，结束态必须有 ended_at')
  WHERE (NEW.status = 'running' AND NEW.started_at IS NULL)
     OR (NEW.status IN ('done', 'failed', 'timeout') AND NEW.ended_at IS NULL)
     OR (NEW.ended_at IS NOT NULL AND NEW.started_at IS NULL);
END;

CREATE INDEX idx_trip_dog_seq ON trip(dog_id, seq);
CREATE INDEX idx_trip_status  ON trip(status, started_at);

-- ---------------------------------------------------------------------------
-- find · 一条发现（3.2 / 3.4）
-- 写入方：c。b/d/e 只读。
-- ---------------------------------------------------------------------------
CREATE TABLE find (
  id              TEXT    PRIMARY KEY,
  trip_id         TEXT    NOT NULL REFERENCES trip(id),

  -- c 写。scene 风景；zhihu 知乎内容；moment 生活片段。
  kind            TEXT    NOT NULL CHECK (kind IN ('scene', 'zhihu', 'moment')),

  title           TEXT    NOT NULL,
  excerpt         TEXT,

  -- c 写。**kind='zhihu' 时必填**，界面上点得开才算 P0 第 4 条成立。
  source_url      TEXT,

  -- c 写。**这一列只回答一个问题：这条知乎内容是不是这次请求现拿的。**
  --   live    本次请求真打到知乎
  --   cache   24 小时内的真结果
  --   fixture 假数据（含全部种子狗）
  -- scene / moment 是自家拼出来的东西，不属于这三档，必须为 NULL。
  -- 给它们标 fixture 会让每一程都像假数据；标 live 就是撒谎。
  source_mode     TEXT    CHECK (source_mode IS NULL OR source_mode IN ('live', 'cache', 'fixture')),

  -- c 写。知乎返回的 AuthorityLevel（1 低—4 超高）与赞数，原样存，不让 AI 判断谁可信。
  authority_level INTEGER CHECK (authority_level IS NULL OR authority_level BETWEEN 1 AND 4),
  vote_up_count   INTEGER CHECK (vote_up_count IS NULL OR vote_up_count >= 0),

  -- c 写。11-16 新增。这条发现配的图，存**路径**不存二进制。
  -- 三种 kind 都可以有：scene 是生成或拼装的场景图，moment 是生活片段图，zhihu 一般没有。
  -- 可空。**空不等于失败** —— 生成失败走纯文字兜底，界面不出现空白框（errors.md）。
  -- 同一条发现只许有一个路径，生成一次就不再变：换设备打开读的是同一张。
  asset_path      TEXT,

  created_at      TEXT    NOT NULL,

  CHECK (
    (kind = 'zhihu'  AND source_url IS NOT NULL AND source_mode IS NOT NULL)
    OR
    (kind IN ('scene', 'moment') AND source_mode IS NULL)
  )
);

CREATE INDEX idx_find_trip ON find(trip_id);
CREATE INDEX idx_find_mode ON find(source_mode);

-- ---------------------------------------------------------------------------
-- exchange · 信箱（4.2 / 4.4 / 9 捎话共用一张表）
-- **全表唯一需要拆到列的地方。四件事不许合并。**
--
--   谁  | 决定什么          | 写哪几列
--   d   | 寄什么、什么时候该到 | id / from_dog / to_dog / kind / payload / deliver_after_trip_seq / created_at
--   c   | 这一刻是否已经到     | delivered_at（投递器独占，写一次就不再写）
--   b   | 算不算被回应        | replied_at（回应能力独占）
--   e   | 算不算被看过        | read_at
--
-- 如果有人想「顺手在投递器里把 replied_at 也写了」，就是绕过 b。
-- 联调时会出现「礼物到了但显示已回应」的错状态。
-- ---------------------------------------------------------------------------
CREATE TABLE exchange (
  id                     TEXT    PRIMARY KEY,

  -- d 写。捎话时这两只狗是「运输工具」，主人原话在 payload 里。
  from_dog               TEXT    NOT NULL REFERENCES dog(id),
  to_dog                 TEXT    NOT NULL REFERENCES dog(id),

  -- d 写。只允许这四个值。**加第五种必须由 c 改 K**，不许谁自己塞一个字符串。
  kind                   TEXT    NOT NULL
                                 CHECK (kind IN ('find', 'greeting', 'gift', 'co_owner_message')),

  -- d 写。业务内容，JSON。四种 kind 的形状见 api.md。
  -- 【铁的边界】seed 狗不伪造主人回复；主人原话不许进 snapshot，只许留在这里。
  payload                TEXT    NOT NULL CHECK (json_valid(payload)),

  -- d 写。**不是一个时间戳，是「收件狗第几次出行」。**
  -- 发送那一刻算：deliver_after_trip_seq = 收件狗当前 seq + 1。
  -- 判断是否到达（c 的投递器，唯一的正确写法）：
  --   exists (select 1 from trip where dog_id = exchange.to_dog
  --           and started_at is not null and seq >= exchange.deliver_after_trip_seq)
  -- **写成 now > 某个时间戳，演示时延后礼物永远不会到。**
  deliver_after_trip_seq INTEGER NOT NULL CHECK (deliver_after_trip_seq >= 1),

  created_at             TEXT    NOT NULL,

  -- c 写。只有投递器能写，且**写一次就不再写**（幂等）。到达 = 收件狗下一次出行开始那一刻。
  delivered_at           TEXT,

  -- b 写。只有 b 的回应能力能写。
  replied_at             TEXT,

  -- e 写。主人点开那条内容才算已读。进页面不算、滚动过不算。
  read_at                TEXT,

  CHECK (from_dog <> to_dog)
);

CREATE INDEX idx_exchange_inbox ON exchange(to_dog, delivered_at);
CREATE INDEX idx_exchange_pend  ON exchange(to_dog, deliver_after_trip_seq);

-- c3 v2：按发送方读取全部投递状态；不改变任何列的写入方。
CREATE INDEX idx_exchange_outbox ON exchange(from_dog, created_at DESC);

-- ---------------------------------------------------------------------------
-- message · 归来的一句话（2.3）
-- 写入方：b。
-- **必须和 trip 分表。** 这句话是 b 写的，trip 的原始记录是 c 写的。合表就有两个写入方。
-- ---------------------------------------------------------------------------
CREATE TABLE message (
  id                TEXT PRIMARY KEY,
  trip_id           TEXT NOT NULL REFERENCES trip(id),

  -- b 写。一句话。话痨 20–35 字 / 寡言 8–15 字，去掉空白后标点算一个字。
  text              TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 120),

  -- b 写。这句话在讲哪条发现（可空）。c 只读，用来做「经历改写兴趣」。
  mentions_find_id  TEXT REFERENCES find(id),

  created_at        TEXT NOT NULL
);

CREATE INDEX idx_message_trip ON message(trip_id);

-- ---------------------------------------------------------------------------
-- invitation · 一次邀请（2.4，P0 第 6 条，核心闭环的入口）
-- 写入方：b。
--
-- 【为什么单独一张表，不塞进 exchange】
--   exchange 是狗 → 狗，靠出行投递到达；邀请是狗 → 自己的主人，**永不投递、永不过期**。
--   两者方向、生命周期、写入方全不一样。放一张表就会出现「邀请也要 deliver_after_trip_seq」
--   这种荒唐字段。
--
-- 【为什么没有 status 列】
--   三种状态（它在等 / 已回应 / 它自己去了）全部是从别的表推出来的：
--     已回应   = reply 里有一条指向它
--     它自己去了 = 它这只狗在邀请之后开始了新的出行，且没有回应
--   所以不存 status，也就没有第二个写入方。查状态用下面的视图 v_invitation_state。
-- ---------------------------------------------------------------------------
CREATE TABLE invitation (
  id                TEXT NOT NULL PRIMARY KEY,
  dog_id            TEXT NOT NULL REFERENCES dog(id),

  -- b 写。邀请原话。**必须有具体动作 + 一个理由 + 一个不做的余地**，缺一条重写。
  -- 字数由 b 的 checkLength() 按标签管，这里只兜住长度上限。
  text              TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 200),

  -- b 写。这条邀请接的是它自己看到的哪条发现（可空）。
  -- 有它才能验收「邀请的理由必须接它自己的兴趣」——这是可查的，不靠感觉。
  based_on_find_id  TEXT REFERENCES find(id),

  -- b 写。**没有 expires_at，也不许加。** 邀请永不过期。
  created_at        TEXT NOT NULL
);

CREATE INDEX idx_invitation_dog ON invitation(dog_id, created_at);

-- 邀请的三种状态。**没有 status 列，这是唯一权威读法。**
-- e 的界面、b 的「最多 3 条待回应」判断，全部查这个视图，不许各自实现一遍。
CREATE VIEW v_invitation_state AS
SELECT
  i.id        AS invitation_id,
  i.dog_id    AS dog_id,
  i.text      AS text,
  i.created_at AS created_at,
  r.id        AS reply_id,
  t.id        AS gone_alone_trip_id,
  CASE
    WHEN r.id IS NOT NULL THEN 'replied'
    WHEN t.id IS NOT NULL THEN 'gone_alone'
    ELSE 'waiting'
  END         AS state
FROM invitation i
LEFT JOIN reply r ON r.invitation_id = i.id
-- 「它自己去了」= 邀请之后这只狗开始的下一次出行。没有就不算，一直是 waiting。
LEFT JOIN trip t ON t.id = (
  SELECT t2.id FROM trip t2
  WHERE t2.dog_id = i.dog_id
    AND t2.started_at IS NOT NULL
    AND t2.started_at > i.created_at
  ORDER BY t2.started_at ASC, t2.seq ASC
  LIMIT 1
);

-- ---------------------------------------------------------------------------
-- reply · 一次回应（2.4，b 的唯一实现，d 来调它）
-- 写入方：b。
--
-- 回应有两个来源，同一种提交能力：
--   exchange_id   回应朋友送来的东西（d 的礼物、发现、捎话）
--   invitation_id 回应自己狗的邀请
-- 恰好填一个，两个都填或都不填都插不进去。
--
-- 【为什么不是 kind 单值枚举】b 今天的交付里第 3 条正常示例是文字加图片同时给。
-- 所以拆成两个可空列，kind 由它们推导出来（生成列，不占一个写入方）。
-- ---------------------------------------------------------------------------
CREATE TABLE reply (
  id            TEXT PRIMARY KEY,

  exchange_id   TEXT REFERENCES exchange(id),
  invitation_id TEXT REFERENCES invitation(id),

  -- b 写。文字上限 200 字（2.4 的唯一硬约束）。
  text          TEXT CHECK (text IS NULL OR length(trim(text)) BETWEEN 1 AND 200),

  -- b 写。照片路径，≤5MB，jpg/png/webp。存路径不存二进制。
  photo_url     TEXT,

  -- 推导列，不是写入方。text / photo / both。**不会有 'none'——空回应不许入库。**
  kind          TEXT GENERATED ALWAYS AS (
                  CASE WHEN text IS NOT NULL AND photo_url IS NOT NULL THEN 'both'
                       WHEN photo_url IS NOT NULL THEN 'photo'
                       ELSE 'text' END
                ) VIRTUAL,

  created_at    TEXT NOT NULL,

  -- 来源恰好一个
  CHECK ((exchange_id IS NOT NULL) <> (invitation_id IS NOT NULL)),
  -- 不许交空回应。不回应就是没有这条记录，不是一条空的记录。
  CHECK (text IS NOT NULL OR photo_url IS NOT NULL)
);

-- 同一个来源只能被回应一次。**两条路径都要有，只做一半就是漏。**
--
-- 重复点击提交是「提交这个动作」的幂等，它不区分来源 —— 邀请和礼物是同一个
-- 提交能力的两个入口。哪条路径缺索引，b 照说明写就会在那条路径上漏。
-- 2026-11-15 a 实测出过这个缺陷：只有 invitation 那条，礼物能插进两条。
CREATE UNIQUE INDEX uniq_reply_invitation ON reply(invitation_id)
  WHERE invitation_id IS NOT NULL;

CREATE UNIQUE INDEX uniq_reply_exchange ON reply(exchange_id)
  WHERE exchange_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- relation · 邻里关系（4.1 / 4.3）
-- 写入方：d。**关系类事实只有 d 写，别人只读。**（不变量五）
--
-- 不变量五：一只狗一个主人，一段经历一个出处。
-- e 的朋友圈、b 的「它记得你回应过」，全部只读 d 写下的这一份，不许自己算一遍。
-- ---------------------------------------------------------------------------
CREATE TABLE relation (
  id           TEXT    PRIMARY KEY,

  -- d 写。**按字典序小的放 dog_a**，避免同一对关系存成两条。
  dog_a        TEXT    NOT NULL REFERENCES dog(id),
  dog_b        TEXT    NOT NULL REFERENCES dog(id),

  -- d 写。第一次相遇、最近一次相遇、一共遇到几次。
  first_met_at TEXT    NOT NULL,
  last_met_at  TEXT    NOT NULL,
  met_count    INTEGER NOT NULL DEFAULT 1 CHECK (met_count >= 1),

  -- d 写。拉黑同时作用于狗和主人（不变量一：人不能直接操作另一个人，但可以选择不见）。
  -- 拉黑之后匹配函数必须排除这一对，双向都排除。
  is_blocked   INTEGER NOT NULL DEFAULT 0 CHECK (is_blocked IN (0, 1)),
  blocked_at   TEXT,

  CHECK (dog_a < dog_b),
  CHECK ((is_blocked = 0 AND blocked_at IS NULL) OR (is_blocked = 1 AND blocked_at IS NOT NULL))
);

CREATE UNIQUE INDEX uniq_relation_pair ON relation(dog_a, dog_b);

-- c3 v2：关系两端都能按最近相遇读取，保留原有唯一索引与约束。
CREATE INDEX idx_relation_dog_a_recent ON relation(dog_a, last_met_at DESC, id);
CREATE INDEX idx_relation_dog_b_recent ON relation(dog_b, last_met_at DESC, id);

-- c3-event-v2: begin
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
-- c3-event-v2: end

-- c3-wish-v3: begin

CREATE VIEW IF NOT EXISTS v_wish_active AS
SELECT id,dog_id,text,category,created_at,revoked_at,source,source_url
FROM wish WHERE revoked_at IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_wish_active_collection ON wish(dog_id)
WHERE source = 'collection' AND revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_wish_collection_content ON wish(dog_id,source_url)
WHERE source = 'collection';
CREATE INDEX IF NOT EXISTS idx_trip_wish ON trip(wish_id);

CREATE TRIGGER IF NOT EXISTS wish_url_insert BEFORE INSERT ON wish
BEGIN
  SELECT RAISE(ABORT, 'wish: canonical HTTPS Zhihu content URL required')
  WHERE NEW.source = 'collection' AND NOT (
  (substr(NEW.source_url,1,31) = 'https://www.zhihu.com/question/' || '' AND (
    (length(substr(NEW.source_url,32)) > 0 AND substr(NEW.source_url,32) NOT GLOB '*[^0-9]*' AND substr(substr(NEW.source_url,32),1,1) <> '0') OR (instr(substr(NEW.source_url,32),'/answer/') > 1 AND (length(substr(substr(NEW.source_url,32),1,instr(substr(NEW.source_url,32),'/answer/')-1)) > 0 AND substr(substr(NEW.source_url,32),1,instr(substr(NEW.source_url,32),'/answer/')-1) NOT GLOB '*[^0-9]*' AND substr(substr(substr(NEW.source_url,32),1,instr(substr(NEW.source_url,32),'/answer/')-1),1,1) <> '0') AND (length(substr(substr(NEW.source_url,32),instr(substr(NEW.source_url,32),'/answer/')+8)) > 0 AND substr(substr(NEW.source_url,32),instr(substr(NEW.source_url,32),'/answer/')+8) NOT GLOB '*[^0-9]*' AND substr(substr(substr(NEW.source_url,32),instr(substr(NEW.source_url,32),'/answer/')+8),1,1) <> '0'))
  )) OR
  (substr(NEW.source_url,1,29) = 'https://zhuanlan.zhihu.com/p/' || '' AND (length(substr(NEW.source_url,30)) > 0 AND substr(NEW.source_url,30) NOT GLOB '*[^0-9]*' AND substr(substr(NEW.source_url,30),1,1) <> '0'))
);
END;
CREATE TRIGGER IF NOT EXISTS wish_url_update BEFORE UPDATE ON wish
BEGIN
  SELECT RAISE(ABORT, 'wish: canonical HTTPS Zhihu content URL required')
  WHERE NEW.source = 'collection' AND NOT (
  (substr(NEW.source_url,1,31) = 'https://www.zhihu.com/question/' || '' AND (
    (length(substr(NEW.source_url,32)) > 0 AND substr(NEW.source_url,32) NOT GLOB '*[^0-9]*' AND substr(substr(NEW.source_url,32),1,1) <> '0') OR (instr(substr(NEW.source_url,32),'/answer/') > 1 AND (length(substr(substr(NEW.source_url,32),1,instr(substr(NEW.source_url,32),'/answer/')-1)) > 0 AND substr(substr(NEW.source_url,32),1,instr(substr(NEW.source_url,32),'/answer/')-1) NOT GLOB '*[^0-9]*' AND substr(substr(substr(NEW.source_url,32),1,instr(substr(NEW.source_url,32),'/answer/')-1),1,1) <> '0') AND (length(substr(substr(NEW.source_url,32),instr(substr(NEW.source_url,32),'/answer/')+8)) > 0 AND substr(substr(NEW.source_url,32),instr(substr(NEW.source_url,32),'/answer/')+8) NOT GLOB '*[^0-9]*' AND substr(substr(substr(NEW.source_url,32),instr(substr(NEW.source_url,32),'/answer/')+8),1,1) <> '0'))
  )) OR
  (substr(NEW.source_url,1,29) = 'https://zhuanlan.zhihu.com/p/' || '' AND (length(substr(NEW.source_url,30)) > 0 AND substr(NEW.source_url,30) NOT GLOB '*[^0-9]*' AND substr(substr(NEW.source_url,30),1,1) <> '0'))
);
END;

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

CREATE TRIGGER IF NOT EXISTS trip_wish_insert BEFORE INSERT ON trip
WHEN NEW.wish_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'trip: wish must belong to the same dog')
  WHERE NOT EXISTS (SELECT 1 FROM wish WHERE id = NEW.wish_id AND dog_id = NEW.dog_id);
END;
CREATE TRIGGER IF NOT EXISTS trip_wish_update BEFORE UPDATE ON trip
WHEN NEW.wish_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'trip: wish must belong to the same dog')
  WHERE NOT EXISTS (SELECT 1 FROM wish WHERE id = NEW.wish_id AND dog_id = NEW.dog_id);
END;
CREATE TRIGGER IF NOT EXISTS trip_wish_history BEFORE UPDATE OF wish_id ON trip
WHEN OLD.started_at IS NOT NULL AND NEW.wish_id IS NOT OLD.wish_id
BEGIN
  SELECT RAISE(ABORT, 'trip: started trip wish association is immutable');
END;
-- c3-wish-v3: end

-- v8: durable discovery receipts (internal; replay metadata is private)
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

CREATE TABLE IF NOT EXISTS trip_discovery_legacy_hold (
  trip_id          TEXT    NOT NULL PRIMARY KEY REFERENCES trip(id),
  dog_id           TEXT    NOT NULL REFERENCES dog(id),
  find_count       INTEGER NOT NULL CHECK (find_count > 0),
  captured_at      TEXT    NOT NULL,
  source_version   INTEGER NOT NULL CHECK (source_version = 7)
) STRICT;

-- Fresh schema increment for the approved v9 rollout.
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
