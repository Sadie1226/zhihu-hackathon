// 目标位置：app/(b)/b4-photo-client.ts
// 浏览器端照片压缩（B 已选方案）：canvas 缩到最长边 ≤1600，导出 webp/0.8。
// 服务端仍按文件头复核格式/边长/完整性，前端压缩只是省流量，不作为信任依据。
'use client'

export const CLIENT_MAX_SIDE = 1600

/**
 * 压缩失败（createImageBitmap 不认的损坏/不可处理格式、无 canvas 环境）直接抛错，
 * 由调用方提示"换一张"，不把原图硬传上去让服务端 415。
 */
export async function compressImageFile(file: File, maxSide = CLIENT_MAX_SIDE): Promise<File> {
  if (typeof createImageBitmap !== 'function') {
    throw new Error('当前浏览器不支持图片解码')
  }
  const bitmap = await createImageBitmap(file)
  try {
    const longest = Math.max(bitmap.width, bitmap.height)
    const scale = longest > maxSide ? maxSide / longest : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('canvas 2d 不可用')
    ctx.drawImage(bitmap, 0, 0, width, height)
    const blob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('压缩失败'))),
        'image/webp',
        0.8,
      )
    })
    // 极端高熵图压缩后仍可能 >5MB，交由服务端 413 拦截，前端不私自再降质。
    return new File([blob], 'photo.webp', { type: 'image/webp' })
  } finally {
    bitmap.close()
  }
}
