'use client'
import { useEffect, useState } from 'react'
import type { StoredAssembly } from '@/contracts/assembly'
import { isTspfAssembly } from '@/contracts/assembly'
import { resolveTspfPlan } from '@/lib/appearance/tspf-plan'
import { wardrobeRoot } from '@/lib/adoption/wardrobe'
import s from './shared-dog.module.css'

export function SharedDog({ assembly }: { assembly: StoredAssembly; reducedMotion: boolean }) {
  const plan = isTspfAssembly(assembly) ? resolveTspfPlan(assembly) : null
  const paths = plan?.layers.map(layer => `${wardrobeRoot}/${layer.path}`) ??
    ['/assets/a5-v25/wardrobe/body.png', ...(['cloth', 'face', 'hat', 'glasses'] as const)
      .map(key => `/assets/a5-v25/wardrobe/${key}-${(assembly as Exclude<StoredAssembly, { outfit: unknown }>)[key] ?? 'none'}.png`)]
  const signature = paths.join('|')
  const [loaded, setLoaded] = useState<{ signature: string; paths: string[] } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  useEffect(() => {
    let active = true
    Promise.all(signature.split('|').map(src => new Promise<void>((resolve, reject) => {
      const img = new Image()
      const timer = window.setTimeout(() => reject(new Error('Image timeout')), 10000)
      img.onload = () => { window.clearTimeout(timer); resolve() }
      img.onerror = () => { window.clearTimeout(timer); reject(new Error('Image unavailable')) }
      img.src = src
    }))).then(() => { if (active) { setLoaded({ signature, paths: signature.split('|') }); setFailed(null) } })
      .catch(() => { if (active) setFailed(signature) })
    return () => { active = false }
  }, [signature])
  return <div className={s.dog} role="img" aria-label={failed === signature ? '穿搭图像未能载入' : '你的看山穿搭'}
    aria-busy={loaded?.signature !== signature && failed !== signature} data-dog-version={plan ? 'r2' : 'legacy'}
    data-foot-x={plan ? 522 : 48} data-foot-y={plan ? 950 : 96}>
    {loaded?.paths.map(path => <img key={path} src={path} alt="" />)}
    {failed === signature && <span role="alert">穿搭图像未能载入，请重新选择后重试。</span>}
    {!loaded && failed !== signature && <span role="status">正在准备穿搭</span>}
  </div>
}
