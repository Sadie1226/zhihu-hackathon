// 目标位置：app/(b)/b4-ports.ts
// 与 A 分支 a-wiring-1120@6e78fff（实现 865a2d2）的 components/app-shell/ports.ts 同形。
// A 的分支未合 main，B 在本文件放同形类型，避免让 main 的 typecheck 依赖未合分支；
// A 接 wiring 后可直接把自己的 PanelContext / ReplyBodyProps 传进来，组件签名不变。
import type { Reply } from '@/contracts/types'

export type CommitChange = {
  resource: 'dog' | 'wishes' | 'invitations' | 'exchanges' | 'journal'
  id?: string
}

export type PanelContext = {
  dogId: string
  reducedMotion: boolean
  /** 隐藏的面板仍挂载以保留草稿；active=false 时停止后台工作。 */
  active?: boolean
  onClose: () => void
  onCommitted: (change?: CommitChange) => void
}

export type Origin = 'trip' | 'mailbox' | 'journal'

/** invitation 与 exchange 恰好一个；业务来源只看这个，不靠 origin 页面上下文猜。 */
export type ReplyTarget =
  | { invitationId: string; exchangeId?: never }
  | { exchangeId: string; invitationId?: never }

export type ReplyBodyProps = PanelContext & {
  target: ReplyTarget
  origin: Origin
  returnTo: string
  onReplied?: (reply: Reply) => void
}

export type InvitationPanelProps = {
  dogId: string
  tripId: string
  origin: 'trip'
  returnTo: string
}
