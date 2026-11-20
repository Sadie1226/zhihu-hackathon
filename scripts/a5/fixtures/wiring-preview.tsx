'use client'
// Explicit port fixture, temporarily mounted by verify-wiring.mjs; never a product route.
import { useState } from 'react'
import { AppShellProvider, useAppShell } from '@/components/app-shell/shell'
import { ReplySlot, PeerActionSlot, ModuleReturn } from '@/components/app-shell/module-slots'
import { useFeedback } from '@/components/app-shell/use-feedback'
import { ReferenceActor } from '@/components/v25/presentation'
import TripPage from '@/components/app-shell/trip-page'
import type { Feedback, ShellBindings } from '@/components/app-shell/ports'
import type { Assembly } from '@/contracts/types'

declare global { interface Window { portEvents?: { event: Feedback; reduced: boolean; aborted: boolean }[] } }
const assembly: Assembly = { cloth: 'jacket', hat: null, glasses: null, face: 'happy' }
const peer = { id: 'fixture-peer', name: '示例伙伴', isSample: true, assembly }
const bindings: ShellBindings = {
  Dog: props => <span data-testid="fixture-dog">{props.assembly.cloth}</span>,
  ReplyBody: props => <p>回应挂点：{props.target.invitationId ?? props.target.exchangeId}；{props.origin}；{props.returnTo}</p>,
  CoOwnerMessageBody: () => <p>捎话挂点</p>,
  GiftActions: () => <p>礼物挂点</p>,
  RelationshipActions: () => <p>关系与举报拉黑挂点</p>,
  PreferencesBody: props => <p>偏好挂点：{props.active ? 'active' : 'hidden'}</p>,
  readFinds: async id => [{ id: 'fixture-find', tripId: id, kind: 'zhihu', title: '端口夹具发现', excerpt: '', sourceUrl: 'https://www.zhihu.com/question/12345', sourceMode: 'fixture', assetPath: null, createdAt: new Date().toISOString(), authorityLevel: null, voteUpCount: null }],
  readMessage: async () => { throw Error('Explicit fixture failure') },
  feedback: (event, context) => {
    const entry = { event, reduced: context.reducedMotion, aborted: context.signal.aborted }
    ;(window.portEvents ??= []).push(entry)
    context.signal.addEventListener('abort', () => { entry.aborted = true }, { once: true })
  },
}
function Body() {
  const { openPanel, setReducedMotion } = useAppShell()
  const feedback = useFeedback()
  const [actor, setActor] = useState(true)
  return <>
    <p>端口验证 · 显式夹具</p>
    <button onClick={() => openPanel('settings')}>打开设置夹具</button>
    <button onClick={() => setReducedMotion(true)}>减少动态夹具</button>
    <button onClick={() => feedback({ kind: 'personality', target: 'fixture', dimension: 0, value: 25, phase: 'release', strength: .5 })}>派发倾向反馈</button>
    <button onClick={() => setActor(false)}>卸载角色夹具</button>
    {actor && <ReferenceActor assembly={assembly} />}
    <ReplySlot target={{ invitationId: 'fixture-invitation' }} origin="journal" returnTo="/journal" onClose={() => {}} />
    <ReplySlot target={{ exchangeId: 'fixture-exchange' }} origin="mailbox" returnTo="//example.test" onClose={() => {}} />
    <PeerActionSlot kind="CoOwnerMessageBody" peer={peer} returnTo="/mailbox" onClose={() => {}} />
    <PeerActionSlot kind="GiftActions" peer={peer} returnTo="/journal" onClose={() => {}} />
    <PeerActionSlot kind="RelationshipActions" peer={peer} returnTo="/mailbox" onClose={() => {}} />
    <ModuleReturn returnTo="https://example.test" />
    <TripPage />
  </>
}
export default function PortPreview() { return <AppShellProvider bindings={bindings}><Body /></AppShellProvider> }
