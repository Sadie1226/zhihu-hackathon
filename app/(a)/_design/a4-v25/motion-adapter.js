/** Static-first boundary: replace adapter, never bind sprites to form rules.
 * Future renderer receives one event per committed change, never loops by default.
 */
(() => {
  let renderer=null;
  window.KanshanMotion={
    register(nextRenderer){renderer=nextRenderer;return()=>{if(renderer===nextRenderer)renderer=null}},
    describe(dimension,value,phase='release'){
      const strength=Math.abs(value-50)/50;
      const direction=value===50?'neutral':value<50?'left':'right';
      const action=direction==='neutral'?{id:'idle',label:'保持自然站姿'}:window.ADOPTION_CONFIG.motion[dimension][direction];
      const thresholds=window.ADOPTION_CONFIG.motionIntensity;
      return {dimension,value,direction,strength,tier:strength===0?'neutral':strength<=thresholds.gentleMax?'gentle':strength<=thresholds.mediumMax?'medium':'strong',phase,actionId:action.id,actionLabel:action.label,loop:false,reducedMotion:matchMedia('(prefers-reduced-motion: reduce)').matches};
    },
    emit(detail){
      document.dispatchEvent(new CustomEvent('kanshan:personality-feedback',{detail}));
      if(detail.phase==='release'&&renderer){try{Promise.resolve(renderer.play(detail)).catch(error=>console.warn('角色反馈暂不可用',error.name))}catch(error){console.warn('角色反馈暂不可用',error.name)}}
    }
  };
})();
