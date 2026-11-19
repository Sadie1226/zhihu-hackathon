import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import './globals.css'
import { AppProviders } from '@/components/app-shell/wiring'

export const metadata: Metadata = {
  title: '看山出门',
  description: '在小屋等它，听它说说路上的见闻。',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return <html lang="zh-CN"><body><AppProviders>{children}</AppProviders></body></html>
}
