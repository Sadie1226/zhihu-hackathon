/* global document, innerWidth */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const spec = process.env.E8_PLAYWRIGHT_MODULE || 'playwright'
const target = /^[a-zA-Z]:[\\/]/.test(spec) || spec.startsWith('/') ? pathToFileURL(spec).href : spec
const { chromium } = await import(target)
const output = process.env.E8_EVIDENCE_DIR || 'team/2026-11-26/e/e8-circle/evidence'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.E8_CHROME, args: ['--no-sandbox'] })
const results = []
try {
  for (const [width, height] of [[375,667],[320,568],[1440,900]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    const errors = []
    const writes = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => { if (['POST','PATCH','PUT','DELETE'].includes(request.method()) && request.url().includes('/api/')) writes.push(request.url()) })
    await page.goto(`${process.env.E8_BASE_URL || 'http://localhost:3112'}/e8-preview`)
    await page.getByRole('heading', { name: '朋友圈', exact: true }).waitFor()
    await page.getByRole('region', { name: '狗的动态', exact: true }).waitFor()
    assert.equal(await page.locator('article').count(), 2)
    assert.equal(await page.getByRole('button', { name: /发布|点赞|留言|评论/ }).count(), 0)
    assert.equal(await page.locator('textarea,input').count(), 0)
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.screenshot({ path: `${output}/${width}-normal.png`, fullPage: true })
    await page.getByLabel('本地验收场景：').selectOption('empty')
    await page.getByText('这一页还安静着。有了新见闻，再来翻翻。', { exact: true }).waitFor()
    await page.getByLabel('本地验收场景：').selectOption('error')
    await page.getByRole('alert').filter({ hasText: '动态暂时读不到' }).waitFor()
    await page.getByRole('button', { name: '重新读取', exact: true }).click()
    await page.getByRole('region', { name: '狗的动态', exact: true }).waitFor()
    await page.getByLabel('本地验收场景：').selectOption('slow')
    await page.getByRole('status', { name: '正在翻看动态' }).waitFor()
    await page.getByLabel('本地验收场景：').selectOption('unavailable')
    await page.getByRole('heading', { name: '这一页还没接通', exact: true }).waitFor()
    assert.equal(await page.locator('article').count(), 0)
    assert.deepEqual(writes, [])
    assert.deepEqual(errors, [])
    results.push({ width, height, fixtureOnly: true, noHumanWriteControls: true, loadingEmptyErrorUnavailable: true, pageErrors: errors, apiWrites: writes })
    await page.close()
  }
  await writeFile(`${output}/verification.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally { await browser.close() }
