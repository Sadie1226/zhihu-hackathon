/* Explicit deterministic review fixtures; replace with A5 service adapter. No network calls. */
window.PreviewService = (() => {
  const signature=d=>JSON.stringify([d.traits,d.interests,d.readMode||'demo']);
  function generate(d){
    const traits=window.ADOPTION_CONFIG.traits;
    return {signature:signature(d),source:'A4 静态样例',tags:traits.map((t,i)=>({t,i,value:d.traits[t.key]??50}))
      .sort((a,b)=>Math.abs(b.value-50)-Math.abs(a.value-50)||a.i-b.i).slice(0,3)
      .map(({t,i,value})=>({dimension:t.key,dimensionLabel:t.left+' / '+t.right,label:value===50?['动静皆宜','亲疏随心','言语随兴','万物与人','表达随心','珍惜时光'][i]:value<50?t.left:t.right,reason:value===50?'这一维暂未偏向任何一端。':'参考了你手动选择的倾向。'}))};
  }
  const stale=d=>!d.generated||d.generated.signature!==signature(d);
  return {signature,generate,stale};
})();
