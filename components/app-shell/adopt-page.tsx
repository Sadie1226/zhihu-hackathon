'use client'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import {
  EXCLUSIVE_PAIRS,
  INTEREST_CATEGORIES,
  type TspfAssembly,
  type InterestCategory,
} from '@/contracts/types'
import type {
  AdoptionDraft,
  DogView,
  GenerationView,
  ProfileView,
} from '@/lib/adoption/view'
import { api, useAppShell } from './shell'
import { useFeedback } from './use-feedback'
import { isTspfAssembly } from '@/contracts/assembly'
import { chooseWear, wardrobeCatalogue, wardrobeDefault, wardrobeThumbnail } from '@/lib/adoption/wardrobe'
import { createRequestId } from '@/lib/adoption/request-id'
import { resolveTspfPlan } from '@/lib/appearance/tspf-plan'
import { wardrobeRoot } from '@/lib/adoption/wardrobe'
import {
  A,
  Frame,
  World,
  Stationery,
  cssVars,
  type AdoptionStep,
} from '@/components/v25/presentation'

type AuthState =
  | 'entry'
  | 'waiting'
  | 'success'
  | 'cancel'
  | 'failure'
  | 'reading'
  | 'empty'
  | 'partial'
type ResultState = 'loading' | 'result' | 'failure'
const sectionNames = {
  basic: '基础资料',
  collections: '收藏',
  followees: '关注',
  contents: '创作',
}
const sectionStatus = {
  ok: '成功',
  empty: '暂无可用内容',
  error: '失败',
  unauthorized: '未授权',
}
const sayings = [
  ['我想去看看小路的另一头。', '家里的阳光，也很值得研究。'],
  ['遇见新朋友，我会先打个招呼。', '先坐在旁边，慢慢熟悉。'],
  ['今天的小发现，我想多说一点。', '我会把喜欢，轻轻放在你身边。'],
  ['这块石头，好像藏着一个故事。', '我想听听，路上的人怎么生活。'],
  ['喜欢的事，我会直接告诉你。', '我想换个温柔的说法。'],
  ['先收好今天这一束光。', '旧故事，也值得再听一遍。'],
]
const motions = [
  ['探头望向窗外', '坐回小垫子'],
  ['抬手打招呼', '小幅低头，偷偷看你'],
  ['冒出两三个小对话泡', '留一个安静的省略号'],
  ['看向窗边植物', '转头看向你'],
  ['我想去看看。', '要不要，一起看看？'],
  ['接住窗边飘来的叶子', '看一眼旁边的小相片'],
]
const emptyDraft: AdoptionDraft = {
  name: '',
  interestCategories: null,
  tendencies: [0, 0, 0, 0, 0, 0],
}
export default function AdoptPage() {
  const { session, error, refresh } = useAppShell()
  const emitFeedback = useFeedback()
  const traitFeedback = (i: number, value: number, release: boolean) => {
    setFeedback({ i, value, release })
    emitFeedback({ kind: 'personality', target: 'adoption-traits', dimension: i, value,
      phase: release ? 'release' : 'change', strength: Math.abs(value - 50) / 50 })
  }
  const router = useRouter()
  const [step, setStep] = useState<AdoptionStep>('auth')
  const [auth, setAuth] = useState<AuthState>('entry')
  const [profile, setProfile] = useState<ProfileView | null>(null)
  const [draft, setDraft] = useState<AdoptionDraft>(emptyDraft)
  const [assembly, setAssembly] = useState<TspfAssembly>(wardrobeDefault)
  const [generation, setGeneration] = useState<GenerationView | null>(null)
  const [generatedState, setGeneratedState] = useState<ResultState>('loading')
  const [creationState, setCreationState] = useState<ResultState>('loading')
  const [created, setCreated] = useState<DogView | null>(null)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [attempted, setAttempted] = useState(false)
  const [interestError, setInterestError] = useState('')
  const [tab, setTab] = useState<keyof TspfAssembly>('cloth')
  const [feedback, setFeedback] = useState<{
    i: number
    value: number
    release: boolean
  } | null>(null)
  const requestId = useRef<string | null>(null)
  const version = useRef(0)
  const operation = useRef(0)
  const mounted = useRef(true)
  const loggingIn = useRef(false)
  const draftScope = useRef<string | null>(null)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      operation.current++
    }
  }, [])
  useEffect(() => {
    if (session?.dog && !created) router.replace('/home')
  }, [session, created, router])
  useEffect(() => {
    const scope = session?.draftScope ?? null
    if (scope === draftScope.current) return
    draftScope.current = scope
    if (!loggingIn.current) {
      operation.current++
      setBusy(false)
      setAuth('entry')
      setStep('auth')
    }
    version.current++
    setCreated(null)
    setProfile(null)
    setGeneration(null)
    setDraft(emptyDraft)
    setAssembly(wardrobeDefault)
    requestId.current = null
    if (scope)
      try {
        const raw = JSON.parse(
          sessionStorage.getItem(`v25-adoption:${scope}`) ?? 'null',
        )
        if (
          raw?.draft &&
          typeof raw.draft.name === 'string' &&
          Array.isArray(raw.draft.tendencies) &&
          raw.draft.tendencies.length === 6 &&
          raw.draft.tendencies.every(
            (v: unknown) =>
              typeof v === 'number' && Number.isFinite(v) && v >= -2 && v <= 2,
          ) &&
          (raw.draft.interestCategories === null ||
            (Array.isArray(raw.draft.interestCategories) &&
              raw.draft.interestCategories.every((v: unknown) =>
                INTEREST_CATEGORIES.includes(v as InterestCategory),
              )))
        ) {
          setDraft(raw.draft)
          if (raw.version === 'tspf-r2-v1' && isTspfAssembly(raw.assembly)) setAssembly(raw.assembly)
          else setNotice('穿搭已更新，请重新选择；名字和兴趣已保留。')
          if (raw.version === 'tspf-r2-v1' && isTspfAssembly(raw.assembly) && typeof raw.requestId === 'string')
            requestId.current = raw.requestId
        }
      } catch {
        /* Invalid/local storage is optional; the server validates all submitted data. */
      }
  }, [session?.draftScope])
  function persist(nextDraft = draft, nextAssembly = assembly) {
    const scope = draftScope.current
    if (scope)
      try {
        sessionStorage.setItem(
          `v25-adoption:${scope}`,
          JSON.stringify({
            version: 'tspf-r2-v1',
            draft: nextDraft,
            assembly: nextAssembly,
            requestId: requestId.current,
          }),
        )
      } catch {
        /* In-memory steps continue if storage is unavailable. */
      }
  }
  function go(next: AdoptionStep) {
    setNotice('')
    setStep(next)
    window.scrollTo(0, 0)
  }
  function change(next: AdoptionDraft) {
    version.current++
    setDraft(next)
    setGeneration(null)
    requestId.current = null
    persist(next)
  }
  const nameError = () =>
    !draft.name.trim()
      ? '先给它一个名字吧。'
      : Array.from(draft.name.trim()).length > 6
        ? '名字最多 6 个字，想一个短一点的称呼吧。'
        : Array.from(draft.name).some(
              (c) => c.codePointAt(0)! < 32 || c.codePointAt(0) === 127,
            )
          ? '名字里不能包含换行或控制字符。'
          : ''
  const failures =
    profile &&
    Object.entries(profile.sections).filter(
      ([key, value]) =>
        key !== 'basic' && ['error', 'unauthorized'].includes(value.status),
    )
  async function readProfile() {
    if (busy) return
    const stamp = ++operation.current
    setBusy(true)
    setNotice('')
    setAuth('reading')
    try {
      if (!session?.authenticated) {
        loggingIn.current = true
        setAuth('waiting')
        await api('/api/auth/development', {})
        await refresh()
      }
      if (!mounted.current || stamp !== operation.current) return
      setAuth('reading')
      const result = await api<ProfileView>('/api/adoption/profile', {})
      if (!mounted.current || stamp !== operation.current) return
      setProfile(result)
      setGeneration(null)
      version.current++
      if (result.sections.basic.status !== 'ok') {
        setAuth('failure')
        setNotice('基础身份尚未确认，请重试。')
      } else if (
        Object.entries(result.sections).some(
          ([k, v]) =>
            k !== 'basic' && ['error', 'unauthorized'].includes(v.status),
        )
      )
        setAuth('partial')
      else
        setAuth(
          Object.entries(result.sections)
            .filter(([k]) => k !== 'basic')
            .every(([, v]) => v.status === 'empty')
            ? 'empty'
            : 'success',
        )
    } catch (e) {
      if (mounted.current && stamp === operation.current) {
        setAuth('failure')
        setNotice(e instanceof Error ? e.message : '这次没能连上，请重试。')
      }
    } finally {
      loggingIn.current = false
      if (mounted.current && stamp === operation.current) {
        setBusy(false)
      }
    }
  }
  async function generate() {
    if (busy || !profile || profile.sections.basic.status !== 'ok') return
    if (nameError()) {
      setAttempted(true)
      go('profile')
      return
    }
    const stamp = ++operation.current
    const revision = version.current
    setBusy(true)
    setNotice('')
    setGeneratedState('loading')
    go('tags')
    try {
      const result = await api<GenerationView>(
        '/api/adoption/personality',
        draft,
      )
      if (
        mounted.current &&
        stamp === operation.current &&
        revision === version.current
      ) {
        setGeneration(result)
        setGeneratedState('result')
      }
    } catch (e) {
      if (mounted.current && stamp === operation.current) {
        setGeneratedState('failure')
        setNotice(e instanceof Error ? e.message : '这次没能整理好。')
      }
    } finally {
      if (mounted.current && stamp === operation.current) setBusy(false)
    }
  }
  async function create() {
    if (busy || !generation) return
    const stamp = ++operation.current
    setBusy(true)
    setNotice('')
    setCreationState('loading')
    go('creation')
    try {
      requestId.current ??= createRequestId()
      persist()
      await Promise.all(resolveTspfPlan(assembly).layers.map(layer => new Promise<void>((resolve, reject) => {
        const image = new Image()
        const timeout = window.setTimeout(() => reject(new Error('穿搭图像读取超时，请保留选择后重试。')), 10000)
        image.onload = () => { window.clearTimeout(timeout); resolve() }
        image.onerror = () => { window.clearTimeout(timeout); reject(new Error('穿搭图像未能载入，请保留选择后重试。')) }
        image.src = `${wardrobeRoot}/${layer.path}`
      })))
      if (!mounted.current || stamp !== operation.current) return
      const result = await api<{ dog: DogView }>('/api/dogs', {
        ...draft,
        assembly,
        fingerprint: generation.fingerprint,
        requestId: requestId.current,
      })
      if (mounted.current && stamp === operation.current) {
        setCreated(result.dog)
        setCreationState('result')
        await refresh()
      }
    } catch (e) {
      if (mounted.current && stamp === operation.current) {
        setCreationState('failure')
        setNotice(e instanceof Error ? e.message : '这次没能安顿下来。')
      }
    } finally {
      if (mounted.current && stamp === operation.current) setBusy(false)
    }
  }
  const button = (
    text: string,
    action: () => void,
    primary = false,
    disabled = false,
  ) => (
    <button
      type="button"
      className={primary ? 'primary' : undefined}
      disabled={disabled}
      onClick={action}
    >
      {text}
    </button>
  )
  const actions = (...children: ReactNode[]) => (
    <div className="actions">
      {children.map((child, i) => (
        <span key={i} className="action-slot">
          {child}
        </span>
      ))}
    </div>
  )
  function nextProfile(skip = false) {
    setAttempted(true)
    if (nameError()) return
    if (!skip && draft.interestCategories?.length === 1) {
      setInterestError('已选 1 类，再选 1 类就好；也可以跳过兴趣。')
      return
    }
    if (skip) change({ ...draft, interestCategories: null })
    go('traits')
  }
  let body: ReactNode,
    greeting = '你好呀，我在这里等你。'
  let variant: 'room' | 'character' | 'entry' = 'room'
  if (step === 'auth') {
    const copy = {
      entry: [
        '先认识你，再认识它。',
        '用知乎账号开始领养，让它带着一点你的兴趣，走进自己的日常。',
      ],
      waiting: session?.provider === 'development'
        ? ['正在确认测试身份。', '确认后会继续读取模拟资料。']
        : ['去知乎，打个招呼。', '请在知乎授权页确认，完成后回到这里。'],
      success: [
        '已经认识你啦。',
        '账号身份确认成功，接下来给看山一个属于你的称呼。',
      ],
      cancel: [
        '没关系，慢慢来。',
        '你取消了这次授权。还没有创建账号或看山，想好了可以重新开始。',
      ],
      failure: session?.provider === 'development'
        ? ['这次没能完成读取。', '身份或资料尚未确认，可以重试后继续。']
        : ['这次没能连上知乎。', '账号身份尚未确认，请重新授权后继续。'],
      reading: [
        '正在了解你的兴趣。',
        '正在读取已授权的资料，不会在这里创建看山。',
      ],
      empty: [
        '留白，也可以是开始。',
        '这次读取成功，但收藏、关注和创作暂无可用内容。',
      ],
      partial: [
        '有些资料，暂时没读到。',
        '账号身份已确认；失败项与“没有内容”不同。',
      ],
    }[auth]
    const results = profile && (
      <>
        {Object.entries(profile.sections).map(([key, value], i) => (
          <span key={key}>
            {i > 0 && <br />}
            {sectionNames[key as keyof typeof sectionNames]}：
            {sectionStatus[value.status]}
          </span>
        ))}
      </>
    )
    body = (
      <>
        <img
          className="welcome"
          src={`${A}welcome.png`}
          width="120"
          height="102"
          alt="一封带蓝色丝带的像素欢迎信"
        />
        <div className="eyebrow">从这里，成为伙伴 · 01</div>
        <h1>{copy[0]}</h1>
        <p className="lead">{copy[1]}</p>
        {auth === 'entry' ? (
          <Stationery title="带着一点你的兴趣，开始认识彼此。">
            <div className="scope">
              {[
                ['基础资料', '确认账号身份与基本信息'],
                ['收藏', '参考你愿意收好的内容'],
                ['关注', '参考你持续留意的方向'],
                ['创作', '参考你公开表达的主题'],
              ].map(([title, description]) => (
                <div key={title}>
                  <strong>{title}</strong>
                  <span>{description}</span>
                </div>
              ))}
            </div>
            <p className="fine">
              用于注册和初始性格生成。你手动调节的倾向优先于知乎资料；穿搭由你自己选。
            </p>
          </Stationery>
        ) : (
          <Stationery
            title={
              auth === 'reading'
                ? '账号身份已确认'
                : auth === 'partial'
                  ? '读取结果 · 模拟资料'
                  : auth === 'success'
                    ? '测试账号 · 已进入'
                    : auth === 'empty'
                      ? '没有内容 ≠ 读取失败'
                      : auth === 'waiting'
                        ? '等待身份确认'
                        : '授权未完成'
            }
            appearance={
              auth === 'success'
                ? 'success'
                : auth === 'reading' || auth === 'waiting'
                  ? 'waiting'
                  : auth === 'failure' || auth === 'partial'
                    ? 'failure'
                    : 'cancel'
            }
            error={auth === 'failure' || auth === 'partial'}
          >
            {notice || results || (
              auth === 'reading'
                ? '正在获取基础资料、收藏、关注与创作，请稍候。'
                : auth === 'waiting'
                  ? '正在确认身份，请稍候。'
                  : '这次还没有创建看山，想好了可以重新开始。'
            )}
          </Stationery>
        )}
        {auth === 'entry'
          ? actions(
              button(
                session?.provider === 'unavailable'
                  ? '知乎登录尚未开放'
                  : '以测试身份开始 →',
                () => {
                  void readProfile()
                },
                true,
                session?.provider === 'unavailable' || !session || busy,
              ),
            )
          : auth === 'partial'
            ? actions(
                button(
                  '重试读取',
                  () => {
                    void readProfile()
                  },
                  false,
                  busy,
                ),
                button('仅用已读资料继续 →', () => go('profile'), true, busy),
              )
            : ['success', 'empty'].includes(auth)
              ? actions(
                  button('继续，给它起个名字 →', () => go('profile'), true),
                )
              : ['waiting', 'reading'].includes(auth)
                ? actions(button('资料读取中…', () => {}, false, true))
                : actions(
                    button(
                      '重新读取 →',
                      () => {
                        void readProfile()
                      },
                      true,
                      busy,
                    ),
                  )}
        <p className="fine">
          {session?.provider === 'unavailable'
            ? '真实知乎登录将在取得凭证后开放。'
            : '当前为测试身份，资料为模拟内容；授权只提供性格参考，不替你选择它的名字和外观。'}
        </p>
        {error && (
          <p role="alert">
            {error}{' '}
            {button('重新读取身份', () => {
              void refresh()
            })}
          </p>
        )}
      </>
    )
  } else if (step === 'profile') {
    greeting = '以后，你会怎么叫我？'
    const count = draft.interestCategories?.length ?? 0
    body = (
      <>
        <div className="eyebrow">先从一个名字开始 · 02</div>
        <h1>以后，就这样叫你吧。</h1>
        <p className="lead">给它一个称呼，再告诉它一些你喜欢的事。</p>
        <div className="field">
          <label htmlFor="dog-name">
            它的名字 <span className="required">· 必填</span>
            <span className="count hint">
              {Array.from(draft.name.trim()).length} / 6
            </span>
          </label>
          <input
            className="name"
            id="dog-name"
            autoComplete="off"
            placeholder="例如：小山"
            value={draft.name}
            aria-invalid={!!(attempted && nameError())}
            aria-describedby="name-help name-error"
            onChange={(e) => change({ ...draft, name: e.target.value })}
            onBlur={() => {
              setAttempted(true)
              if (draft.name !== draft.name.trim())
                change({ ...draft, name: draft.name.trim() })
            }}
          />
          <p className="hint" id="name-help">
            以后也可以改名字。名字规则：1–6 个字。
          </p>
          <p className="hint error-text" id="name-error" role="status">
            {attempted && nameError()}
          </p>
        </div>
        <div className="field">
          <div id="interest-label">
            你想和它一起留意什么？ <span className="hint">· 可选</span>
          </div>
          <div className="chips" role="group" aria-labelledby="interest-label">
            {INTEREST_CATEGORIES.map((category, i) => (
              <button
                key={category}
                className="chip"
                type="button"
                aria-pressed={
                  draft.interestCategories?.includes(category) ?? false
                }
                onClick={() => {
                  setInterestError('')
                  const current = draft.interestCategories ?? []
                  if (current.includes(category)) {
                    const next = current.filter((c) => c !== category)
                    change({
                      ...draft,
                      interestCategories: next.length ? next : null,
                    })
                  } else if (current.length === 3)
                    setInterestError('最多选 3 类。先取消一类，再选新的吧。')
                  else
                    change({
                      ...draft,
                      interestCategories: [...current, category],
                    })
                }}
              >
                <img
                  width="30"
                  height="30"
                  src={`${A}interest-${i}.png`}
                  alt=""
                />
                <span>{category}</span>
              </button>
            ))}
          </div>
          <p
            className={`hint${interestError ? ' error-text' : ''}`}
            role="status"
          >
            {interestError ||
              (count === 0
                ? '还没选也没关系，可以先跳过。'
                : count === 1
                  ? '已选 1 类，再选 1 类就好；也可以跳过兴趣。'
                  : count === 2
                    ? '已选 2 类，刚刚好；还可以再选 1 类。'
                    : '已选 3 类，可以继续；想换一类，先取消已选。')}
          </p>
        </div>
        {actions(
          button('← 返回授权结果', () => go('auth')),
          button('继续，认识它的性格 →', () => nextProfile(), true),
        )}
        <button className="text-button" onClick={() => nextProfile(true)}>
          先跳过兴趣
        </button>
        <p className="fine">
          跳过只清空兴趣，名字仍需填写；返回不会丢失本地选择。
        </p>
      </>
    )
  } else if (step === 'traits') {
    greeting = feedback?.release
      ? sayings[feedback.i][feedback.value > 50 ? 1 : 0]
      : '你好呀，慢慢认识我吧。'
    body = (
      <>
        <div className="eyebrow">认识它 · 03</div>
        <h1>它更像哪一种伙伴？</h1>
        <p className="lead">
          把小滑块挪向你喜欢的一边，也可以留在中间。
          <br />
          你的选择，会比知乎信息更优先影响它的初始性格。
        </p>
        <div className="sliders">
          {EXCLUSIVE_PAIRS.map(([left, right], i) => {
            const v = Math.round(draft.tendencies[i] * 25 + 50),
              offset = (v - 50) / 50
            const size = (x: number) =>
              Math.round(24 + (x >= 0 ? 8 * x : 6 * x))
            return (
              <div
                className={`trait${feedback?.i === i && !feedback.release ? ' dragging' : ''}`}
                key={left}
              >
                <div className="trait-labels">
                  <span
                    className="trait-end left"
                    style={cssVars({ '--trait-size': `${size(-offset)}px`, '--trait-scale': size(-offset) / 24 })}
                  >
                    {left}
                  </span>
                  <span
                    className="trait-end right"
                    style={cssVars({ '--trait-size': `${size(offset)}px`, '--trait-scale': size(offset) / 24 })}
                  >
                    {right}
                  </span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="5"
                  value={v}
                  aria-label={`${left}到${right}`}
                  aria-valuetext={
                    v === 50 ? '两边同样喜欢' : `偏向${v < 50 ? left : right}`
                  }
                  aria-describedby="slider-help"
                  style={cssVars({ '--value': `${v}%` })}
                  onChange={(e) => {
                    const value = Number(e.target.value)
                    change({
                      ...draft,
                      tendencies: draft.tendencies.map((x, j) =>
                        i === j ? (value - 50) / 25 : x,
                      ),
                    })
                    traitFeedback(i, value, false)
                  }}
                  onPointerUp={(e) =>
                    traitFeedback(i, Number(e.currentTarget.value), true)
                  }
                  onKeyUp={(e) => {
                    if (
                      [
                        'ArrowLeft',
                        'ArrowRight',
                        'ArrowUp',
                        'ArrowDown',
                        'Home',
                        'End',
                      ].includes(e.key)
                    )
                      traitFeedback(i, Number(e.currentTarget.value), true)
                  }}
                />
              </div>
            )
          })}
        </div>
        <details className="slider-instructions"><summary>操作说明</summary><p id="slider-help" className="mini">
          拖向哪一端，哪一端的字就大一点。可点击轨道或用方向键调节。
        </p></details>
        <Stationery
          id="trait-feedback"
          title={
            feedback?.release
              ? '我记住你的偏好啦。'
              : feedback
                ? '慢慢挪，看看更喜欢哪一边。'
                : '慢慢认识彼此'
          }
          appearance={
            feedback?.release ? 'success' : feedback ? 'waiting' : 'cancel'
          }
        >
          {feedback?.release
            ? feedback.value === 50
              ? '都可以，慢慢认识。'
              : sayings[feedback.i][feedback.value > 50 ? 1 : 0]
            : feedback
              ? '字的大小，只表达你此刻的偏向。'
              : '不用急着选定，每一种倾向都很好。'}
        </Stationery>
        {actions(
          button('← 上一步', () => go('profile')),
          button(
            '看看它的三个词 →',
            () => {
              if (generation) {
                setGeneratedState('result')
                go('tags')
              } else void generate()
            },
            true,
            busy,
          ),
        )}
        <p className="fine">
          当前展示静止画面；角色动作接口保留，尚未启用动画。
        </p>
      </>
    )
  } else if (step === 'tags') {
    greeting = '我的小性格，正在慢慢成形。'
    const loading = generatedState === 'loading',
      failed = generatedState === 'failure'
    body = (
      <>
        <div className="eyebrow">认识它 · 04</div>
        <h1>
          {loading
            ? '把小小的倾向，收成三个词。'
            : failed
              ? '这次，还没找到合适的词。'
              : '原来，你喜欢这样的伙伴。'}
        </h1>
        <p className="lead">不是把它定死，只是给未来的相处一个开始。</p>
        {loading ? (
          <>
            <Stationery title="正在整理它的初始性格" appearance="waiting">
              先参考你选的倾向，再看看已读资料。不用重复提交。
            </Stationery>
            <div className="waiting-steps">
              <span>整理手动倾向</span>
              <span>参考可用资料</span>
              <span>收成三个词</span>
            </div>
            {actions(button('← 返回修改倾向', () => go('traits'), false, true))}
          </>
        ) : failed ? (
          <>
            <Stationery title="生成暂时失败" error appearance="failure">
              {notice ||
                '可能是网络或服务暂时不可用。名字、兴趣和倾向都还在，不会用默认结果冒充成功。'}
            </Stationery>
            {actions(
              button('← 返回倾向', () => go('traits')),
              button(
                '再试一次 →',
                () => {
                  void generate()
                },
                true,
              ),
            )}
          </>
        ) : (
          <>
            <div className="tag-list">
              {generation?.tags.map((tag, i) => {
                const dimension = EXCLUSIVE_PAIRS.findIndex((pair) =>
                  pair.includes(tag),
                )
                return (
                  <article className="personality-card" key={tag}>
                    <div className="tag-top">
                      <span>0{i + 1}</span>
                      <span>{EXCLUSIVE_PAIRS[dimension].join(' / ')}</span>
                    </div>
                    <h2>{tag}</h2>
                    <p>
                      {draft.tendencies[dimension] !== 0
                        ? '参考了你手动选择的倾向。'
                        : '这一维参考了模拟资料，未进行真实知乎分析。'}
                    </p>
                  </article>
                )
              })}
            </div>
            <Stationery title="这三个词，是认识它的起点。" appearance="success">
              你的手动倾向优先；三个词来自不同维度，外观仍由你自由挑选。
            </Stationery>
            <p className="fine">
              模拟资料生成 · 未读取真实知乎数据
              {failures?.length ? ' · 资料读取失败的部分未作为空数据使用' : ''}
            </p>
            {actions(
              button('← 修改倾向', () => go('traits')),
              button('去挑一套穿搭 →', () => go('wardrobe'), true),
            )}
          </>
        )}
      </>
    )
  } else if (step === 'wardrobe') {
    variant = 'character'
    const c = wardrobeCatalogue[tab]
    body = (
      <>
        <div className="eyebrow">由你挑选 · 05</div>
        <h1>把喜欢，穿在身上。</h1>
        <p className="lead">
          性格没有指定的制服。挑一件衣服，再加一点自己的偏爱。
        </p>
        <div className="wardrobe-tabs" role="group" aria-label="穿搭分类">
          {(Object.keys(wardrobeCatalogue) as (keyof TspfAssembly)[]).map((key) => (
            <button
              key={key}
              aria-pressed={tab === key}
              onClick={() => setTab(key)}
            >
              {wardrobeCatalogue[key].label}
            </button>
          ))}
        </div>
        <div
          className="wardrobe-options"
          data-count={c.items.length}
          role="group"
          aria-label={`${c.label}选项`}
        >
          {c.items.map(([value, label]) => (
            <button
              key={value}
              className="outfit-option"
              aria-pressed={assembly[tab] === value}
              disabled={tab === 'accessory' && assembly.outfit !== null}
              onClick={() => {
                const next = chooseWear(assembly, tab, value)
                if (JSON.stringify(next) === JSON.stringify(assembly)) return
                setAssembly(next)
                requestId.current = null
                persist(draft, next)
              }}
            >
              <img
                src={wardrobeThumbnail(value)}
                width="96"
                height="96"
                alt=""
              />
              <span>{label}</span>
              {assembly[tab] === value && <small>已选</small>}
            </button>
          ))}
        </div>
        <p className="hint" role="status">
          {assembly.outfit ? '套装不能叠加饰品，请先选一件衣服。' : '预览与保存使用同一套穿搭。'}
        </p>
        <Stationery title="是你选的，就是它的样子。" appearance="success">
          套装或衣服必须选一件，饰品最多一件；不按标签自动换装。
        </Stationery>
        {actions(
          button('← 看看三个词', () => go('tags')),
          button(
            '就这样，成为伙伴 →',
            () => {
              void create()
            },
            true,
            busy,
          ),
        )}
      </>
    )
  } else {
    const loading = creationState === 'loading',
      failed = creationState === 'failure'
    variant = loading || failed ? 'character' : 'entry'
    greeting = loading
      ? '我在门边等你。'
      : failed
        ? '没关系，我们再试一次。'
        : '以后，这里就是我们的日常。'
    body = (
      <>
        <div className="eyebrow">成为伙伴 · 06</div>
        <h1>
          {loading
            ? '给它留一盏回家的灯。'
            : failed
              ? '这次，还没能安顿下来。'
              : `${created?.name ?? draft.name}，以后请多关照。`}
        </h1>
        <p className="lead">
          {loading
            ? '正在保存名字、三个性格词和你挑好的穿搭。'
            : failed
              ? '刚才的选择都保留着，不需要从头填写。'
              : '这就是你选的伙伴。它有自己的日常，也会带着小发现来找你。'}
        </p>
        <Stationery
          title={
            loading ? '正在创建' : failed ? '创建暂时失败' : '这就是你的看山'
          }
          appearance={loading ? 'waiting' : failed ? 'failure' : 'success'}
          error={failed}
        >
          {loading
            ? '等待完成后，再一起进小屋。'
            : failed
              ? notice ||
                '可能是网络或服务暂时不可用。重试使用同一份创建内容，避免重复创建。'
              : '名字、性格与穿搭已保存，可以一起进入小屋。'}
        </Stationery>
        {!loading && (
          <div className="adoption-recap">
            <span>名字</span>
            <strong>{created?.name ?? draft.name}</strong>
            <span>性格</span>
            <strong>
              {(created?.personalityTags ?? generation?.tags ?? []).join(' · ')}
            </strong>
            <span>穿搭</span>
            <strong>
              {(Object.keys(wardrobeCatalogue) as (keyof TspfAssembly)[])
                .map(
                  (key) =>
                    wardrobeCatalogue[key].items.find(
                      ([v]) => v === assembly[key],
                    )?.[1],
                )
                .join(' · ')}
            </strong>
          </div>
        )}
        {loading
          ? actions(button('正在保存…', () => {}, false, true))
          : failed
            ? actions(
                button('← 修改穿搭', () => go('wardrobe')),
                button(
                  '保留选择，再试一次 →',
                  () => {
                    void create()
                  },
                  true,
                ),
              )
            : actions(
                button(
                  '进入它的小屋 →',
                  () => {
                    router.replace('/home')
                  },
                  true,
                ),
              )}
        <p className="fine">
          {loading
            ? '正在确认保存结果。'
            : failed
              ? '尚未确认创建结果，重试会保留本次创建标识。'
              : '已保存到当前测试身份；真实知乎账号需要重新领养。'}
        </p>
      </>
    )
  }
  return (
    <Frame step={step}>
      <main id="content" tabIndex={-1}>
        <World
          greeting={greeting}
          assembly={assembly}
          variant={variant}
          motion={
            step === 'traits' && feedback?.release ? (
              <div id="motion-preview">
                <span className="motion-tag">松手动作预留 · 静态说明</span>
                <strong>
                  {feedback.value === 50
                    ? '保持自然站姿'
                    : motions[feedback.i][feedback.value > 50 ? 1 : 0]}
                </strong>
                <span>当前角色保持站姿，未播放动画</span>
              </div>
            ) : undefined
          }
        />
        <section id="paper">{body}</section>
      </main>
    </Frame>
  )
}
