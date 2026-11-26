/* global getComputedStyle, document */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const spec = process.env.E7_PLAYWRIGHT_MODULE || 'playwright'
const { chromium } = await import(spec.startsWith('/') || /^[A-Z]:[\\/]/i.test(spec) ? pathToFileURL(spec).href : spec)
const browser = await chromium.launch({ headless: true, executablePath: process.env.E7_CHROME, args: ['--no-sandbox'] })
const out = process.env.E7_EVIDENCE_DIR || 'team/2026-11-26/e/e7-phone-pixel/evidence'
await mkdir(out, { recursive: true })
const results = []
try {
 for (const [width,height] of [[375,667],[320,568],[1440,900]]) {
  const page = await browser.newPage({ viewport: { width,height } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${process.env.E7_BASE_URL || 'http://localhost:3113'}/e7-preview`)
  await page.getByRole('button', { name: '翻开这一趟', exact: true }).first().click()
  await page.getByRole('region', { name: '归来话', exact: true }).waitFor()
  await page.getByRole('button', { name: /^来往/ }).click()
  const tabs = page.getByRole('navigation', { name: '收寄分类' })
  assert(await tabs.getByRole('button', { name: /^收到/ }).getAttribute('aria-pressed') === 'true')
  await page.getByRole('button', { name: '拆开看看', exact: true }).first().waitFor()
  const before = Number(await tabs.getByRole('button', { name: /^收到/ }).locator('[aria-label$="条新到来信"]').innerText())
  assert(before > 0)
  const pending = page.locator('article').filter({ hasText: '有一份东西还在路上' })
  assert.equal(await pending.count(),1)
  assert.equal(await page.locator('article').first().locator('h2').innerText(),'有一份东西还在路上')
  const fresh = page.locator('article').filter({ has: page.getByRole('heading', { name: '朋友的近况',exact:true }) })
  await fresh.getByRole('button', { name: '拆开看看', exact:true }).click()
  await page.waitForFunction(count => document.querySelector('nav[aria-label="收寄分类"] [aria-label$="条新到来信"]')?.textContent === String(count), before - 1)
  assert.equal(Number(await tabs.getByRole('button', { name: /^收到/ }).locator('[aria-label$="条新到来信"]').innerText()),before-1)
  await page.getByRole('button', { name: '收好，回到这一页' }).click()
  assert.equal(await fresh.getByText('新到',{exact:true}).count(),0)
  await tabs.getByRole('button', { name: '寄出',exact:true }).click()
  assert.equal(await page.getByText('朋友的近况',{exact:true}).count(),0)
  assert.equal(await page.getByText('未投递秘密标题',{exact:true}).count(),0)
  await page.getByRole('button', { name: '收到的礼物',exact:true }).click()
  const thumb = page.locator('article img').first()
  await thumb.waitFor()
  assert.equal(await thumb.evaluate(node => getComputedStyle(node).imageRendering),'pixelated')
  assert.deepEqual(errors,[])
  await page.screenshot({path:`${out}/${width}-gifts.png`,fullPage:true})
  results.push({width,height,splitMail:true,pendingPinned:true,unreadDecrementsOnRead:true,pixelAssets:true,pageErrors:errors})
  await page.close()
 }
 await writeFile(`${out}/verification.json`,JSON.stringify(results,null,2))
} finally {await browser.close()}
