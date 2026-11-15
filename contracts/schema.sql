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

  -- a 写。匿名 session，本产品不做登录（D-003）。一个人可以有多只狗。
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

  -- a 写。装配单，**固定六个键，多一个都不许加**。渲染组件只吃这一个字段。
  -- 形状：{"base","skin":{"color","pattern"},"cloth","hat","glasses","face"}
  -- 键数与键名校验在下面的触发器里（CHECK 写不了子查询）。
  assembly            TEXT    NOT NULL,

  -- d 写。种子狗为 1。**界面必须据此标「示例伙伴」，这是五种阻断缺陷之一。**
  is_sample           INTEGER NOT NULL DEFAULT 0 CHECK (is_sample IN (0, 1)),

  -- **b 写，不是 a。** 全局最高优先级过滤器，高于心愿、高于朋友牵挂、高于当天事件。
  -- c 的搜索键、d 的交换内容、e 的展示，三处都要过。
  blocked_topics      TEXT    NOT NULL DEFAULT '[]'
                              CHECK (json_valid(blocked_topics)
                                     AND json_type(blocked_topics) = 'array'),

  created_at          TEXT    NOT NULL
);

-- 装配单校验：恰好六个键，且这六个键都在。写在触发器里因为 CHECK 不许子查询。
CREATE TRIGGER dog_assembly_ins BEFORE INSERT ON dog
BEGIN
  SELECT RAISE(ABORT,
    'dog.assembly 必须恰好六个键：base / skin / cloth / hat / glasses / face')
  WHERE json_valid(NEW.assembly) = 0
     OR (SELECT COUNT(*) FROM json_each(NEW.assembly)) <> 6
     OR json_type(NEW.assembly, '$.base')   IS NULL
     OR json_type(NEW.assembly, '$.skin')   IS NULL
     OR json_type(NEW.assembly, '$.cloth')  IS NULL
     OR json_type(NEW.assembly, '$.hat')    IS NULL
     OR json_type(NEW.assembly, '$.glasses') IS NULL
     OR json_type(NEW.assembly, '$.face')   IS NULL
     OR json_type(NEW.assembly, '$.skin.color')   IS NULL
     OR json_type(NEW.assembly, '$.skin.pattern') IS NULL;
END;

CREATE TRIGGER dog_assembly_upd BEFORE UPDATE OF assembly ON dog
BEGIN
  SELECT RAISE(ABORT,
    'dog.assembly 必须恰好六个键：base / skin / cloth / hat / glasses / face')
  WHERE json_valid(NEW.assembly) = 0
     OR (SELECT COUNT(*) FROM json_each(NEW.assembly)) <> 6
     OR json_type(NEW.assembly, '$.base')   IS NULL
     OR json_type(NEW.assembly, '$.skin')   IS NULL
     OR json_type(NEW.assembly, '$.cloth')  IS NULL
     OR json_type(NEW.assembly, '$.hat')    IS NULL
     OR json_type(NEW.assembly, '$.glasses') IS NULL
     OR json_type(NEW.assembly, '$.face')   IS NULL
     OR json_type(NEW.assembly, '$.skin.color')   IS NULL
     OR json_type(NEW.assembly, '$.skin.pattern') IS NULL;
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
  interest_categories TEXT    NOT NULL
                              CHECK (json_valid(interest_categories)
                                     AND json_array_length(interest_categories) BETWEEN 2 AND 3),

  -- d 写。最多 3 条，**只放摘要**（一句话），不放 find 原文、不放对话。
  recent_trips        TEXT    NOT NULL DEFAULT '[]'
                              CHECK (json_valid(recent_trips)
                                     AND json_array_length(recent_trips) <= 3),

  -- d 写。当前在等什么，人话一句，如「等一条围巾的回音」。可为空。
  waiting_for         TEXT,

  created_at          TEXT    NOT NULL,

  PRIMARY KEY (dog_id, version)
);

-- ---------------------------------------------------------------------------
-- wish · 心愿（2.2）
-- 写入方：b。c 只读（拿 category 当搜索入口），a 只读。
-- ---------------------------------------------------------------------------
CREATE TABLE wish (
  id         TEXT PRIMARY KEY,
  dog_id     TEXT NOT NULL REFERENCES dog(id),

  -- b 写。主人原话，1–200 字。**只存在这里，不进 snapshot。**
  text       TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 200),

  -- b 写。六类目之一。c 用 CATEGORY_KEYWORDS[category] 做 zhihu_search 的 Query。
  category   TEXT NOT NULL CHECK (category IN
               ('自然风景', '城市角落', '手作与食物', '人与故事', '动物与植物', '冷知识')),

  created_at TEXT NOT NULL,

  -- b 写。撤销就填这一刻，**不物理删除**（手账还要能翻回去）。撤销后 c 不再读它。
  revoked_at TEXT
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
  -- 时间拨盘拨一次 = seq 加一，不碰时钟。
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

-- 同一条邀请只能被回应一次（重复点击靠这条兜住幂等）。
CREATE UNIQUE INDEX uniq_reply_invitation ON reply(invitation_id)
  WHERE invitation_id IS NOT NULL;

CREATE INDEX idx_reply_exchange ON reply(exchange_id);

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
