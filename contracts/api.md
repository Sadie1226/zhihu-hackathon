# 看山出门 · K 契约 · api.md

> 出 c，11-16。**每个接口的入参出参、谁写谁读、什么时候算到达。**
> 表结构见 `schema.sql`，类型见 `types.ts`，出错返回见 `errors.md`。
>
> **这份文件里没有的东西，就是还没定。别自己加，在群里问 c。**

---

## 零、三条时间语义（11-16 就生效，全队遵守）

这三条不是建议，是实现口径。三条都在 `types.ts` 里做成了函数，**别自己重写一遍**。

| 问题 | 裁定 | 代码 |
| --- | --- | --- |
| **什么算「到达」** | 收件狗**下一次出行开始的那一刻**。三种 kind（发现、礼物、捎话）**同一时刻到达** | `isDeliverable(seq, trips)` |
| **什么算「已读」** | 主人**点开那条内容**才算。进页面不算，滚动过不算 | 写 `exchange.read_at`，只有 e 能写 |
| **什么算「新鲜」** | `live` = 本次请求真打到知乎；`cache` = 24 小时内的真结果；`fixture` = 其余（含全部种子狗） | `find.source_mode` |

**「不是这条请求现拿的，一律不许标 live。」** 这是不变量四，也是最容易被评委当场戳穿的一条。

### `deliver_after_trip_seq` 不是时间戳

这是全表最容易写错的一列，写成 `now > deliver_at` 的话**演示时延后礼物永远不会到**。

```
发送那一刻： deliver_after_trip_seq = 收件狗当前 seq + 1
判断到达：   收件狗存在一次 trip，started_at 不为 null 且 seq >= deliver_after_trip_seq
```

打比方：**不是「明天到」，是「它下次出门就带回来」。** 时间拨盘拨的是出行次数，不碰时钟。

---

## 一、谁写谁读（这张表就是权限表）

**一个事实只有一个写入方。** 别人要改，发请求给写入方，不能自己写这列。

| 事实 | 写入方 | 只读的人 |
| --- | --- | --- |
| 狗的身份、名字、标签初值、装配单 | **a** | 全队 |
| 标签漂移（1.3）、标签集合本身 | **a** | 全队 |
| 心愿创建 / 撤销 | **b** | c、a |
| **屏蔽主题 `blocked_topics`** | **b** | **c 出行过滤、d 交换过滤、e 展示** |
| 聊天原文 | **b** | **没有人** |
| 出行状态、发现、`source_mode` | **c** | b、d、e |
| 归来那一句话 `message` | **b** | e |
| 邀请 `invitation` | **b** | d、e |
| 邻里关系、熟悉度、邻居池、`is_sample` | **d** | e、a |
| 事件池 | **d** | c |
| 交换 / 礼物的业务内容与 `deliver_after_trip_seq` | **d** | e、b |
| **`delivered_at`** | **c（投递器）** | d、e |
| **`replied_at`** + 回应动作 | **b** | d、e |
| **`read_at`** | **e** | — |
| 手账珍藏与笔记 | **e** | — |
| 时间语义 | **c 定义** | 全队遵守 |

### `exchange` 列级拆分（全表唯一要拆到字段的地方）

```
id / from_dog / to_dog / kind / payload / deliver_after_trip_seq / created_at   ← d 写
delivered_at                                                                    ← c 独占
replied_at                                                                      ← b 独占
read_at                                                                         ← e 独占
```

**四件事不许合并。** 有人想「顺手在投递器里把 `replied_at` 也写了」，就是绕过 b，联调时会出现「礼物到了但显示已回应」的错状态。

---

## 二、接口清单

八组接口。**每一组都标了归谁实现、谁调用。** URL 前缀没定（c2 部署时定），这里只定形状。

### 1. 领养（a 实现）

```
POST /api/dogs
入： { name?: string, interestCategories?: InterestCategory[] }
出： { dog: Dog }                     ← personalityTags 和 assembly 由 a 生成
错： 无。名字不填也能建，标签一定生成三个。
```

```
GET /api/dogs/:id
出： { dog: Dog }
错： NOT_FOUND
```

**`blocked_topics` 在这个接口里返回，但 a 不能写它。** 它是 b 的列。

### 2. 心愿（b 实现）

```
POST   /api/dogs/:id/wishes    入：{ text: string, category: InterestCategory }  出：{ wish: Wish }
PATCH  /api/wishes/:id/revoke  入：{}                                            出：{ wish: Wish }   ← 填 revoked_at
GET    /api/dogs/:id/wishes?includeRevoked=false                                 出：{ wishes: Wish[] }
```

**撤销是填 `revoked_at`，不是删除。** 手账还要能翻回去。
**`text` 上限 200 字**，超了返回 `CONFLICT`，前端就地提示。

### 3. 出行（c 实现）

```
POST /api/dogs/:id/trips
入： { trigger: TripTrigger }       出：{ trip: Trip }         ← status=pending, seq 自动 +1
错： RATE_LIMITED（一天已两次）、CONFLICT（上次还没结束）
```

```
POST /api/trips/:id/start    入：{ }   出：{ trip: Trip, delivered: Exchange[] }
```

**这个接口是全系统唯一会写 `delivered_at` 的地方。** 它做两件事，一个事务里：

1. 把 `status` 改成 `running`，写 `started_at`
2. **投递**：找出所有 `to_dog = 这只狗`、`delivered_at IS NULL`、`deliver_after_trip_seq <= 本次 seq` 的 exchange，逐条写 `delivered_at`

```
POST /api/trips/:id/finish   入：{ status: 'done'|'failed'|'timeout' }
                             出：{ trip: Trip, finds: Find[], message: Message|null }
出： 归来的一句话由 b 写，c 在这里调 b 的能力
```

```
GET  /api/dogs/:id/trips?limit=10    出：{ trips: Trip[] }
```

**轮询 700ms，不用 SSE**（D-005）。`GET /api/trips/:id` 返回 `status`，前端据此换四态。

### 4. 发现（c 实现）

```
GET /api/trips/:id/finds    出：{ finds: Find[] }
```

**一次出行 3–5 条。** 至少一条 `kind='zhihu'` 带可点 `sourceUrl`（P0 第 4 条）。
**没搜到返回空数组 `{ finds: [] }`，不是错误。** 界面写「今天没找到合适的」，不催。

### 5. 邀请（b 实现）

```
POST /api/dogs/:id/invitations
入： { basedOnFindId?: string }
出： { invitation: Invitation }   或   { wentAlone: true, tripId: string }
```

**第二种返回值是重点。** 待回应邀请已经 3 条时，第 4 条不再生成邀请，改成「它自己去了」。旧的不删，移进手账。

```
GET /api/dogs/:id/invitations?state=all
出： { invitations: InvitationView[] }
```

**必须读 `v_invitation_state` 视图，不许自己算状态。** 三种状态：

| state | 界面 |
| --- | --- |
| `waiting` | 清楚的回应入口，一屏可达 |
| `replied` | 能看出它记下了（不是「发送成功」四个字） |
| `gone_alone` | **带着这一趟的见闻回来的，像一次正常归来**，不是空状态 |

**没有 `expires_at`，也永远不会返回「已过期」。**

### 6. 回应（b 实现，唯一）

```
POST /api/replies
入： { exchangeId?: string, invitationId?: string, text?: string, photoUrl?: string }
出： { reply: Reply }
错： CONFLICT（空回应 / 两个来源都给了 / 同一条邀请已回过）
```

**恰好一个来源，恰好一种以上内容。** 数据库两个 CHECK 兜住：

- `(exchange_id IS NOT NULL) <> (invitation_id IS NOT NULL)`
- `text IS NOT NULL OR photo_url IS NOT NULL`

**没有 `kind: 'none'`。** 不回应就是没有这条记录。空回应会被数据库拒掉，这是故意的。

**重复点击提交**：`reply(invitation_id)` 上有唯一索引，第二次插不进去，返回 `CONFLICT`，前端当成功处理（幂等）。

### 7. 信箱（c 实现，d 直接调）

```
POST /api/exchanges            入：{ fromDog, toDog, kind, payload }
                               出：{ exchange: Exchange }    ← deliver_after_trip_seq 由 c 算
```

**d 不自己算 `deliver_after_trip_seq`。** d 说「寄给谁、寄什么」，c 查收件狗当前 seq 再加一。这样「第几次出行」的口径只有一个人管。

```
GET  /api/dogs/:id/inbox?filter=onTheWay|arrived|all
出： { exchanges: Exchange[] }        ← 按 delivered_at 分「在路上」和「已到」
PATCH /api/exchanges/:id/read  入：{}  出：{ exchange: Exchange }    ← 只有 e 调
```

**投递器幂等靠这一句**（`delivered_at` 已经是 null 才写）：

```sql
UPDATE exchange SET delivered_at = ?
 WHERE to_dog = ? AND delivered_at IS NULL AND deliver_after_trip_seq <= ?
```

`UPDATE` 的 `WHERE` 里带 `delivered_at IS NULL`，重复执行不会覆盖已有时间戳。**不要用「先查再写」**，两个请求同时进来会各写一次。

### 8. 邻居（d 实现）

```
GET /api/dogs/:id/neighbor    出：{ dog: Dog, snapshot: Snapshot|null }
```

匹配规则照 a 的《给D-邻居池》：排除自己、排除同 session、排除已拉黑（`relation.is_blocked`）、优先没交换过的、标签有交集的桶内**真随机**、一次只遇一只。

**`is_sample = true` 必须原样返回。** e 靠它标「示例伙伴」，四处都要标。

---

## 三、四种 `exchange.payload` 的形状

`kind` 决定 payload 长什么样。**加第五种必须由 c 改 K。**

```jsonc
// find —— 发现交换
{ "kind": "find", "findTitle": "修鞋摊旁边的搪瓷缸",
  "findExcerpt": "缸沿上磕了两个口，茶还是满的。", "sourceUrl": null }

// greeting —— 问候近况
{ "kind": "greeting", "line": "这边下了两天雨，你那边呢", "weather": "雨" }

// gift —— 礼物
{ "kind": "gift", "giftName": "一小卷灰蓝色的毛线", "note": "天气要冷了" }

// co_owner_message —— 捎话（P0 第 9 条）
{ "kind": "co_owner_message", "message": "楼下的桂花开了", "fromOwnerOf": "dog_owner" }
```

### 捎话的四条硬边界

1. **必须经一次投递**，不能即时到达。它走 `deliver_after_trip_seq`，和礼物一样。
2. **种子狗不伪造主人回复。** `to_dog.is_sample = true` 时，界面必须写「这是一位示例伙伴，可能不会回话」。AI 假装对面主人回话 = **阻断缺陷**。
3. **主人原话只许留在 `payload` 里。** 绝对不进 `snapshot`，不进任何狗能读到的地方。
4. **拉黑同时作用于狗和主人**（`relation.is_blocked`）。

---

## 四、`snapshot` 是白名单

| 允许 | 禁止 |
| --- | --- |
| `personality_tags` | 聊天原文 |
| `interest_categories` | 心愿原文（**只许折算成类目**） |
| `recent_trips`（最多 3 条，**只放摘要**） | 照片原图 |
| `waiting_for` | `chat_summary`（摘要也是原文派生的，一样串味） |

**有人想在快照里加一个 `chat_summary`，答复是不行。** 这是不变量五的唯一实现方式：一段经历一个出处。

---

## 五、`blocked_topics` 的优先级

**屏蔽高于一切。** 顺序是：屏蔽 > 心愿 > 朋友牵挂 > 当天抽到的事件。

三处都要过这个过滤器，缺一处就是漏：

- **c**：搜知乎之前，关键词先过
- **d**：交换内容和邻居匹配之前过
- **e**：展示之前过（万一从别处漏进来了）

**被屏蔽的内容不进结果集，不算错误，界面上什么都不显示、也不解释为什么。**

---

## 六、前端四态

每个页面都必须有这四种，**少一种就是没做完**：

| 状态 | 长什么样 |
| --- | --- |
| 空 | 有话说，不催、不感叹号。如「今天没找到合适的」 |
| 加载 | 骨架屏，不转圈 |
| 失败 | 如实说断网，可重试 |
| 降级 | 用的是 cache 或 fixture，**界面上显形** |

**断网时朋友圈和手账必须还能打开**（都是本地数据）。这条按阻断缺陷处理。
