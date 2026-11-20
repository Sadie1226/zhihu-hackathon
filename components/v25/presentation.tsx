'use client'

import { useEffect, useId, type CSSProperties, type ReactNode } from 'react'
import Link from 'next/link'
import type { Assembly } from '@/contracts/types'
import { useAppShell } from '@/components/app-shell/shell'
import { useFeedback } from '@/components/app-shell/use-feedback'
import './theme.css'
import './integration.css'

export const A = '/assets/a5-v25/'
export const steps = [
  'auth',
  'profile',
  'traits',
  'tags',
  'wardrobe',
  'creation',
  'home',
] as const
export type AdoptionStep = (typeof steps)[number]

export function Frame({
  step,
  children,
}: {
  step: AdoptionStep
  children: ReactNode
}) {
  return (
    <div data-v25="" data-step={step} className={step === 'home' ? 'home-page' : undefined}>
      <a className="skip" href="#content">
        跳到主要内容
      </a>
      <div className="wrap">
        <header>
          <Link className="brand" href="/home">
            看山出门
          </Link>
          <span>一点点认识，一起过日子</span>
        </header>
        <nav id="steps" aria-label="领养步骤">
          {[
            '知乎授权',
            '名字兴趣',
            '性格倾向',
            '三个词',
            '穿搭',
            '成为伙伴',
            '小屋',
          ].map((text, i) => (
            <span
              key={text}
              className={steps[i] === step ? 'current' : undefined}
              aria-current={steps[i] === step ? 'step' : undefined}
            >
              0{i + 1} {text}
            </span>
          ))}
        </nav>
        {children}
        <p className="home-demo" data-development-note="">
          测试身份 · 模拟知乎资料 · 参考看山；真实账号需重新领养
        </p>
      </div>
    </div>
  )
}

export function Stationery({
  title,
  children,
  appearance = 'cancel',
  error = false,
  id,
}: {
  title: string
  children: ReactNode
  appearance?: 'waiting' | 'success' | 'cancel' | 'failure'
  error?: boolean
  id?: string
}) {
  return (
    <div className={`stationery${error ? ' error' : ''}`} id={id} role="status">
      <img
        className="status-actor"
        src={`${A}head-${appearance}.png`}
        width="72"
        height="64"
        alt=""
      />
      <div className="stationery-copy">
        <strong>{title}</strong>
        <span>{children}</span>
      </div>
    </div>
  )
}

export function ReferenceActor({
  assembly,
  pose = 'stand',
}: {
  assembly: Assembly
  pose?: 'stand' | 'sit'
}) {
  const { bindings, reducedMotion } = useAppShell()
  const feedback = useFeedback()
  const instance = useId()
  useEffect(() => { feedback({ kind: 'actor', target: `actor-${instance}`, action: pose === 'sit' ? 'sit' : 'idle' }) }, [feedback, pose, instance])
  const Renderer = bindings.Dog
  if (Renderer)
    return <Renderer assembly={assembly} reducedMotion={reducedMotion} />
  return (
    <div
      className="dog-assembly reference-actor"
      role="img"
      aria-label="清晰像素看山，红围巾、黄色挎包，没有嘴巴"
      data-assembly={Object.values(assembly).join('/')}
      data-pose={pose}
      data-foot-anchor="50,107.5"
    >
      <img
        className="actor-shadow"
        data-shadow-layer=""
        data-shadow-pose={pose}
        src={`${A}home/v25-shadow-${pose}.png`}
        width="100"
        height="116"
        alt=""
      />
      <span className="actor-visual">
        {(pose === 'sit'
          ? ['sit']
          : ['body', 'face', 'scarf', 'bag', 'leaf']
        ).map((part) => (
          <img
            key={part}
            data-art-layer={part}
            src={`${A}home/v25-kanshan-${part}.png`}
            width="100"
            height="116"
            alt=""
          />
        ))}
      </span>
    </div>
  )
}

export function World({
  greeting,
  assembly,
  variant = 'room',
  motion,
}: {
  greeting: string
  assembly: Assembly
  variant?: 'room' | 'character' | 'entry'
  motion?: ReactNode
}) {
  return (
    <aside
      className={`world${variant !== 'room' ? ' dressing-world' : ''}${variant === 'entry' ? ' entry-world' : ''}`}
    >
      <p id="greeting">{greeting}</p>
      <div
        id="character-stage"
        data-renderer="static"
        aria-label="角色静态画面"
      >
        {variant === 'room' ? (
          <img
            className="room"
            src={`${A}AI素材组合.png`}
            width="630"
            height="684"
            alt="窗边的刘看山站在暖色蓝纹地毯上，身旁有花盆和书本"
          />
        ) : variant === 'character' ? (
          <div className="dressing-stage character-only">
            <div id="outfit-preview">
              <ReferenceActor assembly={assembly} />
            </div>
          </div>
        ) : (
          <div
            className="entry-scene"
            aria-label="看山左侧是一扇略带轴测角度的落地小木门"
          >
            <img
              className="entry-door"
              src={`${A}home/door.png`}
              alt="透出暖光的左侧小木门"
            />
            <div className="entry-dog">
              <ReferenceActor assembly={assembly} />
            </div>
            <div className="entry-floor" />
          </div>
        )}
      </div>
      <p className="caption">
        {variant === 'entry'
          ? '小门在左边，回家的灯已经亮了。'
          : variant === 'room'
            ? '在这里，慢慢认识彼此。'
            : ''}
      </p>
      {motion}
    </aside>
  )
}

export const cssVars = (value: Record<string, string | number>) =>
  value as CSSProperties

export const catalogue = {
  cloth: {
    label: '衣服',
    items: [
      ['hoodie', '蓝色连帽衫'],
      ['jacket', '焦糖夹克'],
      ['sweater', '奶油毛衣'],
      ['raincoat', '小雨衣'],
      ['apron', '植物围裙'],
      ['scarf-coat', '围巾外套'],
    ],
  },
  hat: {
    label: '帽子',
    items: [
      ['beanie', '针织帽'],
      ['cap', '鸭舌帽'],
      ['straw', '小草帽'],
      ['none', '不戴帽子'],
    ],
  },
  glasses: {
    label: '眼镜',
    items: [
      ['round', '圆圆镜框'],
      ['square', '方方镜框'],
      ['sun', '太阳镜'],
      ['none', '不戴眼镜'],
    ],
  },
  face: {
    label: '表情',
    items: [
      ['happy', '开心'],
      ['tired', '困困'],
      ['hopeful', '期待'],
      ['waiting', '安静等你'],
    ],
  },
} as const
export const defaultAssembly: Assembly = {
  cloth: 'hoodie',
  hat: 'none',
  glasses: 'none',
  face: 'happy',
}
