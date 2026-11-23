import type { ComponentType, ReactNode } from 'react'
import type {
  StoredAssembly,
  Find,
  InvitationView,
  Message,
  Reply,
  PublicDogSummary,
} from '../../contracts/types'

/** Thin UI ports, not replacement domain contracts. Fixed entries bind here, never register twice. */
export type PanelContext = {
  dogId: string
  reducedMotion: boolean
  /** Hidden panels stay mounted to retain drafts. Stop background work when false. */
  active?: boolean
  onClose: () => void
  onCommitted: (change?: CommitChange) => void
}
export type CommitChange = { resource: 'dog' | 'wishes' | 'invitations' | 'exchanges' | 'journal'; id?: string }
export type Origin = 'trip' | 'mailbox' | 'journal'
export type ReplyTarget =
  | { invitationId: string; exchangeId?: never }
  | { exchangeId: string; invitationId?: never }
export type ReplyBodyProps = PanelContext & {
  target: ReplyTarget
  origin: Origin
  returnTo: string
  onReplied?: (reply: Reply) => void
}
export type PeerActionProps = PanelContext & {
  peer: PublicDogSummary
  exchangeId?: string
  returnTo: string
}
export type Feedback =
  | { kind: 'actor'; target: string; action: 'idle' | 'blink' | 'look-around' | 'sit' | 'stretch' | 'wave' | 'approach-door' | 'cross-threshold' }
  | { kind: 'personality'; target: string; dimension: number; value: number; phase: 'change' | 'release'; strength: number }
  | { kind: 'ui'; target: string; phase: 'activate' | 'open' | 'close' }
export type FeedbackAdapter = (event: Feedback & { dogId?: string }, context: {
  signal: AbortSignal; reducedMotion: boolean
}) => void
export type RouteContext = { origin: Origin; returnTo: string }
export type TripVisual = { src: string; objectPosition?: string; illustrative?: boolean; canvas?: { width: number; height: number }; foot?: { x: number; y: number; width: number } }
export type Feature = {
  id: string
  label: string
  render: (context: PanelContext) => ReactNode
}
export type TripContent = { finds: Find[]; message: Message | null }
export type ShellBindings = {
  resolveTripVisual?: (finds: readonly Find[]) => TripVisual
  ChatPanel?: ComponentType<PanelContext>
  WishPanel?: ComponentType<PanelContext>
  Invitations?: ComponentType<{
    dogId: string
    tripId: string
    origin: 'trip'
    returnTo: string
  }>
  Dog?: ComponentType<{ assembly: StoredAssembly; reducedMotion: boolean }>
  tripScenes?: { running: string; done: string }
  tripVisuals?: { running?: TripVisual; done?: TripVisual }
  /** Each block is independent. Missing reader means unavailable, never an empty result. */
  readFinds?: (tripId: string, signal: AbortSignal) => Promise<Find[]>
  readMessage?: (tripId: string, signal: AbortSignal) => Promise<Message | null>
  readTripContent?: (
    tripId: string,
    signal: AbortSignal,
  ) => Promise<TripContent>
  routes?: { mailbox?: boolean; journal?: boolean }
  ReplyBody?: ComponentType<ReplyBodyProps>
  PreferencesBody?: ComponentType<PanelContext>
  CoOwnerMessageBody?: ComponentType<PeerActionProps>
  RelationshipActions?: ComponentType<PeerActionProps>
  GiftActions?: ComponentType<PeerActionProps>
  /** Optional implementation; no animation is installed by the shell. */
  feedback?: FeedbackAdapter
}
// Existing invitation types remain owned by contracts; consumers must not invent another DTO.
export type InvitationRecord = InvitationView
