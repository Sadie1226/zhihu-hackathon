/* A4-only resource adapter. Replace this manifest when C/E settle formal anchors. */
window.WARDROBE = (() => {
  const root='assets/wardrobe/';
  const catalogue={
    cloth:{label:'衣服',items:[['hoodie','蓝色连帽衫'],['jacket','焦糖夹克'],['sweater','奶油毛衣'],['raincoat','小雨衣'],['apron','植物围裙'],['scarf-coat','围巾外套']]},
    hat:{label:'帽子',items:[['beanie','针织帽'],['cap','鸭舌帽'],['straw','小草帽'],['none','不戴帽子']]},
    glasses:{label:'眼镜',items:[['round','圆圆镜框'],['square','方方镜框'],['sun','太阳镜'],['none','不戴眼镜']]},
    face:{label:'表情',items:[['happy','开心'],['tired','困困'],['hopeful','期待'],['waiting','安静等你']]}
  };
  const trial={canvas:96,layerOrder:['cloth','face','hat','glasses'],alternateOrder:['cloth','hat','glasses','face']};
  const defaults=()=>({cloth:'hoodie',hat:'none',glasses:'none',face:'happy'});
  const src=(layer,value)=>root+layer+'-'+value+'.png';
  function validate(a){
    for(const [key,c]of Object.entries(catalogue))if(!Object.hasOwn(a,key)||!c.items.some(([v])=>v===a[key]))throw Error('无效的试验装配字段：'+key);
    return a;
  }
  function renderLayers(a,{order=trial.layerOrder}={}){
    validate(a);
    const title=Object.entries(catalogue).map(([k,c])=>c.items.find(([v])=>v===a[k])[1]).join('、');
    // V3: rendering suppression preserves the user's hat selection. Not a C/D data contract.
    return `<div class="dog-assembly" role="img" aria-label="${title}" data-assembly="${Object.values(a).join('/')}"><img src="${root}body.png" width="96" height="96" alt="">${order.filter(k=>!(k==='hat'&&a.cloth==='raincoat')).map(k=>`<img data-layer="${k}" src="${src(k,a[k])}" width="96" height="96" alt="">`).join('')}</div>`;
  }
  const icon=(layer,value)=>value==='none'?root+layer+'-none-icon.png':root+'icon-'+layer+'-'+value+'.png';
  let renderer=null;
  const poseArt=pose=>`<img class="actor-shadow" data-shadow-layer data-shadow-pose="${pose}" src="assets/home/v25-shadow-${pose}.png" alt="" width="100" height="116"><span class="actor-visual" data-pose-layer>${pose==='sit'?'<img data-art-layer="sit" src="assets/home/v25-kanshan-sit.png" alt="" width="100" height="116">':['body','face','scarf','bag','leaf'].map(part=>`<img data-art-layer="${part}" src="assets/home/v25-kanshan-${part}.png" alt="" width="100" height="116">`).join('')}</span>`;
  function render(a,options={}){validate(a);const pose=options.pose==='sit'?'sit':'stand';return renderer?renderer(a,options):`<div class="dog-assembly reference-actor" role="img" aria-label="清晰像素看山，红围巾、黄色挎包，没有嘴巴" data-assembly="${Object.values(a).join('/')}" data-pose="${pose}" data-foot-anchor="50,107.5" data-pose-api="WARDROBE.setPose">${poseArt(pose)}</div>`;}
  function setPose(target,pose){if(!['stand','sit'].includes(pose))throw Error('Unknown static pose');const actor=target?.matches?.('.reference-actor')?target:target?.querySelector?.('.reference-actor');if(!actor)return false;actor.dataset.pose=pose;actor.innerHTML=poseArt(pose);return true;}
  function registerRenderer(next){renderer=next;return()=>{if(renderer===next)renderer=null}};
  return {catalogue,trial,defaults,src,render,renderLayers,registerRenderer,validate,icon,setPose};
})();
