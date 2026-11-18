const {chromium}=require('playwright');
const {pathToFileURL}=require('url');const path=require('path');const fs=require('fs');
(async()=>{
const browser=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}),headless:true});
const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
const url=pathToFileURL(path.join(__dirname,'index.html')).href;
const open=async(p,s='')=>{await page.goto(url+`?page=${p}${s?'&state='+s:''}`);await page.evaluate(()=>document.fonts.ready);await page.locator('img').evaluateAll(imgs=>Promise.all(imgs.map(i=>i.decode())))};
const results=[];
const states={auth:['entry','waiting','success','cancel','failure','reading','empty','partial'],profile:['default','blank','invalid','long','zero','one','two','three','limit'],traits:['default','left','right','dragging','released'],tags:['loading','result','failure','empty'],wardrobe:['default','raincoat','sun'],creation:['loading','failure','success'],home:['default']};
for(const [p,variants]of Object.entries(states))for(const s of variants){
await open(p,s);
for(const width of [375,768,1440]){
await page.setViewportSize({width,height:1000});
await page.locator("img").evaluateAll(a=>Promise.all(a.map(i=>i.decode())));
const check=await page.evaluate(()=>{
 const intersects=(a,b)=>a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;
 return {overflow:document.documentElement.scrollWidth>innerWidth,missing:[...document.images].filter(i=>!i.naturalWidth).length,
 smallButtons:[...document.querySelectorAll('button,select,#review a,input[type=range]')].filter(e=>e.getBoundingClientRect().height<44).length,
 actorOverText:[...document.querySelectorAll('.stationery')].some(e=>intersects(e.querySelector('.status-actor').getBoundingClientRect(),e.querySelector('.stationery-copy').getBoundingClientRect())),
 labelsOffRail:[...document.querySelectorAll('.trait')].some(e=>{const input=e.querySelector('input').getBoundingClientRect();return [...e.querySelectorAll('.trait-end')].some(label=>{const b=label.getBoundingClientRect();return Math.abs((b.top+b.bottom-input.top-input.bottom)/2)>1})}),
 rulesOverText:document.querySelectorAll('.stationery-rules').length>0,
 pawsOffBorder:[...document.querySelectorAll('.stationery')].some(e=>{const a=e.querySelector('.status-actor').getBoundingClientRect(),b=e.getBoundingClientRect();return Math.abs(a.bottom-b.top-10)>2})};
});
results.push({page:p,state:s,width,...check});
if(check.overflow||check.missing||check.smallButtons||check.actorOverText||check.labelsOffRail||check.rulesOverText||check.pawsOffBorder||errors.length)throw Error(JSON.stringify({p,s,width,check,errors}));
if(width!==768&&((p==='auth'&&['waiting','success','failure'].includes(s))||(p==='profile'&&s==='two')||(p==='traits'&&['default','left','right','released'].includes(s))))await page.screenshot({path:path.join(__dirname,`${p}-${s}-${width}.png`),fullPage:true});
}}
const checks=[];const assert=(v,msg)=>{if(!v)throw Error(msg);checks.push(msg)};
await open('traits','default');
assert(await page.locator('.nudge, .trait-labels output').count()===0,'无中间读数、加减控件');
const sizes=()=>page.locator('[data-trait="0"] .trait-end').evaluateAll(a=>a.map(e=>parseFloat(getComputedStyle(e).fontSize)));
assert((await sizes())[0]===(await sizes())[1],'中点两端等大');
await page.evaluate(()=>{window.events=[];document.addEventListener('kanshan:personality-feedback',e=>events.push(e.detail))});
const set=async(i,value,commit=true)=>{await page.locator(`#trait-${i}`).evaluate((el,{value,commit})=>{el.value=value;el.dispatchEvent(new Event('input',{bubbles:true}));if(commit)el.dispatchEvent(new Event('change',{bubbles:true}))},{value,commit})};
await set(0,10,false);assert((await sizes())[0]>(await sizes())[1],'偏左左大右小');
assert(await page.evaluate(()=>events.at(-1).phase==='preview'),'拖动仅预览');
assert(await page.locator('#motion-preview').isHidden(),'拖动不触发角色动作');
await set(0,90);assert((await sizes())[0]<(await sizes())[1],'偏右右大左小');
assert(await page.evaluate(()=>events.at(-1).phase==='release'&&events.at(-1).loop===false),'松手事件一次且不循环');
await page.evaluate(()=>{window.adapterCalls=0;window.dispose=KanshanMotion.register({play(){adapterCalls++}})});
await set(0,75);assert(await page.evaluate(()=>adapterCalls===1),'可替换 renderer 收到提交');
await page.evaluate(()=>dispose());await set(0,25);assert(await page.evaluate(()=>adapterCalls===1),'解除 renderer 不残留调用');
const actions=[];
for(let i=0;i<6;i++)for(const value of [5,95]){await set(i,value);actions.push(await page.evaluate(()=>events.at(-1).actionId));}
assert(new Set(actions).size===12,'六维十二方向动作映射');
await page.locator('#trait-0').focus();await page.keyboard.press('ArrowLeft');assert(await page.locator('#trait-0').inputValue()==='90','键盘可调');
const b=await page.locator('#trait-0').boundingBox();await page.mouse.click(b.x+b.width*.2,b.y+b.height/2);assert(+(await page.locator('#trait-0').inputValue())<50,'点击轨道替代拖动');
await page.getByRole('button',{name:'← 上一步'}).click();await page.locator('#dog-name').fill('小山');await page.locator('[data-interest="0"]').click();await page.getByRole('button',{name:'继续，认识它的性格 →'}).click();assert(page.url().includes('profile'),'兴趣一类阻止继续');
await page.locator('[data-interest="1"]').click();await page.locator('[data-interest="2"]').click();await page.locator('[data-interest="3"]').click();assert(await page.locator('[aria-pressed=true]').count()===3,'兴趣最多三类');
await page.getByRole('button',{name:'继续，认识它的性格 →'}).click();await page.getByRole('button',{name:'← 上一步'}).click();assert(await page.locator('#dog-name').inputValue()==='小山'&&await page.locator('[aria-pressed=true]').count()===3,'返回保留名字兴趣');
await page.locator('#dog-name').fill('');await page.getByRole('button',{name:'先跳过兴趣',exact:true}).click();assert(await page.locator('#dog-name').getAttribute('aria-invalid')==='true','跳过仍需名字');
await page.setViewportSize({width:812,height:375});await open('auth','waiting');assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)),'横屏无溢出');
await page.setViewportSize({width:375,height:1000});await page.addStyleTag({content:'body{font-size:200%}.stationery-copy{font-size:32px}.trait-end{zoom:2}'});assert(!(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)),'双倍文字无溢出');
await page.emulateMedia({reducedMotion:'reduce'});await open('traits','released');assert(await page.evaluate(()=>document.getAnimations().length===0),'保持静态且尊重减少动态');
assert(await page.evaluate(()=>KanshanMotion.describe('time',100).reducedMotion),'动作接口携带减少动态设置');
fs.writeFileSync(path.join(__dirname,'排版核对.json'),JSON.stringify({results,checks,actions,errors},null,2));
await browser.close();console.log(`${results.length} viewport checks; ${checks.length} interaction/interface checks passed`);
})().catch(e=>{console.error(e);process.exit(1)});
