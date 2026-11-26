'use client'

import { SessionGate, useAppShell } from '@/components/app-shell/shell'
import { ReplySlot, PeerActionSlot } from '@/components/app-shell/module-slots'
import { MailboxView } from './mailbox-view'

function Mailbox() {
  const { session, revisions, bindings, reducedMotion, committed } = useAppShell()
  const dogId = session!.dog!.id
  // A owns the composition point. Keep unavailable D actions explicitly unavailable.
  const Composer = bindings.CoOwnerMessageBody
  const canCompose = Boolean(Composer && bindings.RelationshipActions)
  return <MailboxView key={dogId} dogId={dogId} revision={revisions.exchanges ?? 0}
    renderReply={(target, onReplied, close) => <ReplySlot target={target} origin="mailbox" returnTo="/mailbox" onClose={close} onReplied={onReplied} />}
    renderComposer={canCompose && Composer ? (peer, done, close) => <Composer key={peer.id} peer={peer} dogId={dogId} active reducedMotion={reducedMotion} returnTo="/mailbox" onClose={close} onCommitted={() => { committed({ resource: 'exchanges' }); done() }} /> : undefined}
    renderRelationshipActions={bindings.RelationshipActions ? peer => <PeerActionSlot kind="RelationshipActions" peer={peer} returnTo="/mailbox" onClose={() => {}} /> : undefined} />
}
export default function MailboxPage() { return <SessionGate><Mailbox /></SessionGate> }
