const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const fs = require('node:fs')
;(async () => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  const context = await browser.newContext({
    viewport: { width: 375, height: 667 },
  })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  const base = process.env.A5_PREVIEW_URL || 'http://127.0.0.1:3105'
  if (!['localhost', '127.0.0.1'].includes(new URL(base).hostname))
    throw new Error('A5 browser verification requires a local development preview')
  await page.goto(base + '/home')
  await page.waitForURL('**/adopt')
  await page.getByRole('button', { name: '以测试身份开始 →' }).click()
  await page.getByRole('button', { name: '继续，给它起个名字 →' }).click()
  await page.locator('#dog-name').fill('小山')
  await page.getByRole('button',{name:'自然风景',exact:true}).click()
  await page.getByRole('button',{name:'城市角落',exact:true}).click()
  await page.getByRole('button', { name: '继续，认识它的性格 →' }).click()
  await page.getByRole('slider').first().fill('15')
  await page.reload()
  await page.getByRole('button', { name: '以测试身份开始 →' }).click()
  await page.getByRole('button', { name: '继续，给它起个名字 →' }).click()
  assert.equal(await page.locator('#dog-name').inputValue(),'小山')
  assert.equal(await page.getByRole('button',{name:'自然风景',exact:true}).getAttribute('aria-pressed'),'true')
  await page.getByRole('button', { name: '继续，认识它的性格 →' }).click()
  assert.equal(await page.getByRole('slider').first().inputValue(),'15')
  await page.getByRole('button', { name: '看看它的三个词 →' }).click()
  await page.getByRole('button', { name: '去挑一套穿搭 →' }).click()
  // Simulate a lost response AFTER the server commits, then retry the same receipt.
  let committedDog
  await page.route('**/api/dogs',async r=>{
    const response=await r.fetch()
    assert.equal(response.status(),200)
    committedDog=(await response.json()).dog.id
    await r.abort('failed')
  },{times:1})
  await page.getByRole('button', { name: '就这样，成为伙伴 →' }).click()
  await page.getByRole('button', {name:'保留选择，再试一次 →'}).click()
  await page.getByRole('button', { name: '进入它的小屋 →' }).click()
  await page.waitForURL('**/home')
  await page.getByText('小山的小屋', { exact: true }).waitFor()
  await page.getByText('阳光刚好，先一起坐一会儿吧。', { exact: true }).waitFor()
  await page
    .locator('img')
    .evaluateAll((imgs) => Promise.all(imgs.map((i) => i.decode())))
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await page.screenshot({ path: '.local/a5-home-mobile.png', fullPage: true })
  await page.getByRole('button', { name: '档案', exact: true }).click()
  await page.getByRole('textbox', { name: '它的名字' }).fill('草稿名字')
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: '档案', exact: true }).click()
  assert.equal(
    await page.getByRole('textbox', { name: '它的名字' }).inputValue(),
    '草稿名字',
  )
  await page.getByRole('textbox', { name: '它的名字' }).fill('小叶')
  await page.getByRole('button', { name: '保存这个称呼' }).click()
  await page.getByText('称呼已经记好了。').waitFor()
  await page.keyboard.press('Escape')
  assert.equal(
    await page.evaluate(() =>
      document.activeElement.getAttribute('aria-label'),
    ),
    '档案',
  )
  await page.reload()
  await page.getByText('小叶的小屋', { exact: true }).waitFor()
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.screenshot({ path: '.local/a5-home-desktop.png', fullPage: true })
  await page.goto(base + '/trip')
  await page.getByText('它还在家里。', { exact: true }).waitFor()
  assert.equal(
    await page.locator('section[aria-label="归来分享与发现"]').count(),
    0,
  )
  const session = await (
    await context.request.get(base + '/api/session')
  ).json()
  assert.equal(session.dog.id,committedDog)
  const trip = {
    id: 'review-trip',
    dogId: session.dog.id,
    seq: 1,
    status: 'running',
    trigger: 'auto',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    endedAt: null,
  }
  await page.route('**/api/dogs/*/trips?limit=2', (r) =>
    r.fulfill({ json: { trips: [trip] } }),
  )
  await page.route('**/api/trips/review-trip', (r) =>
    r.fulfill({ json: { trip } }),
  )
  await page.reload()
  await page
    .getByRole('heading', { name: '它出门了，沿途的事回来再聊。' })
    .waitFor()
  assert.equal(
    await page.locator('section[aria-label="归来分享与发现"]').count(),
    0,
  )
  trip.status = 'done'
  trip.endedAt = new Date().toISOString()
  await page
    .getByRole('heading', { name: '它回来了，带着一些路上的见闻。' })
    .waitFor()
  await page.getByText('归来内容读取接口尚未接入。').waitFor()
  await page.setViewportSize({ width: 375, height: 667 })
  assert.ok(
    (await page
      .locator('[class*="stage"]')
      .evaluate((e) => e.getBoundingClientRect().height)) >= 320,
  )
  await page.screenshot({
    path: '.local/a5-trip-done-mobile.png',
    fullPage: true,
  })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  for (const [status, heading] of [
    ['pending', '它正在收拾随身的小包。'],
    ['timeout', '今天回来得晚，先坐一会儿。'],
    ['failed', '这趟没能走完，已有的经历还在。'],
  ]) {
    trip.status = status
    await page.reload()
    await page.getByRole('heading', { name: heading }).waitFor()
    assert.equal(
      await page.locator('section[aria-label="归来分享与发现"]').count(),
      status === 'pending' ? 0 : 1,
    )
  }
  await page.route('**/api/dogs/*/trips?limit=2', r => r.fulfill({status:503,json:{code:'NETWORK',detail:'internal-only'}}))
  await page.goto(base + '/home')
  await page.getByRole('link',{name:'暂时读不到它的近况'}).waitFor()
  assert.equal(await page.getByText('阳光刚好，先一起坐一会儿吧。',{exact:true}).count(),0)
  assert.equal(await page.getByText('internal-only',{exact:true}).count(),0)
  await page.goto(base + '/home')
  await page.getByRole('button', { name: '设置', exact: true }).click()
  await page.getByRole('button', { name: '退出测试身份' }).click()
  await page.waitForURL('**/adopt')
  await page.getByRole('button', { name: '以测试身份开始 →' }).waitFor()
  await page.route('**/api/adoption/profile', (r) =>
    r.fulfill({
      json: {
        source: 'mock',
        version: 'review-partial',
        sections: {
          basic: { status: 'ok' },
          collections: { status: 'error' },
          followees: { status: 'empty', count: 0 },
          contents: { status: 'unauthorized' },
        },
      },
    }),
  )
  await page.getByRole('button', { name: '以测试身份开始 →' }).click()
  await page.getByText('收藏：失败', { exact: true }).waitFor()
  assert.equal(await page.getByRole('button', {name:'继续，给它起个名字 →'}).count(),0)
  await page.getByRole('button', {name:'仅用已读资料继续 →'}).click()
  assert.equal(await page.locator('#dog-name').inputValue(),'')
  await page.setViewportSize({ width: 667, height: 375 })
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    false,
  )
  await page.screenshot({
    path: '.local/a5-adopt-partial-landscape.png',
    fullPage: true,
  })
  await page.setViewportSize({ width: 375, height: 667 })
  await page.screenshot({ path: '.local/a5-adopt-mobile.png', fullPage: true })
  await page.unroute('**/api/dogs/*/trips?limit=2')
  // A new empty test identity cannot see a previous dog's data: home must redirect to adopt.
  await page.goto(base + '/home')
  await page.waitForURL('**/adopt')
  assert.deepEqual(errors, [])
  fs.writeFileSync(
    '.local/a5-browser-result.json',
    JSON.stringify(
      {
        passed: [
          'adopt-persist',
          'draft-refresh-restores-name-interests-and-slider',
          'committed-create-lost-response-retry-same-dog',
          'mobile-no-overflow',
          'draft-preserved',
          'rename-persist',
          'escape-focus',
          'desktop',
          'trip-none',
          'running-no-finds',
          'done-read-port',
          'pending',
          'timeout',
          'failed',
          'mobile-stage-320',
          'logout',
          'profile-partial-explicit-continue',
          'landscape-no-overflow',
          'new-session-isolation',
          'read-failure-is-not-empty-or-internal-detail',
        ],
        errors,
      },
      null,
      2,
    ),
  )
  await browser.close()
  console.log('PASS browser flow, screenshots .local/a5-*.png')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
