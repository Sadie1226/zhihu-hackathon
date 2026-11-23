'use client'
// E5 场景裁切验收夹具：临时挂载到 app/(a)/a-scene-crop-fixture，用完即删。
// 渲染的是真实 TripPage 组件（不是另写的静态页），只通过 ports 绑定场景与角色。
// 场景用 ?scene=<slug> 切换；角色用 ?actor=body|ref 切换；不提供页内控件，截图里只有真实页面。
//
// actor=body：单个 E 正式底身 <img>，让页面自身的 .tripActor > * / .tripActor img 规则生效，
//             用于测量容器、脚底落点、遮挡与越界（夹具角色，不是正式 Dog 绑定）。
// actor=ref ：v25 ReferenceActor 原样绑定，用于记录「真实角色组件在 /trip 上下文的实际表现」。
import { useEffect, useMemo, useState } from 'react'
import { AppShellProvider } from '@/components/app-shell/shell'
import { ReferenceActor } from '@/components/v25/presentation'
import { readFinds, readMessage } from '@/components/app-shell/content-reader'
import TripPage from '@/components/app-shell/trip-page'
import type { ShellBindings } from '@/components/app-shell/ports'
import { SCENES, SCENE_CANVAS, type SceneDef } from './scene-manifest'

/** 页面默认角色宽度（trip-page.tsx: visual?.foot?.width ?? 27，单位 % 舞台宽）。 */
const ACTOR_WIDTH_PCT = 27
const BODY_SPRITE = '/assets/a5-v25/home/v25-kanshan-body.png'

function BodyActor() {
  return <img src={BODY_SPRITE} alt="夹具底身" data-e5-body="" />
}

function buildBindings(scene: SceneDef, actor: 'body' | 'ref'): ShellBindings {
  // 朴素映射：把 750×640 资产评审坐标直接归一化成舞台百分比。
  const x = (scene.footPx[0] / SCENE_CANVAS.width) * 100
  const y = (scene.footPx[1] / SCENE_CANVAS.height) * 100
  const visual = { src: scene.file, foot: { x, y, width: ACTOR_WIDTH_PCT } }
  return {
    Dog: actor === 'ref' ? ReferenceActor : BodyActor,
    tripScenes: { running: scene.file, done: scene.file },
    tripVisuals: { running: visual, done: visual },
    readFinds,
    readMessage,
  }
}

export default function SceneCropPreview() {
  const [params, setParams] = useState<{ slug: string; actor: 'body' | 'ref' } | null>(null)
  useEffect(() => {
    const query = new URLSearchParams(window.location.search)
    setParams({
      slug: query.get('scene') ?? SCENES[0].slug,
      actor: query.get('actor') === 'ref' ? 'ref' : 'body',
    })
  }, [])
  const scene = useMemo(() => SCENES.find(item => item.slug === params?.slug) ?? null, [params])
  const bindings = useMemo(
    () => (scene && params ? buildBindings(scene, params.actor) : null),
    [scene, params],
  )
  useEffect(() => {
    if (!scene || !params) return
    const w = window as unknown as { __e5?: unknown }
    w.__e5 = {
      slug: scene.slug,
      place: scene.place,
      actor: params.actor,
      footPx: scene.footPx,
      canvas: SCENE_CANVAS,
      actorWidthPct: ACTOR_WIDTH_PCT,
      sprite: params.actor === 'ref' ? null : BODY_SPRITE,
    }
  }, [scene, params])
  if (!scene || !bindings) return <p>场景夹具载入中…</p>
  return (
    <AppShellProvider bindings={bindings}>
      <TripPage />
    </AppShellProvider>
  )
}
