'use client'

import { SessionGate, useAppShell } from '@/components/app-shell/shell'
import { ReplySlot } from '@/components/app-shell/module-slots'
import { JournalView } from './journal-view'

function Journal() {
  const { session, revisions, reducedMotion } = useAppShell()
  const dogId = session!.dog!.id
  // A 拥有接线点：这里只挂 B 的回应插槽，不新增导航或第二个回应接口。
  return <JournalView key={dogId} dogId={dogId} revision={revisions.exchanges ?? 0} reducedMotion={reducedMotion}
    renderReply={(target, onReplied, close) =>
      <ReplySlot target={target} origin="journal" returnTo="/journal" onClose={close} onReplied={onReplied} />} />
}
export default function JournalPage() {
  return <SessionGate><Journal /></SessionGate>
}
