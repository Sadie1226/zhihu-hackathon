'use client'

import { useMemo, useState } from 'react'
import { CircleView } from './circle-view'
import type { CircleDog, CirclePost, CircleReader } from './circle-model'
const dog = (id: string, name: string): CircleDog => ({ actor: 'dog', id, name, isSample: true })
const posts: CirclePost[] = [
  { id: 'moment_1', author: dog('dog_1', '青椒'), text: '在白桦林里站了一会儿。\n一片叶子刚好落在鼻尖上。', createdAt: '2026-11-25T08:00:00Z', sourceMode: 'fixture', interactions: [
    { dog: dog('dog_2', '小满'), kind: 'like' }, { dog: dog('dog_3', '阿桂'), kind: 'comment', text: '下回想和你一起去看看。' },
  ] },
  { id: 'moment_2', author: dog('dog_2', '小满'), text: '街角书店的灯还亮着，门边有一个暖和的位置。', createdAt: '2026-11-24T11:00:00Z', sourceMode: 'fixture', interactions: [] },
]
export default function CirclePreview() {
  const [scenario, setScenario] = useState('normal')
  const reader = useMemo<CircleReader | undefined>(() => {
    if (scenario === 'unavailable') return undefined
    let attempts = 0
    return async (_, signal) => {
      // React 开发严格模式清理的请求不消耗首次失败场景。
      await Promise.resolve()
      if (signal.aborted) throw new Error('aborted')
      attempts += 1
      if (scenario === 'slow') await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 2500)
        signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('aborted')) }, { once: true })
      })
      if (signal.aborted) throw new Error('aborted')
      if (scenario === 'error' && attempts === 1) throw new Error('fixture read failure')
      return { posts: scenario === 'empty' ? [] : posts }
    }
  }, [scenario])
  return <><div style={{ padding: 16, background: '#eadcc6' }}><label htmlFor="e8-case">本地验收场景：</label><select id="e8-case" value={scenario} onChange={event => setScenario(event.target.value)} style={{ minHeight: 44, font: 'inherit' }}>
    <option value="normal">正常示例</option><option value="empty">空动态</option><option value="error">首次失败，重试恢复</option><option value="slow">读取中</option><option value="unavailable">正式动态未接通</option>
  </select></div><CircleView key={scenario} dogId="dog_1" reader={reader} fixture /></>
}
