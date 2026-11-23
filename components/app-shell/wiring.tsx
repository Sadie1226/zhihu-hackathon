'use client'

import type { ReactNode } from 'react'
import { AppShellProvider } from './shell'
import type { ShellBindings } from './ports'
import { ChatPanel } from '@/app/(b)/b4-chat-panel'
import { WishPanel } from '@/app/(b)/b4-wish-panel'
import { Invitations } from '@/app/(b)/b4-invitations'
import { ReplyBody } from '@/app/(b)/b4-reply-body'
import { readFinds, readMessage } from './content-reader'
import { FeedbackSurface } from './feedback-surface'

/** A is the only editor of this composition point. B/E export bodies; never another home/nav. */
const bindings: ShellBindings = {
  ChatPanel, WishPanel, Invitations, ReplyBody, readFinds, readMessage,
  // Formal Dog/scenes and E routes await their owners.
  // Missing bindings remain explicit; do not synthesize a successful empty response.
  routes: { mailbox: false, journal: false },
}
export function AppProviders({ children }: { children: ReactNode }) {
  return <AppShellProvider bindings={bindings}><FeedbackSurface>{children}</FeedbackSurface></AppShellProvider>
}
