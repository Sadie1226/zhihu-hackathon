'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { api, useAppShell } from './shell'
import { DogArt } from './visuals'
import type { DogView } from '@/lib/adoption/view'
import s from './shell.module.css'

export function ProfilePanel() {
  const { session, updateDog } = useAppShell()
  const dog = session?.dog
  const [name, setName] = useState(dog?.name ?? '')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  async function save(event: FormEvent) {
    event.preventDefault()
    if (!dog || busy) return
    setBusy(true)
    setNotice('')
    try {
      const result = await api<{ dog: DogView }>(
        `/api/dogs/${encodeURIComponent(dog.id)}/name`,
        { name },
        'PATCH',
      )
      updateDog(result.dog)
      setNotice('称呼已经记好了。')
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : '这次没记住，输入还在。',
      )
    } finally {
      setBusy(false)
    }
  }
  if (!dog) return null
  return (
    <>
      <div className={s.portrait}>
        <DogArt assembly={dog.assembly} />
      </div>
      <form onSubmit={save}>
        <label htmlFor="dog-name">它的名字</label>
        <input
          id="dog-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          aria-describedby="rename-help"
        />
        <p id="rename-help" className={s.muted}>
          1–6 个字，想换个称呼时也可以回来。
        </p>
        <button className={s.primary} disabled={busy}>
          {busy ? '正在记下…' : '保存称呼'}
        </button>
        <p role="status">{notice}</p>
      </form>
      <h3>三个性格词</h3>
      <p>{dog.personalityTags.join(' · ')}</p>
      <p className={s.muted}>测试身份 · 模拟资料生成。外观为参考预览。</p>
    </>
  )
}
export function SettingsPanel() {
  const { reducedMotion, setReducedMotion, closePanel, refresh } = useAppShell()
  const router = useRouter()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  async function logout() {
    setBusy(true)
    try {
      await api('/api/auth/logout', {})
      closePanel()
      await refresh()
      router.replace('/adopt')
    } catch {
      setError('这次没能退出，可以再试一次。')
      setBusy(false)
    }
  }
  return (
    <>
      <label className={s.setting}>
        <span>减少动态效果</span>
        <input
          type="checkbox"
          checked={reducedMotion}
          onChange={(e) => setReducedMotion(e.target.checked)}
        />
      </label>
      <p className={s.muted}>也会遵循设备的减少动态偏好。当前画面保持静止。</p>
      <h3>身份与授权</h3>
      <p>当前为测试身份，知乎资料为模拟内容。</p>
      <p>真实知乎登录接入后，需要重新领养；测试伙伴不会自动转入真实账号。</p>
      <button
        onClick={() => {
          void logout()
        }}
        disabled={busy}
      >
        退出测试身份
      </button>
      <p role="alert">{error}</p>
    </>
  )
}
