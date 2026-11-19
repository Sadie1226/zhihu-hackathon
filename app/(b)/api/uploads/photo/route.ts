// 目标位置：app/(b)/api/uploads/photo/route.ts
// route group 不改变对外 URL，仍是 /api/uploads/photo。app/api/ 归 c，不碰。
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { readSessionId, MAX_PHOTO_BYTES, detectMime, makePhotoUrl } from '../../../b6-photo'

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
  if (file.size > MAX_PHOTO_BYTES) return fail(413, 'PAYLOAD_TOO_LARGE', '图片超过 5MB')
  if (file.size === 0) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '空文件')

  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer())
  const mime = detectMime(head)
  if (!mime) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '只接受 jpg/png/webp（按文件头判断）')

  // 文件名用 session 前缀 + 随机串，不带原文件名。
  const url = makePhotoUrl(sessionId)
  const rel = url.slice('/uploads/'.length)
  // 防路径穿越：文件名由白名单字符拼成，仍再做一次断言。
  if (!/^s_[0-9a-z]{8}_[0-9a-z]{16}\.webp$/.test(rel)) return fail(415, 'UNSUPPORTED_MEDIA_TYPE', '文件名非法')
  const dir = path.join(process.cwd(), 'public', 'uploads')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, rel), new Uint8Array(await file.arrayBuffer()))

  return Response.json(
    { url, bytes: file.size, mime },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  )
}
