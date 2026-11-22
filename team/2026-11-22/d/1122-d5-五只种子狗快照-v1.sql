-- 5 只种子狗的快照（d5，排期 11-23，11-22 提前写）
--
-- 为什么只有 5 只：d5 的验收是「5 只性格经历各异的狗入池」，不是 20 只。
-- 先把这 5 只的「话不是一个味」做对，再谈扩充 —— 否则 20 只同款文案只是把问题放大 4 倍。
--
-- **标签与兴趣从 dog 表取，不在本文件里手写。** snapshot 的头两条字段和 dog 表是同一份事实，
-- 两边各写一遍，迟早不一致；而且「标签与 dog 表一致」本来就是调用方要保证的事。
--
-- 幂等：同一 (dog_id, version) 重复执行只更新五个业务字段，不新增行、不改版本号。
-- 已有版本不删 —— snapshot 是版本化的，(dog_id, version) 是主键。
--
-- 依赖：contracts/schema.sql（含 snapshot 表与两个触发器）+ 20 只种子狗已入 dog 表。
-- 校验：这 5 份 recent_trips 全部 ≤3 条、每条 ≤40 字，waiting_for 各一句。
--       形状检查在 lib/social/snapshot.ts（validateSnapshot），真库落库在 snapshot.test.ts B 段。

BEGIN;

-- 01 石头 · 好奇 / 看物 / 当下 ── 见什么都新鲜，只说眼前，爱问为什么
INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
SELECT id, 1, personality_tags, interest_categories,
       '["墙角冒了棵没见过的草，叶子背面是紫的。","河道拐弯的地方水比直的地方慢，为什么？","今天的云有三层，最底下那层跑得最快。"]',
       '等一场能看清雪花的雪', '2026-11-22T00:00:00Z'
  FROM dog WHERE id = 'dog_seed_01'
ON CONFLICT(dog_id, version) DO UPDATE SET
  personality_tags    = excluded.personality_tags,
  interest_categories = excluded.interest_categories,
  recent_trips        = excluded.recent_trips,
  waiting_for         = excluded.waiting_for;

-- 02 豆子 · 恋家 / 慢热 / 寡言 ── 三条加起来 28 字，这就是「寡言」的样子
INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
SELECT id, 1, personality_tags, interest_categories,
       '["楼下。猫在。","炖东西的味道，从三楼飘下来。","没走远，就一圈。"]',
       '等楼下那只猫再来一次', '2026-11-22T00:00:00Z'
  FROM dog WHERE id = 'dog_seed_02'
ON CONFLICT(dog_id, version) DO UPDATE SET
  personality_tags    = excluded.personality_tags,
  interest_categories = excluded.interest_categories,
  recent_trips        = excluded.recent_trips,
  waiting_for         = excluded.waiting_for;

-- 04 叮当 · 自来熟 / 话痨 / 直给 ── 每条都有人、有对话、有态度
INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
SELECT id, 1, personality_tags, interest_categories,
       '["碰见修车的大爷，他说这条街以前全是修车的。","卖鱼的阿姨多塞了一块，路上掉了两次。","拉琴的那首，我站着听完了才走。"]',
       '等大爷说的那家馄饨摊开张', '2026-11-22T00:00:00Z'
  FROM dog WHERE id = 'dog_seed_04'
ON CONFLICT(dog_id, version) DO UPDATE SET
  personality_tags    = excluded.personality_tags,
  interest_categories = excluded.interest_categories,
  recent_trips        = excluded.recent_trips,
  waiting_for         = excluded.waiting_for;

-- 05 老周 · 慢热 / 看人 / 怀旧 ── 看的是人，说的是「以前」
INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
SELECT id, 1, personality_tags, interest_categories,
       '["长椅那个总穿灰外套的人，今天换了件新的。","修鞋摊的收音机还在放那出，我小时候也听过。","书店橱窗里有张旧街景照，街角那家铺子还在。"]',
       '等那出评书说完', '2026-11-22T00:00:00Z'
  FROM dog WHERE id = 'dog_seed_05'
ON CONFLICT(dog_id, version) DO UPDATE SET
  personality_tags    = excluded.personality_tags,
  interest_categories = excluded.interest_categories,
  recent_trips        = excluded.recent_trips,
  waiting_for         = excluded.waiting_for;

-- 07 青椒 · 看人 / 婉转 / 当下 ── 话到嘴边留一半（「大概说了」是它的口气），只讲眼前这一下
INSERT INTO snapshot (dog_id, version, personality_tags, interest_categories, recent_trips, waiting_for, created_at)
SELECT id, 1, personality_tags, interest_categories,
       '["楼下阿姨好像有点心事，我没好意思问。","门口有人蹲下系鞋带，系了很久。","有人给了一点点吃的，我说了谢谢——大概说了。"]',
       '等一条围巾的回音', '2026-11-22T00:00:00Z'
  FROM dog WHERE id = 'dog_seed_07'
ON CONFLICT(dog_id, version) DO UPDATE SET
  personality_tags    = excluded.personality_tags,
  interest_categories = excluded.interest_categories,
  recent_trips        = excluded.recent_trips,
  waiting_for         = excluded.waiting_for;

COMMIT;
