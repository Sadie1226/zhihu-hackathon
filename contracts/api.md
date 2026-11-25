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

打比方：**不是「明天到」，是「它下次出门就带回来」。** 投递仍只看出行序号。11-17 A 裁定：演示时钟可向前推进，用于后续新出行的时间戳，不改写历史时间；C11 实现拨盘，C4 不开放客户端时间参数。

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
| 出行遇到事件的历史 `trip_event` | **c** | d |
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

十组接口。**每一组都标了归谁实现、谁调用。** URL 前缀没定（c2 部署时定），这里只定形状。

c3 v2 只补读取契约、查询参考、类型和索引，不表示 HTTP 路由已部署。原有路由保持不变。

### 1. 领养（a 实现）

#### v5 内部身份与会话

- 受保护接口从 HttpOnly Cookie 经 `resolveAuthContext(request, db)` 解析。认证要求随机凭据的哈希已登记、未撤销、未过期，并匹配当前数据库的身份命名空间。服务端以稳定 owner 归属狗和 Trip。
- 一个已验证的知乎 UID 对应一个 owner，可持有多个独立会话，并恢复唯一领养狗。现阶段只提供服务端映射和会话签发，真实 OAuth 的凭据、回调和身份验证待接。
- `GET /api/session` 返回公开会话视图。`POST /api/auth/logout` 撤销当前会话并清 Cookie，成功返回 `{ "ok": true }`。过期、撤销或未知 Cookie 无法访问私有记录。开发模式需要非生产环境、显式开关及独立数据库。
- 创建收据按 owner 与 requestId 隔离。相同收据和相同内容返回原狗，同收据改内容或已领养后用新收据创建返回 `CONFLICT`。owner、提供方标识、会话哈希与原始 token 都是内部信息。
- v4 升级保留历史 `dog.session_id`，旧匿名 Cookie 不提供新的狗归属。新绑定的狗通过 `dog.owner_id` 关联，种子狗与尚未绑定的历史记录保持无 owner。

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

#### Wish Contract v3（2026-11-18）

字段增加：`Wish.source: 'owner'|'collection'`、`Wish.sourceUrl: string|null`；
SQL 对应 `source`、`source_url`。旧记录迁移为 `owner / NULL`。
owner 的 text 是主人原话；collection 的 text 是 B 从已授权收藏材料提取的主题，仍使用六个兴趣类目。
不引入地点表、地理路线或新 TripTrigger。E 根据持久化 source 显示来源，不根据当前触发方式猜来源。

**写入边界仍属于 B。** 本次提供 `lib/wishes/contract.ts` 共用校验、撤销存储和读取边界，
不新增 HTTP 路由，不实现 OAuth、收藏拉取或自动提取。公共 POST 的 body 仍只有 text/category；
B 可用 `ownerWishFields(body)`，多余键一律 CONFLICT，包括 source、sourceUrl、source_url、session_id。
该函数强制返回 owner/null。收藏导入由服务端在验证 OAuth 授权、收藏归属及 A 的资格规则后，
在 `BEGIN IMMEDIATE` 插入事务内调用 `collectionWishFields(db, dogId, sessionId, verifiedSourceUrl)`，
再由 B 写入其产生的来源字段。不得将客户端表单或模型输出的来源字段直接绑定 SQL。
sessionId 只取 `lib/auth/session.ts` 的可信服务端上下文；归属不符/不存在返回 NOT_FOUND。
URL 校验只能证明地址形状受信任，不证明内容存在、用户收藏了它或 OAuth 已授权。

**有效读取和撤销：** `includeRevoked=false`（默认）、后续出行选心愿必须读 `v_wish_active`，
并通过 dog.session_id 限定当前会话。`includeRevoked=true` 的私有历史读取基础表 wish。
不存在或不属于当前会话返回 NOT_FOUND；合法空集合 `{ wishes: [] }`。
撤销先在同一写事务中核对归属，再执行下面的条件更新；重复撤销成功返回原 Wish，保留第一次时间：

```sql
UPDATE wish SET revoked_at = :at WHERE id = :wishId AND revoked_at IS NULL;
```

共用 `revokeWish(db, wishId, sessionId, serverUtcTime)` 已包含事务、归属和首次写入守卫，
B 调用时不要再包嵌套事务。数据库同时禁止覆盖已有 revoked_at、恢复为 NULL 或物理 DELETE。
撤销不触发自动补位，不清除历史 trip 关联；不冻结 text 编辑，本轮只固定来源身份和关联。

**收藏去重：** `uniq_wish_active_collection(dog_id)` 只覆盖 source=collection 且 revoked_at IS NULL，
同一只狗最多一条有效收藏心愿。`uniq_wish_collection_content(dog_id,source_url)` 覆盖所有收藏记录，
不排除已撤销项。同一规范 URL 撤销后仍不能再次插入；不同狗独立去重。
竞争插入由 SQLite 唯一索引裁定，失败返回 CONFLICT；不能用 INSERT OR REPLACE 绕过历史保留。
id、dog_id、source、source_url 创建后不可改写。B 必须使用列清单 INSERT，不能把旧记录重建成另一来源。

**URL 白名单与规范化：** 使用 `canonicalZhihuContentUrl`，只接受以下 HTTPS 内容路径：

| 输入主机 / 路径 | 规范形式 |
| --- | --- |
| zhihu.com 或 www.zhihu.com，/question/Q | https://www.zhihu.com/question/Q |
| zhihu.com 或 www.zhihu.com，/question/Q/answer/A | https://www.zhihu.com/question/Q/answer/A |
| zhuanlan.zhihu.com，/p/P | https://zhuanlan.zhihu.com/p/P |

Q/A/P 必须为无前导零的正十进制字符串，不转换成 JavaScript number（避免大 ID 精度损失）。
协议和主机大小写归一，保留路径大小写约束；移除一个末尾 `/`，移除全部 query 与 fragment，
这些受支持路径的内容 ID 全在路径中。不同回答的 answer ID、不同文章的 p ID 完整保留；回答不能截成问题 URL。
拒绝 HTTP、相对 URL、凭据、显式端口（含 :443）、尾点主机、伪装/任意子域、短链/跳转链接、
个人页/收藏夹列表、`/answer/A` 等未纳入白名单路径、编码路径或主机、点路径、反斜杠、空白及控制字符。
不跟随重定向，不为未知链接猜测内容 ID。SQLite INSERT/UPDATE 触发器再次校验规范形式。

fixture 响应示例（仅形状，不是 live 收藏）：

```json
{
  "wish": {
    "id": "wish_collection_fixture", "dogId": "dog_seed_07",
    "text": "收藏主题测试样例", "category": "冷知识",
    "createdAt": "2026-11-16T00:25:00Z", "revokedAt": null,
    "source": "collection", "sourceUrl": "https://www.zhihu.com/question/123/answer/456"
  }
}
```

**C 的选择与历史边界：** `selectActiveWish(db, dogId, sessionId)` 仅从有效视图读取，
owner 优先 collection；同来源按 created_at 的实际时间倒序、id 升序稳定取一条。无候选返回 null。
这只是心愿候选选择，不替代已有 `blocked_topics` 最高优先级过滤，也不触发收藏抽取。
当前 `trigger='wish'` 的 start 在原 `BEGIN IMMEDIATE` 内重新选择并写 `trip.wish_id`，
不在 pending 创建时锁定候选；选择、running/started_at、信箱投递一起提交/回滚。
撤销若先提交，该心愿不会被这次出发选中；出发若先提交，之后撤销只影响未来出行。
没有有效候选时 wishId=null，保留原有 C4 状态行为；auto/friend 路径不在本次增加选题或调度逻辑。
未来自动选到心愿的执行器复用既有 wish trigger，不新增 collection trigger；来源看 Wish.source。

`Trip.wishId: string|null` 是唯一历史关联字段，旧行保持 null，不反推/补写历史关联。
外键和同狗触发器保护归属；出发后关联不可修改。重复 start/finish 只返回既有关联。
`readTripWish(db, tripId, sessionId)` 从基础表按历史关联读取（允许已撤销），不得拿当前有效心愿替换历史。
这里的 Wish 是私有信息，不能放进公开 Snapshot，也不在查询中展开 sessionId。

迁移版本 **3**：v1 → v2 → v3，v2 → v3；保留已部署的 002-events.ts。
新增列、视图、索引、触发器和 user_version 在一个事务内完成，失败完整回滚；
新库使用当前完整 schema，v3 在同一事务里检查已存在列，避免重复 ALTER。
所有旧 wish/trip/exchange 原字段保留，重复初始化不重跑迁移。

### 3. 出行（c 实现）

```
POST /api/dogs/:id/trips
入： { trigger: TripTrigger }       出：{ trip: Trip }         ← status=pending, seq 自动 +1
错： CONFLICT（上海当日已出发两次、上次还没结束或入参不合法）、NOT_FOUND（狗不存在或不属于当前 session）
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

#### C4 实现细则（11-17，沿用现有 Trip 字段）

- `GET /api/trips/:id` 出参为 `{ trip: Trip }`，列表默认 `limit=10`，允许 1–100 整数，按 `seq DESC` 返回；空集合 `{ trips: [] }`。
- 五个路由全部验证服务端会话与 owner 归属；缺少有效 Cookie、跨 owner、记录不存在均 HTTP 404 / `NOT_FOUND`。所有响应 `Cache-Control: no-store`，读取不触发状态更新或投递。
- POST 接受 JSON 对象：创建只有 `trigger`，开始为 `{}`，结束只有 `status`。不接收 `session_id`、seq 或时间戳；不允许跨来源 POST。参数/状态/额度冲突均 HTTP 409 / `CONFLICT`；数据库不可用返回脱敏 HTTP 503 / `NETWORK`。成功 HTTP 200。
- A 裁定：UTC 存储；自然日按上海固定 +8 小时切分，仅统计 `started_at IS NOT NULL`，`date(started_at, '+8 hours')` 为归属日。pending 不扣次数，failed/timeout 已出发则计数，跨午夜结束仍归出发日。每日上限 2；沿用 `TRIP_MIN_GAP_HOURS=6`，出发时检查间隔。
- 创建在 `BEGIN IMMEDIATE` 内检查所有权、单个活跃任务、当日额度、分配 `MAX(seq)+1` 并插入；出发在同类事务内重新检查额度及间隔，再写 running/started_at 并调用现有投递器。投递失败整笔回滚。
- 重复 start：running 返回原 trip 和 `delivered: []`，不改 started_at、不再投递；终态不能重新开始。只有 running 可进入终态；重复相同终态返回既有数据且不改 ended_at，其他终态切换返回 CONFLICT。
- finish 只读已有 finds（包含 assetPath），B 未接入前 `message: null`，不伪造发现；不写 replied_at 或 read_at。
- `timeout` 可显式结束；自动超时毫秒数未获裁定，不设置默认值。服务端执行器可传 `timeoutIfDue(id, sessionId, timeoutMs)`，未传即禁用；C4 不启动调度器，不在 GET 中隐式结束任务。
- 共用会话：`lib/auth/session.ts` 的 `ensureAnonymousSession` 给 A 领养使用，`readSessionId` 给服务端鉴权使用。cookie 为随机 32 字节，HttpOnly、SameSite=Lax、Path=/，生产 Secure；数据库只存 SHA-256 派生 sessionId，不向客户端暴露 sessionId。
- 前端调用 `lib/trips/poll.ts` 的 `pollTrip(id, { onTrip, onError, signal? })`；立即读一次，之后每次响应后 700ms 再读，无重叠请求；三个终态停止，HTTP/网络错误回调后停止，返回停止函数供卸载清理。

### 4. 发现（c 实现）

#### 独立归来分享读取（C，2026-11-20）

```text
GET /api/trips/:id/message
入：path.id 为 trip ID；不接受 query 参数、sessionId 或 owner 覆盖。
出：{ message: Message | null }
```

复用 `Message`，不增加字段、表、唯一约束或迁移。B 独占生成和写入，C 只读取。
该接口供 A 的 `readMessage(tripId, signal): Promise<Message|null>` adapter 使用；
**不能为读取内容 POST finish**，旧 finish 行为不变。

- 当前 `readSessionId` cookie → dog.session_id → trip 归属；无/坏 cookie、非法/不存在 trip、跨会话均 HTTP 404 / NOT_FOUND，不返回假空值。
- 存在且属于当前会话的 trip 没有 Message：HTTP 200，`{"message":null}`。
- 有 Message：HTTP 200，五个 camelCase 字段 `id/tripId/text/mentionsFindId/createdAt`；不展开 Find、狗、session 或私有配置。
- pending/running 以及 done/failed/timeout 均可读取已存在记录；读取不生成分享、不修改 trip 状态。failed/timeout 是否显示正常归来由 A 决定，允许单独只读历史。
- **多条历史 Message 的暂行提案，待 B/A 确认**：按 `julianday(created_at) DESC, id DESC` 稳定取最新一条；同一时刻用 ID 倒序破同分。保留所有行，不引入“一趟只能一条”的写入约束或删除。
- 非空 mentionsFindId 必须指向同一 trip 的 Find；包括同主人其他 trip 也不允许。所选最新行引用越界/丢失时返回 HTTP 503 / NETWORK，不返回引用 ID 或内容，不回退旧行，不当作无 Message；B 负责修正写入数据。
- 数据库不可用、SQL 失败或所选记录损坏：HTTP 503 / NETWORK、retriable=true，只含脱敏提示，不暴露 SQL/路径；失败没有 message:null。
- 所有成功/错误响应 `Cache-Control: no-store`、`Vary: Cookie`。Node runtime、动态 GET；无 POST 写入口。数据库读取为单条 SELECT，无任何业务写入。

仅响应形状 fixture 示例（不是 B5 已生成或 A wiring 已接通的证据）：

```json
{
  "message": {
    "id": "msg_001", "tripId": "trip_001",
    "text": "巷子里那面墙红透了，只有靠窗那块还是绿的。",
    "mentionsFindId": "find_s1", "createdAt": "2026-11-16T01:04:00Z"
  }
}
```

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

**重复点击提交**：`invitation_id` 和 `exchange_id` **两条路径上都有唯一索引**，第二次插不进去，返回 `CONFLICT`，前端当成功处理（幂等）。

⚠️ **不要只给一条路径做去重。** 重复提交是「提交这个动作」的幂等，它不区分来源 —— 邀请和礼物是同一个提交能力的两个入口。2026-11-15 只有邀请那条有索引时，礼物能插进两条回应，b 照说明写就会在礼物路径上漏。

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

#### v2 发件集合（c 实现读取，d/e 调用）

```text
GET /api/exchanges?from_dog=:id
入：query.from_dog，必填且只出现一次的非空字符串，不限定为 UUID
出：ExchangesResponse = { exchanges: Exchange[] }
错：CONFLICT（参数缺失、空白、重复或不是单个字符串）
    NOT_FOUND（狗不存在、不属于当前 owner，或没有有效的服务端 session）
```

只返回 `exchange.from_dog = :id` 的记录，包括在路上、已到未读、已读、已回应的记录；
按 `createdAt DESC, id DESC` 排序。`deliveredAt`、`repliedAt`、`readAt` 原样返回，不补时间、不更新状态。
合法且属于当前 session 的狗没有发件时返回 `{ "exchanges": [] }`；不能用空数组代替越权错误。

请求示例：`GET /api/exchanges?from_dog=dog_owner`。以下只是 fixture 响应形状示例：

```json
{
  "exchanges": [{
    "id": "ex_co_owner",
    "fromDog": "dog_owner",
    "toDog": "dog_seed_07",
    "kind": "co_owner_message",
    "payload": { "kind": "co_owner_message", "message": "楼下的桂花开了，你那边闻得到吗", "fromOwnerOf": "dog_owner" },
    "deliverAfterTripSeq": 2,
    "createdAt": "2026-11-16T09:35:00Z",
    "deliveredAt": null,
    "repliedAt": null,
    "readAt": null
  }]
}
```

**发件与收件分开：** 发件使用本节新增接口；E 的收件继续使用
`GET /api/dogs/:id/inbox?filter=onTheWay|arrived|all`。
**不新增 `GET /api/exchanges?to_dog=`**，该参数不能作为发件接口的收件筛选；传入它返回 `CONFLICT`。
手账合并同一只狗的 outbox 与 `GET /api/dogs/:id/inbox?filter=all`，按 exchange ID 去重。
无 `from_dog` 的 `GET /api/exchanges` 不提供全局集合，返回 `CONFLICT`。

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

### 9. 朋友关系读取（c 定义读取契约，d 实现，e 调用）

```text
GET /api/dogs/:id/relations
入：path.id，请求狗的 ID（沿用现有 dog ID，不限定为 UUID）
出：RelationsResponse = { relations: RelationView[] }
错：NOT_FOUND（狗不存在、不属于当前 owner，或没有有效的服务端 session）
```

返回 `dog_a = :id OR dog_b = :id` 的关系，保留 `relation.isBlocked`（包括拉黑记录），不修改关系。
`otherDog` 是关系另一端的狗，不是请求狗；`snapshot` 取另一端狗的最大 `version`，不存在时为 `null`。
按 `relation.lastMetAt DESC, relation.id ASC` 排序。没有关系时返回 `{ "relations": [] }`。
**`GET /api/relations` 不是规范路由，本次不新增无狗范围的全局关系接口。**

公开字段白名单：`otherDog` 仅允许 `id`、`name`、`assembly`、`isSample`。
使用 `PublicDogSummary`，禁止展开完整 `Dog`，禁止返回 `sessionId` / `session_id`、
`blockedTopics` / `blocked_topics` 或其他未列入白名单的狗字段。`snapshot` 仍只使用现有 `Snapshot` 字段，
不加入聊天、主人心愿原文或私有狗字段；没有快照和快照内部类目为空是两件事，本次不改后者规则。

请求示例：`GET /api/dogs/dog_owner/relations`。以下为假数据形状示例，演示对方尚无快照：

```json
{
  "relations": [{
    "relation": {
      "id": "rel_001", "dogA": "dog_owner", "dogB": "dog_seed_07",
      "firstMetAt": "2026-11-16T01:30:00Z", "lastMetAt": "2026-11-16T09:00:00Z",
      "metCount": 2, "isBlocked": false, "blockedAt": null
    },
    "otherDog": {
      "id": "dog_seed_07", "name": "青椒",
      "assembly": {
        "base": "tpl-b", "skin": { "color": "cream", "pattern": "stripe" },
        "cloth": "sweater", "hat": null, "glasses": "round", "face": "waiting"
      },
      "isSample": true
    },
    "snapshot": null
  }]
}
```

#### v2 两个新增 GET 的 session 与映射约定

当前 owner 由服务端已验证的会话上下文提供。客户端的 URL、query、body 不能提供或覆盖归属。
下方 `:sessionId` 只允许从该服务端上下文绑定，`:dogId` 才来自 path.id 或 query.from_dog。
先验证参数，再用同一只请求狗做归属检查；不属于当前 session 与不存在统一返回 `NOT_FOUND`。
读取须在同一只读事务中完成归属检查与查询，避免空集合和越权混淆；查询也重复限定归属。
两个 GET 均不写任何表，不更新已读、回应、相遇次数或快照版本。

接口实现方负责 SQL snake_case → API camelCase 映射：JSON 文本解析为对象/数组，
`is_sample` / `is_blocked` 的 0/1 转为 boolean，时间和 null 原样保留。
D 的 `rules.ts` 保持 camelCase 入口；D 测试装载 SQL 形状 fixtures 时可在 `fromDbRow()` 边界转换，
不能让页面各自猜字段。以下 SQL 是可执行的查询参考，由 `check-contracts.mjs` 直接读取验证；不是 HTTP handler。

```sql
-- c3-v2: owned-dog
SELECT id FROM dog WHERE id = :dogId AND session_id = :sessionId;
```

```sql
-- c3-v2: outbox
SELECT e.*
FROM exchange e
JOIN dog owned ON owned.id = e.from_dog AND owned.session_id = :sessionId
WHERE e.from_dog = :dogId
ORDER BY e.created_at DESC, e.id DESC;
```

```sql
-- c3-v2: relations
SELECT r.*,
       other.id AS other_id, other.name AS other_name,
       other.assembly AS other_assembly, other.is_sample AS other_is_sample,
       s.dog_id AS snapshot_dog_id, s.version AS snapshot_version,
       s.personality_tags AS snapshot_personality_tags,
       s.interest_categories AS snapshot_interest_categories,
       s.recent_trips AS snapshot_recent_trips,
       s.waiting_for AS snapshot_waiting_for, s.created_at AS snapshot_created_at
FROM relation r
JOIN dog owned ON owned.id = :dogId AND owned.session_id = :sessionId
JOIN dog other ON other.id = CASE WHEN r.dog_a = owned.id THEN r.dog_b ELSE r.dog_a END
LEFT JOIN snapshot s ON s.dog_id = other.id
  AND s.version = (SELECT MAX(latest.version) FROM snapshot latest WHERE latest.dog_id = other.id)
WHERE r.dog_a = owned.id OR r.dog_b = owned.id
ORDER BY r.last_met_at DESC, r.id ASC;
```

关系结果映射：`r.*` 只映射为 `Relation`；`other_*` 只映射为上述四字段 `PublicDogSummary`；
`snapshot_dog_id IS NULL` 映射为 `snapshot: null`，否则将 `snapshot_*` 映射为现有 `Snapshot`。
不得把带查询别名的原始行直接返回给前端，也不得通过回查完整 Dog 扩大公开字段。

### 10. 图片生成（c 实现，e 定提示词模板，d/e/a 调用读取）

> 11-16 新增。**接口先定形状，背后接什么可以换。** 生图模型是 GPT 的生图；单张成本与耗时**未验证**，
> 所以「每次出行都生成」还是「每人每天限几张」**还没定**，等 e 给出实测数。
>
> 完整规则见 `team/2026-11-16/a/1116-a-生图SOP与架构-v1.md`。这里只定形状。

```text
POST /api/gen/image
入：GenImageRequest
出：GenImageResult
错：NETWORK / BLOCKED / RATE_LIMITED（见 errors.md 六节的三级兜底）
```

**入参（`GenImageRequest`）**——每一个字段都由服务端查库填充：

```jsonc
{
  "purpose": "portrait" | "moment" | "gift" | "scene",  // 加第五种必须由 c 改 K
  "size":    { "w": 1200, "h": 800 },                   // 按资产规范的尺寸表取
  "place":   { "kind": "城市角落", "timeOfDay": "dusk", "weather": "雨" },  // 查 trip/find
  "dogs": [                                             // 查 dog.assembly，四键
    { "role": "owner",  "assembly": { "cloth": "hoodie", "hat": "beanie", "glasses": null, "face": "hopeful" },
      "refImagePath": "/assets/gen/ref-dog_owner.webp" }
  ],
  "camera":  "single" | "group" | "empty"
}
```

**三个字段级的硬规矩，不是使用约定是接口设计的一部分：**

| 规矩 | 为什么 |
| --- | --- |
| **没有任何字段来自用户原文** | 捎话 `message`、礼物 `note` 都是用户写的，进提示词就是**提示词注入**的口子（「忽略以上要求，画一张……」），也是审核风险。`giftName` 是 d 生成的受控名，可以用 |
| **内容由查库决定，不由模型发挥** | 模型临场决定内容，刷新两次就是两幅画 —— 同一次相遇两个版本，撞不变量五 |
| **外形词只能取契约枚举** | e 有措辞自由（`straw` 怎么翻成画面描述），没有取值自由（不能发明「针织贝雷帽」）。否则 AI 图和拼接图变成两套形象系统 |

**出参（`GenImageResult`）：**

```jsonc
{ "path": "/assets/gen/xxx.webp", "level": 0, "ms": 12345, "model": "..." }
```

`level` 是走到第几级兜底：`0` 生成成功 ／ `2` 退到这只狗的合成整图 ／ `3` 退到纯文字。
**前端按 `level` 决定显示什么，不要自己猜。** 没有 `1` —— 重试是服务端内部动作，用户看不见。

**三条不许违反的：**

1. **生成一次就落库，存路径不存二进制。** 打开页面只读路径，绝不重新生成 —— 否则换台设备打开是另一幅画（不变量五），且断网白屏（`errors.md` 四节，阻断级）。
2. **第 4 步的参考图必须由装配单合成**（`c11b` 的拼接渲出来的那张位图），不是文字描述。这样喂进去的狗和界面上的狗是同一只。
3. **失败三级兜底，没有第四级。** 明确禁止「预制通用图顶替」：一张不是这次出行生成的樱花树图配着「今天在樱花树下」，那不是降级是编造（不变量四）。

`find.asset_path` 和 gift 的 `imagePath` 就是这条接口的落点。

---

### 11. 日常交流（`POST /api/chat`，待 B 实现）

请求和成功体分别使用 `ChatRequest` 和 `ChatResponse`。B 的本机示例通道继续独立运行，正式发送由 A 审合契约后接入。

```json
{
  "dogId": "dog_xxx",
  "text": "今天想和你说件小事",
  "clientMessageId": "msg_intent_xxx"
}
```

- 仅接受 `Content-Type: application/json`，可带 UTF-8 charset。UTF-8 请求体限 16 KiB（16,384 字节），读取时按实际字节设上限，JSON 必须是仅含上述三个自有字段的对象，各字段均为字符串，字段名不得重复。拒绝查询参数、其他字段及客户端提供的 owner、session 或 token。解析后调用 `contracts/chat.ts` 的 `parseChatRequest`。
- `dogId` 是已有狗 ID，原样比较。限 1–128 个 UTF-16 码元，无首尾空白、C0/C1 控制字符或孤立代理码元。`clientMessageId` 限 1–128 个 ASCII 字符，首字为字母或数字，其余为字母、数字、下划线或连字符。区分大小写，不修剪。客户端为一次意图生成一个不可预测的键，例如 `crypto.randomUUID()`，并为该意图的所有重试保存此键。
- `text` 解码后最多 2,048 个 UTF-16 码元，禁止孤立代理码元及 C0/C1 控制字符，允许 TAB、LF 和 CR。使用 JavaScript `trim()` 去首尾空白后，按现有 `countChars` 校验 1–200。该函数移除所有 ECMAScript `\s` 后取 JavaScript `String.length`。标点算字，普通汉字 1 个码元，补充平面 emoji 通常 2 个码元，组合字符按其 UTF-16 码元累计。保存和回传仅做 `trim()`，保留内部空白及换行，不做 Unicode 归一化、合并空白或改写。
- 身份仅来自 Cookie。请求来源、媒体类型和查询参数通过校验后，用 `resolveAuthContext` 验证当前环境下有效、未过期、未撤销的稳定 owner 会话。正文解析后，在最终写事务中重新校验会话，并查 `dog.id = dogId AND dog.owner_id = auth.ownerId AND dog.is_sample = 0`，先授权目标再查幂等记录。缺少有效会话、狗不存在、种子狗、历史无 owner 狗及跨主人目标均返回相同的 404。
- 写入要求单个有效的 `Origin`，其 scheme、host、port 必须与应用请求的受信外部源一致（可信请求 URL 及 Host，或部署明确信任的代理配置）。拒绝缺失、`null`、不匹配的 Origin 及 `Sec-Fetch-Site: cross-site`。不信任请求方任意设置的转发头，不开放跨源写入。所有接口响应设置 `Cache-Control: no-store` 与 `Vary: Cookie`。

**HTTP 200** 在实际提交成功后返回首次持久化的主人消息。新写入和同意图重放使用相同格式。

```json
{
  "id": "chat_xxx",
  "dogId": "dog_xxx",
  "text": "今天想和你说件小事",
  "createdAt": "2026-11-25T08:00:00.000Z"
}
```

`id` 是服务端分配的不透明聊天记录 ID，可用 `chat_` 加随机 UUID 实现。`createdAt` 为首次保存时的服务端 UTC ISO 8601 时间，固定毫秒精度并以 `Z` 结束（`Date.toISOString()`）。首版成功体固定四键。待真实回复生成与保存另行定约后才可扩展 `replyText`，四句本地示例回复不得用作服务端确认。

#### 幂等与恢复

- 按 `(owner_id, client_message_id)` 保证持久化唯一性。同一授权 owner、相同键、相同 `dogId` 且 `trim()` 后文本逐码元相等时，返回原 `id/dogId/text/createdAt`。内部空白或 Unicode 码元改变属于内容改变。相同键提交不同的授权狗或规范化文本返回 409。未归属的目标始终先返回 404，即使该 owner 已用过该键。
- 在 SQLite 写事务中完成会话与狗归属检查、按 owner 和键查已有记录、比较或写入，唯一约束保证多连接并发只写一条。只有目标唯一键冲突可回读当作重放，其他数据库异常不得当成功。重启后从数据库读取原记录。同键允许不同 owner 各自使用，响应不能暴露其他 owner 有无该键。
- B 用本次请求保留的 `clientMessageId` 找到乐观上屏的待确认项，用 200 返回的服务端 `id` 确认并去重。客户端超时、连接中断、503 或响应结果不明时，保留原 `dogId`、文本和键，以同一意图重试。即使第一次已提交但响应丢失，也只确认原记录。明确另发或修改文本后另发时才生成新键。客户端超时本身没有 HTTP 错误响应。

#### 错误和隐私

错误体沿用 `ContractError` 的 `{ code, detail, retriable }`。

| HTTP | code | retriable | 裁定 |
| --- | --- | --- | --- |
| 404 | `NOT_FOUND` | false | 会话无效，或目标狗不存在、未绑定当前 owner、属于种子狗 |
| 409 | `CONFLICT` | false | JSON、来源、媒体类型、字段或长度非法，或同 owner 同键的有效请求改了目标或内容。采用现行 K 校验口径，替代 B 建议稿的 400 |
| 503 | `NETWORK` | true | 数据库写入、读取或必要网络环节真实故障，允许保留原键重试 |

只返回受控错误说明，不回显请求正文、token、owner 内部凭据、其他狗的消息、SQL 错误或堆栈。服务端不得在未确认实际保存时返回 200。

| 内容 | 存取边界 |
| --- | --- |
| Chat | 主人与自己狗的私有日常交流，单独存储 |
| Trip `Message` | 绑定 `tripId` 的归来分享，由 B 通过既有归来读取契约提供 |
| Invitation Reply | 对指定邀请的一次主人回应，写入既有 `reply` |
| CoOwnerMessage | 经 `exchange` 延迟投递的跨狗捎话，适用既有来源和身份边界 |

聊天写入不得创建 `wish` 或长期任务，不得向 `snapshot` 写入原话或派生摘要，不得复制到其他狗、`message`、`exchange`、`reply` 或 `trip_event`。不得用聊天冒充主人回应礼物或邀请。

#### 后续存储提案（待审迁移）

独立 `chat_message` 只保存首次确认的消息。下列 DDL 用于说明约束和契约验证。上线版需经 A/C 审核并以届时批准的新迁移版本接入，当前 schema 与运行入口尚无此表。

```sql
CREATE TABLE chat_message (
  id TEXT PRIMARY KEY NOT NULL,
  owner_id TEXT NOT NULL REFERENCES owner(id),
  client_message_id TEXT NOT NULL,
  dog_id TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, client_message_id),
  FOREIGN KEY (dog_id, owner_id) REFERENCES dog(id, owner_id)
) STRICT;
```

复用现有 `dog(id, owner_id)` 唯一约束。业务层执行完整字段检查、授权和同键原值比较。记录不覆盖，幂等随已保存记录持久保留，本契约不设键过期或公开历史读取 API。

---

## 三、四种 `exchange.payload` 的形状

`kind` 决定 payload 长什么样。**加第五种必须由 c 改 K。**

```jsonc
// find —— 发现交换
{ "kind": "find", "findTitle": "修鞋摊旁边的搪瓷缸",
  "findExcerpt": "缸沿上磕了两个口，茶还是满的。", "sourceUrl": null,
  "sourceFindId": null, "sourceMode": null }

// greeting —— 问候近况
{ "kind": "greeting", "line": "这边下了两天雨，你那边呢", "weather": "雨" }

// gift —— 礼物
{ "kind": "gift", "giftName": "一小卷灰蓝色的毛线", "note": "天气要冷了",
  "imagePath": "/assets/gen/xxx.webp", "sourceFindId": null, "sourceMode": null }

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

### K v4：兴趣 NULL 与数据库版本 4

`Snapshot.interestCategories` 现在允许 `InterestCategory[] | null`，SQL 为 `snapshot.interest_categories`。
NULL 表示未选择兴趣限制，沿用 dog 的语义；非 NULL 必须为 JSON 数组、2–3 项、元素均为既有六个类目。
`[]`、JSON 字符串 `"null"`、空对象、未知类目均非法。SQL NULL 不映射为 []，也不扩成六类数组。
未选兴趣的狗可以生成快照；D 的匹配/展示读取方须显式处理 null。
保留全部原 Snapshot 字段与隐私白名单，不加入心愿、聊天、照片或资料派生文本。
整份 snapshot 不存在（关系响应中的 snapshot:null）和快照存在但兴趣为 null 是两个不同情况。

迁移版本 4（004-snapshot-interest-null.ts）由 bootstrap 既有 BEGIN IMMEDIATE 包裹。
旧表行在事务内暂存，按原名重建 snapshot 并回填，再恢复原表的显式索引/触发器；保留复合主键、dog 外键、
其他列约束/默认值及全部历史版本。没有嵌套事务，不切换 foreign_keys；结束前执行 foreign_key_check。
同名重建不改写视图或其他表触发器中的引用，测试验证这些定义及实际查询保持可用。
新库已允许 NULL 则跳过重建。遇到未知入向外键或旧数据不符合类目约束时完整回滚，先人工核查，不能删行、
改成 NULL 或重建应用数据库来强行升级。版本 2/3 的已部署迁移保持原样。

### K v4：交换来源（仅 find / gift）

类型新增可选 `sourceFindId?: string|null`、`sourceMode?: SourceMode|null`，只附加到 find/gift。
可选是为了历史 JSON 可读；**新的服务端生成记录必须明确供应两个键**，没有来源时用 null。
greeting/co_owner_message 不增加这些键，没有第五种 ExchangeKind，也没有新增 exchange 列。
不加入 authorityLevel 或 voteUpCount。

| sourceFindId | sourceMode | 合法条件 |
| --- | --- | --- |
| 两个键均缺失 | 缺失 | 仅历史读取允许；保持未知，不补 live |
| null | null | 新内容没有 Find 来源（包括事件本身），不要编造 Find ID |
| 真实 find.id | live / cache / fixture | 来源 Find 属于寄件狗的 trip，值严格等于该 Find 存储的 source_mode |
| scene/moment Find 的 id | null | 保留来源 Find 的 NULL，不因有图片或 URL 改成 live |
| 缺一个键、非法模式、悬空 ID、跨狗 ID、无 Find 却声明 live/cache/fixture | 任意 | 拒绝新写入 |

sourceMode 描述原发现记录的来源；读取或交换不代表每次都重新搜过知乎，不能刷新为 live。
sourceUrl 也不是来源证明，不能依据 URL 外形或客户端参数推断 live。
旧 JSON 不要求补写，新字段不能静默改写历史 payload。

可信写入方在其事务中先验证当前 session 对 fromDog 的写入权，再用以下查询解析 sourceFindId；
sourceFindId 只能作为服务端核查输入，不赋予收件方查询私人 trip/find 的权限：

```sql
SELECT f.id, t.dog_id AS dogId, f.source_mode AS sourceMode
FROM find f JOIN trip t ON t.id=f.trip_id
WHERE f.id = :sourceFindId;
```

查不到或 dogId 不等于 fromDog 则拒绝，sourceMode 必须从查询结果取，客户端/模型不得自行指定。
收件方只读允许交换的内容摘要和来源元数据；后续 GET trip/find 仍须按其现有主人归属检查。
greeting/捎话不能借此夹带来源、私人内容或额外身份信息。

共用 `checkExchangeProvenance(payload, {fromDog, trusted, source, historical?})` 是契约级纯函数：
source 只能是上述可信数据库查询结果；新写入需 trusted=true、两个键俱全、存在且同狗的来源和匹配模式。
未受信任输入不能自报来源；historical=true 仅允许缺失两个新键的旧 payload 原样读取。
该函数只检查来源字段，不代替 D 的完整 payload 白名单、屏蔽、自寄和长度校验。
**本轮没有将函数接入 D4/C8 的业务写入事务。exchange.payload 原 JSON 列只校验 JSON 语法，不能自动验证引用或所有权。**

#### D4 激活要求（核对 origin/d4-gift@4fbcd11）

1. 更新 rules.ts 的正式 find/gift 白名单并校验来源类型；保持 greeting/co_owner_message 原白名单。
   不能只往 PENDING_KEYS 添加字段，放行键名不等于校验来源。
2. gift.ts 现为 INCLUDE_PENDING_KEYS=false，且 send() 先 validate(payload)、后追加 heldBack 字段。
   激活时必须调整次序：核查真实 Find/寄件狗归属并派生模式，组装最终 payload，校验完整 payload，再持久化。
   不能仅将开关改 true，否则新增字段绕过原 validate。
3. sourceFindId/sourceMode 仅适用于 find/gift。现有 CoOwnerMessageInput 也接收待批字段，激活时应拒绝这些来源字段，不能沿旧 PENDING_FIELDS 统一附加。
4. 由可信调用上下文验证寄件狗的写入权，来源查验与实际插入在同一事务/一致性边界内。
   D 内存/SQLite store 适配需有真实来源查询能力，不能从调用方伪造的 dogId/mode 构造 trusted source。
5. 更新 gift A11/B9（原来证明 heldBack 不落库）、rules 旧来源 UNKNOWN_KEY 用例，
   增加非法 mode/ID、跨狗、未受信任 live、scene/moment NULL、新旧 JSON 和 greeting/捎话不变的测试。
6. 保留幂等命中返回真实存储行、原投递趟次、不覆盖历史、不提前写 delivered_at/replied_at/read_at 的行为。
   K v4 激活不能变成重复发送或改变“收件狗当前 seq + 1”。

fixtures/exchange.json 保留原 4 条历史 exchanges，另有显式 provenanceCases，引用寄件狗既有 find_seed1，
其实际 kind=moment、source_mode=NULL；没有给 fixture 伪造新的 live 标签。
本节是给 D 的精确接入契约，不表示 D4/C8 新来源写入已经完成或通过端到端验收。

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

---

## 七、事件数据库契约（2026-11-18，内部数据访问，不新增 HTTP 路由）

`event` 是 D 维护的候选池，尚未发生，不得当作 `find` 或真实出行经历。
`trip_event` 是 C 独占写入的历史事实，D 只读。本轮只交数据库基础，未实现 pickEvent、抽签、冷却判断或渲染。

### event：固定 12 列

| SQL 列 | TypeScript Event 字段 | 约束 / 默认值 |
| --- | --- | --- |
| id | id | 非空主键 |
| code | code | 非空且唯一，D 的稳定标识 |
| text | text | 1–40 个 Unicode 字符，不接受空字符串或纯空格 |
| season | season | spring / summer / autumn / winter / any |
| weather | weather | any / clear / rain / snow |
| time_of_day | timeOfDay | any / morning / dusk / night |
| place_tags | placeTags | JSON 数组，元素限 street / stall / riverside / bookstore；默认 [] |
| match_tags | matchTags | JSON 数组，元素限现有六个 INTEREST_CATEGORIES；默认 [] |
| weight | weight | 数值 > 0，默认 30 |
| cooldown_days | cooldownDays | 数值 >= 0，默认 7 |
| asset_refs | assetRefs | JSON 对象，默认 {}；E2c 交可用引用前保留 {} |
| enabled | enabled | SQL 0/1，默认 1；TypeScript 为 boolean |

**没有 created_at。** 所有列非 NULL。JSON 在数据库中为 TEXT，读取边界解析为数组/对象，snake_case 映射为 camelCase。JSON 元素在插入和更新时均由触发器检查；不能只校验 JSON 语法。

`place_tags=[]` 表示无地点限制，不能用来表示「素材尚未填」。非空数组与 `availablePlaces` 有非空交集时才匹配；当 `availablePlaces=[]` 时只有不限地点的候选适用。找不到匹配事件返回 `null`，属于正常结果，不是错误，也不制造替代事件。这里只确定后续选择器的语义，本轮没有运行筛选或加权随机。

`match_tags` 复用「自然风景、城市角落、手作与食物、人与故事、动物与植物、冷知识」，不引入新的兴趣字典。`asset_refs` 的对象内部结构待 E2c 的素材引用对齐；不得为凑素材清空 place_tags。

### trip_event：固定 4 列

`trip_id` → trip.id；`event_id` → event.id；`dog_id` → dog.id；`happened_at` 为 UTC ISO-8601 TEXT。四列非空，主键 `(trip_id,event_id)`，索引 `idx_trip_event_dog(dog_id,happened_at)`。不新增独立 id 或其他时间列，不设置级联删除。C 后续写入时必须使用该 trip 所属 dog；外键校验三条引用存在，业务归属由 C 的写入方检查。

### 初始化与 D 导入

使用现有 `lib/db/bootstrap.ts` 的 `openDatabase()`，版本从 `PRAGMA user_version=1` 增量到 **2**。迁移仅新增两表、JSON 触发器和历史查询索引；新库与旧库使用相同约束，所有 DDL 和版本号在同一事务内提交，失败回滚。已有库不能重复执行整份 schema.sql。

迁移不自动导入事件。`contracts/fixtures/event.json` 只有显式 `sourceMode:"fixture"` 元数据和空 `events` 数组，不代表 D 的生产事件池。

D 使用明确的 12 列 INSERT/UPSERT，在服务端连接上启用 foreign_keys 后导入。当前 `d2c-events` 的 `1117-d2c-事件池三十条-v0.sql` 仍写 13 列：需由 D 从列清单及对应 VALUES 中去掉 created_at；其余 12 列业务数据不需要改写。C 不修改或覆盖该历史 SQL。
