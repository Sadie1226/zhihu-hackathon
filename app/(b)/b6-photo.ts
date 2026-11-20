// app/(b)/b6-photo.ts —— B6 照片归属与内容校验（A 路径，不动公共契约）
import { createHash, randomUUID } from 'node:crypto'
import path from 'node:path'

export const MAX_PHOTO_BYTES = 5 * 1024 * 1024
export const MAX_PHOTO_SIDE = 1600

/**
 * 上传落盘目录的唯一来源：写入、回应校验、读取路由三处都调用它，避免漂移。
 * 本地默认 ./data/uploads（.gitignore 已忽略 data/）；
 * 部署由环境变量 UPLOAD_DIR 指到 /var/lib/zhihu-hackathon/uploads
 * （systemd ReadWritePaths 已放行、StateDirectory 已建好父目录，service 无需改）。
 * 不能放 public/uploads：next start 下代码目录只读，线上写入会 EACCES。
 */
export function uploadDir(): string {
  // 路径是运行时读写的上传目录，不参与 build 文件追踪（否则整个项目被打进输出）。
  return path.resolve(/* turbopackIgnore: true */ process.env.UPLOAD_DIR || './data/uploads')
}

export type PhotoMime = 'image/jpeg' | 'image/png' | 'image/webp'
export type PhotoInfo = { mime: PhotoMime; width: number; height: number }

const EXT_BY_MIME: Record<PhotoMime, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
}
// 归属取完整 session 哈希（readSessionId 返回 anon_ + 64 位十六进制），不再用前 8 位当凭证。
const PHOTO_URL_RE = /^\/uploads\/s_([0-9a-f]{64})_([0-9a-f]{16})\.(jpg|png|webp)$/

function ascii(head: Uint8Array, start: number, end: number): string {
  let out = ''
  for (let i = start; i < end && i < head.length; i += 1) out += String.fromCharCode(head[i])
  return out
}

function jpegSize(head: Uint8Array): { width: number; height: number } | null {
  if (head.length < 4 || head[0] !== 0xff || head[1] !== 0xd8) return null
  let offset = 2
  while (offset + 9 < head.length) {
    if (head[offset] !== 0xff) { offset += 1; continue }
    const marker = head[offset + 1]
    if (marker === 0xff) { offset += 1; continue }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9 || marker === 0xda) break
    const length = (head[offset + 2] << 8) | head[offset + 3]
    if (length < 2) break
    const isSof = marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)
    if (isSof) {
      const height = (head[offset + 5] << 8) | head[offset + 6]
      const width = (head[offset + 7] << 8) | head[offset + 8]
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset += 2 + length
  }
  return null
}

function pngSize(head: Uint8Array): { width: number; height: number } | null {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (head.length < 24 || signature.some((byte, index) => head[index] !== byte)) return null
  if (ascii(head, 12, 16) !== 'IHDR') return null
  const width = ((head[16] << 24) >>> 0) + (head[17] << 16) + (head[18] << 8) + head[19]
  const height = ((head[20] << 24) >>> 0) + (head[21] << 16) + (head[22] << 8) + head[23]
  return width > 0 && height > 0 ? { width, height } : null
}

function webpSize(head: Uint8Array): { width: number; height: number } | null {
  if (head.length < 30 || ascii(head, 0, 4) !== 'RIFF' || ascii(head, 8, 12) !== 'WEBP') return null
  const format = ascii(head, 12, 16)
  if (format === 'VP8X') {
    const width = 1 + head[24] + (head[25] << 8) + (head[26] << 16)
    const height = 1 + head[27] + (head[28] << 8) + (head[29] << 16)
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (format === 'VP8 ' && head[23] === 0x9d && head[24] === 0x01 && head[25] === 0x2a) {
    const width = (head[26] | (head[27] << 8)) & 0x3fff
    const height = (head[28] | (head[29] << 8)) & 0x3fff
    return width > 0 && height > 0 ? { width, height } : null
  }
  if (format === 'VP8L' && head[20] === 0x2f) {
    const width = 1 + head[21] + ((head[22] & 0x3f) << 8)
    const height = 1 + (head[22] >> 6) + (head[23] << 2) + ((head[24] & 0x0f) << 10)
    return width > 0 && height > 0 ? { width, height } : null
  }
  return null
}

/** 只看文件头：格式、真实扩展名、MIME 与边长都由字节决定，不看客户端文件名。 */
export function inspectPhoto(head: Uint8Array): PhotoInfo | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
    const size = jpegSize(head)
    return size ? { mime: 'image/jpeg', ...size } : null
  }
  if (head[0] === 137 && head[1] === 80 && head[2] === 78 && head[3] === 71) {
    const size = pngSize(head)
    return size ? { mime: 'image/png', ...size } : null
  }
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 12) === 'WEBP') {
    const size = webpSize(head)
    return size ? { mime: 'image/webp', ...size } : null
  }
  return null
}

/**
 * A 评审 v2 §2-5：inspectPhoto 只看文件头，仅签名+IHDR 尺寸而无像素数据、
 * 或中途截断的文件都会被当成有效图片。这里对全字节做结构有效性校验：
 *   - PNG：必须有 IDAT（真实像素块）与末尾 IEND，且遍历 chunk 长度不越界、CRC 自洽；
 *   - JPEG：必须 SOI 开头、EOI 结尾，且含 SOS（扫描数据起点）；
 *   - WebP：RIFF 声明长度必须与实际字节吻合，且含 VP8/VP8L/VP8X 图像块。
 * 不引入图像解码库（公共依赖不动），只做结构与结束标记校验，足以挡住截断/空壳。
 */
function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff
  for (let i = start; i < end; i += 1) {
    crc ^= bytes[i]
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & (-(crc & 1)))
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngIntegrity(bytes: Uint8Array): boolean {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10]
  if (bytes.length < 8 || signature.some((byte, i) => bytes[i] !== byte)) return false
  let offset = 8
  let sawIDAT = false
  let sawIEND = false
  while (offset + 12 <= bytes.length) {
    const length = ((bytes[offset] << 24) >>> 0) + (bytes[offset + 1] << 16)
      + (bytes[offset + 2] << 8) + bytes[offset + 3]
    const type = ascii(bytes, offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    if (dataEnd + 4 > bytes.length) return false // 截断：CRC 都在界外
    const stored = ((bytes[dataEnd] << 24) >>> 0) + (bytes[dataEnd + 1] << 16)
      + (bytes[dataEnd + 2] << 8) + bytes[dataEnd + 3]
    if (crc32(bytes, offset + 4, dataEnd) !== stored) return false
    if (type === 'IDAT') sawIDAT = true
    if (type === 'IEND') { sawIEND = true; break }
    offset = dataEnd + 4
  }
  return sawIDAT && sawIEND
}

function jpegIntegrity(bytes: Uint8Array): boolean {
  const n = bytes.length
  if (n < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return false // SOI
  if (bytes[n - 2] !== 0xff || bytes[n - 1] !== 0xd9) return false // EOI（截断必缺）
  let sawSOS = false
  let offset = 2
  while (offset + 1 < n) {
    if (bytes[offset] !== 0xff) { offset += 1; continue }
    const marker = bytes[offset + 1]
    if (marker === 0xff) { offset += 1; continue }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    if (marker === 0xd9) break
    if (offset + 4 > n) return false
    const length = (bytes[offset + 2] << 8) | bytes[offset + 3]
    if (length < 2 || offset + 2 + length > n) return false
    if (marker === 0xda) sawSOS = true // 扫描数据起点
    if (marker === 0xda) break // 之后是熵编码数据，不再按段解析
    offset += 2 + length
  }
  return sawSOS
}

function webpIntegrity(bytes: Uint8Array): boolean {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 12) !== 'WEBP') {
    return false
  }
  const declared = ((bytes[4] << 24) >>> 0) + (bytes[5] << 16) + (bytes[6] << 8) + bytes[7]
  if (declared + 8 !== bytes.length) return false // 截断或尾部多余
  const format = ascii(bytes, 12, 16)
  if (format !== 'VP8X' && format !== 'VP8 ' && format !== 'VP8L') return false
  const chunkLen = ((bytes[16] << 24) >>> 0) + (bytes[16 + 1] << 16)
    + (bytes[16 + 2] << 8) + bytes[16 + 3]
  return chunkLen > 0 && 20 + chunkLen <= bytes.length
}

export function validatePhotoIntegrity(bytes: Uint8Array, mime: PhotoMime): boolean {
  if (mime === 'image/png') return pngIntegrity(bytes)
  if (mime === 'image/jpeg') return jpegIntegrity(bytes)
  if (mime === 'image/webp') return webpIntegrity(bytes)
  return false
}

/** 完整 session 哈希作为归属前缀，随机串仍由服务端生成。 */
export function sessionPhotoOwner(sessionId: string): string {
  return createHash('sha256').update(sessionId).digest('hex')
}

export function makePhotoUrl(sessionId: string, mime: PhotoMime): string {
  const random = randomUUID().replace(/-/g, '').slice(0, 16)
  return `/uploads/s_${sessionPhotoOwner(sessionId)}_${random}.${EXT_BY_MIME[mime]}`
}

export function photoExtension(mime: PhotoMime): string {
  return EXT_BY_MIME[mime]
}

/**
 * photoUrl 三段归属：形状、完整 session 哈希、文件确实存在。
 * 全过才允许写进 reply.photo_url；exists 由调用方注入，避免本模块碰 fs。
 */
export function parseOwnPhotoUrl(
  photoUrl: unknown,
  sessionId: string,
  exists: (name: string) => boolean,
): { ok: true; name: string } | { ok: false; reason: 'shape' | 'owner' | 'missing' } {
  if (typeof photoUrl !== 'string') return { ok: false, reason: 'shape' }
  const match = PHOTO_URL_RE.exec(photoUrl)
  if (!match) return { ok: false, reason: 'shape' }
  if (match[1] !== sessionPhotoOwner(sessionId)) return { ok: false, reason: 'owner' }
  if (!exists(photoUrl.slice('/uploads/'.length))) return { ok: false, reason: 'missing' }
  return { ok: true, name: photoUrl }
}
