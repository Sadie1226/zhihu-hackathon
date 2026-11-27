/* global document, getComputedStyle, fetch, localStorage, setTimeout */
// E7 手账首版验收脚本。默认只读，不写真实业务数据（真实部分只在 E7_DB_PATH 指向独立测试库时执行）。
// 环境变量：E7_BASE_URL / E7_EVIDENCE_DIR / E7_PLAYWRIGHT_MODULE / E7_CHROME / E7_DB_PATH / E7_REAL=1
import { mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

const BASE = process.env.E7_BASE_URL ?? 'http://127.0.0.1:3109'
const OUT = process.env.E7_EVIDENCE_DIR ?? 'team/2026-11-25/e/e7-journal/evidence'
const DB_PATH = process.env.E7_DB_PATH ?? ''
const VIEWPORTS = [
  { name: '375x667', width: 375, height: 667 },
  { name: '320x568', width: 320, height: 568 },
  { name: '1440x900', width: 1440, height: 900 },
]

const failures = []
function check(label, pass, detail) {
  if (!pass) failures.push(detail ? `${label} :: ${detail}` : label)
  return pass
}

async function loadChromium() {
  const spec = process.env.E7_PLAYWRIGHT_MODULE || 'playwright'
  const target = /^[a-zA-Z]:[\\/]/.test(spec) || spec.startsWith('/') ? pathToFileURL(spec).href : spec
  const mod = await import(target)
  const chromium = mod.chromium ?? mod.default?.chromium
  if (!chromium) throw new Error(`无法从 ${spec} 取到 chromium`)
  return chromium
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function waitText(page, text, timeout = 30000) {
  await page.waitForFunction(t => (document.body.innerText || '').includes(t), text, { timeout })
}

async function overflowOf(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }))
}

async function smallTargets(page) {
  return page.evaluate(() => [...document.querySelectorAll('button, a, select')]
    .map(node => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ node, rect }) => {
      const style = getComputedStyle(node)
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
    })
    .filter(({ rect }) => rect.height < 44)
    .map(({ node, rect }) => ({ text: (node.textContent || '').trim().slice(0, 18), height: Math.round(rect.height) })))
}

async function selectScenario(page, value) {
  await page.selectOption('#e7-case', value)
  await sleep(120)
}

/** 取指定元素的计算样式，只回传需要的键，避免整份 CSSStyleDeclaration 序列化。 */
async function styleOf(locator, keys) {
  return locator.evaluate((node, list) => {
    const style = getComputedStyle(node)
    const out = {}
    for (const key of list) out[key] = style[key]
    return out
  }, keys)
}

/** WCAG 相对亮度；只用来判断正文与纸底的对比度是否够读。 */
function relativeLuminance(color) {
  const match = /rgba?\(([^)]+)\)/.exec(color ?? '')
  if (!match) return null
  const parts = match[1].split(',').slice(0, 3).map(part => {
    const value = Number.parseFloat(part) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  if (parts.length < 3 || parts.some(Number.isNaN)) return null
  return 0.2126 * parts[0] + 0.7152 * parts[1] + 0.0722 * parts[2]
}

function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground)
  const b = relativeLuminance(background)
  if (a === null || b === null) return null
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

/** 计算样式的时长可能是 '0.048s' 或 '48ms'，统一换算成毫秒。 */
function msOf(value) {
  if (typeof value !== 'string') return null
  if (value.endsWith('ms')) return Number.parseFloat(value)
  if (value.endsWith('s')) return Number.parseFloat(value) * 1000
  return null
}

/** 只用键盘 Tab 走到目标按钮，保证 :focus-visible 真的命中（脚本 focus() 不算）。 */
async function tabUntil(page, text, max = 18) {
  for (let index = 0; index < max; index++) {
    await page.keyboard.press('Tab')
    // 分类按钮会带新到计数徽标，文字变成「来往3」，按前缀匹配即可。
    const hit = await page.evaluate(target => (document.activeElement?.textContent || '').trim().startsWith(target), text)
    if (hit) return true
  }
  return false
}

async function rectOf(locator) {
  return locator.evaluate(node => {
    const box = node.getBoundingClientRect()
    return { width: Math.round(box.width), height: Math.round(box.height) }
  })
}

const GLYPH = 'span[class*="glyph"]'
const REVEAL_P = 'p[title="点一下直接显示全文"]'

async function revealState(page) {
  const paragraph = page.locator(REVEAL_P)
  const glyphs = page.locator(`${REVEAL_P} ${GLYPH}`)
  const count = await glyphs.count()
  const paragraphCount = await paragraph.count()
  const read = async (index, key) => (count > index
    ? glyphs.nth(index).evaluate((node, prop) => getComputedStyle(node)[prop], key)
    : null)
  return {
    paragraph: paragraphCount,
    glyphs: count,
    ariaLabel: paragraphCount > 0 ? await paragraph.getAttribute('aria-label') : null,
    animationName: await read(0, 'animationName'),
    animationDuration: await read(0, 'animationDuration'),
    firstDelay: await read(0, 'animationDelay'),
    fourthDelay: await read(3, 'animationDelay'),
    firstOpacity: await read(0, 'opacity'),
  }
}

async function fixtureRun(browser) {
  const report = []
  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } })
    const page = await ctx.newPage()
    const errors = []
    page.on('pageerror', error => errors.push(String(error.message).slice(0, 160)))
    const row = { viewport: vp.name, errors, checks: {} }

    await page.goto(`${BASE}/e7-preview`, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await waitText(page, '翻开这一趟')
    await sleep(200)

    row.checks.defaultTab = await page.getByRole('button', { name: '旅途', exact: true }).getAttribute('aria-pressed')
    check(`${vp.name} 默认落在旅途`, row.checks.defaultTab === 'true', String(row.checks.defaultTab))

    const box = await overflowOf(page)
    row.checks.overflow = box
    check(`${vp.name} 旅途无横向溢出`, box.scrollWidth <= box.clientWidth + 1, JSON.stringify(box))
    row.checks.smallTargets = await smallTargets(page)
    check(`${vp.name} 旅途触达区 ≥44px`, row.checks.smallTargets.length === 0, JSON.stringify(row.checks.smallTargets))
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-trips.png`, fullPage: true })

    // 展开第一趟：地点、条数、归来话都来自数据
    await page.getByRole('button', { name: '翻开这一趟' }).first().click()
    await waitText(page, '喀纳斯')
    row.checks.trip = {
      place: (await page.getByText('喀纳斯', { exact: true }).count()) > 0,
      count: (await page.getByText(/这一趟记下 2 条发现/).count()) > 0,
      message: (await page.getByText('湖面很静，我站了一会儿。', { exact: true }).count()) > 0,
    }
    check(`${vp.name} 展开后显示真实地点/条数/归来话`,
      row.checks.trip.place && row.checks.trip.count && row.checks.trip.message, JSON.stringify(row.checks.trip))
    // 超时那趟不能显示成正常归来，也不能用「回来得晚」暗示它成功回来了
    row.checks.timeoutLabel = await page.getByText('这次超时了', { exact: true }).count()
    row.checks.lateWording = await page.getByText('回来得晚', { exact: true }).count()
    row.checks.doneLabel = await page.getByText('回来了', { exact: true }).count()
    check(`${vp.name} 超时是明确超时态而非「回来得晚」`,
      row.checks.timeoutLabel === 1 && row.checks.doneLabel === 1 && row.checks.lateWording === 0,
      `timeout=${row.checks.timeoutLabel} done=${row.checks.doneLabel} late=${row.checks.lateWording}`)

    // 像素信纸口径：卡片用 stationery.png 的 10px 贴图边框，页面底是纯色纸底
    const cardStyle = await styleOf(page.locator('article').first(),
      ['borderTopWidth', 'borderImageSource', 'borderImageSlice', 'imageRendering', 'backgroundColor'])
    row.checks.layers = {
      page: await page.evaluate(() => {
        const root = document.querySelector('#content')?.parentElement
        return root ? getComputedStyle(root).backgroundColor : null
      }),
      card: cardStyle,
    }
    check(`${vp.name} 卡片用像素信纸边框（stationery.png / 10px）`,
      /stationery\.png/.test(cardStyle.borderImageSource)
        && cardStyle.borderTopWidth === '10px'
        && cardStyle.imageRendering === 'pixelated'
        && String(cardStyle.borderImageSlice).startsWith('10'),
      JSON.stringify(cardStyle))
    check(`${vp.name} 页面底为纯色纸底`,
      row.checks.layers.page === 'rgb(255, 248, 237)', String(row.checks.layers.page))

    // 贴图必须真的能取到，不能只是 CSS 里写了路径
    const stationery = await page.evaluate(async source => {
      const url = /url\(["']?([^"')]+)["']?\)/.exec(source || '')?.[1]
      if (!url) return { url: null }
      const response = await fetch(url, { cache: 'no-store' })
      const body = await response.arrayBuffer()
      return { url, status: response.status, type: response.headers.get('content-type'), bytes: body.byteLength }
    }, cardStyle.borderImageSource)
    row.checks.stationery = stationery
    check(`${vp.name} 信纸贴图实际加载`,
      stationery.status === 200 && /image\/png/.test(stationery.type || '') && stationery.bytes > 100,
      JSON.stringify(stationery))
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-trip-open.png`, fullPage: true })

    // 来往：未送达的标题与正文都不能进 DOM
    await page.getByRole('button', { name: /^来往/ }).click()
    await waitText(page, '收到')
    await sleep(200)
    const html = await page.content()
    row.checks.sealed = {
      titleLeaked: html.includes('未投递秘密标题'),
      bodyLeaked: html.includes('未投递秘密正文'),
      sealedCard: (await page.getByText('有一份东西还在路上', { exact: true }).count()) > 0,
    }
    check(`${vp.name} 未送达收件不泄露标题/正文`,
      !row.checks.sealed.titleLeaked && !row.checks.sealed.bodyLeaked && row.checks.sealed.sealedCard,
      JSON.stringify(row.checks.sealed))
    // 已送达的收件共 4 封（发现 / 问候 / 礼物 / 长信），未送达那封不给入口
    const openable = await page.getByRole('button', { name: '拆开看看' }).count()
    row.checks.openable = openable
    check(`${vp.name} 未送达不提供拆信入口`, openable === 4, String(openable))
    const lettersBox = await overflowOf(page)
    row.checks.lettersOverflow = lettersBox
    check(`${vp.name} 来往无横向溢出`, lettersBox.scrollWidth <= lettersBox.clientWidth + 1, JSON.stringify(lettersBox))
    row.checks.lettersSmall = await smallTargets(page)
    check(`${vp.name} 来往触达区 ≥44px`, row.checks.lettersSmall.length === 0, JSON.stringify(row.checks.lettersSmall))
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-letters.png`, fullPage: true })

    // 无遮挡：卡片左侧的信封图标不能压住标题文字（按文字实际占位算，不看块级盒）
    row.checks.iconOverlap = await page.evaluate(() => {
      const card = document.querySelector('section[aria-label="来往"] article')
      const icon = card?.querySelector('img')
      const title = card?.querySelector('h2')
      if (!icon || !title) return null
      const range = document.createRange()
      range.selectNodeContents(title)
      const a = icon.getBoundingClientRect()
      const b = range.getBoundingClientRect()
      return {
        overlap: !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top),
        icon: { left: Math.round(a.left), right: Math.round(a.right) },
        title: { left: Math.round(b.left), top: Math.round(b.top) },
      }
    })
    check(`${vp.name} 信封图标不压标题`,
      row.checks.iconOverlap !== null && row.checks.iconOverlap.overlap === false,
      JSON.stringify(row.checks.iconOverlap))

    // 选中分类：底色、字重、底部细标记三者共同区分，不能只靠颜色
    const tabLetters = page.getByRole('button', { name: /^来往/ })
    row.checks.tabStyle = {
      selected: await styleOf(tabLetters, ['backgroundColor', 'fontWeight', 'boxShadow']),
      idle: await styleOf(page.getByRole('button', { name: '旅途', exact: true }), ['backgroundColor', 'fontWeight', 'boxShadow']),
    }
    const tabStyle = row.checks.tabStyle
    check(`${vp.name} 选中分类用底色+字重+细标记区分`,
      tabStyle.selected.backgroundColor !== tabStyle.idle.backgroundColor
        && Number.parseFloat(tabStyle.selected.fontWeight) > Number.parseFloat(tabStyle.idle.fontWeight)
        && tabStyle.selected.boxShadow.includes('inset'),
      JSON.stringify(tabStyle))

    // 焦点：只用键盘 Tab 走到分类按钮，暖棕内环必须可见，且不改变盒子尺寸
    const focusBoxBefore = await rectOf(tabLetters)
    const focusReached = await tabUntil(page, '来往')
    const focusStyle = await styleOf(tabLetters, ['boxShadow'])
    const focusBoxAfter = await rectOf(tabLetters)
    row.checks.focus = { focusReached, focusStyle, focusBoxBefore, focusBoxAfter }
    check(`${vp.name} 键盘焦点有暖棕内环且不改变盒子尺寸`,
      focusReached && focusStyle.boxShadow.includes('inset') && focusStyle.boxShadow.includes('138, 102, 54')
        && focusBoxBefore.width === focusBoxAfter.width && focusBoxBefore.height === focusBoxAfter.height,
      JSON.stringify(row.checks.focus))

    // 轻压反馈：只动 transform，盒子尺寸不变，不产生布局跳动
    const pressBox = await tabLetters.boundingBox()
    const pressBefore = await rectOf(tabLetters)
    await page.mouse.move(pressBox.x + pressBox.width / 2, pressBox.y + pressBox.height / 2)
    await page.mouse.down()
    await sleep(140)
    const pressStyle = await styleOf(tabLetters, ['transform', 'backgroundColor'])
    const pressDuring = await rectOf(tabLetters)
    await page.mouse.up()
    await sleep(160)
    row.checks.press = { pressBefore, pressDuring, transform: pressStyle.transform }
    check(`${vp.name} 按下有轻压反馈且不撑开布局`,
      typeof pressStyle.transform === 'string' && pressStyle.transform.startsWith('matrix')
        && pressBefore.width === pressDuring.width && pressBefore.height === pressDuring.height,
      JSON.stringify(row.checks.press))

    // 新到的那封：第一次打开才渐显；点一下立即全显；回看直接给全文
    const greeting = page.locator('article').filter({ hasText: '朋友的近况' })
    await greeting.getByRole('button', { name: '拆开看看' }).click()
    await waitText(page, '这边下了两天雨，你那边呢')
    const reveal = await revealState(page)
    reveal.fourthGapMs = msOf(reveal.fourthDelay) !== null && msOf(reveal.firstDelay) !== null
      ? Math.round(msOf(reveal.fourthDelay) - msOf(reveal.firstDelay))
      : null
    reveal.durationMs = msOf(reveal.animationDuration)
    row.checks.reveal = reveal
    check(`${vp.name} 新到信件首段逐字渐显（64ms 错峰 / 单字 260–300ms）`,
      reveal.paragraph === 1 && reveal.glyphs > 0 && String(reveal.animationName).includes('glyphIn')
        && reveal.fourthGapMs === 192 && reveal.durationMs !== null && reveal.durationMs >= 260 && reveal.durationMs <= 300,
      JSON.stringify(reveal))
    check(`${vp.name} 渐显时读屏拿到完整原文`,
      reveal.ariaLabel === '这边下了两天雨，你那边呢', String(reveal.ariaLabel))
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-letter-reveal.png`, fullPage: true })

    // 点一下立即显示全文：不再有逐字节点，正文立刻可读
    await page.locator(`${REVEAL_P} span[class*="reveal"]`).click()
    await sleep(120)
    row.checks.revealClick = {
      glyphs: await page.locator(`${REVEAL_P} ${GLYPH}`).count(),
      text: (await page.locator('section[aria-label="这一封的内容"]').innerText()).includes('这边下了两天雨，你那边呢'),
      back: (await page.getByRole('button', { name: '收好，回到这一页' }).count()) > 0,
    }
    check(`${vp.name} 点一下立即显示全文`,
      row.checks.revealClick.glyphs === 0 && row.checks.revealClick.text && row.checks.revealClick.back,
      JSON.stringify(row.checks.revealClick))

    // 展开的信纸沿用同一套像素信纸边框，正文保持可读
    const paperStyle = await styleOf(page.locator('section[aria-label="这一封的内容"]'),
      ['borderTopWidth', 'borderImageSource', 'imageRendering'])
    row.checks.layers.paper = paperStyle
    check(`${vp.name} 展开信纸沿用像素信纸边框`,
      /stationery\.png/.test(paperStyle.borderImageSource) && paperStyle.borderTopWidth === '10px',
      JSON.stringify(paperStyle))
    const readable = await page.evaluate(() => {
      const node = document.querySelector('section[aria-label="这一封的内容"] p[class*="text"]')
      if (!node) return null
      const style = getComputedStyle(node)
      return { color: style.color, lineHeight: style.lineHeight, fontSize: style.fontSize }
    })
    row.checks.readable = readable
    const ratio = readable ? contrastRatio(readable.color, row.checks.layers.page) : null
    check(`${vp.name} 正文文字可读（对比度 ≥ 4.5、行高 ≥ 24）`,
      readable !== null && ratio !== null && ratio >= 4.5 && Number.parseFloat(readable.lineHeight) >= 24,
      JSON.stringify({ ...readable, contrast: ratio && Number(ratio.toFixed(2)) }))
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-letter-open.png`, fullPage: true })

    await page.getByRole('button', { name: '收好，回到这一页' }).click()
    await sleep(200)
    row.checks.detail = { returned: (await page.getByRole('button', { name: '拆开看看' }).count()) === 4 }
    check(`${vp.name} 详情可返回列表`, row.checks.detail.returned, JSON.stringify(row.checks.detail))

    // 回看同一封：已读，直接显示全文，不再渐显
    await greeting.getByRole('button', { name: '拆开看看' }).click()
    await waitText(page, '这边下了两天雨，你那边呢')
    const replay = await revealState(page)
    row.checks.replay = { paragraph: replay.paragraph, glyphs: replay.glyphs }
    check(`${vp.name} 已读回看不再渐显`,
      replay.glyphs === 0 && (await page.getByText('这边下了两天雨，你那边呢', { exact: true }).count()) > 0,
      JSON.stringify(row.checks.replay))
    await page.getByRole('button', { name: '收好，回到这一页' }).click()
    await sleep(200)

    // 长正文：整段能读、不横向溢出、行高够
    await page.locator('article').filter({ hasText: '河边的一封长信' }).getByRole('button', { name: '拆开看看' }).click()
    await waitText(page, '水面结了一层薄冰')
    const longStyle = await styleOf(page.locator(`section[aria-label="这一封的内容"] ${REVEAL_P}`), ['lineHeight', 'fontSize'])
    const longBox = await overflowOf(page)
    row.checks.longText = {
      ...longStyle,
      overflow: longBox,
      tail: (await page.locator('section[aria-label="这一封的内容"]').innerText()).includes('大概也会站在那里不说话'),
    }
    check(`${vp.name} 长正文可读且不横向溢出`,
      row.checks.longText.tail && longBox.scrollWidth <= longBox.clientWidth + 1
        && Number.parseFloat(longStyle.lineHeight) >= 24,
      JSON.stringify(row.checks.longText))
    // 等逐字渐显全部落地再截图：64ms 错峰下长信要跑两秒多，不能停在半透明中间帧
    await page.waitForFunction(sel => [...document.querySelectorAll(sel)]
      .every(node => Number(getComputedStyle(node).opacity) > 0.99), `${REVEAL_P} ${GLYPH}`, { timeout: 8000 })
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-long-letter.png`, fullPage: true })

    // 一级阅读界面：只留「阅读设置」入口，开关与减少动效说明都不能直接出现
    row.checks.settingsEntry = {
      entry: await page.getByRole('button', { name: '阅读设置' }).count(),
      expanded: await page.getByRole('button', { name: '阅读设置' }).getAttribute('aria-expanded'),
      directToggle: await page.getByRole('button', { name: /逐字渐显/ }).count(),
      directReducedNote: await page.getByText('系统已开启「减少动态效果」，这一封直接显示全文。', { exact: true }).count(),
      panel: await page.locator('#e7-reading-settings').count(),
    }
    check(`${vp.name} 一级界面只留阅读设置入口`,
      row.checks.settingsEntry.entry === 1 && row.checks.settingsEntry.expanded === 'false'
        && row.checks.settingsEntry.directToggle === 0 && row.checks.settingsEntry.directReducedNote === 0
        && row.checks.settingsEntry.panel === 0,
      JSON.stringify(row.checks.settingsEntry))

    // 展开二级设置后才出现开关；关掉后写入存储
    await page.getByRole('button', { name: '阅读设置' }).click()
    await sleep(120)
    const toggle = page.getByRole('button', { name: '关掉逐字渐显' })
    row.checks.toggleOff = {
      present: (await toggle.count()) > 0,
      panel: await page.locator('#e7-reading-settings').count(),
      stored: null,
    }
    if (row.checks.toggleOff.present) {
      await toggle.click()
      await sleep(120)
      row.checks.toggleOff.labelAfter = await page.getByRole('button', { name: '打开逐字渐显' }).count()
      row.checks.toggleOff.stored = await page.evaluate(() => localStorage.getItem('e7-journal:reveal'))
    }
    check(`${vp.name} 渐显可关闭并记住选择`,
      row.checks.toggleOff.present && row.checks.toggleOff.panel === 1
        && row.checks.toggleOff.labelAfter === 1 && row.checks.toggleOff.stored === 'off',
      JSON.stringify(row.checks.toggleOff))

    // 收起二级设置后刷新：设置仍收起，渐显仍是关的
    await page.getByRole('button', { name: '阅读设置' }).click()
    await sleep(120)
    row.checks.settingsCollapsed = {
      expanded: await page.getByRole('button', { name: '阅读设置' }).getAttribute('aria-expanded'),
      panel: await page.locator('#e7-reading-settings').count(),
      stored: await page.evaluate(() => localStorage.getItem('e7-journal:settings')),
    }
    check(`${vp.name} 收起二级设置并记住收起`,
      row.checks.settingsCollapsed.expanded === 'false' && row.checks.settingsCollapsed.panel === 0
        && row.checks.settingsCollapsed.stored === 'closed',
      JSON.stringify(row.checks.settingsCollapsed))

    // 关掉之后重新加载：设置仍是收起的，新到的信也直接给全文
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitText(page, '翻开这一趟')
    await page.getByRole('button', { name: /^来往/ }).click()
    await waitText(page, '朋友的近况')
    await page.locator('article').filter({ hasText: '朋友的近况' }).getByRole('button', { name: '拆开看看' }).click()
    await waitText(page, '这边下了两天雨，你那边呢')
    row.checks.settingsAfterReload = {
      expanded: await page.getByRole('button', { name: '阅读设置' }).getAttribute('aria-expanded'),
      panel: await page.locator('#e7-reading-settings').count(),
      directToggle: await page.getByRole('button', { name: /逐字渐显/ }).count(),
    }
    check(`${vp.name} 刷新后设置仍收起且不直接露出开关`,
      row.checks.settingsAfterReload.expanded === 'false' && row.checks.settingsAfterReload.panel === 0
        && row.checks.settingsAfterReload.directToggle === 0,
      JSON.stringify(row.checks.settingsAfterReload))
    const offState = await revealState(page)
    row.checks.revealOff = { glyphs: offState.glyphs, paragraph: offState.paragraph }
    check(`${vp.name} 关掉渐显后新信直接全文`,
      offState.glyphs === 0 && offState.paragraph === 0, JSON.stringify(row.checks.revealOff))
    await page.evaluate(() => localStorage.setItem('e7-journal:reveal', 'on'))

    // 系统「减少动态效果」：逐字节点不再动画，直接可见
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitText(page, '翻开这一趟')
    await page.getByRole('button', { name: /^来往/ }).click()
    await waitText(page, '朋友的近况')
    await page.locator('article').filter({ hasText: '朋友的近况' }).getByRole('button', { name: '拆开看看' }).click()
    await waitText(page, '这边下了两天雨，你那边呢')
    const reduced = await revealState(page)
    row.checks.reducedMotion = {
      glyphs: reduced.glyphs, animationName: reduced.animationName, opacity: reduced.firstOpacity,
    }
    check(`${vp.name} 减少动态效果下不播逐字动画`,
      reduced.animationName === 'none' && reduced.firstOpacity === '1', JSON.stringify(row.checks.reducedMotion))
    await page.emulateMedia({ reducedMotion: 'no-preference' })
    await page.evaluate(() => localStorage.setItem('e7-journal:reveal', 'on'))
    await page.getByRole('button', { name: '收好，回到这一页' }).click()
    await sleep(200)

    // 礼物：只列已收到的，不含自己寄出的与未送达的
    await page.getByRole('button', { name: '收到的礼物', exact: true }).click()
    await waitText(page, '一小卷灰蓝色的毛线')
    const giftText = await page.locator('main').innerText()
    row.checks.gifts = {
      received: giftText.includes('一小卷灰蓝色的毛线'),
      outgoing: giftText.includes('一片压好的银杏叶'),
      pendingGift: giftText.includes('未送达'),
    }
    check(`${vp.name} 礼物只含已收到`, row.checks.gifts.received && !row.checks.gifts.outgoing, JSON.stringify(row.checks.gifts))
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-gifts.png`, fullPage: true })

    // 四态：失败、读取中、部分失败、空态必须彼此可分
    await selectScenario(page, 'error')
    await waitText(page, '重新读取')
    const errorText = await page.locator('main').innerText()
    row.checks.errorState = {
      hasRetry: (await page.getByRole('button', { name: '重新读取' }).count()) > 0,
      saysEmpty: errorText.includes('还没有出过门'),
    }
    check(`${vp.name} 读取失败可重试且不冒充空态`,
      row.checks.errorState.hasRetry && !row.checks.errorState.saysEmpty, JSON.stringify(row.checks.errorState))
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-error.png`, fullPage: true })

    await selectScenario(page, 'slow')
    row.checks.loadingState = (await page.getByText('正在翻这一本手账…', { exact: true }).count()) > 0
    check(`${vp.name} 读取中与失败可分`, row.checks.loadingState === true)
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-loading.png`, fullPage: true })

    await selectScenario(page, 'partial')
    await waitText(page, '翻开这一趟')
    await page.getByRole('button', { name: /^来往/ }).click()
    await waitText(page, '发件暂时读不到')
    row.checks.partial = (await page.getByText(/发件暂时读不到/).count()) > 0
    check(`${vp.name} 单侧失败不拖垮整页`, row.checks.partial === true)
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-partial.png`, fullPage: true })

    await selectScenario(page, 'empty')
    await waitText(page, '还没有出过门')
    row.checks.emptyState = (await page.getByText('还没有出过门。等它第一次出发，这里就会记下第一页。', { exact: true }).count()) > 0
    check(`${vp.name} 空态与失败可分`, row.checks.emptyState === true)
    await page.screenshot({ path: `${OUT}/fixture-${vp.name}-empty.png`, fullPage: true })

    await selectScenario(page, 'sealed')
    await waitText(page, '翻开这一趟')
    await page.getByRole('button', { name: /^来往/ }).click()
    await sleep(400)
    const sealedHtml = await page.content()
    row.checks.sealedOnly = {
      leaked: sealedHtml.includes('未投递秘密标题') || sealedHtml.includes('未投递秘密正文'),
      openButtons: await page.getByRole('button', { name: '拆开看看' }).count(),
    }
    check(`${vp.name} 只有未送达时也无拆信入口`,
      !row.checks.sealedOnly.leaked && row.checks.sealedOnly.openButtons === 0, JSON.stringify(row.checks.sealedOnly))

    check(`${vp.name} 无页面异常`, errors.length === 0, JSON.stringify(errors))
    await ctx.close()
    report.push(row)
  }
  return report
}

async function adopt(name) {
  const auth = await fetch(`${BASE}/api/auth/development`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })
  if (!auth.ok) throw new Error(`development auth ${auth.status}`)
  const cookie = auth.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')
  const draft = { name, interestCategories: ['自然风景', '城市角落'], tendencies: [1, -0.6, 0.8, 0.4, -1, 0.6] }
  const generated = await fetch(`${BASE}/api/adoption/personality`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(draft),
  })
  if (!generated.ok) throw new Error(`personality ${generated.status} ${await generated.text()}`)
  const fingerprint = (await generated.json()).fingerprint
  const created = await fetch(`${BASE}/api/dogs`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ ...draft, assembly: { cloth: 'jacket', hat: 'cap', glasses: 'square', face: 'hopeful' }, fingerprint, requestId: randomUUID() }),
  })
  if (!created.ok) throw new Error(`create ${created.status} ${await created.text()}`)
  return { cookie, dog: (await created.json()).dog }
}

async function realRun(browser) {
  if (!DB_PATH) return { skipped: 'E7_DB_PATH 未设置，未跑真实接口部分' }
  const { DatabaseSync } = await import('node:sqlite')
  const me = await adopt('手账验收')
  const peer = await adopt('手账伙伴')
  const stamp = Date.now()
  const tripId = `trip_e7_${stamp}`
  const now = new Date().toISOString()

  const db = new DatabaseSync(DB_PATH)
  try {
    const seq = (db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM trip WHERE dog_id = ?').get(me.dog.id)).next
    db.prepare('INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at,wish_id) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(tripId, me.dog.id, seq, 'done', 'auto', now, now, now, null)
    db.prepare('INSERT INTO find(id,trip_id,kind,title,excerpt,source_url,source_mode,authority_level,vote_up_count,asset_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(`find_e7_scene_${stamp}`, tripId, 'scene', '验收地点A', '验收用的场景摘录。', null, null, null, null, null, now)
    db.prepare('INSERT INTO find(id,trip_id,kind,title,excerpt,source_url,source_mode,authority_level,vote_up_count,asset_path,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run(`find_e7_zhihu_${stamp}`, tripId, 'zhihu', '验收知乎条目', '验收用的知乎摘录。', 'https://www.zhihu.com/question/123', 'live', 3, 42, null, now)
    db.prepare('INSERT INTO message(id,trip_id,text,mentions_find_id,created_at) VALUES(?,?,?,?,?)')
      .run(`msg_e7_${stamp}`, tripId, '验收归来话：今天走得很慢。', `find_e7_scene_${stamp}`, now)
    db.prepare('INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at,delivered_at,replied_at,read_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(`ex_e7_arrived_${stamp}`, peer.dog.id, me.dog.id, 'find',
        JSON.stringify({ kind: 'find', findTitle: '验收已到标题', findExcerpt: '验收已到正文。', sourceUrl: null, sourceMode: 'fixture' }),
        seq, now, now, null, null)
    db.prepare('INSERT INTO exchange(id,from_dog,to_dog,kind,payload,deliver_after_trip_seq,created_at,delivered_at,replied_at,read_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(`ex_e7_sealed_${stamp}`, peer.dog.id, me.dog.id, 'find',
        JSON.stringify({ kind: 'find', findTitle: '验收未送达标题', findExcerpt: '验收未送达正文。', sourceUrl: null, sourceMode: null }),
        seq + 5, now, null, null, null)
  } finally {
    db.close()
  }

  const ctx = await browser.newContext({ viewport: { width: 375, height: 667 } })
  const [name, value] = me.cookie.split('=')
  await ctx.addCookies([{ name, value, domain: new URL(BASE).hostname, path: '/' }])
  const page = await ctx.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(String(error.message).slice(0, 160)))
  const out = { dogId: me.dog.id, tripId, errors, checks: {} }

  await page.goto(`${BASE}/journal`, { waitUntil: 'domcontentloaded', timeout: 60000 })
  await waitText(page, '手账')
  await waitText(page, '翻开这一趟')
  out.url = page.url()
  out.heading = await page.locator('h1').first().innerText().catch(() => null)
  out.tabs = await page.getByRole('navigation', { name: '手账分类' }).locator('button').allInnerTexts()
  check('真实页 h1 为手账', out.heading === '手账', String(out.heading))

  const box = await overflowOf(page)
  out.checks.overflow = box
  check('真实页 375 无横向溢出', box.scrollWidth <= box.clientWidth + 1, JSON.stringify(box))

  await page.getByRole('button', { name: '翻开这一趟' }).first().click()
  await waitText(page, '验收地点A')
  out.checks.trip = {
    place: (await page.getByText('验收地点A', { exact: true }).count()) > 0,
    count: (await page.getByText(/这一趟记下 2 条发现/).count()) > 0,
    message: (await page.getByText('验收归来话：今天走得很慢。', { exact: true }).count()) > 0,
  }
  check('真实页展开显示地点/条数/归来话',
    out.checks.trip.place && out.checks.trip.count && out.checks.trip.message, JSON.stringify(out.checks.trip))
  await page.screenshot({ path: `${OUT}/real-375x667-trip-open.png`, fullPage: true })

  await page.getByRole('button', { name: /^来往/ }).click()
  await waitText(page, '收到')
  await sleep(300)
  const html = await page.content()
  out.checks.letters = {
    arrivedVisible: (await page.getByText('验收已到标题', { exact: true }).count()) > 0,
    sealedLeak: html.includes('验收未送达标题') || html.includes('验收未送达正文'),
    sealedPlaceholder: (await page.getByText('有一份东西还在路上', { exact: true }).count()) > 0,
    openButtons: await page.getByRole('button', { name: '拆开看看' }).count(),
  }
  check('真实页未送达不泄露且无拆信入口',
    !out.checks.letters.sealedLeak && out.checks.letters.sealedPlaceholder, JSON.stringify(out.checks.letters))
  await page.screenshot({ path: `${OUT}/real-375x667-letters.png`, fullPage: true })

  const readSeen = []
  page.on('response', async response => {
    if (!response.url().includes('/read')) return
    const entry = { status: response.status(), body: '' }
    try { entry.body = await response.text() } catch { entry.body = '' }
    readSeen.push(entry)
  })

  function readAtOf(exchangeId) {
    const conn = new DatabaseSync(DB_PATH)
    try { return conn.prepare('SELECT read_at FROM exchange WHERE id = ?').get(exchangeId).read_at }
    finally { conn.close() }
  }

  const readAtBefore = readAtOf(`ex_e7_arrived_${stamp}`)
  await page.getByRole('button', { name: '拆开看看' }).first().click()
  await waitText(page, '验收已到正文。')
  // 等真实落库，而不是固定等一个毫秒数（PATCH 本身可能要几百毫秒）
  let readAtAfter = null
  for (let attempt = 0; attempt < 40; attempt++) {
    readAtAfter = readAtOf(`ex_e7_arrived_${stamp}`)
    if (readAtAfter) break
    await sleep(250)
  }
  const sealedReadAt = readAtOf(`ex_e7_sealed_${stamp}`)

  out.checks.read = {
    before: readAtBefore,
    after: readAtAfter,
    sealedUntouched: sealedReadAt === null,
    responseStatus: readSeen[0]?.status ?? null,
    responseHasReadAt: typeof readSeen[0]?.body === 'string' && readSeen[0].body.includes('"readAt":"'),
    bodyVisible: (await page.getByText('验收已到正文。', { exact: true }).count()) > 0,
  }
  check('真实页拆信后才写已读',
    readAtBefore === null && typeof readAtAfter === 'string' && out.checks.read.sealedUntouched
      && out.checks.read.responseStatus === 200 && out.checks.read.responseHasReadAt,
    JSON.stringify(out.checks.read))
  await page.screenshot({ path: `${OUT}/real-375x667-letter-open.png`, fullPage: true })

  // 回看同一封：已读，直接给全文；且不能因为再打开一次又写一遍已读
  const firstReveal = await revealState(page)
  const patchesAfterFirst = readSeen.length
  await page.getByRole('button', { name: '收好，回到这一页' }).click()
  await sleep(250)
  await page.getByRole('button', { name: '拆开看看' }).first().click()
  await waitText(page, '验收已到正文。')
  await sleep(600)
  const replay = await revealState(page)
  out.checks.replay = {
    firstGlyphs: firstReveal.glyphs,
    replayGlyphs: replay.glyphs,
    patchesAfterFirst,
    patchesAfterReplay: readSeen.length,
  }
  check('真实页回看不再渐显且不重复写已读',
    firstReveal.glyphs > 0 && replay.glyphs === 0 && readSeen.length === patchesAfterFirst,
    JSON.stringify(out.checks.replay))

  await page.getByRole('button', { name: '收好，回到这一页' }).click()
  await page.getByRole('button', { name: '收到的礼物', exact: true }).click()
  await sleep(400)
  out.checks.gifts = (await page.locator('main').innerText()).includes('还没有收到礼物')
  check('真实页无礼物时是空态而非报错', out.checks.gifts === true)
  await page.screenshot({ path: `${OUT}/real-375x667-gifts.png`, fullPage: true })

  check('真实页无页面异常', errors.length === 0, JSON.stringify(errors))
  await ctx.close()
  return out
}

mkdirSync(OUT, { recursive: true })
const chromium = await loadChromium()
const launchOptions = { headless: true, args: ['--no-sandbox', '--no-proxy-server'] }
if (process.env.E7_CHROME) launchOptions.executablePath = process.env.E7_CHROME
const browser = await chromium.launch(launchOptions)

const result = { base: BASE, ranAt: new Date().toISOString(), fixture: null, real: null, failures }
try {
  result.fixture = await fixtureRun(browser)
  if (process.env.E7_REAL === '1') result.real = await realRun(browser)
} finally {
  await browser.close()
}

writeFileSync(`${OUT}/verification.json`, `${JSON.stringify(result, null, 2)}\n`)
console.log(JSON.stringify(result, null, 2))
if (failures.length) {
  console.error(`FAILED ${failures.length}`)
  process.exitCode = 1
} else {
  console.log('ALL CHECKS PASSED')
}
