import { api } from '../core/api.js';
import { state } from '../core/state.js';
import { $,hide,show,setText } from '../core/dom.js';
import { cityById } from '../data/cities.js';
import { TOWER_KEYS,TOWER_SCENARIOS } from '../data/levels.js';

let scenario='normal';
let requestVersion=0;

function formatDuration(value) {
  const milliseconds=Math.max(0,Math.round(Number(value)||0));
  const hours=Math.floor(milliseconds/3600000);
  const minutes=Math.floor(milliseconds/60000)%60;
  const seconds=Math.floor(milliseconds/1000)%60;
  const millis=milliseconds%1000;
  const clock=`${String(minutes).padStart(2,'0')}:${String(seconds).padStart(2,'0')}.${String(millis).padStart(3,'0')}`;
  return hours ? `${String(hours).padStart(2,'0')}:${clock}` : clock;
}

function renderScenarioButtons() {
  const wrap=$('leaderboard-scenarios');
  wrap.replaceChildren();
  for(const key of TOWER_KEYS) {
    const button=document.createElement('button');
    button.type='button';button.textContent=TOWER_SCENARIOS[key].label;
    button.className=key===scenario?'active':'';
    button.addEventListener('click',()=>{scenario=key;renderScenarioButtons();loadLeaderboard();});
    wrap.appendChild(button);
  }
}

function appendRow(list,row,own=false) {
  const item=document.createElement('tr');item.className=`leaderboard-row rank-${row.rank}${own?' leaderboard-own':''}`;
  if(own)item.setAttribute?.('aria-current','true');
  for(const [className,value] of [
    ['leaderboard-rank',`#${row.rank}`],['leaderboard-name',row.name],
    ['leaderboard-layers',`${row.cleared_layers} 层`],['leaderboard-time',formatDuration(row.total_elapsed_ms)],
  ]) { const cell=document.createElement('td');cell.className=className;cell.textContent=value;item.appendChild(cell); }
  list.appendChild(item);
}

function renderRows(payload) {
  const list=$('leaderboard-list');
  list.replaceChildren();
  const leaders=(payload?.leaders || []).slice(0,20);
  if(!leaders.length && !payload?.player){
    const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.className='leaderboard-empty';cell.textContent='暂无排名';row.appendChild(cell);list.appendChild(row);return;
  }
  for(const row of leaders)appendRow(list,row,!!row.is_me);
  if(payload?.player){
    const divider=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.className='leaderboard-divider';cell.textContent='···';divider.appendChild(cell);list.appendChild(divider);
    appendRow(list,payload.player,true);
  }
}

function renderMessage(message) {
  const list=$('leaderboard-list');list.replaceChildren();
  const row=document.createElement('tr'),cell=document.createElement('td');cell.colSpan=4;cell.className='leaderboard-empty';cell.textContent=message;row.appendChild(cell);list.appendChild(row);
}

async function loadLeaderboard() {
  const version=++requestVersion;
  renderMessage('正在加载…');
  try {
    const query=new URLSearchParams({mode:'tower',city:state.currentCityId,scenario});
    const rows=await api(`/leaderboard?${query}`);
    if(version===requestVersion)renderRows(rows);
  } catch(error) { if(version===requestVersion)renderMessage(error.message); }
}

export function openTowerLeaderboard() {
  document.body?.classList.add('modal-open');
  const city=cityById(state.currentCityId);
  setText('leaderboard-title',`${city?.name || ''}无尽排行`);
  show('leaderboard-dialog');renderScenarioButtons();loadLeaderboard();
}

export function closeTowerLeaderboard() {
  requestVersion++;
  hide('leaderboard-dialog');
  document.body?.classList.remove('modal-open');
}
