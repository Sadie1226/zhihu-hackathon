'use client'

import { SessionGate, useAppShell } from '@/components/app-shell/shell'
import { ReplySlot, PeerActionSlot } from '@/components/app-shell/module-slots'
import { MailboxView } from './mailbox-view'

export function MailboxContent({ embedded = false, onBack }: { embedded?: boolean; onBack?: () => void }) {
  const { session, revisions, bindings, reducedMotion, committed } = useAppShell()
  const dogId = session!.dog!.id
  // A owns the composition point. Keep unavailable D actions explicitly unavailable.
  const Composer = bindings.CoOwnerMessageBody
  const canCompose = Boolean(Composer && bindings.RelationshipActions)
  return <MailboxView key={dogId} dogId={dogId} revision={revisions.exchanges ?? 0} embedded={embedded} onBack={onBack}
    renderReply={(target, onReplied, close) => <ReplySlot target={target} origin="mailbox" returnTo={embedded ? "/home" : "/mailbox"} onClose={close} onReplied={onReplied} />}
    renderComposer={canCompose && Composer ? (peer, done, close) => <Composer key={peer.id} peer={peer} dogId={dogId} active reducedMotion={reducedMotion} returnTo={embedded ? "/home" : "/mailbox"} onClose={close} onCommitted={() => { committed({ resource: 'exchanges' }); done() }} /> : undefined}
    renderRelationshipActions={bindings.RelationshipActions ? peer => <PeerActionSlot kind="RelationshipActions" peer={peer} returnTo={embedded ? "/home" : "/mailbox"} onClose={() => {}} /> : undefined} />
}
export default function MailboxPage() { return <SessionGate><MailboxContent /></SessionGate> }
