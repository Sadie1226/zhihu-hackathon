'use client'

import { SessionGate, useAppShell } from '@/components/app-shell/shell'
import { ReplySlot } from '@/components/app-shell/module-slots'
import { JournalView, type JournalTab } from './journal-view'

export function JournalContent({ embedded = false, initialTab, onBack }: { embedded?: boolean; initialTab?: JournalTab; onBack?: () => void }) {
  const { session, revisions, reducedMotion } = useAppShell()
  const dogId = session!.dog!.id
  // A 拥有接线点：这里只挂 B 的回应插槽，不新增导航或第二个回应接口。
  return <JournalView key={dogId} dogId={dogId} revision={revisions.exchanges ?? 0} reducedMotion={reducedMotion} embedded={embedded} initialTab={initialTab} onBack={onBack}
    renderReply={(target, onReplied, close) =>
      <ReplySlot target={target} origin="journal" returnTo={embedded ? "/home" : "/journal"} onClose={close} onReplied={onReplied} />} />
}
export default function JournalPage() {
  return <SessionGate><JournalContent /></SessionGate>
}
