import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawn, execFileSync } from 'node:child_process'
import { mkdirSync, appendFileSync, writeFileSync, existsSync, unlinkSync, rmdirSync, renameSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { openDatabase } from '../../lib/db/bootstrap.ts'
import { createFindStore } from '../../lib/trips/finds.ts'
import { checkPersonalityTags } from '../../contracts/types.ts'
import { inspectPhoto } from '../../app/(b)/b6-photo.ts'
const require = createRequire(import.meta.url)
const { chromium } = require('playwright')
const mode = process.env.AUDIT_MODE || 'wiring'
const out = `.local/audit-${mode}`
mkdirSync(out,{recursive:true})
const dbPath=path.resolve(`${out}/a5-development-${randomUUID()}.sqlite`)
const base='http://127.0.0.1:3131'
const fixtureDirectory=path.resolve('app/(a)/a-wiring-fixture')
const fixtureFile=path.join(fixtureDirectory,'page.tsx')
if(mode!=='baseline') {
  assert.equal(existsSync(fixtureDirectory),false,'refuse to overwrite an existing route')
  mkdirSync(fixtureDirectory)
  writeFileSync(fixtureFile,"export { default } from '@/scripts/a5/fixtures/wiring-preview'\n")
}
const result={mode,sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),fixtureOnly:true,realOAuth:false,checks:[],knownGaps:[],errors:[]}
result.workingTreeDirty=!!execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()
const child=spawn(process.execPath,['node_modules/next/dist/bin/next','dev','--hostname','127.0.0.1','--port','3131'],{windowsHide:true,env:{...process.env,DATABASE_PATH:dbPath,APP_IDENTITY_PROVIDER:'development',UPLOAD_DIR:path.resolve(`${out}/uploads`)}})
child.stdout.on('data',d=>appendFileSync(`${out}/server.log`,d))
child.stderr.on('data',d=>appendFileSync(`${out}/server.log`,d))
let browser
const mark=(name,details={})=>result.checks.push({name,...details,passed:true})
try {
  for(let i=0;i<120;i++) {
    if(child.exitCode!==null) throw Error(`Server exited ${child.exitCode}`)
    try {if((await fetch(base+'/api/health')).ok) break} catch { /* Server is still starting. */ }
    await new Promise(r=>globalThis.setTimeout(r,250))
  }
  browser=await chromium.launch({channel:'chrome',headless:true})
  const contexts=await Promise.all([browser.newContext({viewport:{width:375,height:667}}),browser.newContext({viewport:{width:1440,height:900}})])
  const pages=await Promise.all(contexts.map(c=>c.newPage()))
  for(const page of pages) page.on('pageerror',e=>result.errors.push(e.message))
  const names=['小甲','小乙']
  const dogs=await Promise.all(pages.map(async(page,index)=>{
    await page.goto(base+'/home');await page.waitForURL('**/adopt')
    await page.getByRole('button',{name:'以测试身份开始 →'}).click()
    await page.getByRole('button',{name:'继续，给它起个名字 →'}).click()
    await page.locator('#dog-name').fill(names[index])
    if(index===1) {
      await page.getByRole('button',{name:'自然风景',exact:true}).click()
      await page.getByRole('button',{name:'城市角落',exact:true}).click()
    }
    if(index===0) {
      await page.locator('#dog-name').fill('')
      await page.getByRole('button',{name:'继续，认识它的性格 →'}).click()
      await page.locator('#dog-name').waitFor()
      await page.locator('#dog-name').fill(names[index])
      await page.getByRole('button',{name:'先跳过兴趣',exact:true}).click()
    } else await page.getByRole('button',{name:'继续，认识它的性格 →'}).click()
    await page.getByRole('slider').first().fill('15')
    await page.getByRole('button',{name:'看看它的三个词 →'}).click()
    await page.getByRole('button',{name:'去挑一套穿搭 →'}).click()
    await page.getByRole('button',{name:'焦糖夹克',exact:true}).click()
    for(const [category, option] of [['帽子','鸭舌帽'],['眼镜','方方镜框'],['表情','期待']]) {
      await page.getByRole('button',{name:category,exact:true}).click()
      await page.getByRole('button',{name:option,exact:true}).click()
    }
    let committed
    if(index===0) await page.route('**/api/dogs',async r=>{
      const response=await r.fetch();assert.equal(response.status(),200)
      committed=(await response.json()).dog.id;await r.abort('failed')
    },{times:1})
    await page.getByRole('button',{name:'就这样，成为伙伴 →'}).click()
    if(index===0) await page.getByRole('button',{name:'保留选择，再试一次 →'}).click()
    await page.getByRole('button',{name:'进入它的小屋 →'}).click();await page.waitForURL('**/home')
    await page.getByText(names[index]+'的小屋',{exact:true}).waitFor()
    await page.reload();await page.getByText(names[index]+'的小屋',{exact:true}).waitFor()
    const session=await (await contexts[index].request.get(base+'/api/session')).json()
    if(committed) assert.equal(session.dog.id,committed)
    assert.equal(session.dog.assembly.cloth,'jacket')
    assert.deepEqual(session.dog.assembly,{cloth:'jacket',hat:'cap',glasses:'square',face:'hopeful'})
    assert.equal(checkPersonalityTags(session.dog.personalityTags).ok,true)
    assert.deepEqual(Object.keys(session.dog.assembly).sort(),['cloth','face','glasses','hat'])
    assert.deepEqual(session.dog.interestCategories,index===0?null:['自然风景','城市角落'])
    await page.screenshot({path:`${out}/home-${index}.png`,fullPage:true})
    return session.dog
  }))
  assert.notEqual(dogs[0].id,dogs[1].id)
  mark('two-independent-browser-contexts-adopt-refresh-and-isolate',{dogs:dogs.map(d=>d.id)})
  mark('lost-create-response-retry-same-dog')
  mark('required-name-null-or-two-interests-three-dimensions-four-keys')
  for(let i=0;i<2;i++) {
    const response=await contexts[i].request.get(base+'/api/dogs/'+encodeURIComponent(dogs[1-i].id))
    assert.equal(response.status(),404)
  }
  mark('cross-owner-dog-read-rejected')
  const db=openDatabase(dbPath)
  assert.equal(db.prepare('SELECT count(*) n FROM dog').get().n,2)
  const draft={name:'',interestCategories:null,tendencies:[0,0,0,0,0,0]}
  for(const patch of [{name:''},{name:'一二三四五六七'},{name:'有效',interestCategories:['自然风景']},{name:'有效',interestCategories:['自然风景','自然风景']}]) {
    assert.equal((await contexts[0].request.post(base+'/api/adoption/personality',{data:{...draft,...patch}})).status(),409)
  }
  mark('server-rejects-empty-overlong-name-single-or-duplicate-interests')
  const owner=db.prepare('SELECT session_id FROM dog WHERE id=?').get(dogs[0].id).session_id
  const now=new Date().toISOString(),tripId='audit_trip'
  db.prepare('INSERT INTO trip(id,dog_id,seq,status,trigger,created_at,started_at,ended_at) VALUES(?,?,1,?,?,?,?,?)').run(tripId,dogs[0].id,'running','auto',now,now,null)
  const find=createFindStore(db).write({tripId,kind:'zhihu',title:'显式联调示例',excerpt:'测试资料，不是真实搜索。',sourceUrl:'https://www.zhihu.com/question/12345/answer/67890',sourceMode:'fixture',authorityLevel:null,voteUpCount:null,assetPath:null},owner)
  let response=await contexts[0].request.get(base+`/api/trips/${tripId}/finds`)
  assert.equal(response.status(),200);assert.equal(response.headers()['cache-control'],'no-store')
  assert.equal((await response.json()).finds[0].id,find.id)
  assert.equal((await contexts[1].request.get(base+`/api/trips/${tripId}/finds`)).status(),404)
  assert.equal((await fetch(base+`/api/trips/${tripId}/finds`)).status,404)
  mark('finds-real-http-owned-foreign-missing-no-store')
  const page=pages[0]
  await page.goto(base+'/trip')
  await page.getByRole('heading',{name:'它出门了，沿途的事回来再聊。',exact:true}).waitFor()
  assert.equal(await page.locator('[aria-label="归来分享与发现"]').count(),0)
  mark('running-no-return-content')
  for(const status of ['done','failed','timeout']) {
    db.prepare('UPDATE trip SET status=?,ended_at=? WHERE id=?').run(status,now,tripId)
    await page.reload()
    const headings={done:'它回来了，带着一些路上的见闻。',failed:'这趟没能走完，已有的经历还在。',timeout:'这趟出行暂时没能确认结果。'}
    await page.getByRole('heading',{name:headings[status],exact:true}).waitFor()
    assert.equal(await page.locator('[aria-label="归来分享与发现"]').count(),status==='done'?1:0)
    if(status==='done' && mode==='baseline') await page.getByText('归来内容读取接口尚未接入。',{exact:true}).waitFor()
    if(status==='done' && mode!=='baseline') await page.getByRole('heading',{name:'显式联调示例',exact:true}).waitFor()
    mark(`real-trip-${status}-state`)
    await page.screenshot({path:`${out}/trip-${status}.png`,fullPage:true})
  }
  if(mode==='baseline') {
    result.knownGaps.push('empty wiring: chat/wish/invitations/return-read not bound','formal owner and account recovery absent','logout only clears cookie; replay remains authorized','mock profile and generator only','formal wardrobe/visual assets not bound')
    assert.equal(await pages[1].getByRole('button',{name:'心愿',exact:true}).isDisabled(),true)
    mark('baseline-empty-wiring-confirmed')
  }
  if(mode!=='baseline') {
    db.prepare('UPDATE trip SET status=\'done\' WHERE id=?').run(tripId)
    // An older invitation with no reliable trip link must not be claimed by the current trip.
    db.prepare('INSERT INTO invitation(id,dog_id,text,based_on_find_id,created_at) VALUES(?,?,?,?,?)').run('audit-current',dogs[0].id,'看到一片叶子，愿意的话拍给我看看；不拍也没关系。',find.id,now)
    db.prepare('INSERT INTO invitation(id,dog_id,text,based_on_find_id,created_at) VALUES(?,?,?,?,?)').run('audit-unscoped',dogs[0].id,'未关联本次旅途的旧邀请',null,now)
    await page.reload()
    await page.getByText('看到一片叶子，愿意的话拍给我看看；不拍也没关系。',{exact:true}).waitFor()
    assert.equal(await page.getByText('未关联本次旅途的旧邀请',{exact:true}).count(),0)
    await page.getByRole('textbox',{name:'回一句（≤200 字）'}).fill('我看到了，先记在这里。')
    await page.getByRole('button',{name:'回一句',exact:true}).click()
    await page.getByText('这一条已经回过了，这里暂时没有别的邀请。',{exact:true}).waitFor()
    const saved=db.prepare('SELECT id FROM reply WHERE invitation_id=?').get('audit-current')
    assert.ok(saved)
    const repeat=await contexts[0].request.post(base+'/api/replies',{data:{invitationId:'audit-current',text:'重复点击'}})
    assert.equal(repeat.status(),200);assert.equal((await repeat.json()).reply.id,saved.id)
    assert.equal(db.prepare('SELECT count(*) n FROM reply WHERE invitation_id=?').get('audit-current').n,1)
    mark('trip-scoped-invitation-text-reply-durable-and-idempotent')
    // Exercise the actual browser compressor and actual upload/reply handlers.
    db.prepare('INSERT INTO invitation(id,dog_id,text,based_on_find_id,created_at) VALUES(?,?,?,?,?)')
      .run('audit-photo',dogs[0].id,'显式照片联调：愿意的话留一张图，不拍也没关系。',find.id,now)
    await page.reload()
    await page.getByText('显式照片联调：愿意的话留一张图，不拍也没关系。',{exact:true}).waitFor()
    const photo=Buffer.from(await page.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=3000;canvas.height=2000
      const context=canvas.getContext('2d');context.fillStyle='#75a66c';context.fillRect(0,0,3000,2000)
      return canvas.toDataURL('image/png').split(',')[1]
    }),'base64')
    await page.locator('input[type="file"]').setInputFiles({name:'synthetic-large.png',mimeType:'image/png',buffer:photo})
    await page.getByRole('textbox',{name:'回一句（≤200 字）'}).fill('显式测试照片，保留这段文字。')
    let releaseUpload, uploadSeen
    const waitingUpload=new Promise(resolve=>{uploadSeen=resolve})
    await page.route('**/api/uploads/photo',async route=>{
      uploadSeen();await new Promise(resolve=>{releaseUpload=resolve});await route.abort().catch(()=>{})
    },{times:1})
    await page.getByRole('button',{name:'回一句',exact:true}).click()
    await waitingUpload
    await page.getByRole('button',{name:'取消上传',exact:true}).click()
    releaseUpload()
    await page.getByRole('button',{name:'回一句',exact:true}).waitFor()
    assert.equal(db.prepare('SELECT count(*) n FROM reply WHERE invitation_id=?').get('audit-photo').n,0)
    assert.equal(await page.getByRole('textbox',{name:'回一句（≤200 字）'}).inputValue(),'显式测试照片，保留这段文字。')
    mark('photo-upload-cancel-preserves-text-without-reply')
    let uploadCount=0
    page.on('request',request=>{if(request.url()===base+'/api/uploads/photo') uploadCount++})
    await page.route('**/api/replies',route=>route.fulfill({status:503,json:{code:'NETWORK'}}),{times:1})
    await page.getByRole('button',{name:'回一句',exact:true}).click()
    await page.getByRole('alert').filter({hasText:'这次没回应成功，文字和图都还在，可以再试一次。'}).waitFor()
    assert.equal(uploadCount,1)
    assert.equal(db.prepare('SELECT count(*) n FROM reply WHERE invitation_id=?').get('audit-photo').n,0)
    await page.getByRole('button',{name:'重试',exact:true}).click()
    await page.getByText('这一条已经回过了，这里暂时没有别的邀请。',{exact:true}).waitFor()
    assert.equal(uploadCount,1,'reply retry must reuse its already uploaded photo')
    const photoReply=db.prepare('SELECT * FROM reply WHERE invitation_id=?').get('audit-photo')
    assert.ok(photoReply);assert.equal(photoReply.kind,'both')
    const storedPhoto=readFileSync(path.join(out,'uploads',photoReply.photo_url.replace(/^\/uploads\//,'')))
    const info=inspectPhoto(storedPhoto)
    assert.equal(info.mime,'image/webp');assert.equal(info.width,1600);assert.ok(info.height<=1600)
    const repeatPhoto=await contexts[0].request.post(base+'/api/replies',{data:{invitationId:'audit-photo',text:'再次重放'}})
    assert.equal(repeatPhoto.status(),200);assert.equal((await repeatPhoto.json()).reply.id,photoReply.id)
    assert.equal((await contexts[1].request.post(base+'/api/replies',{data:{invitationId:'audit-photo',text:'越权'}})).status(),404)
    mark('browser-photo-compression-upload-reply-retry-idempotent-and-owned',{width:info.width,mime:info.mime})
    const fileCount=readdirSync(path.join(out,'uploads')).length
    const small=Buffer.from(await page.evaluate(()=>{
      const canvas=document.createElement('canvas');canvas.width=20;canvas.height=20
      canvas.getContext('2d').fillRect(0,0,20,20);return canvas.toDataURL('image/png').split(',')[1]
    }),'base64')
    for(const [label,bytes,cookie,expected] of [
      ['forged',small,'zhihu_session='+ 'z'.repeat(43),401],
      ['truncated',small.subarray(0,24),null,415],
    ]) {
      const options={multipart:{file:{name:'fixture.png',mimeType:'image/png',buffer:bytes}}}
      if(cookie)options.headers={cookie}
      const upload=await contexts[0].request.post(base+'/api/uploads/photo',options)
      assert.equal(upload.status(),expected,label)
    }
    assert.equal(readdirSync(path.join(out,'uploads')).length,fileCount)
    mark('invalid-upload-session-and-truncated-image-rejected-without-files')
    const after=db.prepare('SELECT status FROM trip WHERE id=?').get(tripId)
    assert.equal(after.status,'done')
    mark('read-page-does-not-start-or-finish-trips')
    await page.goto(base+'/home')
    let sessionReads=0
    await page.getByRole('button',{name:'心愿',exact:true}).click()
    await page.getByRole('textbox',{name:'想看什么……'}).fill('下次看看窗边的植物')
    page.on('request',r=>{if(r.url()===base+'/api/session')sessionReads++})
    await page.getByRole('button',{name:'记下心愿',exact:true}).click()
    await page.getByRole('button',{name:'撤销心愿：下次看看窗边的植物'}).waitFor()
    assert.equal(sessionReads,0)
    await page.getByRole('button',{name:'撤销心愿：下次看看窗边的植物'}).click()
    await page.getByText('还没告诉它想看什么。',{exact:true}).waitFor()
    assert.ok(db.prepare('SELECT revoked_at FROM wish WHERE dog_id=?').get(dogs[0].id).revoked_at)
    await page.getByRole('textbox',{name:'想看什么……'}).fill('保留的心愿草稿')
    await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'心愿',exact:true}).click()
    assert.equal(await page.getByRole('textbox',{name:'想看什么……'}).inputValue(),'保留的心愿草稿')
    await page.keyboard.press('Escape')
    assert.equal(await page.evaluate(()=>document.activeElement?.textContent?.trim()),'心愿')
    mark('wish-real-create-revoke-local-refresh-draft-and-focus')
    await page.getByRole('button',{name:'聊聊',exact:true}).click()
    await page.getByRole('textbox',{name:'想说什么……'}).fill('聊天草稿')
    await page.keyboard.press('Escape')
    await page.getByRole('button',{name:'聊聊',exact:true}).click()
    assert.equal(await page.getByRole('textbox',{name:'想说什么……'}).inputValue(),'聊天草稿')
    await page.getByText('本机示例，不会送出，也不会记成任务。',{exact:true}).waitFor()
    await page.keyboard.press('Escape')
    mark('chat-explicit-fixture-and-draft-retained')
    await page.screenshot({path:`${out}/wired-home.png`,fullPage:true})
    // Per-block request interceptions only exercise read states; real HTTP was checked above.
    await page.route('**/api/trips/audit_trip/finds',r=>r.fulfill({status:503,json:{code:'NETWORK'}}))
    await page.goto(base+'/trip')
    await page.getByRole('button',{name:'重读发现',exact:true}).waitFor()
    assert.equal(await page.getByText('这次没有可展示的发现。',{exact:true}).count(),0)
    await page.getByText('这次还没有留下分享。',{exact:true}).waitFor()
    mark('find-failure-not-empty-share-true-null-independent')
    await page.unroute('**/api/trips/audit_trip/finds')
    await page.getByRole('button',{name:'重读发现',exact:true}).click()
    await page.getByRole('heading',{name:'显式联调示例',exact:true}).waitFor()
    await page.getByText('来源：示例资料',{exact:true}).waitFor()
    mark('targeted-find-retry-source-label-and-original-link')
    await page.route('**/api/trips/audit_trip/finds',r=>r.fulfill({json:{finds:[]}}))
    await page.reload();await page.getByText('这次没有可展示的发现。',{exact:true}).waitFor()
    mark('real-empty-response-is-distinct')
    await page.unroute('**/api/trips/audit_trip/finds')
    let releaseFind
    await page.route('**/api/trips/audit_trip/finds',async r=>{
      await new Promise(resolve=>{releaseFind=resolve})
      await r.fulfill({json:{finds:[{...find,title:'旧请求不得回填'}]}}).catch(()=>{})
    })
    await page.reload()
    await page.getByText('正在读取发现…',{exact:true}).waitFor()
    db.prepare('UPDATE trip SET status=\'running\',ended_at=NULL WHERE id=?').run(tripId)
    await page.reload()
    await page.getByRole('heading',{name:'它出门了，沿途的事回来再聊。',exact:true}).waitFor()
    releaseFind()
    assert.equal(await page.getByRole('heading',{name:'旧请求不得回填',exact:true}).count(),0)
    assert.equal(await page.locator('[aria-label="归来分享与发现"]').count(),0)
    mark('loading-and-late-find-request-does-not-fill-running-page')
    await page.unroute('**/api/trips/audit_trip/finds')
    db.prepare('UPDATE trip SET status=\'failed\',ended_at=? WHERE id=?').run(now,tripId)
    let findsRequests=0
    page.on('request',r=>{if(r.url().endsWith('/api/trips/audit_trip/finds'))findsRequests++})
    await page.reload()
    await page.getByRole('heading',{name:'这趟没能走完，已有的经历还在。',exact:true}).waitFor()
    assert.equal(findsRequests,0)
    await page.getByRole('button',{name:'查看已保存记录',exact:true}).click()
    await page.getByRole('heading',{name:'显式联调示例',exact:true}).waitFor()
    assert.equal(await page.locator('[aria-label="归来分享与发现"]').count(),0)
    assert.equal(await page.locator('[aria-label="来自它的邀请"]').count(),0)
    mark('failed-explicit-archive-view-without-success-or-invitation')
    for(const width of [375,1440]) {
      await page.setViewportSize({width,height:width===375?667:900})
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false)
      await page.screenshot({path:`${out}/wired-trip-${width}.png`,fullPage:true})
    }
    mark('mobile-desktop-no-horizontal-overflow')
    db.prepare('UPDATE trip SET status=\'done\' WHERE id=?').run(tripId)
    await page.goto(base+'/a-wiring-fixture')
    await page.getByText('端口验证 · 显式夹具',{exact:true}).waitFor()
    await page.getByText('回应挂点：fixture-invitation；journal；/journal',{exact:true}).waitFor()
    await page.getByText('回应挂点：fixture-exchange；mailbox；/home',{exact:true}).waitFor()
    for(const text of ['捎话挂点','礼物挂点','关系与举报拉黑挂点']) await page.getByText(text,{exact:true}).waitFor()
    assert.equal(await page.getByRole('link',{name:'返回原处',exact:true}).getAttribute('href'),'/home')
    await page.getByRole('button',{name:'打开设置夹具',exact:true}).click()
    await page.getByText('偏好挂点：active',{exact:true}).waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('heading',{name:'端口夹具发现',exact:true}).waitFor()
    await page.getByRole('button',{name:'重读分享',exact:true}).waitFor()
    assert.equal(await page.getByTestId('fixture-dog').count()>=1,true)
    await page.screenshot({path:`${out}/optional-ports.png`,fullPage:true})
    mark('optional-slots-and-independent-message-failure-consumed')
    await page.getByRole('button',{name:'减少动态夹具',exact:true}).click()
    await page.getByRole('button',{name:'派发倾向反馈',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.portEvents.some(item=>item.event.kind==='personality'&&item.reduced)),true)
    await page.getByRole('button',{name:'卸载角色夹具',exact:true}).click()
    assert.equal(await page.evaluate(()=>window.portEvents.some(item=>item.event.kind==='actor'&&item.aborted)),true)
    mark('feedback-reduced-motion-and-unmount-cancellation')
    result.knownGaps.push('formal OAuth/owner/revocation, formal visual assets and E routes remain unbound; chat is an explicit local fixture')
  }
  const before=await contexts[0].cookies()
  await contexts[0].request.post(base+'/api/auth/logout',{data:{}})
  const oldCookie=before.find(c=>c.name==='zhihu_session')
  response=await fetch(base+`/api/dogs/${dogs[0].id}`,{headers:{Cookie:`zhihu_session=${oldCookie.value}`}})
  assert.equal(response.status,200)
  mark('known-development-logout-replay-gap-reproduced',{replayStatus:response.status})
  assert.equal(db.prepare('SELECT count(*) n FROM dog').get().n,2)
  db.close()
  assert.deepEqual(result.errors,[])
  result.passed=true
} catch (error) {
  result.failure=String(error).slice(0,2000)
  for (const [index, context] of (browser?.contexts() ?? []).entries()) {
    const page=context.pages()[0]
    if(page) {
      await page.screenshot({path:`${out}/failure-${index}.png`,fullPage:true}).catch(()=>{})
      writeFileSync(`${out}/failure-${index}.txt`,`${page.url()}\n${await page.locator('body').innerText().catch(()=> 'unavailable')}`)
    }
  }
  throw error
} finally {
  writeFileSync(`${out}/result.json`,JSON.stringify(result,null,2))
  await browser?.close()
  if(process.platform==='win32'&&child.exitCode===null) {
    try { execFileSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}) } catch { child.kill() }
  } else child.kill()
  if(mode!=='baseline') {
    unlinkSync(fixtureFile);rmdirSync(fixtureDirectory)
    // Next dev generates route validators. Preserve this worktree's generated dev types locally,
    // otherwise a later production typecheck still imports the removed fixture route.
    const generatedTypes=path.resolve('.next/dev/types')
    const preservedTypes=path.resolve(`.local/dev-types-${randomUUID()}`)
    assert.ok(generatedTypes.startsWith(path.resolve('.next/dev')+path.sep))
    assert.ok(preservedTypes.startsWith(path.resolve('.local')+path.sep))
    if(existsSync(generatedTypes)) renameSync(generatedTypes,preservedTypes)
  }
}
console.log(JSON.stringify(result,null,2))
