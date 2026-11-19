// 目标位置：app/(b)/uploads/[name]/route.ts
// 对外 GET /uploads/<name>：照片已从 public/ 移到 uploadDir()（本地 ./data/uploads，
// 部署 UPLOAD_DIR=/var/lib/zhihu-hackathon/uploads）。public/ 在 next start 下只读且
// 不再写入，因此必须有这个读取端，否则 <img src="/uploads/..."> 会 404。
// route group (b) 不进 URL；文件名形状与上传/回应校验共用同一正则口径。
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { uploadDir } from '../../b6-photo'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const NAME_RE = /^s_([0-9a-f]{64})_([0-9a-f]{16})\.(jpg|png|webp)$/
const MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
}

type Context = { params: Promise<{ name: string }> }

function notFound() {
  return new Response('Not Found', { status: 404, headers: { 'Cache-Control': 'no-store' } })
}

export async function GET(_request: Request, context: Context) {
  const { name } = await context.params
  // 只接受本接口产出的文件名，挡住 ../ 穿越与任意路径读取。
  if (!NAME_RE.test(name)) return notFound()
  try {
    const bytes = await readFile(path.join(uploadDir(), name))
    const ext = name.slice(name.lastIndexOf('.') + 1)
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'Content-Type': MIME[ext],
        'Content-Length': String(bytes.byteLength),
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return notFound()
  }
}
