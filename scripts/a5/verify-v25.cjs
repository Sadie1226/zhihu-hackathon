// Run against a local dev preview; Playwright/pngjs/pixelmatch may be supplied via NODE_PATH.
const { chromium } = require('playwright')
const { PNG } = require('pngjs')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')
const assert = require('node:assert/strict')
const base = process.env.A5_PREVIEW_URL || 'http://127.0.0.1:3105'
const source = pathToFileURL(path.resolve('app/(a)/_design/a4-v25/index.html')).href
const assembly = {cloth:'hoodie',hat:'none',glasses:'none',face:'happy'}
const dog = {id:'visual',name:'看山',personalityTags:['好奇','看物','当下'],interestCategories:null,assembly,isSample:false}
async function ready(page) {
  await page.evaluate(() => document.fonts.ready)
  await page.locator('img').evaluateAll(imgs => Promise.all(imgs.map(i=>i.decode())))
}
async function rect(page, selector, parent) {
  return page.locator(selector).first().evaluate((e,parent)=>{
    const b=e.getBoundingClientRect(), r=parent?document.querySelector(parent).getBoundingClientRect():{x:0,y:0}
    const s=getComputedStyle(e)
    return {x:b.x-r.x,y:b.y-r.y,width:b.width,height:b.height,font:s.fontFamily,size:s.fontSize,color:s.color}
  },parent)
}
// Review controls intentionally aren't shipped. Align ONLY the outer crop's device-pixel phase
// identically in both pages, retaining all unmodified relative geometry in the report.
async function capture(page, selector, file) {
  const offset=await page.locator(selector).evaluate(e=>{
    e.dataset.captureStyle=e.getAttribute('style') || ''
    if(getComputedStyle(e).position==='static')e.style.position='relative'
    const b=e.getBoundingClientRect(); const x=Math.round(b.x)-b.x,y=Math.round(b.y)-b.y
    e.style.left=`${x}px`; e.style.top=`${y}px`; return {x,y}
  })
  const buffer=await page.locator(selector).screenshot({path:file})
  await page.locator(selector).evaluate(e=>{e.setAttribute('style',e.dataset.captureStyle);delete e.dataset.captureStyle})
  return {buffer,offset}
}
;(async()=>{
  assert.ok(['localhost','127.0.0.1'].includes(new URL(base).hostname))
  fs.mkdirSync('.local',{recursive:true})
  const {default:pixelmatch}=await import(pathToFileURL(require.resolve('pixelmatch')).href)
  const browser=await chromium.launch({channel:'chrome',headless:true})
  const reference=await browser.newPage(), current=await browser.newPage()
  const errors=[]
  current.on('pageerror',e=>errors.push(e.message))
  await current.route('**/api/session',r=>r.fulfill({json:{provider:'development',authenticated:true,dog}}))
  let state='default'
  await current.route('**/api/dogs/*/trips?limit=2',r=>r.fulfill({json:{trips:state==='default'?[]:[{id:'visual-trip',dogId:dog.id,seq:1,status:state==='away'?'running':'done',trigger:'auto',createdAt:'2026-11-19T00:00:00Z',startedAt:'2026-11-19T00:00:00Z',endedAt:state==='returned'?'2026-11-19T01:00:00Z':null}]}}))
  const report={home:[],adoption:[],errors}
  for(const viewport of [{width:375,height:667},{width:768,height:900},{width:1440,height:900},{width:812,height:375}]) {
    for(const p of [reference,current])await p.setViewportSize(viewport)
    for(state of ['default','away','returned']){
      await reference.goto(source+`?page=home&state=${state}`)
      await current.goto(base+'/home')
      await current.getByRole('link',{name:`查看旅途：${state==='away'?'出门了':state==='returned'?'刚回来':'在家'}`,exact:true}).waitFor()
      await Promise.all([ready(reference),ready(current)])
      const row={...viewport,state,geometry:{}}
      for(const selector of ['.home-room','.scene-left-ui','.nameplate','.settings-button','.room-speech',...(state==='away'?[]:['.room-actor'])]){
        const pair=await Promise.all([reference,current].map(p=>rect(p,selector,'.home-room')))
        row.geometry[selector]=pair
        for(const key of ['x','y','width','height'])assert.ok(Math.abs(pair[0][key]-pair[1][key])<0.05,`${viewport.width}/${state}/${selector}/${key}`)
      }
      const stem=`.local/v25-${state}-${viewport.width}`
      const a=await capture(reference,'.home-room',stem+'-reference.png'),b=await capture(current,'.home-room',stem+'-react.png')
      const i=PNG.sync.read(a.buffer),j=PNG.sync.read(b.buffer)
      assert.equal(i.width,j.width);assert.equal(i.height,j.height)
      const diff=new PNG({width:i.width,height:i.height})
      row.pixels=pixelmatch(i.data,j.data,diff.data,i.width,i.height,{threshold:0.1})
      row.total=i.width*i.height; row.ratio=row.pixels/row.total;row.captureAlignment=[a.offset,b.offset]
      assert.ok(row.ratio<0.001,`home visual regression: ${viewport.width}/${state}`)
      fs.writeFileSync(stem+'-diff.png',PNG.sync.write(diff))
      if(state==='default'){
        await reference.locator('[data-panel="profile"]').click()
        await current.getByRole('button',{name:'档案',exact:true}).click()
        row.panel=await Promise.all([reference,current].map(p=>rect(p,'.home-panel')))
        for(const key of ['x','y','width','height'])assert.ok(Math.abs(row.panel[0][key]-row.panel[1][key])<0.05,`panel ${viewport.width} ${key}`)
        await current.getByRole('dialog').screenshot({path:`.local/v25-panel-${viewport.width}.png`})
      }
      report.home.push(row)
    }
  }
  // Capture the actual persisted seven-step flow; the source page is never injected into React.
  const context=await browser.newContext(), flow=await context.newPage()
  flow.on('pageerror',e=>errors.push(e.message))
  const steps=[['auth','entry'],['profile','two'],['traits','default'],['tags','result'],['wardrobe','default'],['creation','success']]
  await flow.goto(base+'/adopt')
  for(const [step,scene] of steps){
    for(const viewport of [{width:375,height:667},{width:768,height:900},{width:1440,height:900},{width:812,height:375}]){
      await flow.setViewportSize(viewport);await reference.setViewportSize(viewport)
      await reference.goto(source+`?page=${step}&state=${scene}`)
      await Promise.all([ready(reference),ready(flow)])
      assert.equal(await flow.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false,`${step}/${viewport.width} overflow`)
      const row={step,...viewport,regions:{}}
      const revisedWardrobe=step==='wardrobe' && viewport.width>850
      for(const selector of ['#paper','.world','#character-stage','h1']) {
        row.regions[selector]=await Promise.all([reference,flow].map(p=>rect(p,selector,'#content')))
        const pair=row.regions[selector]
        for(const key of ['x','y','width','font','size','color']) {
          if(revisedWardrobe && key==='y' && ['.world','#character-stage'].includes(selector))continue
          assert.equal(pair[0][key],pair[1][key],`${step}/${viewport.width}/${selector}/${key}`)
        }
      }
      const stem=`.local/v25-stage-${step}-${viewport.width}`
      if(revisedWardrobe){
        const actor=await rect(flow,'.character-only .reference-actor','#content'), paper=row.regions['#paper'][1]
        assert.equal(actor.width,345); assert.equal(actor.height,400)
        assert.ok(Math.abs(actor.x+actor.width/2-row.regions['.world'][1].width/2)<0.05)
        assert.ok(Math.abs(actor.y+actor.height/2-paper.y-paper.height/2)<0.05)
        row.revision='User revision: desktop wardrobe dog centered in left column, 345x400 (25% larger); excluded from original-stage pixel equality.'
        row.actor=actor
        await capture(flow,'#character-stage',stem+'-react.png')
      }else{
      const a=await capture(reference,'#character-stage',stem+'-reference.png'),b=await capture(flow,'#character-stage',stem+'-react.png')
      const i=PNG.sync.read(a.buffer),j=PNG.sync.read(b.buffer)
      assert.equal(i.width,j.width);assert.equal(i.height,j.height)
      const diff=new PNG({width:i.width,height:i.height})
      row.stagePixels=pixelmatch(i.data,j.data,diff.data,i.width,i.height,{threshold:0.1})
      row.stageTotal=i.width*i.height
      assert.ok(row.stagePixels/row.stageTotal<0.001,`stage visual regression: ${step}/${viewport.width}`)
      fs.writeFileSync(stem+'-diff.png',PNG.sync.write(diff))
      }
      const component={profile:'.chips',traits:'.sliders',wardrobe:'.wardrobe-options'}[step]
      if(component){
        const a=await capture(reference,component,stem+'-controls-reference.png'),b=await capture(flow,component,stem+'-controls-react.png')
        const i=PNG.sync.read(a.buffer),j=PNG.sync.read(b.buffer)
        assert.equal(i.width,j.width);assert.equal(i.height,j.height)
        const diff=new PNG({width:i.width,height:i.height})
        row.controlPixels=pixelmatch(i.data,j.data,diff.data,i.width,i.height,{threshold:0.1});row.controlTotal=i.width*i.height
        assert.ok(row.controlPixels/row.controlTotal<0.015,`controls visual regression: ${step}/${viewport.width}`)
        fs.writeFileSync(stem+'-controls-diff.png',PNG.sync.write(diff))
      }
      await flow.evaluate(()=>window.scrollTo(0,0))
      await flow.screenshot({path:`.local/v25-react-${step}-${viewport.width}.png`,fullPage:true})
      report.adoption.push(row)
    }
    if(step==='auth'){
      await flow.getByRole('button',{name:'以测试身份开始 →'}).click()
      await flow.getByRole('button',{name:'继续，给它起个名字 →'}).click()
      await flow.locator('#dog-name').fill('看山')
      await flow.getByRole('button',{name:'自然风景',exact:true}).click()
      await flow.getByRole('button',{name:'城市角落',exact:true}).click()
    }else if(step==='profile')await flow.getByRole('button',{name:'继续，认识它的性格 →'}).click()
    else if(step==='traits')await flow.getByRole('button',{name:'看看它的三个词 →'}).click()
    else if(step==='tags')await flow.getByRole('button',{name:'去挑一套穿搭 →'}).click()
    else if(step==='wardrobe'){
      await flow.getByRole('button',{name:'就这样，成为伙伴 →'}).click()
      await flow.getByRole('button',{name:'进入它的小屋 →'}).waitFor()
    }
  }
  assert.deepEqual(errors,[])
  fs.writeFileSync('.local/v25-verification.json',JSON.stringify(report,null,2))
  console.log(JSON.stringify({home:report.home.map(({width,state,pixels,total})=>({width,state,pixels,total})),adoption:report.adoption.map(({step,width,stagePixels,stageTotal})=>({step,width,stagePixels,stageTotal})),errors},null,2))
  await browser.close()
})().catch(e=>{console.error(e);process.exit(1)})
