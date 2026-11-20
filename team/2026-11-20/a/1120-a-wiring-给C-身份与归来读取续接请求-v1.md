# 给 C：A wiring 已接后的身份与归来读取续接

2026-11-20。仅本地 `a-wiring-1120`，未发布或自动发送；请求不计交付完成。

A 已从 main cb65637 建隔离分支，接 B 候选与 Find GET。实际消费点见[组件接入表](1120-a-wiring-组件接入表-v1.md)。原 11-19 身份请求继续有效，本件补本轮复验与当前代码差异。

1. **正式身份仍缺。** 两个独立浏览器上下文的开发领养、刷新恢复、跨狗404和同收据重试已实际通过；但 logout 后重放原 cookie 读取本人狗仍200，已复现。请交正式 owner 到随机会话的服务端映射、撤销/过期、开发/真实命名空间、一真实账号一狗与跨浏览器同账号恢复。不要把“清 cookie”当撤销；测试狗不迁移。当前 main 已 v4 迁移，追加前重查下一可用编号，不重写旧迁移。
2. **Message 独立只读。** A `ports.ts` 已有 `readMessage(tripId,signal):Promise<Message|null>`；`trip-page.tsx` 与 Find 分别加载/失败/重试。请与 B 交实际端点、归属/no-store/Vary Cookie、空值和排序语义。当前 A 显示“分享读取尚未接入”，没有硬造 GET 或把无接口当 null；请勿要求页面 POST finish 读分享。
3. **邀请读取的 trip 范围。** A 在本地 B 读取路由加可选 tripId，检查该 trip 属于当前狗，并用 `invitation.based_on_find_id -> find.trip_id` 限定本趟。狗级不带该参数的读取保留；无来源关联的旧邀请不猜所属趟次。请核公共 API/DTO 是否接纳此读取条件，或给兼容的替代规则；不添加 invitation.trip_id/新表作为本轮默认方案。
4. **终止态记录。** A failed/timeout 不进入正常归来区，可手动打开已存只读记录且不挂邀请。Find GET 已可消费；Message 端点请明确这些状态的可读边界，网络/权限错误不能返回假空列表。

交付请列分支/提交、迁移与兼容范围、HTTP示例和实际验证。A 继续维护页面/绑定，C 收口公共契约，未经真实 OAuth 复验不标正式领养完成。
