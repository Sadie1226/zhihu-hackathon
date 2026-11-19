// app/(b)/b6-photo.ts —— B6 照片归属校验（A 路径，不动契约）
// 对外：uploadUrl 形状校验 + 文件头判型 + photoUrl 三段归属判断。
import { randomUUID } from 'node:crypto'
import { readSessionId } from '@/lib/auth/session'

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024
const SESSION_PREFIX_CHARS = 8
const PHOTO_URL_RE = /^\/uploads\/s_([0-9a-z]{8})_([0-9a-z]{16})\.webp$/

/** 上传：生成 s_<session8>_<随机16>.webp，session8 取匿名 session 的哈希前 8 位。 */
export function makePhotoUrl(sessionId: string): string {
  const session8 = sessionId.replace(/^anon_/, '').slice(0, SESSION_PREFIX_CHARS).padEnd(SESSION_PREFIX_CHARS, '0')
  const rand = randomUUID().replace(/-/g, '').slice(0, 16)
  return `/uploads/s_${session8}_${rand}.webp`
}

/** 文件头判型：不看扩展名。只读前 12 字节。 */
export function detectMime(head: Uint8Array): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const hex = (b: Uint8Array) => Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('')
  if (head.length >= 3 && hex(head.slice(0, 3)) === 'ffd8ff') return 'image/jpeg'
  if (head.length >= 8 && hex(head.slice(0, 8)) === '89504e470d0a1a0a') return 'image/png'
  if (head.length >= 12 && Buffer.from(head.slice(0, 4)).toString('ascii') === 'RIFF'
      && Buffer.from(head.slice(8, 12)).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

/**
 * photoUrl 三段归属判断，全过才允许写进 reply.photo_url。
 * ① 形状 ② session 前缀 == 当前会话 ③ 文件真实存在。
 * 存在性由调用方注入 exists()（避免本模块直接碰 fs，便于测试）。
 */
export function parseOwnPhotoUrl(
  photoUrl: unknown,
  sessionId: string,
  exists: (name: string) => boolean,
): { ok: true; name: string } | { ok: false; reason: 'shape' | 'owner' | 'missing' } {
  if (typeof photoUrl !== 'string') return { ok: false, reason: 'shape' }
  const match = PHOTO_URL_RE.exec(photoUrl)
  if (!match) return { ok: false, reason: 'shape' }
  const owner = sessionId.replace(/^anon_/, '').slice(0, SESSION_PREFIX_CHARS).padEnd(SESSION_PREFIX_CHARS, '0')
  if (match[1] !== owner) return { ok: false, reason: 'owner' }
  if (!exists(photoUrl.slice('/uploads/'.length))) return { ok: false, reason: 'missing' }
  return { ok: true, name: photoUrl }
}

export { readSessionId }
