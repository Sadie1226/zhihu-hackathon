# 给 C · 契约输入（11-16）

> **这份文件怎么用：** 整份贴给你写代码的 AI，前面加一句：
> 「按下面这份契约输入，产出 `contracts/` 五个文件：`schema.sql`、`types.ts`、`fixtures/*.json`、`api.md`、`errors.md`。不要自己加表、不要自己加字段，这份文件没写的字段先不要建。」
>
> 出完以后，`docs/` 里这份就可以不再看了 —— 以 `contracts/` 为准。

---

## 一、五份文件各装什么

| 文件 | 装什么 | 这份文件里对应哪一节 |
| --- | --- | --- |
| `schema.sql` | 建表语句 + 每列的写入方注释 | 第二节（表与字段）、第三节（exchange 列级拆分） |
| `types.ts` | 所有实体类型 + 枚举 | 第四节（TS 枚举）、第二节（字段类型） |
| `fixtures/*.json` | 每类实体一份假数据 | 第二节的举例列直接当样例 |
| `api.md` | 每个接口的入参出参 + 谁写谁读 + 错误语义 | 第五节（边界表）、第七节（时间语义） |
| `errors.md` | 出错时返回什么、界面显示什么 | 第六节（四个禁区 + 错误分类） |

八类实体：`dog` `snapshot` `wish` `trip` `find` `exchange` `message` `reply`。

---

## 二、表与字段（每列都标了写入方）

**规则：一个事实只有一个写入方。别人要改，发请求给写入方，不能自己写这列。**

### `dog` — 一只狗（写入方：a）

| 字段 | 类型 | 举例 | 说明 |
| --- | --- | --- | --- |
| `id` | string | `dog_7f3a` | 主键 |
| `name` | string(1–6) | `豆子` | 可为空，空则用标签生成的候选名 |
| `session_id` | string | `s_91c2` | 匿名 session，不做登录 |
| `personality_tags` | string[3] | `['好奇','看人','婉转']` | 必须来自 3 个不同维度，见第四节 |
| `interest_categories` | string[2–3] | `['自然风景','人与故事']` | 可为空，空＝全都要 |
| `assembly` | json | 见下 | 装配单，渲染用 |
| `is_sample` | boolean | `false` | 种子狗为 `true`，写入方是 d |
| `blocked_topics` | string[] | `['宠物离世']` | **写入方是 b，不是 a**。全局最高优先级过滤器 |
| `created_at` | timestamp | — | |

`assembly` 的形状固定六个键，**多一个都不许加**：

```json
{ "base": "tpl-a", "skin": { "color": "red", "pattern": "spot" },
  "cloth": "hoodie", "hat": "beanie", "glasses": null, "face": "hopeful" }
```

### `snapshot` — 状态快照（写入方：d）

**这张表存在的唯一目的是给别的狗读。所以它只能是白名单，不是黑名单。**

| 字段 | 类型 | 允许出现在这里 |
| --- | --- | --- |
| `dog_id` | string | — |
| `personality_tags` | string[3] | ✅ |
| `interest_categories` | string[2–3] | ✅ |
| `recent_trips` | json[3] | ✅ 只放「摘要」，不放原文 |
| `waiting_for` | string | ✅ 当前在等什么（如「等一条围巾的回音」） |
| `version` | int | — |
| ~~聊天原文~~ | — | ❌ **一个字都不许** |
| ~~主人的心愿原文~~ | — | ❌ 只允许折算成类目 |

### `wish` — 心愿（写入方：b）

`id` / `dog_id` / `text` / `category`（六类目之一）/ `created_at` / `revoked_at`

### `trip` — 一次出行（写入方：c）

`id` / `dog_id` / `status`（`pending` `running` `done` `failed` `timeout`）/ `started_at` / `ended_at` / `trigger`（`auto` `wish` `friend`）

### `find` — 一条发现（写入方：c）

`id` / `trip_id` / `kind`（`scene` `zhihu` `moment`）/ `title` / `excerpt` / `source_url` / `source_mode`（`live` `cache` `fixture`）/ `authority_level` / `vote_up_count`

### `exchange` — 信箱（**列级拆分，见第三节**）

### `message` — 归来的一句话（写入方：b）

`id` / `trip_id` / `text` / `mentions_find_id` / `created_at`

> **`message` 必须和 `trip` 分表。** 归来的一句话是 b 写的，trip 的原始记录是 c 写的。合表就会变成两个写入方。

### `reply` — 一次回应（写入方：b，**唯一实现**）

`id` / `exchange_id` / `kind`（`text` `photo` `none`）/ `content` / `created_at`

---

## 三、`exchange` 必须列级拆开 —— 全表唯一要拆到字段的地方

不拆，c 和 d 一定会在同一行上互相覆盖。

```
exchange
  id / from_dog / to_dog / kind / payload / created_at    ← d 写
  deliver_at                                              ← d 按规则算出来写
  delivered_at                                            ← c 的投递器独占（幂等，写一次不再写）
  replied_at                                              ← b 的回应能力独占
  read_at                                                 ← e 独占
```

| 谁 | 决定什么 | 一句话 |
| --- | --- | --- |
| **d** | 寄什么、什么时候该到 | 业务内容与 `deliver_at` |
| **c** | 这一刻是否已经到 | 只有投递器能写 `delivered_at`，且写一次就不再写 |
| **b** | 算不算被回应 | 只有 b 的回应能力能写 `replied_at` |
| **e** | 算不算被看过 | 只有 e 能写 `read_at` |

**四件事不许合并。** 如果有人想「顺手在投递器里把 replied_at 也写了」，那就是绕过 b，联调时会出现「礼物到了但显示已回应」的错状态。

`kind` 只允许四个值：`find`（发现交换）/ `greeting`（问候近况）/ `gift`（礼物）/ `co_owner_message`（捎话）。
**加第五种必须由 c 改 K，不许谁自己塞一个字符串。**

---

## 四、`types.ts` 里必须出现的枚举（直接抄）

```ts
// 12 个性格标签 —— 6 个维度，每维度两极互斥
export const PERSONALITY_TAGS = [
  '好奇', '恋家',      // 维度1 探索范围
  '自来熟', '慢热',    // 维度2 对陌生人
  '话痨', '寡言',      // 维度3 说话密度
  '看物', '看人',      // 维度4 关注对象
  '直给', '婉转',      // 维度5 表达方式
  '当下', '怀旧',      // 维度6 时间感
] as const
export type PersonalityTag = typeof PERSONALITY_TAGS[number]

// 互斥对：同一只狗不能同时拥有同一对里的两个
export const EXCLUSIVE_PAIRS: [PersonalityTag, PersonalityTag][] = [
  ['好奇', '恋家'], ['自来熟', '慢热'], ['话痨', '寡言'],
  ['看物', '看人'], ['直给', '婉转'], ['当下', '怀旧'],
]

// 六个初始关注类目 —— 同时是 c 的搜索关键词入口
export const INTEREST_CATEGORIES = [
  '自然风景', '城市角落', '手作与食物',
  '人与故事', '动物与植物', '冷知识',
] as const
export type InterestCategory = typeof INTEREST_CATEGORIES[number]

// 每类的首轮搜索关键词，c 直接拿去做 zhihu_search 的 Query
export const CATEGORY_KEYWORDS: Record<InterestCategory, string[]> = {
  '自然风景':   ['下雪的地方', '秋天的树', '海边日落'],
  '城市角落':   ['老城区', '街边小店', '深夜便利店'],
  '手作与食物': ['家常菜', '手作', '烘焙'],
  '人与故事':   ['普通人', '一个人生活', '老手艺'],
  '动物与植物': ['猫', '多肉', '流浪动物'],
  '冷知识':     ['为什么', '冷知识', '科普'],
}

export type SourceMode = 'live' | 'cache' | 'fixture'
export type ExchangeKind = 'find' | 'greeting' | 'gift' | 'co_owner_message'
export type TripStatus = 'pending' | 'running' | 'done' | 'failed' | 'timeout'
```

**`PERSONALITY_TAGS` 是唯一权威来源。** 别处不许再写一遍中文标签，全部引用这个常量。

---

## 五、`api.md` 要写清的边界（照这张表）

| 事实 | 写入方 | 只读的人 |
| --- | --- | --- |
| 狗的身份、名字、标签初值、装配单 | **a** | 全队 |
| 标签漂移（1.3）、标签集合本身 | **a** | 全队 |
| 心愿创建/撤销 | **b** | c、a |
| 屏蔽主题 | **b** | **c 出行过滤、d 交换过滤、e 展示** |
| 聊天原文 | **b** | **没有人** |
| 出行状态、发现、`source_mode` | **c** | b、d、e |
| 归来那一句话 | **b** | e |
| 邻里关系、熟悉度、邻居池、`is_sample` | **d** | e、a |
| 事件池 | **d** | c |
| 交换/礼物的业务内容与 `deliver_at` | **d** | e、b |
| `delivered_at` | **c**（投递器） | d、e |
| `replied_at` + 回应动作 | **b** | d、e |
| `read_at` | **e** | — |
| 手账珍藏与笔记 | **e** | — |
| 时间语义 | **c 定义** | 全队遵守 |

---

## 六、`errors.md` 要覆盖的四个禁区

**禁区一：主人的聊天原文一个字都不进 `snapshot`。**
`snapshot` 是白名单字段表，不是黑名单。有人想在快照里加个 `chat_summary`，答复是不行 —— 摘要也是原文派生的，一样会串味。

**禁区二：屏蔽在任何地方优先于心愿。**
`blocked_topics` 的过滤优先级高于心愿、高于朋友牵挂、高于当天抽到的事件。c 的搜索键、d 的交换内容、e 的展示，三处都要过这个过滤器。

**禁区三：谁都不许自己新建表、自己加字段。**
只有 c 改 K，只加不删，旧字段留到 11-29 之后再清。

**禁区四：关系类事实只有 d 写。**
e 的朋友圈、b 的「它记得你回应过」，全部只读 d 写下的那一份。

### 错误分类（`errors.md` 要分清的，别混成一个 500）

| 情况 | 返回什么 | 界面该显示什么 |
| --- | --- | --- |
| 没搜到 | 空数组，不是错误 | 「今天没找到合适的」，不催 |
| 网络断 | `NETWORK` | 如实说断网，四态里的「失败」 |
| 知乎限流 `30001` | `RATE_LIMITED` | **降级到 cache 并标 `cache`，不重试** |
| 鉴权失败 `20001` | `AUTH` | 服务端告警，用户侧静默降级 |
| 内容不合规 | `BLOCKED` | 不显示，也不解释为什么 |
| 被屏蔽主题 | 不进结果集，不算错误 | 什么都不显示 |

---

## 七、时间语义三行表（11-16 必须进 K）

| 问题 | 裁定 | 为什么 |
| --- | --- | --- |
| **什么算「到达」** | 在**收件狗**下一次出行**开始的那一刻**写 `delivered_at`。三种 kind 同一时刻：发现交换、礼物、捎话都在这一刻到达 | 一句话能数清、能演示（拨一次表就到），不依赖真实时钟 |
| **什么算「已读」** | 主人**点开那条内容**才算。进页面不算，滚动过不算 | 不变量三。进页面就算已读等于逼人看 |
| **什么算「新鲜」** | `live` = 本次请求真打到知乎；`cache` = 24 小时内的真结果；`fixture` = 其余（含全部种子狗）。**不是这条请求现拿的，一律不许标 `live`** | 不变量四，这条最容易被评委当场戳穿 |

## 八、三条提前拍的口径（免得你写投递器时自己猜）

| 口径 | 裁定 | 你要改什么 |
| --- | --- | --- |
| **邀请永不过期** | 未回应就一直留着，界面绝不出现「已过期」。同时待回应最多 3 条：第 4 条不再生成邀请，改「它自己去了」；旧的不删，移进手账 | 你的投递器不负责邀请过期判断 —— 根本不存在这个逻辑 |
| **一天出行两次**（早晚各一，间隔 ≥6 小时） | 演示用时间拨盘加速，不靠真实时钟 | 定时任务的判断条件 |
| **礼物/捎话「跨一次出行」= 收件狗的下一次出行** | 不是 24 小时，不是发送方的出行 | `deliver_at` 的含义：它不是一个时间戳，是「等收件狗下次出门」 |

> ⚠️ 最后这条对你影响最大：`deliver_at` 虽然叫 time，**语义是「收件狗的下一次 trip 开始时」**。你可以存一个时间戳，但判断到达必须用「收件狗有没有开始新的 trip」，不是 `now > deliver_at`。这一条写错，演示时延后礼物永远不会到。
