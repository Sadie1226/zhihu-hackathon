'use client'
import { useRef, useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import {
  EXCLUSIVE_PAIRS,
  INTEREST_CATEGORIES,
  type Assembly,
  type InterestCategory,
} from '@/contracts/types'
import type {
  AdoptionDraft,
  DogView,
  GenerationView,
  ProfileView,
} from '@/lib/adoption/view'
import { api, useAppShell } from './shell'
import { DogArt, TestBadge } from './visuals'
import s from './shell.module.css'

const initial: Assembly = {
  cloth: 'hoodie',
  hat: 'none',
  glasses: 'none',
  face: 'happy',
}
const optionLabels: Record<string, string> = {
  hoodie: '连帽衫',
  jacket: '夹克',
  sweater: '毛衣',
  raincoat: '雨衣',
  apron: '围裙',
  'scarf-coat': '围巾外套',
  none: '不戴',
  beanie: '针织帽',
  cap: '鸭舌帽',
  straw: '草帽',
  round: '圆框',
  square: '方框',
  sun: '墨镜',
  happy: '开心',
  tired: '困倦',
  hopeful: '期待',
  waiting: '等候',
}
export default function AdoptPage() {
  const { session, error, refresh } = useAppShell()
  const router = useRouter()
  const [profile, setProfile] = useState<ProfileView | null>(null)
  const [draft, setDraft] = useState<AdoptionDraft>({
    name: '',
    interestCategories: null,
    tendencies: [0, 0, 0, 0, 0, 0],
  })
  const [assembly, setAssembly] = useState(initial)
  const [generation, setGeneration] = useState<GenerationView | null>(null)
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [continued, setContinued] = useState(false)
  const requestId = useRef<string | null>(null)
  const version = useRef(0)
  useEffect(() => {
    if (session?.dog) router.replace('/home')
  }, [session, router])
  function change(next: AdoptionDraft) {
    version.current++
    setDraft(next)
    setGeneration(null)
    requestId.current = null
  }
  async function run(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setNotice('')
    try {
      await action()
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '这次没记住，可以再试一次',
      )
    } finally {
      setBusy(false)
    }
  }
  async function readProfile() {
    const value = await api<ProfileView>('/api/adoption/profile', {})
    setProfile(value)
    setContinued(false)
    setGeneration(null)
    requestId.current = null
    version.current++
  }
  const failures =
    profile &&
    Object.entries(profile.sections).filter(
      ([key, value]) =>
        key !== 'basic' && ['error', 'unauthorized'].includes(value.status),
    )
  const canGenerate =
    profile?.sections.basic.status === 'ok' && (!failures?.length || continued)
  if (!session)
    return (
      <main className={s.page}>
        <h1>先认识一下</h1>
        <p role="status">{error || '正在读取身份…'}</p>
        {error && (
          <button
            onClick={() => {
              void refresh()
            }}
          >
            重新读取
          </button>
        )}
      </main>
    )
  if (session.provider === 'unavailable')
    return (
      <main className={s.page}>
        <h1>看山出门</h1>
        <div className={s.card}>
          <p>知乎登录尚未开放。</p>
          <p>
            按接入安排，12 月 5
            日取得凭证后开放真实授权。开发预览需要在独立测试库中启用测试身份。
          </p>
        </div>
      </main>
    )
  return (
    <main className={s.page}>
      <p className={s.muted}>看山出门 / 认识新伙伴</p>
      <h1>从一个小小的名字开始</h1>
      <TestBadge />
      <p>这里使用模拟资料。以后用真实知乎账号进入时，需要重新领养。</p>
      {!session.authenticated ? (
        <button
          className={s.primary}
          disabled={busy}
          onClick={() => {
            void run(async () => {
              await api('/api/auth/development', {})
              await refresh()
            })
          }}
        >
          以测试身份进入
        </button>
      ) : (
        <>
          <section className={s.card}>
            <h2>1 · 认识你和它</h2>
            <button
              disabled={busy}
              onClick={() => {
                void run(readProfile)
              }}
            >
              {profile ? '重新读取模拟资料' : '读取模拟知乎资料'}
            </button>
            {profile && (
              <ul>
                {Object.entries(profile.sections).map(([key, value]) => (
                  <li key={key}>
                    {
                      (
                        {
                          basic: '基础身份',
                          collections: '收藏',
                          followees: '关注',
                          contents: '创作',
                        } as Record<string, string>
                      )[key]
                    }
                    ：
                    {
                      {
                        ok: '已读取',
                        empty: '没有相关资料',
                        error: '读取失败',
                        unauthorized: '未获授权',
                      }[value.status]
                    }
                    {value.count !== undefined ? `（${value.count}）` : ''}
                  </li>
                ))}
              </ul>
            )}
            {!!failures?.length && (
              <label>
                <input
                  type="checkbox"
                  checked={continued}
                  onChange={(e) => setContinued(e.target.checked)}
                />
                我已了解失败项，继续使用成功读取的资料
              </label>
            )}
            <label className={s.field}>
              给它一个名字（1–6 个字）
              <input
                value={draft.name}
                onChange={(e) => change({ ...draft, name: e.target.value })}
                disabled={busy}
              />
            </label>
            <p>它喜欢留意什么？不选表示都愿意看看；选择时选 2–3 类。</p>
            <div className={s.choices}>
              {INTEREST_CATEGORIES.map((category) => (
                <label key={category}>
                  <input
                    type="checkbox"
                    disabled={busy}
                    checked={
                      draft.interestCategories?.includes(category) ?? false
                    }
                    onChange={(e) => {
                      const next = e.target.checked
                        ? [...(draft.interestCategories ?? []), category]
                        : draft.interestCategories!.filter(
                            (c) => c !== category,
                          )
                      change({
                        ...draft,
                        interestCategories: next.length
                          ? (next as InterestCategory[])
                          : null,
                      })
                    }}
                  />
                  {category}
                </label>
              ))}
            </div>
            <p>你愿意替它选的倾向（中间表示交给资料）：</p>
            {EXCLUSIVE_PAIRS.map(([left, right], i) => (
              <label className={s.tendency} key={left}>
                <span>{left}</span>
                <input
                  type="range"
                  min="-2"
                  max="2"
                  step="1"
                  aria-label={`${left}到${right}`}
                  value={draft.tendencies[i]}
                  disabled={busy}
                  onChange={(e) =>
                    change({
                      ...draft,
                      tendencies: draft.tendencies.map((v, j) =>
                        j === i ? Number(e.target.value) : v,
                      ),
                    })
                  }
                />
                <span>{right}</span>
              </label>
            ))}
            <button
              disabled={busy || !canGenerate}
              onClick={() => {
                void run(async () => {
                  const stamp = version.current
                  const result = await api<GenerationView>(
                    '/api/adoption/personality',
                    draft,
                  )
                  if (stamp === version.current) {
                    setGeneration(result)
                    requestId.current = null
                  }
                })
              }}
            >
              整理三个性格词
            </button>
            {generation && (
              <p role="status">{generation.tags.join(' · ')}（模拟资料生成）</p>
            )}
          </section>
          <section className={s.card}>
            <h2>2 · 带它回小屋</h2>
            <div className={s.formGrid}>
              <div>
                <div className={s.portrait}>
                  <DogArt assembly={assembly} wardrobe />
                </div>
                <p className={s.muted}>试验穿搭预览；正式穿搭尚未开放。</p>
              </div>
              <div>
                {(Object.keys(initial) as (keyof Assembly)[]).map((key) => (
                  <label key={key}>
                    {
                      {
                        cloth: '衣服',
                        hat: '帽子',
                        glasses: '眼镜',
                        face: '表情',
                      }[key]
                    }
                    <select
                      disabled={busy}
                      value={assembly[key] ?? 'none'}
                      onChange={(e) => {
                        setAssembly({ ...assembly, [key]: e.target.value })
                        requestId.current = null
                      }}
                    >
                      {{
                        cloth: [
                          'hoodie',
                          'jacket',
                          'sweater',
                          'raincoat',
                          'apron',
                          'scarf-coat',
                        ],
                        hat: ['none', 'beanie', 'cap', 'straw'],
                        glasses: ['none', 'round', 'square', 'sun'],
                        face: ['happy', 'tired', 'hopeful', 'waiting'],
                      }[key].map((value) => (
                        <option key={value} value={value}>
                          {optionLabels[value]}
                        </option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>
            <button
              className={s.primary}
              disabled={busy || !generation}
              onClick={() => {
                void run(async () => {
                  if (!generation) return
                  requestId.current ??= crypto.randomUUID()
                  await api<{ dog: DogView }>('/api/dogs', {
                    ...draft,
                    assembly,
                    fingerprint: generation.fingerprint,
                    requestId: requestId.current,
                  })
                  await refresh()
                  router.replace('/home')
                })
              }}
            >
              {busy ? '正在记下…' : '一起回小屋'}
            </button>
          </section>
        </>
      )}
      <p role="alert" className={s.alert}>
        {notice}
      </p>
    </main>
  )
}
