# 共用匿名会话（C4 → A）

仅在 Node 服务端导入 `session.ts`，不要从客户端组件导入。

领养接口直接使用同一 helper，不自行生成 session_id：

```ts
const { sessionId, setCookie } = ensureAnonymousSession(request, db)
// A 将 sessionId 写入新狗的 dog.session_id；禁止读取 body.session_id。
// 成功创建后：
const response = Response.json({ dog: publicResult })
if (setCookie) response.headers.append('Set-Cookie', setCookie)
return response
```

`publicResult` 不应包含 sessionId。cookie 是 32 字节密码学随机值；库内 ID 为其 SHA-256 摘要。已有合法 cookie 且确实拥有狗则复用，未知或重复 cookie 重新签发，防止领养时采用外部指定的身份。C4 不创建狗、不代 A 设置领养接口。

读取接口用 `readSessionId(request)` 并通过数据库验证狗归属；返回 null 或无所属狗时统一 NOT_FOUND。不接受 body/query 的 session_id。不要记录 cookie、不要把它放进 URL。

开发 cookie 名 `zhihu_session`；生产为 `__Host-zhihu_session`，设置 Secure、HttpOnly、SameSite=Lax、Path=/，无 Domain。生产浏览器会话需要 HTTPS；C2 公网 HTTP 骨架能展示首页和健康检查，但领养联调前需要配置 HTTPS。cookie 是浏览器会话 cookie；关闭会话后恢复机制未在 C4 内定义。既有 fixture 的 session_id 不是可登录身份，不提供转换入口。
