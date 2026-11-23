// 浏览器复现脚本（本次归档新增，2026-11-22）
// 用法：在 team/2026-11-22/e/ 目录运行 python -m http.server 8623 --bind 127.0.0.1
//       然后 node e12/minimum-assembly/browser-check.cjs
// 需要 playwright 模块与一个 Chromium；可用 E4_CHROMIUM_PATH 指定可执行文件。
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.E4_CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--no-proxy-server', '--proxy-bypass-list=<-loopback>'],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
  const bad = [];
  page.on('requestfailed', r => bad.push('FAIL ' + r.url() + ' :: ' + ((r.failure() || {}).errorText || '')));
  page.on('response', r => { if (r.status() >= 400) bad.push('HTTP' + r.status() + ' ' + r.url()); });
  await page.goto('http://127.0.0.1:8623/e12/minimum-assembly/', { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelector('#result').textContent !== '载入中', null, { timeout: 20000 });
  const text = await page.textContent('#result');
  const imagesOk = await page.evaluate(() => [...document.images].every(i => i.complete && i.naturalWidth > 0));
  await page.screenshot({ path: 'e12/minimum-assembly/browser-check.png' });
  console.log('RESULT:', text);
  console.log('images ok:', imagesOk);
  console.log('bad requests:', bad.length ? bad : 'none');
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exitCode = 1; });
