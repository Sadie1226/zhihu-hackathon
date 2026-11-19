import { loadEnvFile } from 'node:process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { searchZhihu } from '../../lib/zhihu/index.ts'

// Opt-in only: npm test never imports this script or sends a network request.
const report = { checkedAt: new Date().toISOString(), query: '想看雪', requestedCount: 3,
  requestCount: 0, httpStatus: null, successfulCount: 0, result: 'NOT_RUN',
  errorType: null, reason: null, responseFields: null, publicResults: [] }
let envAvailable = true
try { loadEnvFile(process.argv[2] ?? '.env') } catch { envAvailable = false }
if (!envAvailable || !process.env.ZHIHU_ACCESS_SECRET?.trim()) {
  Object.assign(report, { errorType: 'AUTH', reason: envAvailable ? 'SECRET_MISSING' : 'ENV_FILE_UNAVAILABLE' })
} else {
  report.requestCount = 1
  const result = await searchZhihu(report.query, report.requestedCount)
  report.httpStatus = result.httpStatus
  if (result.ok) {
    Object.assign(report, { result: 'SEARCH_OK', successfulCount: result.items.length,
      responseFields: result.responseFields,
      publicResults: result.items.map(item => ({ ...item, excerpt: item.excerpt?.slice(0, 160) ?? null })) })
  } else {
    Object.assign(report, { result: 'FAILED', errorType: result.error.code,
      reason: result.error.detail, upstreamCode: result.upstreamCode })
  }
}
mkdirSync('.local', { recursive: true })
writeFileSync('.local/c5-live-report.json', JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
process.exitCode = report.result === 'SEARCH_OK' ? 0 : 1
