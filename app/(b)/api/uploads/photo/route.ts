// 目标位置：app/(b)/api/uploads/photo/route.ts
// route group 不改变对外 URL：POST /api/uploads/photo。真实格式/扩展名/MIME 由字节决定。
// 落盘走 b6-photo 的 uploadDir()：本地 ./data/uploads，部署 UPLOAD_DIR 指向可写状态目录。
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readSessionId } from '@/lib/auth/session'
import {
  inspectPhoto, makePhotoUrl, uploadDir, MAX_PHOTO_BYTES, MAX_PHOTO_SIDE,
} from '../../../b6-photo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function fail(status: number, code: string, detail: string) {
  return Response.json({ code, detail }, { status, headers: { 'Cache-Control': 'no-store' } })
}

export async function POST(request: Request) {
  const sessionId = readSessionId(request)
  if (!sessionId) return fail(401, 'UNAUTHORIZED', '没有有效会话')

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

  const url = makePhotoUrl(sessionId, info.mime)
  const name = url.slice('/uploads/'.length)
  if (!/^s_[0-9a-f]{64}_[0-9a-f]{16}\.(jpg|png|webp)$/.test(name)) {
    return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '文件名非法')
  }
  const dir = uploadDir()
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, name), new Uint8Array(await file.arrayBuffer()))

  // 写什么格式就返回什么 MIME；不把 jpeg/png 原字节伪装成 webp。
  return Response.json(
    { url, bytes: file.size, mime: info.mime, width: info.width, height: info.height },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
