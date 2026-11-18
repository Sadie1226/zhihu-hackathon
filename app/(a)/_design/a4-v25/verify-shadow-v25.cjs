const {chromium}=require('playwright');
const {pathToFileURL}=require('url'),path=require('path'),fs=require('fs');
(async()=>{
const b=await chromium.launch({...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{channel:'chrome'}),headless:true});
const p=await b.newPage();const out=[];const ok=(v,s)=>{if(!v)throw Error(s);out.push(s)};
for(const [width,height]of [[375,900],[812,375],[1440,1000]]){
 await p.setViewportSize({width,height});const base=pathToFileURL(path.join(__dirname,'index.html')).href;
 await p.goto(base+'?page=home');await p.locator('img').evaluateAll(a=>Promise.all(a.map(i=>i.decode())));
 ok(await p.locator('.nameplate>img').isVisible(),width+' profile icon restored');
 ok(await p.locator('.room-actor [data-shadow-layer]').count()===1,width+' single actor-owned shadow');
 ok(await p.locator('.room-actor [data-art-layer]').count()===5,width+' standing art stays layered');
 const movement=await p.evaluate(()=>{const el=document.querySelector('.room-actor'),sh=el.querySelector('[data-shadow-layer]'),a=el.getBoundingClientRect(),s=sh.getBoundingClientRect();el.style.marginLeft='24px';const bb=el.getBoundingClientRect(),ss=sh.getBoundingClientRect();el.style.marginLeft='0px';return Math.abs((bb.x-a.x)-(ss.x-s.x))<.1&&Math.abs(bb.x-a.x-24)<.1});
 ok(movement,width+' shadow follows actor translation');
 const anchor=await p.locator('.room-actor').boundingBox();
 await p.evaluate(()=>WARDROBE.setPose(document.querySelector('.room-actor'),'sit'));await p.locator('.room-actor img').evaluateAll(a=>Promise.all(a.map(i=>i.decode())));
 const after=await p.locator('.room-actor').boundingBox();ok(Math.abs(anchor.y+anchor.height-after.y-after.height)<.1,width+' sit preserves ground anchor');
 ok(await p.locator('[data-shadow-pose="sit"]').count()===1,width+' sit swaps its own shadow');
 ok(await p.locator('.room-actor [data-art-layer="sit"]').count()===1,width+' supplied sitting reference available');
 ok(await p.evaluate(()=>document.getAnimations().length===0),width+' remains static');
 await p.locator('.home-room').screenshot({path:path.join(__dirname,`sitting-static-${width}.png`)});
 await p.goto(base+'?page=home&state=away');ok(await p.locator('.room-actor,[data-shadow-layer]').count()===0,width+' away removes both actor and shadow');
 await p.goto(base+'?page=home&state=sitting');await p.locator('img').evaluateAll(a=>Promise.all(a.map(i=>i.decode())));
 ok(await p.locator('.reference-actor[data-pose="sit"]').count()===1,width+' sit review state renders');
}
await b.close();fs.writeFileSync(path.join(__dirname,'v25-shadow-checks.json'),JSON.stringify({passed:out.length,checks:out},null,2));console.log(out.length+' v25 pose/shadow checks passed');
})().catch(e=>{console.error(e);process.exit(1)});
