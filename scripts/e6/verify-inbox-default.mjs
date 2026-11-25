import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
const { chromium } = await import(process.env.E6_PLAYWRIGHT_MODULE || 'playwright')
// Separate output: never overwrite the previous E6 acceptance evidence.
const output = process.env.E6_OUTPUT || 'team/2026-11-25/e/e6-inbox-default/evidence'
await mkdir(output, { recursive: true })
const browser = await chromium.launch({ headless: true, executablePath: process.env.E6_CHROMIUM_PATH, args: ['--no-sandbox'] })
try {
  const page = await browser.newPage({ viewport: { width: 375, height: 667 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(`${process.env.E6_BASE_URL || 'http://127.0.0.1:3110'}/e6-preview`)
  await page.getByRole('button', { name: '朋友来信', exact: true, pressed: true }).waitFor()
  await page.getByRole('button', { name: '拆开看看', exact: true }).first().waitFor()
  await page.getByLabel('本地验收场景：').selectOption('invitations-error')
  await page.getByRole('button', { name: '拆开看看', exact: true }).first().waitFor()
  await page.screenshot({ path: `${output}/inbox-default.png`, fullPage: true })
  await page.getByRole('button', { name: '邀请与回音', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '邀请暂时读不到' }).waitFor()
  await page.screenshot({ path: `${output}/invitations-error.png`, fullPage: true })
  await page.getByRole('button', { name: '朋友来信', exact: true }).click()
  await page.getByRole('button', { name: '拆开看看', exact: true }).first().waitFor()
  // Scoped to main: Next App Router mounts its own #__next-route-announcer__ with role="alert"
  // inside a shadow root, so a document-wide alert count reports framework chrome, not this page.
  assert.equal(await page.locator('main').getByRole('alert').count(), 0)
  await page.getByRole('button', { name: '邀请与回音', exact: true }).click()
  await page.getByRole('button', { name: '打开邀请', exact: true }).waitFor()
  // New scenario instance makes its first invitation request fail again.
  await page.getByLabel('本地验收场景：').selectOption('normal')
  await page.getByRole('button', { name: '朋友来信', exact: true, pressed: true }).waitFor()
  await page.getByLabel('本地验收场景：').selectOption('invitations-error')
  await page.getByRole('button', { name: '邀请与回音', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: '邀请暂时读不到' }).waitFor()
  await page.getByRole('button', { name: '重新读取', exact: true }).click()
  await page.getByRole('button', { name: '打开邀请', exact: true }).waitFor()
  await page.screenshot({ path: `${output}/invitations-retry.png`, fullPage: true })
  assert.deepEqual(errors, [])
  const result = { defaultInbox: true, invitationFailureDoesNotBlockInbox: true, invitationRetryRecovers: true, pageErrors: errors }
  await writeFile(`${output}/verification.json`, JSON.stringify(result, null, 2))
  console.log(JSON.stringify(result, null, 2))
} finally { await browser.close() }
