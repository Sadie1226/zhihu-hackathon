const {chromium}=require(process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES ? process.env.CODEX_PRIMARY_RUNTIME_NODE_MODULES+'/playwright' : 'playwright');
const fs=require('fs');
(async()=>{const browser=await chromium.launch({executablePath:process.env.E4_CHROMIUM_PATH || undefined,args:['--no-sandbox']});
const cases=[[375,667],[320,568],[1440,900]].flatMap(([w,h])=>['running','done'].map(s=>[w,h,s])).concat(['loading','timeout','failed','read-error','cached'].map(s=>[375,667,s]));
const results=[];
for(const [width,height,state] of cases){
 const page=await browser.newPage({viewport:{width,height}});
 await page.goto('file://'+process.cwd()+'/e4/index.html?state='+state);
 await page.screenshot({path:'e4/'+width+'x'+height+'-'+state+'.png'});
 const result=await page.evaluate(()=>{const r=s=>{const z=document.querySelector(s)?.getBoundingClientRect();return z?[z.x,z.y,z.width,z.height,z.bottom]:null};return {doc:document.documentElement.scrollWidth,scene:r('.scene'),copy:r('.copy'),find:r('.find'),action:r('.find a'),text:document.querySelector('.copy').textContent,imagesOk:[...document.images].every(i=>i.complete&&i.naturalWidth>0)}});
 if(result.doc>width||!result.imagesOk)throw Error(state);
 results.push({width,height,state,...result});await page.close();
}
fs.writeFileSync('e4/measurements.json',JSON.stringify({browser:browser.version(),coordinates:['x','y','width','height','bottom'],results},null,2));
await browser.close();
})().catch(e=>{console.error(e);process.exitCode=1});
