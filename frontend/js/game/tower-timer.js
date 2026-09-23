import { state } from '../core/state.js';
import { setText } from '../core/dom.js';

let timer=null;
let completedElapsedMs=0;

function formatElapsed(milliseconds) {
  const total=Math.max(0,Math.floor(Number(milliseconds)/1000));
  const hours=Math.floor(total/3600);
  const minutes=Math.floor(total%3600/60);
  const seconds=total%60;
  return hours ? `${hours}:${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}` : `${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}`;
}

function render(layerElapsedMs) {
  const layer=Math.max(0,Number(layerElapsedMs)||0);
  state.towerLayerElapsedMs=layer;
  setText('tower-timer',`${formatElapsed(layer)}/${formatElapsed(completedElapsedMs+layer)}`);
}

export function startTowerTimer(startedAt=Date.now(),totalElapsedMs=0) {
  stopTowerTimer();
  completedElapsedMs=Math.max(0,Number(totalElapsedMs)||0);
  state.towerStartedAt=new Date(startedAt).getTime();
  if(!Number.isFinite(state.towerStartedAt))state.towerStartedAt=Date.now();
  const tick=()=>render(Date.now()-state.towerStartedAt);
  tick();timer=setInterval(tick,250);timer?.unref?.();
}

export function stopTowerTimer(finalElapsedMs,totalElapsedMs) {
  if(finalElapsedMs!=null && totalElapsedMs!=null)completedElapsedMs=Math.max(0,(Number(totalElapsedMs)||0)-(Number(finalElapsedMs)||0));
  if(finalElapsedMs!=null)render(finalElapsedMs);
  else if(timer!=null && Number.isFinite(state.towerStartedAt))render(Date.now()-state.towerStartedAt);
  if(timer!=null){clearInterval(timer);timer=null;}
  state.towerStartedAt=null;
  return state.towerLayerElapsedMs;
}
