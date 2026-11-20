'use client'
import { createContext, useContext } from 'react'
import type { DogView, SessionView } from '@/lib/adoption/view'
import type { CommitChange, Feature, ShellBindings } from './ports'

type ShellContextValue = {
  session: SessionView | null
  error: string
  refresh: () => Promise<void>
  updateDog: (dog: DogView) => void
  reducedMotion: boolean
  setReducedMotion: (value: boolean) => void
  openPanel: (id: string) => void
  closePanel: () => void
  registerFeature: (feature: Feature) => () => void
  features: Feature[]
  bindings: ShellBindings
  revisions: Partial<Record<CommitChange['resource'], number>>
  committed: (change?: CommitChange) => void
}
export const ShellContext = createContext<ShellContextValue | null>(null)
export function useAppShell() {
  const value = useContext(ShellContext)
  if (!value) throw new Error('AppShellProvider is missing')
  return value
}
