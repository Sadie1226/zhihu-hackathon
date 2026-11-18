/* Scene assets, layout anchors and entry mapping are replaceable independently. */
window.HomeScene=(()=>{
 const A='assets/home/';
 const config={
  wide:{src:A+'room-wide.png',actor:{x:56.1917,y:92.4581,width:26.6312}},
  tall:{src:A+'room-tall.png',actor:{x:56.1917,y:92.4581,width:26.6312}},
  entries:[{id:'chat',label:'聊聊',icon:'chat',feature:'01 / 2.1、2.3'}, {id:'wish',label:'心愿',icon:'wish',feature:'01 / 2.2'}, {id:'mail',label:'来信',icon:'mail',feature:'01 / 2.4、4.4、5.2'}, {id:'journal',label:'手账',icon:'journal',feature:'01 / 3.2、4.1–4.2、5.1、5.3'}]
 };
 // Future animator gets world-space entry/exit anchors; no timer or walking until static approval.
 const transition={phase:'static',outsideDirection:'left',insideDoor:'right',events:['approach-door','cross-threshold','scene-ready'],register(renderer){this.renderer=renderer;return()=>{this.renderer=null}}};
 const image=(name,cls='')=>`<img class="${cls}" src="${A+name}.png" alt="">`;
 function entry(c){
  const {$,draft}=c;
  $('.world').classList.add('entry-world');
  $('#character-stage').innerHTML=`<div class="entry-scene" aria-label="看山左侧是一扇略带轴测角度的落地小木门"><img class="entry-door" src="${A}door.png" alt="透出暖光的左侧小木门"><div class="entry-dog">${WARDROBE.render(draft.assembly)}</div><div class="entry-floor"></div></div>`;
  $('.caption').textContent='小门在左边，回家的灯已经亮了。';
 }
 function render(c){
  const {$,draft,esc,notes,save,state}=c;document.body.classList.add('home-page');
  const away=state==='away',returned=state==='returned';
  const status=away?'出门了':returned?'刚回来':'在家';
  const caption=away?'它出门看看了。你可以留个心愿，晚点再来。':returned?'我回来了，路上有件小事想告诉你。':'阳光刚好，先一起坐一会儿吧。';
  const actor=returned?{x:76,y:92.4581,width:26.6312}:config.wide.actor;
  const tallActor=returned?{x:76,y:92.4581,width:26.6312}:config.tall.actor;
  $('#content').innerHTML=`<section class="home-shell" aria-label="看山的小屋"><div class="home-room"><div class="scene-left-ui"><div class="home-top"><button class="nameplate" data-panel="profile">${image('profile')}<span><strong id="home-name">${esc(draft.name||'看山')}的小屋</strong><small>${status}</small></span></button><button class="settings-button" data-panel="settings">${image('settings')}<span>设置</span></button></div><nav class="home-dock" aria-label="小屋功能">${HomeAdapters.entries().map(e=>`<button data-panel="${e.id}">${image(e.icon)}<span>${esc(e.label)}</span></button>`).join('')}</nav></div><picture><source media="(max-width:600px) and (orientation:portrait)" srcset="${config.tall.src}"><img class="room-background" src="${config.wide.src}" width="480" height="320" alt="明亮紧凑的小屋：蓝色窗框、浅木书桌椅、绿植、蓝边方毯和右侧庭院门，左侧为透明底素材图标"></picture>${away?'':`<button class="room-actor" data-panel="chat" aria-label="和看山聊聊" style="--x:${actor.x}%;--y:${actor.y}%;--w:${actor.width}%;--tx:${tallActor.x}%;--ty:${tallActor.y}%;--tw:${tallActor.width}%">${WARDROBE.render(draft.assembly)}</button>`}<div class="room-speech" role="status">${caption}</div></div><p class="home-demo">A4 静态小屋 · 页面内容为演示，尚未连接真实生活数据</p><div class="home-panel-backdrop" hidden></div><section class="home-panel" role="dialog" aria-modal="true" aria-labelledby="panel-title" tabindex="-1" hidden></section></section>`;
  $('#annotations').innerHTML=notes([
   ['空间与静态分镜','成功页为外侧视角：门在角色左侧。入屋后切室内视角：门在右侧，角色出现在中央地毯。刚回来状态给出门口位置；当前不播放行走和转场，待静态构图确认后接动画。'],
   ['主入口分类','聊聊：交流/归来分享；心愿：添加撤销；来信：邀请、回音、捎话、延后礼物；手账：旅途、相遇交换与朋友圈。档案承接改名；设置放必要偏好。无好友概览、签到、货币、催促红点或强制出发。'],
   ['替换与业务边界','home-scene.js 配置横竖背景及角色位置，角色由 wardrobe.js 的可替换渲染入口输出，当前固定为用户指定无嘴巴参考看山，服装选择仅存草稿。背景不含角色/文字/UI，图标独立。面板仅是本地静态交互示例；真实数据、账号归属、改名和保存由 A5 接入。']
  ],'v25清晰像素与随身阴影：yiwan按原参考修复整块地毯和空房间，高清1504×716背景采用752×358逻辑像素整数放大；看山按统一100×116画布清理像素边缘，身体/五官/围巾/挎包/枫叶五层，阴影为角色容器内独立透明层。木牌头像恢复。HomeAdapters支持注册新功能、角色动作与UI动效渲染器，接口原样保留、默认静态；后续通过返回的解除函数清理。横竖使用同一清晰背景，手机通过视口裁切适配；站姿/坐姿静态素材及阴影共用脚底锚点，WARDROBE.setPose同步更换角色和阴影。现有HomeAdapters动作、功能与UI动效接口保持原样，未启用动画，静态分层不代表所有动作资产已交付。后续外观更换入口仅预留在配置，不开放创建后重新选择face。');
  const panel=$('.home-panel'),backdrop=$('.home-panel-backdrop');let trigger;
  const motionOff=()=>!!draft.reducedMotion||matchMedia('(prefers-reduced-motion: reduce)').matches;
  const close=()=>{HomeAdapters.ui({phase:'close',target:panel,reducedMotion:motionOff()});panel.hidden=true;backdrop.hidden=true;trigger?.focus()};
  const field=(label,id,placeholder)=>`<label for="${id}">${label}</label><textarea id="${id}" rows="3" placeholder="${placeholder}"></textarea>`;
  function open(id,button){
   trigger=button;HomeAdapters.ui({phase:'open',id,target:panel,reducedMotion:motionOff()});let title='',body='';
   const custom=HomeAdapters.feature(id);
   if(custom){title=custom.label;body=custom.render({draft,esc,save});}
   else
   if(id==='profile'){
    title='它的小档案';body=`<div class="profile-character">${WARDROBE.render(draft.assembly)}</div><label for="rename">它的名字</label><input id="rename" class="name" value="${esc(draft.name||'看山')}" aria-describedby="rename-help"><p class="hint" id="rename-help">建议规则沿用领养页：1–12个字。</p><button class="primary" data-local="rename">保存这个称呼</button><p class="panel-feedback" role="status"></p><h3>三个性格词</h3><p>${(draft.generated||PreviewService.generate(draft)).tags.map(t=>esc(t.label)).join(' · ')}</p><p class="fine">外观修改位置已预留，后续范围确认后接入；当前不开放重新选择表情。</p>`;
   }else if(id==='settings'){
    title='小屋设置';body=`<p>把这里调成舒服的样子。</p><label class="setting-row"><span>减少动态效果</span><input id="reduced-motion" type="checkbox" ${draft.reducedMotion?'checked':''}></label><p class="hint">当前均为静态画面；该偏好会传给后续动画接口。</p><div class="settings-section"><h3>账号与授权</h3><p>知乎账号与授权管理接入位置。当前预览没有真实账号。</p></div>`;
   }else if(id==='chat'){
    title='和它坐一会儿';body=`<div class="dialogue"><strong>${esc(draft.name||'看山')}</strong><p>${away?'我出门了，回家后再慢慢听你说。':'今天，有什么想和我说的吗？'}</p></div>${away?'':field('想说的话','chat-text','分享一点今天的小事…')+'<button class="primary" data-local="chat">把这句话留在演示里</button>'}<p class="panel-feedback" role="status"></p><p class="fine">聊天不自动成为长期心愿；此处不生成虚构回复。</p>`;
   }else if(id==='wish'){
    title='最近想看看什么？';body=`<p>留一个心愿，它会在自己的日常里慢慢留意。</p>${field('我的心愿','wish-text','例如：想看看秋天的河边')}<button class="primary" data-local="wish">放好这个心愿</button><div id="wish-list"></div><p class="panel-feedback" role="status"></p>`;
   }else if(id==='mail'){
    title='来信';body=`<div class="panel-tabs" role="group" aria-label="来信分类"><button aria-pressed="true" data-mail="邀请与回音">邀请与回音</button><button aria-pressed="false" data-mail="捎话">捎话</button><button aria-pressed="false" data-mail="礼物">礼物</button></div><div class="empty-letter">${image('mail')}<h3 id="mail-empty">这里还没有邀请与回音。</h3><p>有些东西，会在路上多走一会儿。</p></div><p class="fine">演示空状态；不伪造真实来信，也不提前显示尚未到达的礼物。</p>`;
   }else{
    title='旅途手账';body=`<div class="panel-tabs" role="group" aria-label="记录分类"><button aria-pressed="true" data-journal="旅途">旅途</button><button aria-pressed="false" data-journal="来往">来往</button><button aria-pressed="false" data-journal="朋友圈">朋友圈</button></div><div class="empty-letter">${image('journal')}<h3 id="journal-empty">第一段旅途，还没写下。</h3><p>等它回来，再一起翻翻。</p></div><p class="fine">旅途发现保留可点来源；来往包括交换、礼物和未回应邀请。朋友圈只展示狗的动态与互动。</p>`;
   }
   panel.innerHTML=`<div class="panel-heading"><h2 id="panel-title">${title}</h2><button data-close aria-label="关闭面板">关闭</button></div><p class="panel-demo">静态交互示例 · 仅保存在本标签页</p>${body}`;
   panel.hidden=false;backdrop.hidden=false;panel.focus();panel.querySelector('[data-close]').onclick=close;
   panel.querySelector('[data-local="rename"]')?.addEventListener('click',()=>{
    const name=$('#rename').value.trim(),error=!name?'先写一个名字吧。':[...name].length>c.C.name.max?'名字最多12个字。':!c.C.name.pattern.test(name)?'请使用汉字、字母、数字、空格或 ·。':'';
    $('.panel-feedback').textContent=error||'称呼已在本标签页更新。';if(error)return;draft.name=name;save();$('#home-name').textContent=name+'的小屋';
   });
   $('#reduced-motion')?.addEventListener('change',e=>{draft.reducedMotion=e.target.checked;save()});
   panel.querySelector('[data-local="chat"]')?.addEventListener('click',()=>{$('.panel-feedback').textContent=$('#chat-text').value.trim()?'这句话已留在演示草稿中，未发送给服务端。':'先写一点想说的话吧。';draft.chatDraft=$('#chat-text').value;save()});
   function wishes(){const list=$('#wish-list');if(!list)return;list.innerHTML=(draft.homeWishes||[]).map((text,i)=>`<div class="wish-item"><span>${esc(text)}</span><button data-remove="${i}">撤销</button></div>`).join('');list.querySelectorAll('button').forEach(b=>b.onclick=()=>{draft.homeWishes.splice(+b.dataset.remove,1);save();wishes();panel.querySelector('[data-local="wish"]').focus()})}
   wishes();panel.querySelector('[data-local="wish"]')?.addEventListener('click',()=>{const text=$('#wish-text').value.trim();if(!text){$('.panel-feedback').textContent='写一个小小的心愿吧。';return}draft.homeWishes=[...(draft.homeWishes||[]),text];save();$('#wish-text').value='';wishes();$('.panel-feedback').textContent='已加入演示心愿，未交给真实出行服务。'});
   panel.querySelectorAll('[data-mail],[data-journal]').forEach(b=>b.onclick=()=>{b.parentElement.querySelectorAll('button').forEach(v=>v.setAttribute('aria-pressed',String(v===b)));if(b.dataset.mail)$('#mail-empty').textContent='这里还没有'+b.dataset.mail+'。';else $('#journal-empty').textContent=b.dataset.journal==='旅途'?'第一段旅途，还没写下。':'这里还没有'+b.dataset.journal+'记录。'});
  }
  if(state==='sitting')WARDROBE.setPose($('.room-actor'),'sit');
  HomeAdapters.actor({phase:'mount',action:away?'away':returned?'return':state==='sitting'?'sit':'idle',target:$('.room-actor'),reducedMotion:motionOff(),assembly:draft.assembly});
  $('#content').querySelectorAll('[data-panel]').forEach(b=>b.onclick=()=>open(b.dataset.panel,b));backdrop.onclick=close;
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!panel.hidden)close()});
  panel.addEventListener('keydown',e=>{if(e.key!=='Tab')return;const a=[...panel.querySelectorAll('button,input,textarea')].filter(v=>!v.disabled);if(e.shiftKey&&(document.activeElement===a[0]||document.activeElement===panel)){e.preventDefault();a.at(-1)?.focus()}else if(!e.shiftKey&&document.activeElement===a.at(-1)){e.preventDefault();a[0]?.focus()}});
 }
 return {config,transition,entry,render};
})();
