// 目标位置：app/(b)/api/uploads/photo/route.ts
// route group 不改变对外 URL：POST /api/uploads/photo。真实格式/扩展名/MIME 由字节决定。
// 落盘走 b6-photo 的 uploadDir()：本地 ./data/uploads，部署 UPLOAD_DIR 指向可写状态目录。
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readSessionId } from '@/lib/auth/session'
import { getDatabase } from '@/lib/db/index'
import {
  inspectPhoto, validatePhotoIntegrity, makePhotoUrl, uploadDir,
  MAX_PHOTO_BYTES, MAX_PHOTO_SIDE,
} from '../../../b6-photo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function fail(status: number, code: string, detail: string) {
  return Response.json({ code, detail }, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  const sessionId = readSessionId(request)
  if (!sessionId) return fail(401, 'UNAUTHORIZED', '没有有效会话')

  // A 评审 v2 §2-1：readSessionId 只验 Cookie 格式+哈希，格式正确但未经服务端
  // 建立的 Cookie 也能通过。这里在 B 上传边界消费现有 dog.session_id 归属，
  // 确认当前会话确由服务端建立（至少有一只狗归它）；无归属一律拒且不落文件。
  // 正式身份底座由 C 收口后，这一行替换为查身份表即可，不改公共 schema。
  let db
  try {
    db = getDatabase()
  } catch {
    return fail(503, 'NETWORK', '这次没连上，可以再试一次')
  }
  const owned = db.prepare('SELECT 1 FROM dog WHERE session_id = ? LIMIT 1').get(sessionId)
  if (!owned) return fail(401, 'UNAUTHORIZED', '会话没有有效归属')

  let form: FormData
  try {
    form = await request.formData()
  } catch {
    return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '需要 multipart/form-data')
  }

  const file = form.get('file')
  if (!(file instanceof File)) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '缺少文件字段 file')
  if (file.size === 0) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '空文件')
  if (file.size > MAX_PHOTO_BYTES) return fail(413, 'PAYLOAD_TOO_LARGE', '图片超过 5MB')

  // 服务端自己读文件头，不能只信前端压图结果或扩展名。
  const head = new Uint8Array(await file.slice(0, Math.min(65536, file.size)).arrayBuffer())
  const info = inspectPhoto(head)
  if (!info) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '只接受内容确为 jpg/png/webp 的图片')
  if (info.width > MAX_PHOTO_SIDE || info.height > MAX_PHOTO_SIDE) {
    return fail(413, 'PAYLOAD_TOO_LARGE', '图片边长不能超过 1600 像素')
  }
  // A 评审 v2 §2-5：只看头部签名/IHDR 会让"仅签名+尺寸、没有像素数据"和截断文件
  // 蒙混过关。这里对全字节做结构/结束块校验，损坏或截断一律拒；不引入图像库依赖。
  const full = new Uint8Array(await file.arrayBuffer())
  if (!validatePhotoIntegrity(full, info.mime)) {
    return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '图片内容损坏或截断，无法读取')
  }

  const url = makePhotoUrl(sessionId, info.mime)
  const name = url.slice('/uploads/'.length)
  if (!/^s_[0-9a-f]{64}_[0-9a-f]{16}\.(jpg|png|webp)$/.test(name)) {
    return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '文件名非法')
  }
  const dir = uploadDir()
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, name), full)

  // 写什么格式就返回什么 MIME；不把 jpeg/png 原字节伪装成 webp。
  return Response.json(
    { url, bytes: file.size, mime: info.mime, width: info.width, height: info.height },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
