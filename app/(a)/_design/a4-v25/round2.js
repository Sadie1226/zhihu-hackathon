/* Round-two views depend on a small context; assets and service stay replaceable. */
window.RoundTwo=(()=>{
  let ctx,tab='cloth';
  const S=()=>window.PreviewService,W=()=>window.WARDROBE;
  function init(c){ctx=c;ctx.draft.assembly={...W().defaults(),...ctx.draft.assembly};}
  const actions=(...buttons)=>`<div class="actions">${buttons.join('')}</div>`;
  function preview(){
    const {draft,$}=ctx;
    $('.world').classList.add('dressing-world');
    $('#character-stage').innerHTML=`<div class="dressing-stage character-only"><div id="outfit-preview">${W().render(draft.assembly)}</div></div>`;
    $('.caption').textContent='';$('#greeting').textContent='';

  }
  function tagsView(){
    const {state,draft,$,paper,notice,btn,notes,esc}=ctx;
    $('#greeting').textContent='我的小性格，正在慢慢成形。';
    const loading=state==='loading',failed=state==='failure',empty=state==='empty'||(draft.readMode==='empty'&&Object.values(draft.traits).every(v=>v===50));
    const generated=(empty||S().stale(draft))?S().generate(empty?{...draft,traits:Object.fromEntries(ctx.C.traits.map(t=>[t.key,50]))}:draft):draft.generated;
    const title=loading?'把小小的倾向，收成三个词。':failed?'这次，还没找到合适的词。':'原来，你喜欢这样的伙伴。';
    let body;
    if(loading)body=notice('正在整理它的初始性格','先参考你选的倾向，再看看已读资料。不用重复提交。',false,'waiting')+`<div class="waiting-steps"><span>整理手动倾向</span><span>参考可用资料</span><span>收成三个词</span></div>`+actions(btn('← 返回修改倾向','back-traits'));
    else if(failed)body=notice('生成暂时失败','可能是网络或服务暂时不可用。名字、兴趣和倾向都还在，不会用默认结果冒充成功。',true,'failure')+actions(btn('← 返回倾向','back-traits'),btn('再试一次 →','generate-tags',true));
    else body=`<div class="tag-list">${generated.tags.map((tag,i)=>`<article class="personality-card"><div class="tag-top"><span>0${i+1}</span><span>${esc(tag.dimensionLabel)}</span></div><h2>${esc(tag.label)}</h2><p>${esc(tag.reason)}</p></article>`).join('')}</div>`+notice(empty?'留白，也有它的可能。':'这三个词，是认识它的起点。',empty?'资料读取成功但没有可用内容。这一组是全居中时的默认建议，等待你确认。':'你的手动倾向优先；三个词来自不同维度，外观仍由你自由挑选。',false,'success')+`<p class="fine">A4 样例结果 · 未调用服务端生成${draft.readMode==='partial'?' · 资料读取失败的部分未作为空数据使用':''}</p>`+actions(btn('← 修改倾向','back-traits'),btn('去挑一套穿搭 →','to-wardrobe',true));
    paper.innerHTML=`<div class="eyebrow">认识它 · 04</div><h1>${title}</h1><p class="lead">不是把它定死，只是给未来的相处一个开始。</p>${body}`;
    $('#annotations').innerHTML=notes([
      ['输入与输出','建议输入：<code>traits[6], interestCategories[], profileRead</code>；正式接口由 A5 适配。输出恰好三个标签，每项带不同 <code>dimension</code>。此处确定性样例仅用于验收结构，不是生成算法。'],
      ['空资料与失败','资料 empty 表示读取成功但没有内容；read error 另行告知并重试，不转成 empty；生成 error 不返回伪造标签。等待态不显示虚构进度和倒计时。'],
      ['返回规则 · 建议待确认','保存生成时的输入签名；修改倾向/兴趣/资料来源后结果失效，下一步重走生成；未修改复用。全居中无数据用明确默认建议；有资料时如何择维由服务端策略定。']
    ],'本预览按手动偏向强度选三个维度，同值按固定顺序，只为可重复验收；不是已确认的产品生成规则。');
  }
  function wardrobeView(){
    const {draft,$,paper,btn,notice,notes}=ctx;
    if(ctx.state==='raincoat')draft.assembly.cloth='raincoat';
    if(ctx.state==='sun')draft.assembly.glasses='sun';
    preview();
    paper.innerHTML=`<div class="eyebrow">由你挑选 · 05</div><h1>把喜欢，穿在身上。</h1><p class="lead">性格没有指定的制服。挑一件衣服，再加一点自己的偏爱。</p><div class="wardrobe-tabs" role="group" aria-label="穿搭分类">${Object.entries(W().catalogue).map(([k,c])=>`<button data-outfit-tab="${k}" aria-pressed="${k===tab}">${c.label}</button>`).join('')}</div><div id="mobile-outfit-preview" class="mobile-outfit-preview" aria-hidden="true"></div><div id="wardrobe-options" class="wardrobe-options" role="group" aria-label="可选穿搭"></div><p id="wardrobe-rule" class="hint" role="status"></p>${notice('是你选的，就是它的样子。','衣服、帽子、眼镜和表情都由你选择；不按标签自动换装。',false,'success')}${actions(btn('← 看看三个词','back-tags'),btn('就这样，成为伙伴 →','create-dog',true))}`;
    paper.querySelectorAll('[data-outfit-tab]').forEach(b=>b.addEventListener('click',()=>{tab=b.dataset.outfitTab;updateWardrobe()}));
    updateWardrobe();
    $('#annotations').innerHTML=notes([
      ['四字段与提交','<code>assembly:{cloth,hat,glasses,face}</code>，枚举按 E2b。当前选项仅保留草稿，角色固定为指定参考图；暂停试验图层叠加，点创建保存静态快照。表情是外观选择，创建后固定；后续换表情范围待确认。'],
      ['雨衣与帽子 · V3','预览采用“保留帽子选择、雨衣时暂停显示”的试验策略。离开雨衣恢复原帽；正式归一化由 C/D 决定，不把这一策略冒充契约。墨镜遮眼，其余镜框透眼；帽子露耳。'],
      ['替换接口与试验边界','v22试验部件保留但暂停展示；当前主角色为用户指定参考图，registerRenderer可接入E正式装配器。<code>wardrobe.js</code> 集中资源、层序和校验；所有图层同原点，不逐页CSS挪动。正式尺寸/锚点/层序仍待 C/E。']
    ],'试验层序 body → cloth → face → hat → glasses，以满足遮眼效果；备用层序可传给 render。另一层序若采用，必须重新处理眼部透明窗，不能只换数组就宣称两种都合格。null/none 的正式适配仍待 C-20，本稿仅用内部 none。');
  }
  function updateWardrobe(){
    const {draft,$,save}=ctx;const c=W().catalogue[tab];
    $('[data-outfit-tab="'+tab+'"]').parentElement.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.outfitTab===tab)));
    const rain=tab==='hat'&&draft.assembly.cloth==='raincoat';
    $('#wardrobe-options').setAttribute('aria-label',c.label+'选项');
    $('#wardrobe-options').dataset.count=c.items.length;
    $('#wardrobe-options').innerHTML=c.items.map(([value,label])=>`<button type="button" class="outfit-option" data-outfit="${value}" aria-pressed="${draft.assembly[tab]===value}" ${rain?'disabled':''}><img src="${W().icon(tab,value)}" width="96" height="96" alt=""><span>${label}</span>${draft.assembly[tab]===value?'<small>已选</small>':''}</button>`).join('');
    $('#wardrobe-rule').textContent='当前使用参考看山，选项只保留草稿，暂停叠加服装素材。';
    /* Original rules retained in catalogue/adapter; no misleading outfit preview. */
    const futureRule=rain?'雨衣自带帽兜，独立帽子暂停显示；换回其他衣服会恢复原选择。':tab==='face'?'选择它的初始表情；创建后固定，不代表实时心情。':tab==='glasses'?'太阳镜遮住眼睛，圆框和方框保留眼神。':'点选后，左侧看山会换上你的选择。';
    $('#wardrobe-options').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{draft.assembly[tab]=b.dataset.outfit;save();updateWardrobe()}));
    $('#outfit-preview').innerHTML=W().render(draft.assembly);
    $('#mobile-outfit-preview').innerHTML=W().render(draft.assembly)+'<span>参考看山<br>服装暂不叠加。</span>';
  }
  function creationView(){
    const {draft,state,$,paper,btn,notice,notes,esc}=ctx;preview();
    const loading=state==='loading',failed=state==='failure';
    if(!loading&&!failed)window.HomeScene.entry(ctx);
    $('#greeting').textContent=loading?'我在门边等你。':failed?'没关系，我们再试一次。':'以后，这里就是我们的日常。';
    const name=esc(draft.name||'看山');
    paper.innerHTML=`<div class="eyebrow">成为伙伴 · 06</div><h1>${loading?'给它留一盏回家的灯。':failed?'这次，还没能安顿下来。':name+'，以后请多关照。'}</h1><p class="lead">${loading?'正在保存名字、三个性格词和你挑好的穿搭。':failed?'刚才的选择都保留着，不需要从头填写。':'这就是你选的伙伴。它有自己的日常，也会带着小发现来找你。'}</p>${notice(loading?'正在创建':failed?'创建暂时失败':'这就是你的看山',loading?'等待完成后，再一起进小屋。':failed?'可能是网络或服务暂时不可用。重试使用同一份创建内容，避免重复创建。':'名字、性格与穿搭已在这张静态成功稿中确认。',failed,loading?'waiting':failed?'failure':'success')}${!loading?`<div class="adoption-recap"><span>名字</span><strong>${name}</strong><span>性格</span><strong>${(draft.generated||S().generate(draft)).tags.map(t=>esc(t.label)).join(' · ')}</strong><span>穿搭</span><strong>${Object.entries(W().catalogue).map(([k,c])=>c.items.find(([v])=>v===draft.assembly[k])[1]+(k==='hat'&&draft.assembly.cloth==='raincoat'&&draft.assembly.hat!=='none'?'（雨衣时收起）':'')).join(' · ')}</strong></div>`:''}${actions(...(loading?[btn('← 返回检查','back-wardrobe')]:failed?[btn('← 修改穿搭','back-wardrobe'),btn('保留选择，再试一次 →','retry-create',true)]:[btn('进入它的小屋 →','enter-home',true)]))}<p class="fine">静态验收示意 · 本次没有向服务端创建或保存角色</p>`;
    $('#annotations').innerHTML=notes([
      ['提交时机','仅从穿搭页确认后创建，冻结 <code>name/interests/traits/personality/assembly</code> 快照；重复点击不发第二次提交。A5 服务端执行校验、事务和幂等，不依赖按钮禁用。'],
      ['失败与返回','失败保留所有草稿和创建快照，重试同一请求；返回修改后使用新快照。网络超时不应直接认定未创建，A5 需要以幂等键查询已有结果。'],
      ['成功去向','A5 仅在确认真实创建成功并拿到归属本人角色后跳转小屋；此处进入静态衔接稿。刷新恢复与账号隔离须在 A5 真实环境另验。']
    ],'本稿只在当前标签页保留演示草稿，不能据此验收账号级持久化、越权防护或真实创建。');
  }
  function homeView(){window.HomeScene.render(ctx);}
  function render(c){init(c);({tags:tagsView,wardrobe:wardrobeView,creation:creationView,home:homeView}[ctx.page])();}
  function handle(action,c){
    init(c);const {draft,go,save}=ctx;
    if(action==='generate-tags'){go('tags',S().stale(draft)?'loading':'result');return true;}
    if(action==='to-wardrobe'){if(ctx.state==='empty')draft.generated=S().generate({...draft,traits:Object.fromEntries(ctx.C.traits.map(t=>[t.key,50]))});else if(S().stale(draft))draft.generated=S().generate(draft);save();go('wardrobe');return true;}
    if(action==='create-dog'||action==='retry-create'){
      if(!draft.name?.trim()){go('profile');return true;}
      if(S().stale(draft)){go('tags','loading');return true;}
      W().validate(draft.assembly);draft.creationSnapshot=JSON.parse(JSON.stringify({name:draft.name,interests:draft.interests,traits:draft.traits,personality:draft.generated,assembly:draft.assembly}));save();go('creation','loading');return true;
    }
    const routes={'back-tags':['tags','result'],'back-wardrobe':['wardrobe'],'enter-home':['home'],'back-created':['creation','success']};
    if(routes[action]){go(...routes[action]);return true;}return false;
  }
  return {render,handle};
})();
