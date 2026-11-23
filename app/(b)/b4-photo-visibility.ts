// app/(b)/b4-photo-visibility.ts —— B 侧图片读取可见性契约（不碰公共 schema、不碰 A wiring）
//
// 依据（三处一致，2026-11-21）：
//   team/2026-11-21/a/1121-a-给B与C-请求-已合集成取用与剩余接口收口-v1.md:13
//   team/STATUS.md:241
//   a-wiring-1120 / 1120-a-wiring-给B-组件与回应续接请求-v2.md:29
// 原文红线：「不能只限上传本人而使合法收件人看不到图」。
//
// 当前实现是 capability URL：文件名 s_<owner64>_<random16>.<ext> 不可伪造，
// 任何持有链接者（上传者本人或合法收件人）都能读；无链接者猜不到。这条模型
// 同时满足「收件人可见」与「不靠页面猜归属」。
//
// 本模块只固化 B 拥有且能独立验证的部分：文件名形状、capability 语义、缓存边界。
// 身份判定 / invitation-exchange 场景归属 / 过期撤销，依赖 C 的稳定 owner 与公共
// 契约，A/B/C 对齐后由 A 接线；B 不在此伪造身份底座，也不按 session 拦截读取
// （那会让合法收件人看不到图，直接踩红线）。

/** 文件名形状与上传端 makePhotoUrl / 回应端 parseOwnPhotoUrl 共用同一口径，避免漂移。 */
export const PHOTO_NAME_RE = /^s_([0-9a-f]{64})_([0-9a-f]{16})\.(jpg|png|webp)$/

export type PhotoExt = 'jpg' | 'png' | 'webp'

export type PhotoNameDecision =
  | { ok: true; owner: string; nonce: string; ext: PhotoExt }
  | { ok: false; reason: 'shape' | 'traversal' }

/**
 * 读取前的纯分类：只认本接口产出的文件名，挡住 ../ 穿越与任意路径读取。
 * 不做身份判断——capability 链接即授权，合法收件人与上传者同等可读。
 */
export function classifyPhotoName(name: unknown): PhotoNameDecision {
  if (typeof name !== 'string') return { ok: false, reason: 'shape' }
  if (name.includes('/') || name.includes('\\') || name.includes('..')) {
    return { ok: false, reason: 'traversal' }
  }
  const match = PHOTO_NAME_RE.exec(name)
  if (!match) return { ok: false, reason: 'shape' }
  return { ok: true, owner: match[1], nonce: match[2], ext: match[3] as PhotoExt }
}

/**
 * capability 模型下「谁能读」的显式答案：持有合规链接即可读。
 * 上传者本人与合法收件人一视同仁；不存在「仅上传本人」的限制。
 * 这样 A 的红线在契约层可被单测锁定，不会因后续改路由被悄悄破坏。
 */
export function canReadByCapability(decision: PhotoNameDecision): boolean {
  return decision.ok === true
}

/**
 * 缓存边界：三方对齐前保持 B 既有行为（private，不入共享缓存），B 不单方加长。
 * 过期/撤销后的可见性属公共契约，待 A/B/C 对齐后由 A 在接线层统一实施。
 */
export const PHOTO_READ_CACHE_CONTROL = 'private, max-age=3600'
