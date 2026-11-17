-- d2c · 三十条事件 v0（11-17）

-- 写入方 d。asset_refs 一律 {} 占位，等 e2c（11-22）素材清单。

-- 幂等：ON CONFLICT(code) DO UPDATE（只更新 d 写的列）。

-- ⚠ place_tags = '[]' 的语义是「任何场景都成立」，不是「还没填」。



INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_spring_plum_rain', 'spring_plum_rain', '雨停之前，屋檐下站了三个人，都没说话。', 'spring', 'rain', 'any', '["street", "stall"]', '["城市角落"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_spring_first_green', 'spring_first_green', '墙根的草冒了一点绿，昨天还没有。', 'spring', 'clear', 'morning', '[]', '["自然风景", "动物与植物"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_spring_kite', 'spring_kite', '天上有个风筝，线看不出牵在哪。', 'spring', 'clear', 'any', '["riverside"]', '["自然风景"]', 25, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_spring_laundry', 'spring_laundry', '晾衣绳上挂着一排白衬衫，风一吹全朝一个方向。', 'spring', 'clear', 'any', '["street"]', '["城市角落"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_spring_cat_undercar', 'spring_cat_undercar', '一只猫在车底下睡，尾巴尖偶尔动一下。', 'spring', 'any', 'any', '["street"]', '["动物与植物"]', 35, 5, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_spring_seed_stall', 'spring_seed_stall', '摊上摆着一排小纸包，写着番茄、黄瓜、向日葵。', 'spring', 'any', 'any', '["stall"]', '["手作与食物", "动物与植物"]', 25, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_summer_icecream', 'summer_icecream', '冰淇淋摊前排着队，甜筒化得比吃得快。', 'summer', 'clear', 'any', '["stall"]', '["手作与食物"]', 80, 3, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_summer_shower', 'summer_shower', '雨来得急，有人顶着塑料袋跑过去。', 'summer', 'rain', 'any', '["street"]', '["城市角落"]', 40, 5, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_summer_cicada', 'summer_cicada', '树上的蝉叫得整条街都听见，忽然一起停了。', 'summer', 'any', 'dusk', '[]', '["动物与植物"]', 40, 5, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_summer_night_stall', 'summer_night_stall', '夜市收摊，老板把最后一盆冰粉倒进自己碗里。', 'summer', 'any', 'night', '["stall"]', '["手作与食物", "人与故事"]', 35, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_summer_bookstore_ac', 'summer_bookstore_ac', '书店的冷气从门口漏出来，站一会儿就凉了。', 'summer', 'clear', 'any', '["bookstore"]', '["城市角落"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_summer_river_fish', 'summer_river_fish', '河边有人拿网捞小鱼，捞上来又放回去。', 'summer', 'any', 'any', '["riverside"]', '["动物与植物"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_autumn_ginkgo', 'autumn_ginkgo', '银杏叶落了一地，扫的人只扫出一条路。', 'autumn', 'clear', 'any', '["street"]', '["自然风景"]', 45, 5, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_autumn_chestnut', 'autumn_chestnut', '糖炒栗子的锅在转，纸袋烫手。', 'autumn', 'any', 'any', '["stall"]', '["手作与食物"]', 50, 3, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_autumn_book_box', 'autumn_book_box', '书店门口摆了个纸箱，写着「随便拿，看完放回来」。', 'autumn', 'any', 'any', '["bookstore"]', '["人与故事", "冷知识"]', 35, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_autumn_river_fog', 'autumn_river_fog', '河面上的雾还没散，对岸的楼只剩轮廓。', 'autumn', 'any', 'morning', '["riverside"]', '["自然风景"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_autumn_radio', 'autumn_radio', '修鞋摊的收音机在播评书，声音时断时续。', 'autumn', 'any', 'any', '["stall", "street"]', '["人与故事"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_autumn_birds', 'autumn_birds', '天上有一队鸟往南飞，队形一直没散。', 'autumn', 'clear', 'dusk', '[]', '["动物与植物", "自然风景"]', 25, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_winter_first_snow', 'winter_first_snow', '雪落在袖子上，能看清每一片的形状，然后化掉。', 'winter', 'snow', 'any', '["street"]', '["自然风景"]', 60, 3, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_winter_one_glove', 'winter_one_glove', '长椅扶手上有人落了一只手套，另一只不知在哪。', 'winter', 'any', 'any', '["street"]', '["人与故事"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_winter_sweet_potato', 'winter_sweet_potato', '烤红薯的桶边围了三个人，都在烤手。', 'winter', 'any', 'night', '["stall"]', '["手作与食物"]', 45, 5, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_winter_window_steam', 'winter_window_steam', '小饭馆的玻璃全是雾，有人用手指画了个笑脸。', 'winter', 'any', 'night', '["street"]', '["城市角落"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_winter_bookstore_chair', 'winter_bookstore_chair', '书店最里面的角落有张椅子，椅背上搭着一件外套。', 'winter', 'any', 'any', '["bookstore"]', '["人与故事"]', 25, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_winter_river_ice', 'winter_river_ice', '河边结了薄冰，水在冰下面还在走。', 'winter', 'clear', 'any', '["riverside"]', '["自然风景"]', 25, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_any_street_music', 'any_street_music', '有人在路口拉琴，琴盒开着，里面有几枚硬币。', 'any', 'clear', 'dusk', '["street"]', '["人与故事"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_any_shop_cat', 'any_shop_cat', '店门口的猫认得每个进门的人，只对熟的抬头。', 'any', 'any', 'any', '["bookstore", "stall"]', '["动物与植物"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_any_slow_walker', 'any_slow_walker', '前面有个老人走得慢，后面的人都没超过去。', 'any', 'any', 'any', '["street"]', '["人与故事"]', 30, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_any_lost_dog_poster', 'any_lost_dog_poster', '电线杆上贴着找狗启事，照片里的狗在笑。', 'any', 'any', 'any', '["street"]', '["动物与植物", "人与故事"]', 25, 7, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_any_market_scale', 'any_market_scale', '菜场门口有个自助的秤，秤上留着上一个人的重量。', 'any', 'any', 'any', '["stall"]', '["冷知识", "城市角落"]', 20, 14, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;

INSERT INTO event (id, code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)
VALUES ('ev_any_moon_ring', 'any_moon_ring', '月亮边上有圈淡淡的光，据说第二天要起风。', 'any', 'clear', 'night', '[]', '["冷知识", "自然风景"]', 20, 14, '{}', 1, '2026-11-17T00:00:00Z')
ON CONFLICT(code) DO UPDATE SET
  text = excluded.text, season = excluded.season, weather = excluded.weather,
  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,
  match_tags = excluded.match_tags, weight = excluded.weight,
  cooldown_days = excluded.cooldown_days;
