# -*- coding: utf-8 -*-
"""d2c 三十条事件 v0：生成 markdown 表 + INSERT SQL，并按值域自检。

等 c 的 DDL 落库后才能做真库实测；现在只能核值域与长度。
place_tags 只允许我 11-16 提过的四个值（C 已确认值域不动），
'[]' = 任何场景都成立 —— 这个语义见文档第三节。
"""
import json

CATEGORIES = {'自然风景', '城市角落', '手作与食物', '人与故事', '动物与植物', '冷知识'}
PLACES = {'street', 'stall', 'riverside', 'bookstore'}
SEASONS = {'spring', 'summer', 'autumn', 'winter', 'any'}
WEATHERS = {'any', 'clear', 'rain', 'snow'}
TIMES = {'any', 'morning', 'dusk', 'night'}

# (code, text, season, weather, time_of_day, place_tags, match_tags, weight, cooldown)
E = [
    # ── 春 ────────────────────────────────────────────────────────────────
    ('spring_plum_rain', '雨停之前，屋檐下站了三个人，都没说话。',
     'spring', 'rain', 'any', ['street', 'stall'], ['城市角落'], 30, 7),
    ('spring_first_green', '墙根的草冒了一点绿，昨天还没有。',
     'spring', 'clear', 'morning', [], ['自然风景', '动物与植物'], 30, 7),
    ('spring_kite', '天上有个风筝，线看不出牵在哪。',
     'spring', 'clear', 'any', ['riverside'], ['自然风景'], 25, 7),
    ('spring_laundry', '晾衣绳上挂着一排白衬衫，风一吹全朝一个方向。',
     'spring', 'clear', 'any', ['street'], ['城市角落'], 30, 7),
    ('spring_cat_undercar', '一只猫在车底下睡，尾巴尖偶尔动一下。',
     'spring', 'any', 'any', ['street'], ['动物与植物'], 35, 5),
    ('spring_seed_stall', '摊上摆着一排小纸包，写着番茄、黄瓜、向日葵。',
     'spring', 'any', 'any', ['stall'], ['手作与食物', '动物与植物'], 25, 7),
    # ── 夏 ────────────────────────────────────────────────────────────────
    ('summer_icecream', '冰淇淋摊前排着队，甜筒化得比吃得快。',
     'summer', 'clear', 'any', ['stall'], ['手作与食物'], 80, 3),
    ('summer_shower', '雨来得急，有人顶着塑料袋跑过去。',
     'summer', 'rain', 'any', ['street'], ['城市角落'], 40, 5),
    ('summer_cicada', '树上的蝉叫得整条街都听见，忽然一起停了。',
     'summer', 'any', 'dusk', [], ['动物与植物'], 40, 5),
    ('summer_night_stall', '夜市收摊，老板把最后一盆冰粉倒进自己碗里。',
     'summer', 'any', 'night', ['stall'], ['手作与食物', '人与故事'], 35, 7),
    ('summer_bookstore_ac', '书店的冷气从门口漏出来，站一会儿就凉了。',
     'summer', 'clear', 'any', ['bookstore'], ['城市角落'], 30, 7),
    ('summer_river_fish', '河边有人拿网捞小鱼，捞上来又放回去。',
     'summer', 'any', 'any', ['riverside'], ['动物与植物'], 30, 7),
    # ── 秋 ────────────────────────────────────────────────────────────────
    ('autumn_ginkgo', '银杏叶落了一地，扫的人只扫出一条路。',
     'autumn', 'clear', 'any', ['street'], ['自然风景'], 45, 5),
    ('autumn_chestnut', '糖炒栗子的锅在转，纸袋烫手。',
     'autumn', 'any', 'any', ['stall'], ['手作与食物'], 50, 3),
    ('autumn_book_box', '书店门口摆了个纸箱，写着「随便拿，看完放回来」。',
     'autumn', 'any', 'any', ['bookstore'], ['人与故事', '冷知识'], 35, 7),
    ('autumn_river_fog', '河面上的雾还没散，对岸的楼只剩轮廓。',
     'autumn', 'any', 'morning', ['riverside'], ['自然风景'], 30, 7),
    ('autumn_radio', '修鞋摊的收音机在播评书，声音时断时续。',
     'autumn', 'any', 'any', ['stall', 'street'], ['人与故事'], 30, 7),
    ('autumn_birds', '天上有一队鸟往南飞，队形一直没散。',
     'autumn', 'clear', 'dusk', [], ['动物与植物', '自然风景'], 25, 7),
    # ── 冬 ────────────────────────────────────────────────────────────────
    ('winter_first_snow', '雪落在袖子上，能看清每一片的形状，然后化掉。',
     'winter', 'snow', 'any', ['street'], ['自然风景'], 60, 3),
    ('winter_one_glove', '长椅扶手上有人落了一只手套，另一只不知在哪。',
     'winter', 'any', 'any', ['street'], ['人与故事'], 30, 7),
    ('winter_sweet_potato', '烤红薯的桶边围了三个人，都在烤手。',
     'winter', 'any', 'night', ['stall'], ['手作与食物'], 45, 5),
    ('winter_window_steam', '小饭馆的玻璃全是雾，有人用手指画了个笑脸。',
     'winter', 'any', 'night', ['street'], ['城市角落'], 30, 7),
    ('winter_bookstore_chair', '书店最里面的角落有张椅子，椅背上搭着一件外套。',
     'winter', 'any', 'any', ['bookstore'], ['人与故事'], 25, 7),
    ('winter_river_ice', '河边结了薄冰，水在冰下面还在走。',
     'winter', 'clear', 'any', ['riverside'], ['自然风景'], 25, 7),
    # ── 不限季节 ───────────────────────────────────────────────────────────
    ('any_street_music', '有人在路口拉琴，琴盒开着，里面有几枚硬币。',
     'any', 'clear', 'dusk', ['street'], ['人与故事'], 30, 7),
    ('any_shop_cat', '店门口的猫认得每个进门的人，只对熟的抬头。',
     'any', 'any', 'any', ['bookstore', 'stall'], ['动物与植物'], 30, 7),
    ('any_slow_walker', '前面有个老人走得慢，后面的人都没超过去。',
     'any', 'any', 'any', ['street'], ['人与故事'], 30, 7),
    ('any_lost_dog_poster', '电线杆上贴着找狗启事，照片里的狗在笑。',
     'any', 'any', 'any', ['street'], ['动物与植物', '人与故事'], 25, 7),
    ('any_market_scale', '菜场门口有个自助的秤，秤上留着上一个人的重量。',
     'any', 'any', 'any', ['stall'], ['冷知识', '城市角落'], 20, 14),
    ('any_moon_ring', '月亮边上有圈淡淡的光，据说第二天要起风。',
     'any', 'clear', 'night', [], ['冷知识', '自然风景'], 20, 14),
]


def check() -> list[str]:
    bad = []
    if len(E) != 30:
        bad.append(f'条数 {len(E)} != 30')
    codes = [e[0] for e in E]
    if len(set(codes)) != len(codes):
        bad.append('code 有重复')
    for code, text, s, w, t, places, tags, weight, cd in E:
        n = len(text.replace(' ', ''))
        if not (1 <= n <= 40):
            bad.append(f'{code}: text {n} 字，超出 1–40')
        if s not in SEASONS:
            bad.append(f'{code}: season {s} 非法')
        if w not in WEATHERS:
            bad.append(f'{code}: weather {w} 非法')
        if t not in TIMES:
            bad.append(f'{code}: time_of_day {t} 非法')
        if set(places) - PLACES:
            bad.append(f'{code}: place_tags 越界 {set(places) - PLACES}')
        if set(tags) - CATEGORIES:
            bad.append(f'{code}: match_tags 越界 {set(tags) - CATEGORIES}')
        if weight <= 0:
            bad.append(f'{code}: weight {weight} 必须 > 0')
        if cd < 0:
            bad.append(f'{code}: cooldown {cd} 必须 >= 0')
    return bad


def stats() -> list[str]:
    out = []
    for key, idx, label in (('季节', 2, None), ('天气', 3, None), ('时段', 4, None)):
        c = {}
        for e in E:
            c[e[idx]] = c.get(e[idx], 0) + 1
        out.append(f'{key}：' + ' '.join(f'{k}={v}' for k, v in sorted(c.items())))
    tc = {}
    for e in E:
        tc[len(e[6])] = tc.get(len(e[6]), 0) + 1
    out.append('match_tags 个数分布：' + ' '.join(f'{k}个={v}条' for k, v in sorted(tc.items())))
    pc = {}
    for e in E:
        for p in e[5]:
            pc[p] = pc.get(p, 0) + 1
    out.append('place_tags 使用：' + ' '.join(f'{k}={v}' for k, v in sorted(pc.items())))
    out.append(f'无 place 限制（[] = 任何场景）：{sum(1 for e in E if not e[5])} 条')
    return out


def esc(s: str) -> str:
    return s.replace("'", "''")


def to_sql() -> str:
    lines = [
        '-- d2c · 三十条事件 v0（11-17）',
        '-- 写入方 d。asset_refs 一律 {} 占位，等 e2c（11-22）素材清单。',
        '-- 幂等：ON CONFLICT(code) DO UPDATE（只更新 d 写的列）。',
        '-- ⚠ place_tags = \'[]\' 的语义是「任何场景都成立」，不是「还没填」。',
        '',
    ]
    for code, text, s, w, t, places, tags, weight, cd in E:
        lines.append(
            'INSERT INTO event (id, code, text, season, weather, time_of_day, '
            'place_tags, match_tags, weight, cooldown_days, asset_refs, enabled, created_at)\n'
            f"VALUES ('ev_{code}', '{code}', '{esc(text)}', '{s}', '{w}', '{t}', "
            f"'{json.dumps(places, ensure_ascii=False)}', '{json.dumps(tags, ensure_ascii=False)}', "
            f"{weight}, {cd}, '{{}}', 1, '2026-11-17T00:00:00Z')\n"
            'ON CONFLICT(code) DO UPDATE SET\n'
            '  text = excluded.text, season = excluded.season, weather = excluded.weather,\n'
            '  time_of_day = excluded.time_of_day, place_tags = excluded.place_tags,\n'
            '  match_tags = excluded.match_tags, weight = excluded.weight,\n'
            '  cooldown_days = excluded.cooldown_days;'
        )
    return '\n\n'.join(lines) + '\n'


def to_md() -> str:
    head = [
        '| # | code | 一句话 | 季节 | 天气 | 时段 | place | match | 权重 | 冷却 |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ]
    for i, (code, text, s, w, t, places, tags, weight, cd) in enumerate(E, 1):
        p = '/'.join(places) if places else '—（不限）'
        m = '/'.join(tags) if tags else '—'
        head.append(f'| {i} | `{code}` | {text} | {s} | {w} | {t} | {p} | {m} | {weight} | {cd}d |')
    return '\n'.join(head)


if __name__ == '__main__':
    bad = check()
    print('=== 自检 ===')
    print('\n'.join(bad) if bad else '全部通过（30 条、值域、字数、权重、冷却）')
    print('\n=== 分布 ===')
    print('\n'.join(stats()))
    open('d2c-30事件.sql', 'w', encoding='utf-8').write(to_sql())
    open('d2c-30事件.table.md', 'w', encoding='utf-8').write(to_md() + '\n')
    print('\n已写 d2c-30事件.sql 与 d2c-30事件.table.md')
