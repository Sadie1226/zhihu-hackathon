import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// Local E1 review renderer. No package installation, production API or browser account.
// Reuses an explicitly supplied installed Chromium executable in an isolated temporary profile.
const here = fileURLToPath(new URL('.', import.meta.url));
const root = resolve(here, '../..');
const html = join(here, 'index.html');
const output = join(root, 'team/2026-11-16/e');
const browserExe = process.env.BROWSER_EXE;
const renderVersion = process.env.REVIEW_VERSION || 'v1';
assert.match(renderVersion, /^v[1-9][0-9]*$/, 'REVIEW_VERSION must be a delivery version such as v2.');
if (!browserExe) throw new Error('Set BROWSER_EXE to an installed Chromium executable.');
await access(browserExe); await access(html); await access(output);
for (const title of ['小屋', '旅途', '朋友来信']) {
  for (const kind of ['关键稿', '手机稿']) {
    const target = join(output, `1116-e1-${title}${kind}-${renderVersion}.png`);
    const exists = await access(target).then(() => true, () => false);
    if (exists) throw new Error(`Refusing to overwrite an existing delivery: ${target}. Use a new REVIEW_VERSION.`);
  }
}
const validationPath = join(here, `validation-${renderVersion}.json`);
if (await access(validationPath).then(() => true, () => false)) throw new Error('Validation output already exists; use a new REVIEW_VERSION.');
const profile = await mkdtemp(join(tmpdir(), 'kanshan-e1-review-'));
const chrome = spawn(browserExe, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-extensions', '--hide-scrollbars', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
const endpoint = await new Promise((resolveEndpoint, reject) => {
  let errors = '';
  const timer = setTimeout(() => reject(new Error(`Browser startup timed out: ${errors.slice(-800)}`)), 20000);
  chrome.stderr.on('data', chunk => {
    errors += chunk.toString();
    const match = errors.match(/DevTools listening on (ws:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
  });
  chrome.once('error', error => { clearTimeout(timer); reject(error); });
  chrome.once('exit', code => { clearTimeout(timer); reject(new Error(`Browser exited during startup: ${code} ${errors.slice(-800)}`)); });
});
const ws = new WebSocket(endpoint);
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }); });
let sequence = 0;
const pending = new Map();
const listeners = new Set();
const exceptions = [];
ws.addEventListener('message', event => {
  const msg = JSON.parse(event.data);
  if (msg.id && pending.has(msg.id)) {
    const item = pending.get(msg.id); pending.delete(msg.id); clearTimeout(item.timer);
    if (msg.error) item.reject(new Error(JSON.stringify(msg.error))); else item.resolve(msg.result);
  } else {
    if (msg.method === 'Runtime.exceptionThrown') exceptions.push(msg.params.exceptionDetails.text);
    for (const listener of [...listeners]) listener(msg);
  }
});
function call(method, params = {}, sessionId) {
  return new Promise((resolveCall, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 20000);
    pending.set(id, { resolve: resolveCall, reject, timer });
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
function once(method, sessionId) {
  return new Promise((resolveEvent, reject) => {
    const timer = setTimeout(() => { listeners.delete(listener); reject(new Error(`Missing browser event: ${method}`)); }, 20000);
    function listener(msg) {
      if (msg.method === method && msg.sessionId === sessionId) { clearTimeout(timer); listeners.delete(listener); resolveEvent(msg.params); }
    }
    listeners.add(listener);
  });
}
let session;
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function navigate(page, state = 'normal', width = 1600, height = 1200) {
  await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 600 }, session);
  const url = pathToFileURL(html); url.searchParams.set('page', page); url.searchParams.set('state', state); url.searchParams.set('capture', '1');
  const ready = once('Page.loadEventFired', session);
  await call('Page.navigate', { url: url.href }, session); await ready;
  await evaluate('Promise.all([document.fonts.ready, ...Array.from(document.images, img => img.decode())]).then(() => true)');
}
async function screen(name) {
  const result = await call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, session);
  const bytes = Buffer.from(result.data, 'base64');
  await writeFile(join(output, name), bytes); return bytes.length;
}
const report = { browser: null, desktop: [], mobile: [], checks: [], exceptions };
try {
  report.browser = (await call('Browser.getVersion')).product;
  const target = await call('Target.createTarget', { url: 'about:blank' });
  session = (await call('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await call('Page.enable', {}, session); await call('Runtime.enable', {}, session);
  for (const [page, title] of [['home', '小屋'], ['trip', '旅途'], ['mail', '朋友来信']]) {
    await navigate(page);
    const metrics = await evaluate('({width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight, title: document.querySelector("section:not([hidden]) h1").textContent, images: Array.from(document.images).map(x => ({loaded: x.complete && x.naturalWidth > 0, width:x.naturalWidth, height:x.naturalHeight}))})');
    assert.equal(metrics.scrollWidth, metrics.width, `${page}: horizontal overflow`);
    assert.ok(metrics.scrollHeight <= metrics.height, `${page}: desktop content is clipped`);
    assert.ok(metrics.images.every(x => x.loaded));
    const name = `1116-e1-${title}关键稿-${renderVersion}.png`;
    const bytes = await screen(name);
    report.desktop.push({ page, file: name, bytes, ...metrics });
    await navigate(page, 'normal', 390, 1200);
    const mobile = await evaluate('({width:innerWidth, scrollWidth:document.documentElement.scrollWidth, contentHeight:document.documentElement.scrollHeight})');
    assert.equal(mobile.scrollWidth, 390, `${page}: mobile horizontal overflow`);
    const mobileName = `1116-e1-${title}手机稿-${renderVersion}.png`;
    const mobileBytes = await screen(mobileName);
    report.mobile.push({ page, file: mobileName, bytes: mobileBytes, ...mobile });
  }
  // Inspect available interactive controls before exercising the authored local mockup.
  await navigate('mail');
  const labels = await evaluate('Array.from(document.querySelectorAll("button")).filter(b => b.getClientRects().length).map(b => b.textContent.trim())');
  assert.ok(labels.includes('写一段捎话')); report.checks.push('Visible local controls inspected');
  await evaluate('document.querySelector("#letter-paper [data-modal=relay]").click()');
  assert.ok((await evaluate('document.querySelector("#dialog-content").textContent')).includes('这是一位示例伙伴，可能不会回话。'));
  await evaluate('document.querySelector("#draft-input").value="预览草稿";document.querySelector("#draft-input").dispatchEvent(new Event("input"));document.querySelector("#keep-draft").click()');
  assert.ok((await evaluate('document.querySelector("#draft-message").textContent')).includes('未发送'));
  await evaluate('document.querySelector("#dialog-close").click();document.querySelector("#letter-paper [data-modal=relay]").click()');
  assert.equal(await evaluate('document.querySelector("#draft-input").value'), '预览草稿');
  await evaluate('new Promise(resolve => { document.querySelector("#preview-dialog").addEventListener("close", () => requestAnimationFrame(() => resolve(true)), {once:true}); document.querySelector("#dialog-close").click(); })');
  assert.equal(await evaluate('document.activeElement.dataset.modal'), 'relay');
  report.checks.push('Relay sample notice, in-preview draft retention, no-send result and close focus return');
  await evaluate('document.querySelector("[data-letter=gift]").click()');
  assert.ok((await evaluate('document.querySelector("#letter-paper").textContent')).includes('示例回应照片未提供'));
  await evaluate('document.querySelector("[data-mailtab=received]").focus();document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}))');
  assert.equal(await evaluate('document.activeElement.dataset.mailtab'), 'sent');
  assert.ok((await evaluate('document.querySelector("#letter-paper").textContent')).includes('有东西在路上，还没到。'));
  assert.ok(!(await evaluate('document.querySelector("#letter-paper").textContent')).includes('楼下的桂花开了'));
  report.checks.push('Missing-photo placeholder; sent/in-transit is not an arrived incoming message and does not expose payload');
  for (const page of ['home', 'trip', 'mail']) {
    for (const state of ['empty', 'failed', 'degraded']) {
      await navigate(page, state);
      assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
      const copy = await evaluate('document.querySelector("main").innerText');
      assert.ok(copy.includes('示例内容'));
      if (state === 'failed') assert.ok(copy.includes('再试一次'));
      if (page === 'mail' && state === 'empty') assert.ok(copy.includes('还没有谁捎东西来。它出门的时候会看看信箱。'));
    }
    await navigate(page, 'loading');
    await evaluate('new Promise(resolve => { if(document.querySelector("#state-select").value === "degraded") return resolve(true); const observer=new MutationObserver(() => { if(document.querySelector("#state-select").value === "degraded") {observer.disconnect();resolve(true);} }); observer.observe(document.querySelector("#main"), {childList:true,subtree:true}); })');
    assert.equal(await evaluate('document.querySelector("#state-select").value'), 'degraded');
  }
  report.checks.push('Three pages: empty/failed/degraded visible and loading resolves into explicit degradation within the configured 1.9s feedback window');
  await navigate('trip');
  await evaluate('document.querySelector("[data-find=snow]").click()');
  assert.ok((await evaluate('document.querySelector("#dialog-content").textContent')).includes('假原文链接不可点'));
  assert.equal(await evaluate('document.querySelectorAll("a[href^=http]").length'), 0);
  report.checks.push('Fixture Zhihu content marked as example; no fake original links');
  assert.equal(exceptions.length, 0, `Browser exceptions: ${exceptions.join(', ')}`);
  await writeFile(validationPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  try { await call('Browser.close'); } catch { chrome.kill(); }
  ws.close();
  for (const item of pending.values()) clearTimeout(item.timer);
}
