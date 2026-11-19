# C5 知乎搜索适配器

服务端调用 `searchZhihu(query, count=3)`，入口为 `lib/zhihu/index.ts`。
该入口有 `server-only` 构建保护，只在服务端读取 `process.env.ZHIHU_ACCESS_SECRET`。
Next.js 使用本地环境加载规则；CLI 验证脚本显式加载指定 `.env`。

固定调用 `GET https://developer.zhihu.com/api/v1/content/zhihu_search`，
发送 Query、Count（1–10）、Bearer 鉴权和秒级 X-Request-Timestamp。
使用 no-store、禁止跟随重定向、15 秒请求超时；适配器不自动重试。
不要把 transport core `client.ts` 接到浏览器；它只用于服务端依赖注入与离线模拟测试。

2026-11-19 已实际验证响应为 `{ Code, Message, Data: { HasMore, SearchHashId, Items } }`。
Items 中读取 Title、ContentText、Url、AuthorityLevel、VoteUpCount。
实测 AuthorityLevel 为字符串 "4"，边界允许 "1"–"4" 并转换为 K 的数值枚举；
也接受已为数值的 1–4。缺失元数据保留 null，不编造等级或赞数。
作者、头像、签名、评论等字段不进入返回值或交付报告。

成功返回 `{ ok: true, items, httpStatus, fetchedAt, responseFields }`。
items 是搜索材料，不是已经持久化的 Find：没有 find.id/tripId。
按 AuthorityLevel 降序、VoteUpCount 降序稳定排列，保留最多 count 条；相同链接去重。
标题与摘要去除上游 HTML 标记，作为纯文本使用，禁止 dangerouslySetInnerHTML。
原文 URL 保留上游内容路径及回答 ID，仅接受受信任 HTTPS 知乎问题/回答/文章路径，去掉 query 和 fragment。
不能用 query、标题或内容 ID 猜造原文链接。格式错误、未知响应、非法 URL 均返回脱敏 NETWORK，不伪造空成功。
真正成功响应中的材料才标 sourceMode=live；合法 Items=[] 返回空集合。

失败结果是内部判别联合，不是前端 HTTP 响应：

| 情况 | code | retriable | 上层处理 |
| --- | --- | --- | --- |
| 无凭据、HTTP 401/403、业务 20001 | AUTH | false | alert=true，服务端告警；后续 C9 使用 cache/fixture |
| HTTP 429、业务 30001 | RATE_LIMITED | false | 不自动重试；后续 C9 使用 cache/fixture |
| 本地非法 Query/Count、业务 10001 | CONFLICT | false | 参数纠正 |
| 网络/请求超时、HTTP 5xx、未知业务码、无效 JSON/结构 | NETWORK | true | 如实保留失败，由调用方决定是否发起新请求 |

AUTH/RATE_LIMITED 的 `fallback='cache-or-fixture'` 是内部接入指示，不代表缓存或降级能力已经实现。
本阶段没有缓存、fixture 自动回退、告警服务或前端错误透传；调用方不得把 AUTH/RATE_LIMITED 直接展示给用户。
异常文本、响应 Message、请求头、原始响应均不写日志或挂到错误 cause。
网络超时用 NETWORK；不在这个适配器中改变 trip 为 timeout。

应用接入前仍必须按契约在搜索之前执行 blocked_topics 过滤。
本次不读取 session/心愿、不给 trip/find 落库、不生成旅行发现，也不建立公开搜索路由。

离线测试：`node --test tests/zhihu.test.mjs`，全部为明确的 synthetic 输入；不消耗知乎额度。

真实检查（仅手动运行，每次最多一个 HTTP 请求）：

```bash
node --conditions=react-server scripts/c5/verify-live.mjs /absolute/path/to/.env
```

不传路径则加载当前工作目录的 `.env`。缺失/空凭据返回 AUTH 并以退出码 1 结束，不发送请求。
脚本固定关键词「想看雪」、Count=3，输出状态、字段名和公开内容摘要；脱敏报告落在 Git 忽略的
`.local/c5-live-report.json`。它不打印凭据、作者资料、评论或响应标识值。
保留下来的历史报告不代表新的调用仍是 live；只有本次响应可被本次调用标 live。
