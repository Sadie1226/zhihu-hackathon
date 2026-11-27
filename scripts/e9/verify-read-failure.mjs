/* global document, getComputedStyle */
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
const spec = process.env.E9_PLAYWRIGHT_MODULE || process.env.E7_PLAYWRIGHT_MODULE || 'playwright'
const { chromium } = await import(spec.startsWith('/') || /^[A-Z]:[\\/]/i.test(spec) ? pathToFileURL(spec).href : spec)
const out = process.env.E9_EVIDENCE_DIR || 'team/2026-11-27/e/e9-read-failure/evidence'
await mkdir(out, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.E9_CHROME || process.env.E7_CHROME, args: ['--no-sandbox'] })
const results = []
async function badgeCount(page, expected) {
  await page.waitForFunction(count => {
    const read = nav => Number(document.querySelector(`nav[aria-label="${nav}"] [aria-label$="条新到来信"]`)?.textContent ?? 0)
    return read('收寄分类') === count && read('手账分类') === count
  }, expected)
}
async function appearance(card) {
  return card.evaluate(node => {
    const box = getComputedStyle(node)
    const status = [...node.querySelectorAll('span')].find(item => item.textContent.includes('新到') || item.textContent.includes('安静地留着'))
    return { boxShadow: box.boxShadow, statusBackground: status ? getComputedStyle(status).backgroundColor : null }
  })
}
try {
  for (const [width,height] of [[375,667],[320,568],[1440,900]]) {
    const page = await browser.newPage({ viewport: { width,height } })
    const errors = [], writes = []
    page.on('pageerror', error => errors.push(error.message))
    page.on('request', request => {
      if (['POST','PATCH','PUT','DELETE'].includes(request.method()) && new URL(request.url()).pathname.startsWith('/api/')) writes.push(request.url())
    })
    await page.goto(`${process.env.E9_BASE_URL || 'http://localhost:3115'}/e7-preview`)
    // Wait for fixture data loaded by React, not merely server-rendered select HTML.
    await page.getByRole('button', { name: '翻开这一趟', exact:true }).first().waitFor()
    async function enterFailureScenario() {
      await page.getByLabel('本地验收场景：').selectOption('normal')
      await page.getByRole('button', { name: /^来往/ }).click()
      await page.getByRole('button', { name: '拆开看看', exact:true }).first().waitFor()
      await page.getByLabel('本地验收场景：').selectOption('read-error')
      await page.getByRole('button', { name: /^来往/ }).click()
      await page.getByRole('button', { name: '拆开看看', exact:true }).first().waitFor()
      await badgeCount(page,3)
    }
    const fresh = page.locator('article').filter({ has: page.getByRole('heading', { name: '朋友的近况', exact:true }) })
    const alert = page.locator('main').getByRole('alert').filter({ hasText:'已读状态没保存' })
    const back = page.getByRole('button', { name:'收好，回到这一页',exact:true })
    await enterFailureScenario()
    const before = await appearance(fresh)
    await fresh.getByRole('button', { name:'拆开看看',exact:true }).click()
    await alert.waitFor()
    await page.getByText('这边下了两天雨，你那边呢', {exact:true}).waitFor()
    await badgeCount(page,3)
    // 等逐字渐显落定再截图：否则拍到半透明中间帧，无法证明正文可读。
    await page.waitForFunction(() => document.getAnimations().every(animation => animation.playState === 'finished'))
    await page.screenshot({path:`${out}/${width}-save-failed.png`,fullPage:true})
    await back.click()
    assert.equal(await fresh.getByText(/新到/).count(),1)
    assert.deepEqual(await appearance(fresh),before)
    await page.screenshot({path:`${out}/${width}-still-new.png`,fullPage:true})
    // Fresh fixture instance: exercise explicit retry button instead of reopening auto-save.
    await enterFailureScenario()
    await fresh.getByRole('button', {name:'拆开看看',exact:true}).click()
    await alert.waitFor()
    await page.getByRole('button', {name:'重新保存已读',exact:true}).click()
    await page.getByRole('status').filter({hasText:'正在保存已读状态'}).waitFor()
    await badgeCount(page,3)
    await badgeCount(page,2)
    assert.equal(await alert.count(),0)
    await back.click()
    assert.equal(await fresh.getByText(/新到/).count(),0)
    assert.notDeepEqual(await appearance(fresh),before)
    assert.equal(await page.locator('article').getByText(/新到/).count(),2)
    await page.screenshot({path:`${out}/${width}-retry-saved.png`,fullPage:true})
    await fresh.getByRole('button', {name:'拆开看看',exact:true}).click()
    await badgeCount(page,2)
    assert.equal(await alert.count(),0)
    assert.equal(await page.getByText('正在保存已读状态…',{exact:true}).count(),0)
    assert.equal(await page.getByText('未投递秘密标题',{exact:true}).count(),0)
    assert.equal(await page.getByText('未投递秘密正文',{exact:true}).count(),0)
    assert.deepEqual(errors,[])
    assert.deepEqual(writes,[])
    results.push({width,height,failedSaveKeepsCount:true,failedSaveKeepsHighlight:true,retryDecrementsOnce:true,otherUnreadPreserved:true,rereadDoesNotDecrement:true,sealedContentHidden:true,pageErrors:errors,apiWrites:writes})
    await page.close()
  }
  await writeFile(`${out}/verification.json`,JSON.stringify({fixtureOnly:true,results},null,2))
  console.log(JSON.stringify(results,null,2))
} finally { await browser.close() }
