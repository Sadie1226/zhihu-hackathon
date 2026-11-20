# 给 B：隔离接线后的正文与回应续接 v2

2026-11-20。本请求随 GitHub 分支 `a-wiring-1120` 发布，未合 main；请求不计B任务完成，未自动发送群消息。

## 请求属性与配套材料

原任务：B5归来分享（11-21）、B6文字/照片回应（11-21）、B7偏好边界（11-25）；上传及异常修复属于原交付返工，不重复记新任务。跨页面共用回应在11-19请求中已提出，本轮落实为ReplyBody适配；Message独立只读接口属于11-19提出、本轮细化的B/C接口补充。B7只提供挂点，不提前其整项截止。

本轮未擅自给新增底座/读取补充编造截止日期；请回交预计交付时间与阻塞，由A收口到任务安排。原任务截止不因本请求自动顺延。

- 配套交付：[A隔离交付说明v2](1120-a-wiring-隔离交付-v2.md)，说明A已做的接线、验证与剩余依赖。
- 配套接口：[组件接入表v2](1120-a-wiring-组件接入表-v2.md)，说明实际文件、类型、消费位置、未绑定行为和示例。
- 分类与取用：[总请求](1120-a-给全队-请求-A接线取用与任务衔接-v1.md)。两份附件已一并放入同一请求区，请结合本请求阅读，不另开requests目录；不要求接收方重做A的页面/宿主/wiring。


A 已将 `aca451f` 保留历史合入隔离分支，绑定 ChatPanel/WishPanel/Invitations 与 Find GET。main 仍 cb65637；请取 `a-wiring-1120`，不能只拉 main 获取本轮代码。

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
