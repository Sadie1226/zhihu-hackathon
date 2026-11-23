-- d2c · 事件条件修正 v1（11-23 傍晚）
--
-- 只做一件事：把两条「名义不限地点、文本却自带场景」的事件条件改准。
--
-- 为什么现在改：C 11/23 口径是「无合适事件就不展示事件，旅途继续」。
-- 那么 place_tags='[]' 就必须真的代表「任何场景都成立」，不能拿来兜底。
-- 原文案：
--   spring_first_green「墙根的草冒了一点绿」—— 要有墙，沙丘/白桦林/湖心没有
--   summer_cicada「树上的蝉叫得整条街都听见」—— 要有街，同上
-- 改完之后 place_tags='[]' 只剩 2 条真不限：autumn_birds、any_moon_ring。
--
-- 为什么收紧条件而不是改文案：「墙根」「整条街」是这批文本里少数有画面的细节，
-- 为了迁就条件去把它改成「路边」「树上的蝉」，是拿质量换整齐。条件该说实话。
--
-- 幂等：都带 `AND place_tags = '[]'` 前置。第二次执行影响 0 行；
-- 日后若有人已经改过这两条的 place_tags，这条补丁不会覆盖他。
--
-- 依赖：先导入 team/2026-11-18/d/1118-d2c-事件池三十条-v1.sql（30 条 UPSERT），
-- 再执行本文件。顺序反了会更新 0 行 —— 不是错，是没东西可改。

-- 墙根：街面的墙脚、店铺门口的墙脚都成立；两张图里都有墙，沙丘和树林没有。
UPDATE event SET place_tags = '["street", "stall"]'
 WHERE code = 'spring_first_green' AND place_tags = '[]';

-- 整条街：必须落在街面上。公园园路勉强算，湖岸、沙丘、林地都不算。
UPDATE event SET place_tags = '["street"]'
 WHERE code = 'summer_cicada' AND place_tags = '[]';

-- 自查（SQLite CLI 里可单独跑）：
--   SELECT code, place_tags FROM event WHERE place_tags = '[]' ORDER BY code;
-- 期望恰好两行：any_moon_ring、autumn_birds。
