/* global document, innerWidth */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const spec = process.env.E7_PLAYWRIGHT_MODULE || 'playwright'
const target = /^[a-zA-Z]:[\\/]/.test(spec) || spec.startsWith('/') ? pathToFileURL(spec).href : spec
const { chromium } = await import(target)
const output = process.env.E7_EVIDENCE_DIR || 'team/2026-11-26/e/e7-review-fixes/evidence'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.E7_CHROME, args: ['--no-sandbox'] })
const results = []
try {
  for (const [width, height] of [[375,667],[320,568],[1440,900]]) {
    const page = await browser.newPage({ viewport: { width, height } })
    const errors = []
    page.on('pageerror', error => errors.push(error.message))
    await page.goto(`${process.env.E7_BASE_URL || 'http://localhost:3111'}/e7-preview`)
    // 开发首屏在 select 还没水合时就派发 change 会丢掉场景选择，先等 React 挂上属性再选。
    await page.waitForFunction(() => {
      const select = document.querySelector('#e7-case')
      return Boolean(select) && Object.keys(select).some(key => key.startsWith('__reactProps$') || key.startsWith('__reactFiber$'))
    })
    await page.getByLabel('本地验收场景：').selectOption('review')
    await page.getByRole('button', { name: '翻开这一趟', exact: true }).first().click()
    const trip = page.locator('article').filter({ has: page.getByRole('heading', { name: '第 1 次出行', exact: true }) })
    await trip.getByRole('button', { name: '重新读取归来话' }).waitFor()
    for (const text of ['示例内容', '来自先前保存的发现', '来自一次知乎发现', '来源信息未提供']) {
      assert.equal(await trip.getByText(text, { exact: true }).count(), 1)
    }
    assert.equal(await trip.getByText('这一趟没有留下归来话。', { exact: true }).count(), 0)
    await page.screenshot({ path: `${output}/${width}-message-error.png`, fullPage: true })
    await trip.getByRole('button', { name: '重新读取归来话' }).click()
    await trip.getByText('正在重新读取这一趟…', { exact: true }).waitFor()
    assert.equal(await trip.getByText('来源发现0', { exact: true }).count(), 1)
    await trip.getByText('湖面很静，我站了一会儿。', { exact: true }).waitFor()
    assert.equal(await trip.getByRole('button', { name: '重新读取归来话' }).count(), 0)
    await page.getByRole('button', { name: '来往', exact: true }).click()
    const outgoing = page.locator('article').filter({ has: page.getByText(/^寄出 ·/) })
    for (const text of ['在路上', '已寄出', '对方已读', '对方已回应']) {
      assert.equal(await outgoing.getByText(text, { exact: true }).count(), 1)
    }
    assert.equal(await outgoing.getByText('新到', { exact: true }).count(), 0)
    assert.equal(await page.getByText('未投递秘密标题', { exact: true }).count(), 0)
    assert.equal(await page.getByText('未投递秘密正文', { exact: true }).count(), 0)
    await page.getByRole('button', { name: '收到的礼物', exact: true }).click()
    for (const [index, text] of ['示例内容', '来自先前保存的发现', '来自一次知乎发现', '来源信息未提供'].entries()) {
      const gift = page.locator('article').filter({ has: page.getByRole('heading', { name: `来源礼物${index}`, exact: true }) })
      assert.equal(await gift.getByText(text, { exact: true }).count(), 1)
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    assert.deepEqual(errors, [])
    await page.screenshot({ path: `${output}/${width}-gift-sources.png`, fullPage: true })
    results.push({ width, height, sourceModes: true, messageRetryRetainsFinds: true, outgoingStates: true, sealedContentHidden: true, pageErrors: errors })
    await page.close()
  }
  await writeFile(`${output}/verification.json`, JSON.stringify(results, null, 2))
  console.log(JSON.stringify(results, null, 2))
} finally { await browser.close() }
