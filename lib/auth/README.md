# v5 服务端身份

`resolveAuthContext(request, db)` 只从当前环境的 HttpOnly Cookie 解析会话。会话凭据必须在 `owner_session` 登记，且仍在有效期、未撤销、属于当前命名空间。用 `assertOwnedDog` 或 `assertOwnedTrip` 校验资源归属。内部 owner ID、供应方 UID、会话哈希和凭据均不进入客户端 DTO。

真实身份适配器在服务端完成提供方验证后调用 `issueOwnerSession(db, { provider: 'zhihu', subject })`，并把返回的 `setCookie` 写入响应头。UID 以原始字符串保存。当前仓库未接入正式 OAuth 验证。会话有效期为七天，每次签发产生独立凭据。生产 Cookie 使用 `__Host-zhihu_session`、`Secure`、`HttpOnly`、`SameSite=Lax` 与 `Path=/`。

开发入口要求非生产、`APP_IDENTITY_PROVIDER=development` 和实际打开的独立 `a5-development*.sqlite` 数据库。已有开发会话可直接复用。失效或退出后重新进入会生成新的开发身份，历史数据继续保留。正式库只解析 `zhihu` 命名空间。

`readSessionId(request)` 为已存在的服务端调用者提供兼容。它委托公共解析器查会话，返回稳定的内部归属键。v5 新归属写入 `dog.owner_id` 与兼容列 `dog.session_id`，历史列值在迁移时保留。数据库约束阻止无 owner 的狗使用现有 owner 的兼容键。旧匿名 Cookie 无法作为凭据恢复旧归属。
