import type { Exchange } from '../../contracts/types.ts'

/** 仅开发夹具：每封可读收件第一次失败，重试才写已读，不访问真实 HTTP/数据库。 */
export function createReadFailureFixture(rows: Exchange[], retryDelayMs = 1000) {
  const failed = new Set<string>()
  return async (id: string, signal: AbortSignal): Promise<{ exchange: Exchange }> => {
    // 已取消的开发严格模式请求不消耗第一次失败，也不能修改夹具。
    await Promise.resolve()
    signal.throwIfAborted()
    const row = rows.find(item => item.id === id)
    if (!row || !row.deliveredAt) throw new Error('这一封还没到。')
    if (!row.readAt && !failed.has(id)) {
      failed.add(id)
      throw new Error('示例：已读保存第一次失败')
    }
    if (retryDelayMs > 0) await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, retryDelayMs)
      function abort() { clearTimeout(timer); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
    signal.throwIfAborted()
    row.readAt ??= new Date().toISOString()
    return { exchange: { ...row } }
  }
}
