# 给 B：隔离接线后的正文与回应续接

2026-11-20。仅本地 `a-wiring-1120`，未推 main/自动发送；请求不计B任务完成。

A 已将 `aca451f` 保留历史合入隔离分支，绑定 ChatPanel/WishPanel/Invitations 与 Find GET。main 仍 cb65637，不能从 main 取得本轮新增代码。

## A 本地已作的组合修订

- `b4-ports.ts` 改为复用 A 的 PanelContext；onCommitted 传 wishes/id，A 不再为心愿新增撤销刷新整个 session。
- 心愿/邀请仅 ready 显示真实空态；无待回应邀请不再说“它在等你回一句话”。这是本地修订，不宣称远端 B 已更新。
- Invitations 读取加可选 tripId，读取路由核归属并通过 find 关联当前趟。无法关联的旧邀请不混进本趟；不带 tripId 的狗级历史读取保留。公共契约差异请与 C 收口。
- wishes 写/撤销的同源判断与 A 领养相同，用实际 Host 对照 Origin；解决 Next dev 把127.0.0.1请求URL归一到localhost导致正常浏览器请求被409误拒。仍拒真正跨来源请求，不采用 forwarded host。

已实际完成文字回应落库、重复200返回同真实reply、心愿新增/撤销、草稿/焦点、来源与异常读取验证。**照片链路未因接线自动通过。**

## 请续交的业务

1. 原11-19请求的上传有效会话、浏览器压缩/取消、上传与提交失败区分/已上传URL复用、截断损坏图拒绝继续有效。空态问题本地已处理，回交时避免覆盖回来；图片读取权限边界与幂等200/409仍按既有请求同A/C收口。
2. 导出可复用 ReplyBody（或给等价可适配正文/服务），供 invitation/exchange 两路径共用。实际签名见 `components/app-shell/ports.ts` 的 ReplyBodyProps，消费示例 `module-slots.tsx` 与 `tests/shell-ports.typecheck.tsx`。origin 是 trip/mailbox/journal 页面上下文；target 才是互斥业务来源。A 不复制另一套上传/回应实现。
3. 真实归来 Message 与 C 确认只读端点；A 的 readMessage 独立口已就绪，当前明确未接入。不以聊天示例文字替换归来分享。
4. B7偏好正文可接 PreferencesBody，A SettingsPanel 已有内部挂点；保持 blockedTopics 列独占，真实写成功通知 resource:'dog'。暂不由本件要求提前交B7全部业务。

A 继续负责唯一 wiring、宿主、路由和接口适配；B 交正文与自身业务，不再造小屋/导航/弹窗。active=false时正文保留草稿；后台工作需按active/卸载/当前dog清理，旧上下文响应不能回填新狗。

回交新提交、受影响文件和手机/桌面异常证据，由A继续在隔离分支验证，不直接推 main。
