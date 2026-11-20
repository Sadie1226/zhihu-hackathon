'use client'

import type { Assembly } from '@/contracts/types'
import { useAppShell } from './shell'
import s from './shell.module.css'

export const assetRoot = '/assets/a5-v25'
export function DogArt({
  assembly,
  wardrobe = false,
}: {
  assembly: Assembly
  wardrobe?: boolean
}) {
  const { bindings, reducedMotion } = useAppShell()
  const Renderer = bindings.Dog
  if (Renderer)
    return <Renderer assembly={assembly} reducedMotion={reducedMotion} />
  if (wardrobe)
    return (
      <span className={s.dogArt} role="img" aria-label="试验穿搭预览">
        <img
          src={`${assetRoot}/wardrobe/body.png`}
          alt=""
          width="96"
          height="96"
        />
        {(['cloth', 'face', 'hat', 'glasses'] as const).map((layer) => (
          <img
            key={layer}
            src={`${assetRoot}/wardrobe/${layer}-${assembly[layer] ?? 'none'}.png`}
            alt=""
            width="96"
            height="96"
          />
        ))}
      </span>
    )
  return (
    <span
      className={s.dogArt}
      role="img"
      aria-label="像素看山参考形象，红围巾、黄色挎包"
    >
      <img
        src={`${assetRoot}/home/v25-shadow-stand.png`}
        alt=""
        width="100"
        height="116"
      />
      {['body', 'face', 'scarf', 'bag', 'leaf'].map((part) => (
        <img
          key={part}
          src={`${assetRoot}/home/v25-kanshan-${part}.png`}
          alt=""
          width="100"
          height="116"
        />
      ))}
    </span>
  )
}
export function TestBadge() {
  return <p className={s.testBadge}>测试身份 · 模拟知乎资料 · 参考外观</p>
}
