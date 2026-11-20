'use client'
import type { ReactNode } from 'react'
import { useFeedback } from './use-feedback'

export function FeedbackSurface({ children }: { children: ReactNode }) {
  const feedback = useFeedback()
  return <div style={{ display: 'contents' }} onClickCapture={event => {
    const target = event.target instanceof Element ? event.target.closest('button, a') : null
    if (target instanceof HTMLElement && !target.hasAttribute('disabled'))
      feedback({ kind: 'ui', target: target.dataset.effect || target.id || target.dataset.panel || target.getAttribute('aria-label') || target.tagName.toLowerCase(), phase: 'activate' })
  }}>{children}</div>
}
