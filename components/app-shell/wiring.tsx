'use client'

import type { ReactNode } from 'react'
import { AppShellProvider } from './shell'
import type { ShellBindings } from './ports'

/** A is the only editor of this composition point. B/E export bodies; never another home/nav. */
const bindings: ShellBindings = {}
export function AppProviders({ children }: { children: ReactNode }) {
  return <AppShellProvider bindings={bindings}>{children}</AppShellProvider>
}
