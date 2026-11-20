# A wiring：组件、读取和路由接入表 v2


> 本版供团队从已发布分支取用，覆盖 v1 的“仅本地”状态；代码及验收范围不变。与新增总请求同放 `team/2026-11-20/a/`，属于请求的配套交付附件，不是要求接收方重做 A 的实现。详见[总请求与原任务/补充项分类](1120-a-给全队-请求-A接线取用与任务衔接-v1.md)。

2026-11-20。**已发布隔离分支 `a-wiring-1120`，未合 main，未部署。**
基线 main `cb65637`，隔离合入 B 候选 `aca451f`；唯一装配点仍为 `components/app-shell/wiring.tsx`，仅 A 修改。本表覆盖旧 React 接入说明里与当前代码冲突的部分。

## 当前已接与明确未接

| 接口/组件 | 现状 | 消费位置与提供方 |
|---|---|---|
| ChatPanel | 已绑定，**本机示例**，不是真实 chat | 小屋聊聊及点击角色；B 正文、A 宿主 |
| WishPanel | 已绑定开发库真实新增/撤销 | 小屋心愿；成功只更新心愿相关状态，不刷新整份 session |
| Invitations | 已绑定旅途邀请/文字回应 | 仅 done 正常归来区；根据 find 关联限定当前 trip，不把旧邀请当本趟邀请 |
| readFinds | 已绑定现有 GET | `content-reader.ts`，私有 GET/no-store/AbortSignal，错误不变空或 fixture |
| readMessage | 已定义独立读取口，**未绑定** | 分享区明确“读取尚未接入”，等待 B/C 真实 Message 读取；不能当 Message=null |
| readTripContent | 原整体读取口保留兼容 | 仅无新分块 reader 时使用；不得为读内容 POST finish |
| Dog | 类型及所有主要宿主挂点保留，**正式实现未绑定** | C11b 实现、E 新角色素材；ReferenceActor 与 `/trip` 独立角色区使用同一装配单 |
| tripScenes / tripVisuals | 类型与舞台消费已就绪，**正式素材未绑定** | E 交背景；visuals 可带 objectPosition 与 foot 百分比 `{x,y,width}`；角色/阴影独立于背景 |
| routes.mailbox/journal | 仍 false，**页面尚未交接入** | E 做实际 `/mailbox` `/journal` 页面；开关只控制 A 的入口，不能代替路由或数据 |
| ReplyBody | 类型与 ReplySlot 消费组件已做，**B 真实通用正文未绑定** | 旅途/来信/手账共用，分别支持 invitation/exchange；不是现有只支持旅途列表的 Invitations 的别名 |
| PreferencesBody | 类型与 SettingsPanel 内部挂点已做，**B 业务未绑定** | B 的偏好/屏蔽主题业务；A 继续维护整份设置与账号操作 |
| CoOwnerMessageBody / RelationshipActions / GiftActions | 类型与 PeerActionSlot 已做，**D 业务 UI 未绑定** | E 来信/关系/手账详情消费；公开对方狗、目标交换及返回上下文，不增首页按钮 |
| feedback | 类型、派发、取消已做，**没有动画实现绑定** | 角色实例 idle/sit、六倾向 change/release、按钮 activate；减少动态与 AbortSignal 始终传递 |

已有 A 自有领养六场景、Frame/Stationery、档案改名、设置与唯一 dialog 不再重复造 bindings。朋友圈是后续 E8 页面，入口仍待 A 收口；演示拨盘仍是独立演示件，本轮没有开放它们。好友概览、实时人聊、场景 c11c 等已砍内容不恢复。

## 面板生命周期与定向刷新

```ts
type PanelContext = {
  dogId: string
  reducedMotion: boolean
  active?: boolean
  onClose(): void
  onCommitted(change?: {
    resource: 'dog' | 'wishes' | 'invitations' | 'exchanges' | 'journal'
    id?: string
  }): void
}
```

固定 chat/wish 不注册新入口。A 提供标题、关闭、遮罩、焦点；关闭/隐藏保留草稿，`active=false` 不等于卸载，正文的订阅/计时器按需要暂停。身份 scope 或 dog 改变时清空面板并卸载旧实例。正文仍须取消旧请求或丢弃旧响应。

`onCommitted({resource:'dog'})` 才刷新 session；其他 resource 只增加对应 `useAppShell().revisions`，供相关消费者定向重读；正文自己维护刚提交后的列表。旧无参调用仍可编译，**不再触发全 App 会话刷新**。过期 scope 的回调不能刷新新身份。

## 来信/手账的回应与业务操作

从 `components/app-shell/module-slots.tsx` 导入：

```tsx
<ReplySlot
  target={{ exchangeId: exchange.id }}
  origin="mailbox"
  returnTo="/mailbox"
  onClose={closeDetail}
  onReplied={reply => updateThisExchange(reply)}
/>
// invitationId 与 exchangeId 恰好一个；手账 origin="journal"。

<PeerActionSlot
  kind="CoOwnerMessageBody"
  peer={publicDogSummary}
  exchangeId={exchange.id}
  returnTo="/mailbox"
  onClose={closeDetail}
/>
// 同一挂点支持 RelationshipActions / GiftActions；缺 binding 时不出现假按钮。
```

`ReplySlot` 从当前统一上下文拿 dogId，按狗及回应目标重建实例；没有正文时明确未接入。`returnTo` 限定已知应用内页面，外部或非法值回小屋；直接页面内详情仍可维护自己的滚动/筛选状态。完整可编译示例见 `tests/shell-ports.typecheck.tsx`。

业务数据继续使用 `contracts/` 的 Reply/PublicDogSummary/Assembly 等。URL/props 不是服务端鉴权；不在 props 里传 token/owner/session。E 页面复用现有 AppProviders 和 SessionGate，不再包第二套正式 Provider。

来信只在真正打开已到内容时更新 readAt；列表/预取/开小屋不写。手账复用已有事实并保留未回应邀请。寄礼物入口、朋友圈入口和创建后换装范围尚未定，不凭挂点扩展产品。

## 旅途数据与视觉

正常归来只在 done 展示；running/pending 无发现或邀请。failed/timeout 的“查看已保存记录”是用户主动打开的独立只读区，不是成功归来，不挂邀请。

发现与分享各有未接入、加载、失败、成功（可为空）状态，独立重试；一个失败不拖死另一个。读取状态按 trip ID 和 reader 版本隔离，卸载取消；页面不创建/开始/结束旅途，不写邀请。状态重读失败保留的记录明确标为先前读取，停止展示可回应邀请。

Find 保留来源顺序与原文，按 ID 去重；有效 mentionsFindId 可前置并从分享链接定位。详情原地展开，外链不丢当前页面。缺图隐藏图片，正文保留；不足三条不补造，超过五条不静默删除。真实搜索的 P0 标准不变。

Dog 的画布、脚底、比例和阴影由正式组件/manifest 归一；tripVisuals 的 foot 是宿主百分比区域，不是强制角色沿用旧100×116。E 先交背景与新角色静态样张，再接动画。

## 动作与 UI 反馈

`ports.ts` 的 Feedback 分为 actor、personality、ui。倾向值使用当前 UI 的 **0–100**；`strength=abs(value-50)/50`，服务端仍是原 -2～2、步进0.2。不能在消费者混用两种范围。

`feedback(event,{signal,reducedMotion})` 可选，默认无实现。角色 target 带 React 实例 ID；按钮可用 `data-effect` 提供稳定 target，缺少时取已有 id/固定入口等信息。事件不含输入原文。adapter 须在 signal abort 时清理自己的资源，reducedMotion 下保持静态与信息；A 在实例卸载、上下文改变及新事件替换时中止旧信号。

没有恢复 window.HomeAdapters/KanshanMotion，没有动画文件、默认循环或批量生图。只预留的 actor action/open/close 等事件不代表这些动作均已制作或所有触发点已接。

## 已知依赖

- C 正式 owner/账号恢复/会话撤销、B/C Message 只读契约仍缺；开发身份不等于真实 OAuth。
- B 照片上传的有效会话、压缩/取消、上传与回应失败分离/URL重用、损坏图校验仍按原请求待修；本轮只做 A 接线必须的来源、空态、类型与请求来源兼容改动。
- 当前旅途筛选实现的可选 `tripId` 参数尚未进入公共 API 文档，交 C 收口；无法关联的旧邀请留在狗级历史，不在旅途里猜归属。
- 正式角色/背景、来信/手账页面及真实通用回应正文未绑定。预留存在不算这些模块完成。
