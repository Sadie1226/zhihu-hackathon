'use client'

import Link from 'next/link'
import { useAppShell } from './shell'
import type { PanelContext, PeerActionProps, ReplyBodyProps } from './ports'
import { internalReturnTo } from './content-reader'

/** For E's mailbox/journal details. B supplies one body for both invitation and exchange. */
export function ReplySlot(props: Omit<ReplyBodyProps, keyof PanelContext> & { onClose: () => void }) {
  const { session, reducedMotion, bindings, committed } = useAppShell()
  const Body = bindings.ReplyBody
  if (!session?.dog) return null
  return Body ? <Body {...props} key={`${session.dog.id}:${props.target.invitationId ?? props.target.exchangeId}`}
    dogId={session.dog.id} active reducedMotion={reducedMotion} onCommitted={committed}
    returnTo={internalReturnTo(props.returnTo)} /> : <p>回应模块尚未接入，已有内容仍可阅读。</p>
}

/** Named business slots inside E's details, not additional navigation or dialogs. */
export function PeerActionSlot({ kind, ...props }: Omit<PeerActionProps, keyof PanelContext> & {
  kind: 'CoOwnerMessageBody' | 'RelationshipActions' | 'GiftActions'; onClose: () => void
}) {
  const { session, reducedMotion, bindings, committed } = useAppShell()
  const Body = bindings[kind]
  if (!Body || !session?.dog) return null
  return <Body {...props} key={`${session.dog.id}:${props.peer.id}:${kind}`} dogId={session.dog.id}
    reducedMotion={reducedMotion} active onCommitted={committed} returnTo={internalReturnTo(props.returnTo)} />
}

export function ModuleReturn({ returnTo }: { returnTo: string }) {
  return <Link href={internalReturnTo(returnTo)}>返回原处</Link>
}
