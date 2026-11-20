import type { ComponentType, ReactNode } from 'react'
import type {
  Assembly,
  Find,
  InvitationView,
  Message,
} from '../../contracts/types'

/** Thin UI ports, not replacement domain contracts. Fixed entries bind here, never register twice. */
export type PanelContext = {
  dogId: string
  reducedMotion: boolean
  onClose: () => void
  onCommitted: () => void
}
export type Feature = {
  id: string
  label: string
  render: (context: PanelContext) => ReactNode
}
export type TripContent = { finds: Find[]; message: Message | null }
export type ShellBindings = {
  ChatPanel?: ComponentType<PanelContext>
  WishPanel?: ComponentType<PanelContext>
  Invitations?: ComponentType<{
    dogId: string
    tripId: string
    origin: 'trip'
    returnTo: string
  }>
  Dog?: ComponentType<{ assembly: Assembly; reducedMotion: boolean }>
  tripScenes?: { running: string; done: string }
  readTripContent?: (
    tripId: string,
    signal: AbortSignal,
  ) => Promise<TripContent>
  routes?: { mailbox?: boolean; journal?: boolean }
}
// Existing invitation types remain owned by contracts; consumers must not invent another DTO.
export type InvitationRecord = InvitationView
