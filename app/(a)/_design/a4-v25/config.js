// 可替换素材、字段、状态集中于此；不依赖服务端契约。
window.ADOPTION_CONFIG = {
  assets: {room:'assets/AI素材组合.png',welcome:'assets/welcome.png',interestIcon:i=>`assets/interest-${i}.png`,paper:'assets/stationery.png',head:state=>`assets/head-${state}.png`},
  statusAppearance:{entry:'cancel',waiting:'waiting',reading:'waiting',success:'success',cancel:'cancel',failure:'failure',empty:'cancel',partial:'failure'},
  traitVisuals:{baseSize:24,minSize:18,maxSize:32},
  motionIntensity:{gentleMax:.3,mediumMax:.7},
  motion:{
    exploration:{left:{id:'look-out-window',label:'探头望向窗外'},right:{id:'sit-on-cushion',label:'坐回小垫子'}},
    social:{left:{id:'wave-hello',label:'抬手打招呼'},right:{id:'shy-glance',label:'小幅低头，偷偷看你'}},
    expression:{left:{id:'chat-bubbles',label:'冒出两三个小对话泡'},right:{id:'quiet-ellipsis',label:'留一个安静的省略号'}},
    attention:{left:{id:'look-at-plant',label:'看向窗边植物'},right:{id:'turn-to-owner',label:'转头看向你'}},
    communication:{left:{id:'direct-invitation',label:'我想去看看。'},right:{id:'gentle-invitation',label:'要不要，一起看看？'}},
    time:{left:{id:'catch-leaf',label:'接住窗边飘来的叶子'},right:{id:'look-at-photo',label:'看一眼旁边的小相片'}}
  },
  name: {max:12, pattern:/^[\p{L}\p{N} ·]+$/u},
  interests:['自然风景','城市角落','手作与食物','人与故事','动物与植物','冷知识'],
  traits:[
    {key:'exploration',left:'好奇',right:'恋家',say:['我想去看看小路的另一头。','家里的阳光，也很值得研究。']},
    {key:'social',left:'自来熟',right:'慢热',say:['遇见新朋友，我会先打个招呼。','先坐在旁边，慢慢熟悉。']},
    {key:'expression',left:'话痨',right:'寡言',say:['今天的小发现，我想多说一点。','我会把喜欢，轻轻放在你身边。']},
    {key:'attention',left:'看物',right:'看人',say:['这块石头，好像藏着一个故事。','我想听听，路上的人怎么生活。']},
    {key:'communication',left:'直给',right:'婉转',say:['喜欢的事，我会直接告诉你。','我想换个温柔的说法。']},
    {key:'time',left:'当下',right:'怀旧',say:['先收好今天这一束光。','旧故事，也值得再听一遍。']}
  ],
  pages:{
    auth:{title:'知乎授权',states:{entry:'授权入口',waiting:'授权等待中',success:'授权成功',cancel:'取消授权',failure:'授权失败',reading:'资料读取中',empty:'资料为空',partial:'附加资料读取失败'}},
    profile:{title:'名字与兴趣',states:{default:'正常输入',blank:'名字未填',invalid:'名字含非法字符',long:'名字超长',zero:'兴趣未选',one:'只选一类',two:'已选两类',three:'已选三类',limit:'尝试第四类'}},
    traits:{title:'性格倾向',states:{default:'默认等大',left:'偏左示意',right:'偏右示意',dragging:'拖动中示意',released:'松手反馈示意'}},
    handoff:{title:'本轮边界',states:{default:'后续验收说明'}}
  }
};

// Round-two pages are additive, keeping first-round inputs and assets intact.
delete window.ADOPTION_CONFIG.pages.handoff;
Object.assign(window.ADOPTION_CONFIG.pages, {
 tags:{title:'三个性格词',states:{loading:'性格生成中',result:'三个不同维度标签',failure:'生成失败',empty:'资料为空的建议结果'}},
 wardrobe:{title:'挑选穿搭',states:{default:'正常挑选',raincoat:'雨衣与帽子',sun:'墨镜遮眼'}},
 creation:{title:'成为伙伴',states:{loading:'创建中',failure:'创建失败保留输入',success:'创建成功'}},
 home:{title:'进入小屋',states:{default:'在家',away:'出门了',returned:'刚回来',sitting:'坐下 · 静态预览'}}
});
