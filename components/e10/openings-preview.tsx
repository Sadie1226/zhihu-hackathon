'use client'

import { useState } from 'react'
import MailboxPreview from '@/components/e6/mailbox-preview'
import JournalPreview from '@/components/e7/journal-preview'
import { HomeOpenings, type OpeningKind } from './home-openings'

export default function OpeningsPreview() {
  const [kind, setKind] = useState<OpeningKind | null>(null)
  const [reduced, setReduced] = useState(false)
  return <main style={{ margin: '0 auto', padding: 20, maxWidth: 1000, color: '#514337', background: '#fff8ed', minHeight: '100svh' }}>
    <h1>小屋开启动效 · 示例预览</h1>
    <p>这里的来信、伙伴、手账都是夹具。选择与拆信只改变当前试样，不联系真人。</p>
    <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', margin: '16px 0' }}>
      <button style={{ minHeight: 44 }} onClick={() => setKind('mail')}>试开来信</button>
      <button style={{ minHeight: 44 }} onClick={() => setKind('journal')}>试开手账</button>
      <label style={{ display: 'inline-flex', alignItems: 'center', minHeight: 44 }}><input type="checkbox" checked={reduced} onChange={event => setReduced(event.target.checked)} />减少动效（试样）</label>
    </div>
    <img src="/assets/a5-v25/home/room-wide.png" alt="现有小屋背景，用于检查浮层打开后小屋仍可辨认" width="1504" height="716" style={{ display: 'block', width: '100%', height: 'auto', imageRendering: 'pixelated' }} />
    {kind && <HomeOpenings kind={kind} onClose={() => setKind(null)} reducedMotion={reduced}
      renderMailbox={close => <MailboxPreview embedded onBack={close} />}
      renderJournal={(tab, directory) => <JournalPreview embedded initialTab={tab} onBack={directory} reducedMotion={reduced} />} />}
  </main>
}
