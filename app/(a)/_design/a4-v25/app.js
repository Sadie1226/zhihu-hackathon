/* A4 本地静态原型。视图与事件独立，未来 A5 可用真实服务替换流程适配层。 */
(() => {
  const C=window.ADOPTION_CONFIG, $=s=>document.querySelector(s);
  const params=new URLSearchParams(location.search);
  const page=Object.hasOwn(C.pages,params.get('page'))?params.get('page'):'auth';
  const state=Object.hasOwn(C.pages[page].states,params.get('state'))?params.get('state'):Object.keys(C.pages[page].states)[0];
  const emptyDraft=()=>({name:'',interests:[],traits:Object.fromEntries(C.traits.map(t=>[t.key,50]))});
  let draft=emptyDraft();
  try {const saved=JSON.parse(sessionStorage.getItem('kanshan-a4-v25'));if(saved)draft={...draft,...saved,traits:{...draft.traits,...saved.traits}};}catch{}
  const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const save=()=>{try{sessionStorage.setItem('kanshan-a4-v25',JSON.stringify(draft));}catch{}};
  const href=(p,s='')=>`?page=${p}${s?'&state='+s:''}`;
  const go=(p,s='')=>{save();location.href=href(p,s)};
  const btn=(text,action,primary=false)=>`<button type="button" data-action="${action}" class="${primary?'primary':''}">${text}</button>`;
  const notice=(title,body,error=false,appearance=C.statusAppearance[state]||'cancel',id='')=>`<div class="stationery ${error?'error':''}" ${id?`id="${id}"`:''} role="status"><img class="status-actor" src="${C.assets.head(appearance)}" width="72" height="64" alt=""><div class="stationery-copy"><strong>${title}</strong><span>${body}</span></div></div>`;
  const notes=(items,rule='')=>`<details open><summary>字段与交互标注 · 供 A4 评审 / A5 对接</summary><div class="notes">${items.map(([h,p])=>`<div><b>${h}</b><p>${p}</p></div>`).join('')}</div>${rule?`<div class="rules">${rule}</div>`:''}</details>`;
  $('#review').innerHTML=Object.entries(C.pages).map(([k,v])=>`<a href="${href(k)}" ${k===page?'aria-current="page"':''}>${v.title}</a>`).join('');
  $('#state').innerHTML=Object.entries(C.pages[page].states).map(([k,v])=>`<option value="${k}" ${k===state?'selected':''}>${v}</option>`).join('');
  $('#state').addEventListener('change',e=>go(page,e.target.value));
  const order=['auth','profile','traits','tags','wardrobe','creation','home'];
  $('#steps').innerHTML=['知乎授权','名字兴趣','性格倾向','三个词','穿搭','成为伙伴','小屋'].map((t,i)=>`<span class="${order.indexOf(page)===i?'current':''}" ${order.indexOf(page)===i?'aria-current="step"':''}>0${i+1} ${t}</span>`).join('');
  const paper=$('#paper');let attempted=false,interestError='';
  $('.room').src=C.assets.room;
  function nameError(){const n=draft.name.trim();if(!n)return '先给它一个名字吧。';if([...n].length>C.name.max)return `名字最多 ${C.name.max} 个字，想一个短一点的称呼吧。`;if(!C.name.pattern.test(n))return '请使用汉字、字母、数字、空格或 ·，不要填写链接和特殊符号。';return '';}
  function authView(){
    $('#greeting').textContent='你好呀，我在这里等你。';
    const copy={
      entry:['先认识你，再认识它。','用知乎账号开始领养，让它带着一点你的兴趣，走进自己的日常。'],
      waiting:['去知乎，打个招呼。','请在知乎授权页确认，完成后回到这里。'],
      success:['已经认识你啦。','账号身份确认成功，接下来给看山一个属于你的称呼。'],
      cancel:['没关系，慢慢来。','你取消了这次授权。还没有创建账号或看山，想好了可以重新开始。'],
      failure:['这次没能连上知乎。','账号身份尚未确认，请重新授权后继续。'],
      reading:['正在了解你的兴趣。','正在读取已授权的资料，不会在这里创建看山。'],
      empty:['留白，也可以是开始。','授权成功。这次读取成功，但基础资料部分字段为空，收藏、关注和创作暂无可用内容。'],
      partial:['有些资料，暂时没读到。','账号身份已确认；收藏和创作读取失败。这与“没有内容”不同。']
    }[state];
    let detail='',actions='';
    if(state==='entry'){
      detail=notice('带着一点你的兴趣，开始认识彼此。',`<div class="scope"><div><strong>基础资料</strong><span>确认账号身份与基本信息</span></div><div><strong>收藏</strong><span>参考你愿意收好的内容</span></div><div><strong>关注</strong><span>参考你持续留意的方向</span></div><div><strong>创作</strong><span>参考你公开表达的主题</span></div></div><p class="fine">用于注册和初始性格生成。你手动调节的倾向优先于知乎资料；穿搭由你自己选。</p>`);
      actions=btn('用知乎账号开始 →','authorize',true);
    }else if(state==='waiting'){
      detail=notice('等待知乎授权','本稿不会打开真实授权页；请先看这张等待状态示意。可用上方验收状态切换回调结果。');actions=btn('取消这次授权','cancel');
    }else if(state==='success'){
      detail=notice('演示账号 · 已授权','基础资料、收藏、关注和创作读取完成。本稿未读取真实数据。');actions=btn('继续，给它起个名字 →','profile',true);
    }else if(state==='cancel'||state==='failure'){
      detail=notice(state==='cancel'?'授权已取消':'授权未完成',state==='cancel'?'需要知乎授权才能开始领养。':'可能是网络异常或授权已失效；未填入任何虚构资料。',state==='failure');actions=btn('重新授权 →','authorize',true);
    }else if(state==='reading'){
      detail=notice('账号身份已确认','基础资料：成功<br>收藏：读取中 · 关注：读取中 · 创作：读取中');actions='<button disabled>资料读取中…</button>';
    }else if(state==='empty'){
      detail=notice('没有内容 ≠ 读取失败','可以通过名字、兴趣与手动倾向认识它。不会把默认标签说成是知乎分析结果。');actions=btn('继续填写 →','profile',true);
    }else{
      detail=notice('读取结果 · 演示','基础资料：成功 · 关注：成功<br>收藏：失败 · 创作：失败',true)+`<p class="fine">建议待确认：允许仅用读取成功的资料与手动输入继续，不把失败字段当作空数据。</p>`;
      actions=btn('重试读取','reading')+btn('仅用已读资料继续 →','profile',true);
    }
    paper.innerHTML=`<img class="welcome" src="${C.assets.welcome}" width="120" height="102" alt="一封带蓝色丝带的像素欢迎信"><div class="eyebrow">从这里，成为伙伴 · 01</div><h1>${copy[0]}</h1><p class="lead">${copy[1]}</p>${detail}<div class="actions">${actions}</div><p class="fine">授权只提供性格参考，不替你选择它的名字和外观。</p>`;
    $('#annotations').innerHTML=notes([
      ['01 / 身份与用途','注册依赖真实知乎身份。回调校验、账号归属与 Cookie 是 A5 责任；本稿授权按钮只跳转等待示意，不产生账号。'],
      ['02 / 字段与读取状态','建议模型：<code>profileRead.{basic,collections,following,creations}</code> 分别记录 loading / success / empty / error。基础身份失败不可继续。'],
      ['03 / 取消、失败与返回','取消和身份失败只提供重新授权；附加读取失败明确告知失败项，重试不清除草稿，继续能力作为建议待确认。']
    ],'这是授权用途说明页，不模拟知乎官方授权页面，也不宣称实际取得上述范围权限；A5 须以真实授权与接口能力核实。');
  }
  function profileView(){
    $('#greeting').textContent='以后，你会怎么叫我？';
    if(state!=='default'){
      draft.name=state==='blank'?'':state==='invalid'?'小山<script>':state==='long'?'给看山起一个特别特别特别长的名字':'小山';
      const counts={zero:0,one:1,two:2,three:3,limit:3};if(state in counts)draft.interests=C.interests.slice(0,counts[state]);
      attempted=['blank','invalid','long','one'].includes(state);interestError=state==='limit'?'最多选 3 类。先取消一类，再选新的吧。':'';
    }
    paper.innerHTML=`<div class="eyebrow">先从一个名字开始 · 02</div><h1>以后，就这样叫你吧。</h1><p class="lead">给它一个称呼，再告诉它一些你喜欢的事。</p><div class="field"><label for="dog-name">它的名字 <span class="required">· 必填</span><span class="count hint" id="name-count"></span></label><input class="name" id="dog-name" autocomplete="off" placeholder="例如：小山" value="${esc(draft.name)}" aria-describedby="name-help name-error"><p class="hint" id="name-help">以后也可以改名字。建议规则：1–12 个字。</p><p class="hint error-text" id="name-error" role="status"></p></div><div class="field"><div id="interest-label">你想和它一起留意什么？ <span class="hint">· 可选</span></div><div class="chips" role="group" aria-labelledby="interest-label">${C.interests.map((t,i)=>`<button type="button" class="chip" data-interest="${i}" aria-pressed="${draft.interests.includes(t)}"><img width="30" height="30" src="${C.assets.interestIcon(i)}" alt=""><span>${t}</span></button>`).join('')}</div><p id="interest-hint" class="hint" role="status"></p></div><div class="actions">${btn('← 返回授权结果','back-auth')}<button class="primary" data-action="next-traits">继续，认识它的性格 →</button></div><button class="text-button" data-action="skip">先跳过兴趣</button><p class="fine">跳过只清空兴趣，名字仍需填写；返回不会丢失本地选择。</p>`;
    $('#dog-name').addEventListener('input',e=>{draft.name=e.target.value;save();updateProfile()});
    $('#dog-name').addEventListener('blur',()=>{draft.name=draft.name.trim();$('#dog-name').value=draft.name;attempted=true;save();updateProfile()});
    paper.querySelectorAll('[data-interest]').forEach(b=>b.addEventListener('click',()=>{
      const t=C.interests[+b.dataset.interest],at=draft.interests.indexOf(t);interestError='';
      if(at>=0)draft.interests.splice(at,1);else if(draft.interests.length===3)interestError='最多选 3 类。先取消一类，再选新的吧。';else draft.interests.push(t);
      save();updateProfile();
    }));
    updateProfile();
    $('#annotations').innerHTML=notes([
      ['01 / 名字 · 必填','<code>name: string</code>。建议提交前 trim，按 Unicode 字符计 1–12；允许汉字、字母、数字、间隔空格和 ·。超长不截断，错误放在字段下；后续支持改名。'],
      ['02 / 兴趣 · 可选','<code>interestCategories: string[]</code>。本稿用显示文案，A5 适配正式枚举。合法数量为 0 / 2 / 3；1 项阻止继续，第四项不加入，已有选择保留。'],
      ['03 / 草稿与提交','本地 sessionStorage 仅供静态评审。下一步只校验并保留输入，不请求后端。返回与刷新恢复同一标签页草稿；A5 的账号隔离和真实持久化另验。']
    ],'建议待确认：名字规则尚未定案；A5 须使用相同规则做服务端校验。兴趣为空保留 []，不得偷偷展开为全部六类。');
  }
  function updateProfile(){
    const error=attempted?nameError():'';$('#name-error').textContent=error;$('#dog-name').setAttribute('aria-invalid',String(!!error));$('#name-count').textContent=`${[...draft.name.trim()].length} / ${C.name.max}`;
    paper.querySelectorAll('[data-interest]').forEach(b=>b.setAttribute('aria-pressed',String(draft.interests.includes(C.interests[+b.dataset.interest]))));
    const n=draft.interests.length;$('#interest-hint').textContent=interestError||(n===0?'还没选也没关系，可以先跳过。':n===1?'已选 1 类，再选 1 类就好；也可以跳过兴趣。':n===2?'已选 2 类，刚刚好；还可以再选 1 类。':'已选 3 类，可以继续；想换一类，先取消已选。');
    $('#interest-hint').classList.toggle('error-text',!!interestError||(attempted&&n===1));
  }
  function traitText(t,value){return value===50?'都可以，慢慢认识。':t.say[value<50?0:1]}
  function traitsView(){
    $('#greeting').textContent='你好呀，慢慢认识我吧。';
    // Explicit review fixtures are deterministic; ordinary back navigation restores draft.
    if(params.has('state')) {
      draft.traits=Object.fromEntries(C.traits.map(t=>[t.key,50]));
      if(state==='left')draft.traits.time=15;
      if(['right','dragging','released'].includes(state))draft.traits.exploration=85;
    }
    const active=state==='left'?5:0;
    const t=C.traits[active],value=draft.traits[t.key];
    paper.innerHTML=`<div class="eyebrow">认识它 · 03</div><h1>它更像哪一种伙伴？</h1><p class="lead">把小滑块挪向你喜欢的一边，也可以留在中间。<br>你的选择，会比知乎信息更优先影响它的初始性格。</p><div class="sliders">${C.traits.map((t,i)=>{
      const v=draft.traits[t.key];
      return `<div class="trait ${state==='dragging'&&i===0?'dragging':''}" data-trait="${i}"><div class="trait-labels" id="labels-${i}"><span class="trait-end left" data-side="left">${t.left}</span><span class="trait-end right" data-side="right">${t.right}</span></div><input type="range" id="trait-${i}" min="0" max="100" step="5" value="${v}" style="--value:${v}%" aria-label="${t.left}到${t.right}" aria-describedby="slider-help"></div>`;
    }).join('')}</div><p id="slider-help" class="mini">拖向哪一端，哪一端的字就大一点。可点击轨道或用方向键调节。</p>${notice('慢慢认识彼此',state==='released'?traitText(t,value):'不用急着选定，每一种倾向都很好。',false,state==='released'?'success':'cancel','trait-feedback')}<div class="actions">${btn('← 上一步','back-profile')}${btn('看看它的三个词 →','generate-tags',true)}</div><p class="fine">当前展示静止画面；松手动作已留接口，等待视觉确认后再接动画。</p>`;
    function visual(i,v){
      const t=C.traits[i],offset=(v-50)/50,conf=C.traitVisuals;
      const size=x=>Math.round(conf.baseSize+(x>=0?(conf.maxSize-conf.baseSize)*x:(conf.baseSize-conf.minSize)*x));
      $(`[data-trait="${i}"] .left`).style.setProperty('--trait-size',size(-offset)+'px');
      $(`[data-trait="${i}"] .right`).style.setProperty('--trait-size',size(offset)+'px');
      const input=$(`#trait-${i}`);input.style.setProperty('--value',v+'%');
      input.setAttribute('aria-valuetext',v===50?'两边同样喜欢':`偏向${v<50?t.left:t.right}`);
    }
    function preview(detail){
      const el=$('#motion-preview');el.hidden=false;
      el.innerHTML=`<span class="motion-tag">松手动作预留 · 静态说明</span><strong>${esc(detail.actionLabel)}</strong><span>${({gentle:'轻幅度',medium:'中幅度',strong:'明显幅度',neutral:'自然状态'})[detail.tier]} · 当前角色保持站姿，未播放动画</span>`;
      el.dataset.action=detail.actionId;el.dataset.tier=detail.tier;
    }
    function update(i,v,phase){
      const t=C.traits[i];draft.traits[t.key]=v;save();visual(i,v);
      $(`#trait-${i}`).closest('.trait').classList.toggle('dragging',phase==='preview');
      const detail=window.KanshanMotion.describe(t.key,v,phase);
      window.KanshanMotion.emit(detail);
      const fb=$('#trait-feedback');
      fb.querySelector('strong').textContent=phase==='release'?'我记住你的偏好啦。':'慢慢挪，看看更喜欢哪一边。';
      fb.querySelector('.stationery-copy>span').textContent=phase==='release'?traitText(t,v):'字的大小，只表达你此刻的偏向。';
      fb.querySelector('.status-actor').src=C.assets.head(phase==='release'?'success':'waiting');
      if(phase==='release'){$('#greeting').textContent=traitText(t,v);preview(detail)}
    }
    C.traits.forEach((t,i)=>{
      const input=$(`#trait-${i}`);visual(i,+input.value);
      input.addEventListener('input',e=>update(i,+e.target.value,'preview'));
      input.addEventListener('change',e=>update(i,+e.target.value,'release'));
    });
    if(state==='released')preview(window.KanshanMotion.describe(t.key,value));
    $('#annotations').innerHTML=notes([
      ['01 / 标签与滑条','可见界面去掉中间读数、百分比和加减。居中两端等大，偏向一端逐渐放大该端，另一端缩小。标签始终在固定两端，轨道不随文字改变位置。读屏仍能读出倾向。'],
      ['02 / 十二种松手动作','按用户动作表配置，松手只提交一次动作事件，拖动不播放角色动作。当前主角色仍为静止站姿；下方动作说明仅用于验收接口映射，不冒充动画完成。'],
      ['03 / 预留接口','<code>kanshan:personality-feedback</code> 携带 dimension / direction / strength / tier / phase / actionId / loop / reducedMotion。未来可用 <code>KanshanMotion.register(renderer)</code> 独立挂接部件动画。']
    ],'手动倾向优先于知乎资料。强度仅控制未来动作幅度，不等于性格概率或模型权重。动作映射与强度阈值在 config.js，可替换而不改表单逻辑。');
  }
  const context=()=>({C,$,page,state,draft,paper,notice,notes,btn,esc,save,go});
  if(['tags','wardrobe','creation','home'].includes(page))window.RoundTwo.render(context());
  else ({auth:authView,profile:profileView,traits:traitsView}[page])();
  // Outcome controls are visibly outside product UI; no fake automatic network completion.
  const demo=document.createElement('div');demo.className='demo-controls';demo.setAttribute('aria-label','静态验收结果控制');
  const outcomes=page==='auth'&&['waiting','reading'].includes(state)?[['success','演示：授权与读取完成'],['empty','演示：资料为空'],['partial','演示：附加资料失败'],['failure','演示：授权失败']]:page==='tags'&&state==='loading'?[['result','演示：生成成功'],['failure','演示：生成失败']]:page==='creation'&&state==='loading'?[['success','演示：创建成功'],['failure','演示：创建失败']]:[];
  demo.innerHTML=outcomes.map(([s,label])=>`<button data-outcome="${s}">${label}</button>`).join('');
  if(outcomes.length){$('.review-state').after(demo);demo.querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{if(page==='tags'&&b.dataset.outcome==='result')draft.generated=PreviewService.generate(draft);if(page==='auth')draft.readMode=b.dataset.outcome==='empty'?'empty':b.dataset.outcome==='partial'?'partial':'demo';go(page,b.dataset.outcome)}));}

  paper.addEventListener('click',e=>{
    const action=e.target.closest('[data-action]')?.dataset.action;if(!action)return;
    if(window.RoundTwo.handle(action,context()))return;
    const routes={authorize:['auth','waiting'],cancel:['auth','cancel'],reading:['auth','reading'],profile:['profile'], 'back-auth':['auth','success'],'back-profile':['profile'],'back-traits':['traits'],entry:['auth']};
    if(routes[action]){if(page==='auth'&&action==='profile')draft.readMode=state==='empty'?'empty':state==='partial'?'partial':'demo';go(...routes[action]);return;}
    if(action==='skip'||action==='next-traits'){
      attempted=true;if(action==='skip')draft.interests=[];updateProfile();save();
      if(nameError()){$('#dog-name').focus();return;}
      if(draft.interests.length===1){$('#interest-hint').textContent='再选 1 类，或点击“先跳过兴趣”。';paper.querySelector('[data-interest]').focus();return;}
      draft.name=draft.name.trim();go('traits');
    }
  });
})();
