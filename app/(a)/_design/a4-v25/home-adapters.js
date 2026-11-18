/* Static by default. Animators and future feature panels attach without changing scene HTML. */
window.HomeAdapters=(()=>{
 const features=new Map(),actors=new Set(),effects=new Set();
 const entries=[{id:'chat',label:'聊聊',icon:'chat'},{id:'wish',label:'心愿',icon:'wish'},{id:'mail',label:'来信',icon:'mail'},{id:'journal',label:'手账',icon:'journal'}];
 const listen=(set,renderer)=>{set.add(renderer);return()=>set.delete(renderer)};
 const emit=(set,detail)=>{for(const r of set)r(detail)};
 function registerFeature(feature){if(!/^[a-z][a-z0-9-]*$/.test(feature.id)||!feature.label||typeof feature.render!=='function')throw Error('Invalid feature');if(entries.some(e=>e.id===feature.id)||features.has(feature.id))throw Error('Duplicate feature');features.set(feature.id,feature);return()=>features.delete(feature.id)}
 return {
  entries:()=>[...entries,...features.values()],registerFeature,
  feature:id=>features.get(id),
  registerActor:r=>listen(actors,r),registerUIEffect:r=>listen(effects,r),
  actorActions:['idle','blink','look-around','sit','stretch','wave','approach-door','cross-threshold'],
  actor(detail){emit(actors,{...detail,staticPreview:true})},
  ui(detail){emit(effects,{...detail,staticPreview:true})}
 };
})();
