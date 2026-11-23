// 编译期消费示例：证明 B 的 ReplyBody 可绑到 A 的 ShellBindings.ReplyBody。
// 与 a-wiring-1120 的 tests/shell-ports.typecheck.tsx 同形；不额外建路由/导航/服务。
import { ReplyBody } from '../app/(b)/b4-reply-body'
import type {
  ReplyTarget, PanelContext, CommitChange, Origin,
} from '../app/(b)/b4-ports'
import type { Reply } from '../contracts/types'

export const invitationTarget: ReplyTarget = { invitationId: 'invitation-1' }
export const exchangeTarget: ReplyTarget = { exchangeId: 'exchange-1' }
// @ts-expect-error 一条回应恰好一个业务来源。
export const invalidTarget: ReplyTarget = { invitationId: 'i', exchangeId: 'e' }

const context: PanelContext = {
  dogId: 'dog-1',
  reducedMotion: false,
  active: true,
  onClose: () => {},
  onCommitted: (change?: CommitChange) => { void change?.resource },
}

export function BindingsExample() {
  const make = (target: ReplyTarget, origin: Origin, returnTo: string) => (
    <ReplyBody {...context} target={target} origin={origin} returnTo={returnTo}
      onReplied={(reply: Reply) => { void reply.id }} />
  )
  return <>
    {make(invitationTarget, 'trip', '/trip')}
    {make(exchangeTarget, 'mailbox', '/mailbox')}
    {make(exchangeTarget, 'journal', '/journal')}
  </>
}
