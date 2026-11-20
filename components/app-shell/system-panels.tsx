'use client'
import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { api, useAppShell } from './shell'
import { ReferenceActor } from '@/components/v25/presentation'
import type { DogView } from '@/lib/adoption/view'

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
      <div className="profile-character">
        <ReferenceActor assembly={dog.assembly} />
      </div>
      <form onSubmit={save}>
        <label htmlFor="rename">它的名字</label>
        <input
          id="rename"
          className="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          aria-describedby="rename-help"
          required
        />
        <p className="hint" id="rename-help">
          名字规则沿用领养页：1–6个字。
        </p>
        <button className="primary" disabled={busy}>
          {busy ? '正在记下…' : '保存这个称呼'}
        </button>
        <p className="panel-feedback" role="status">
          {notice}
        </p>
      </form>
      <h3>三个性格词</h3>
      <p>{dog.personalityTags.join(' · ')}</p>
      <p className="fine">外观修改位置已预留，当前不开放重新选择表情。</p>
    </>
  )
}
export function SettingsPanel({ active = true }: { active?: boolean }) {
  const { session, bindings, committed, reducedMotion, setReducedMotion, closePanel, refresh } = useAppShell()
  const Preferences = bindings.PreferencesBody
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
      <p>把这里调成舒服的样子。</p>
      <label className="setting-row">
        <span>减少动态效果</span>
        <input
          type="checkbox"
          checked={reducedMotion}
          onChange={(e) => setReducedMotion(e.target.checked)}
        />
      </label>
      <p className="hint">当前均为静态画面；该偏好会传给后续动画接口。</p>
      {Preferences && session?.dog && <Preferences dogId={session.dog.id} reducedMotion={reducedMotion}
        active={active} onClose={closePanel} onCommitted={committed} />}
      <div className="settings-section">
        <h3>账号与授权</h3>
        <p>
          当前为测试身份，知乎资料为模拟内容。真实知乎登录接入后需要重新领养；测试伙伴不会转入真实账号。
        </p>
        <button
          disabled={busy}
          onClick={() => {
            void logout()
          }}
        >
          退出测试身份
        </button>
        <p role="alert">{error}</p>
      </div>
    </>
  )
}
