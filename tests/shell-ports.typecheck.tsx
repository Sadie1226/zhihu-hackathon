// Compile-time integration examples for B/D/E. No extra routes, navigation or mock services.
import type { ReplyTarget, ShellBindings } from '../components/app-shell/ports'
import { ReplySlot, PeerActionSlot, ModuleReturn } from '../components/app-shell/module-slots'

export const invitationTarget: ReplyTarget = { invitationId: 'invitation-1' }
export const exchangeTarget: ReplyTarget = { exchangeId: 'exchange-1' }
// @ts-expect-error A reply must never have two business sources.
export const invalidTarget: ReplyTarget = { invitationId: 'i', exchangeId: 'e' }
export const futureBindings: ShellBindings = {
  ReplyBody: props => <p>{props.target.invitationId ?? props.target.exchangeId}</p>,
  PreferencesBody: props => <button onClick={() => props.onCommitted({ resource: 'dog' })}>保存偏好</button>,
  CoOwnerMessageBody: props => <p>{props.peer.name}</p>,
  RelationshipActions: props => <p>{props.peer.id}</p>,
  GiftActions: props => <p>{props.exchangeId}</p>,
  Dog: () => <span />,
  feedback: (_event, context) => { context.signal.throwIfAborted() },
}
export function DetailExample() {
  const onClose = () => {}
  const peer = { id: 'peer-1', name: '示例', isSample: true,
    assembly: { cloth: 'hoodie', hat: null, glasses: null, face: 'happy' } } as const
  return <>
    <ReplySlot target={exchangeTarget} origin="mailbox" returnTo="/mailbox" onClose={onClose} />
    <ReplySlot target={invitationTarget} origin="journal" returnTo="/journal" onClose={onClose} />
    <PeerActionSlot kind="CoOwnerMessageBody" peer={peer} returnTo="/mailbox" onClose={onClose} />
    <PeerActionSlot kind="RelationshipActions" peer={peer} returnTo="/mailbox" onClose={onClose} />
    <PeerActionSlot kind="GiftActions" peer={peer} returnTo="/journal" onClose={onClose} />
    <ModuleReturn returnTo="/mailbox" />
  </>
}
