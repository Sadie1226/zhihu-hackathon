const {chromium}=require('playwright');
const {pathToFileURL}=require('url');const path=require('path'),fs=require('fs');
(async()=>{const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}),headless:true});const page=await browser.newPage();const url=pathToFileURL(path.join(__dirname,'index.html')).href;const errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
const open=async(p,s='')=>{await page.goto(url+`?page=${p}${s?'&state='+s:''}`);await page.evaluate(()=>document.fonts.ready);await page.locator('img').evaluateAll(a=>Promise.all(a.map(i=>i.decode())))};
const assert=(v,msg)=>{if(!v)throw Error(msg);checks.push(msg)};
for(const [width,height]of [[375,900],[812,375],[1440,1000]]){
await page.setViewportSize({width,height});
for(const state of ['default','away','returned']){
await open('home',state);assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}/${state} no overflow`);
assert(await page.locator('.home-dock button').count()===4,`${width}/${state} four primary entries`);
assert(await page.locator('.room-actor').count()===(state==='away'?0:1),`${width}/${state} correct presence`);
assert((await page.locator('.room-background').evaluate(e=>e.currentSrc)).includes(width===375?'room-tall':'room-wide'),`${width}/${state} correct scene composition`);
await page.screenshot({path:path.join(__dirname,`home-${state}-${width}.png`),fullPage:true});
}
await open('creation','success');assert(await page.locator('.entry-door').count()===1,`${width} independent entrance door`);
assert(await page.locator('.entry-door').evaluate(e=>{const d=e.getBoundingClientRect(),a=document.querySelector('.entry-dog').getBoundingClientRect();return d.x+d.width/2<a.x+a.width/2}),`${width} entrance door left of character`);
await page.screenshot({path:path.join(__dirname,`entry-${width}.png`),fullPage:true});
await open('wardrobe');for(const tab of ['hat','glasses','face']){
await page.locator(`[data-outfit-tab="${tab}"]`).click();assert(await page.locator('[data-outfit]').evaluateAll(a=>{const b=a.map(e=>e.getBoundingClientRect());return b.length===4&&b[0].y===b[1].y&&b[2].y===b[3].y&&b[0].y<b[2].y&&b[0].x===b[2].x}),`${width}/${tab} 2 by 2`);
}await page.screenshot({path:path.join(__dirname,`wardrobe-four-${width}.png`),fullPage:true});
await open('home');for(const id of ['chat','wish','mail','journal','profile','settings']){
await page.locator(`[data-panel="${id}"]`).first().click();assert(await page.locator('.home-panel').isVisible(),`${width}/${id} opens`);
assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),`${width}/${id} panel no overflow`);
await page.keyboard.press('Escape');assert(await page.locator('.home-panel').isHidden(),`${width}/${id} closes with Escape`);
} }
await page.setViewportSize({width:375,height:900});await open('home');
await page.locator('[data-panel="profile"]').click();await page.locator('#rename').fill('山山');await page.locator('[data-local="rename"]').click();assert((await page.locator('#home-name').innerText()).includes('山山'),'rename updates home title');
await page.screenshot({path:path.join(__dirname,'home-profile-375.png'),fullPage:true});await page.keyboard.press('Escape');await page.reload();assert((await page.locator('#home-name').innerText()).includes('山山'),'rename persists demo draft');
await page.locator('[data-panel="wish"]').click();await page.locator('#wish-text').fill('看看河边');await page.locator('[data-local="wish"]').click();assert(await page.locator('.wish-item').count()===1,'wish demo added');await page.locator('[data-remove]').click();assert(await page.locator('.wish-item').count()===0,'wish demo revoked');
await page.keyboard.press('Escape');await page.locator('[data-panel="settings"]').click();await page.locator('#reduced-motion').check();await page.keyboard.press('Escape');assert(await page.evaluate(()=>JSON.parse(sessionStorage.getItem('kanshan-a4-v25')).reducedMotion===true),'motion preference reserved');
assert(errors.length===0,'no runtime errors');fs.writeFileSync(path.join(__dirname,'home-checks.json'),JSON.stringify({checks,errors},null,2));await browser.close();console.log(checks.length+' home checks passed');})().catch(e=>{console.error(e);process.exit(1)});
