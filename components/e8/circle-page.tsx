'use client'

import { SessionGate, useAppShell } from '@/components/app-shell/shell'
import { CircleView } from './circle-view'

function Circle() {
  const { session } = useAppShell()
  const dog = session!.dog!
  // 正式动态源没有契约/适配器，明确降级，绝不把主人的聊天或捎话拼作公开动态。
  return <CircleView key={dog.id} dogId={dog.id} />
}
export default function CirclePage() { return <SessionGate><Circle /></SessionGate> }
