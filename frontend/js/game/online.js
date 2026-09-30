import { state } from '../core/state.js';
import { account } from '../core/account.js';
import { api } from '../core/api.js';
import { DATA_VERSION } from '../core/config.js';
import { $,hide,show,setText,setStatus,showLoading,hideLoading,showCenterToast,showError } from '../core/dom.js';
import { loadWalkTransfer } from '../core/storage.js';
import { LEVELS,TOWER_SCENARIOS } from '../data/levels.js';
import { startLevel,ensureStopsReady } from './session.js';
import { ensureGameDataReady } from './data-ready.js';
import { showResultOverlay,towerSign } from '../ui/result.js';
import { startTowerTimer,stopTowerTimer } from './tower-timer.js';
import { loadStoryProgress } from './progress.js';

const towerLimitPercent=layer=>Math.round(Math.max(0.01,1-(layer-1)*0.99/11)*100);

export function leaveOnlineRound() {
  state.onlineEpoch=(state.onlineEpoch||0)+1;
  state.onlineRound=null;
  state.walkTransfer=loadWalkTransfer();
  stopTowerTimer();
  if($('force-walk-toggle')) $('force-walk-toggle').disabled=false;
  setText('result-sync','');hide('result-retry');
}
function activateOnline(payload,command,owner,epoch,meta={}) {
    if((state.onlineEpoch||0)!==epoch || account.user?.id!==owner)return false;
    const puzzle=payload.stage.puzzle;
    if(puzzle.dataVersion!==DATA_VERSION || !state.transitDataHash || state.transitDataHash!==puzzle.dataHash) {
      throw new Error('地图版本与服务器不一致，请刷新页面后重试。');
    }
    const cloud={...payload,command,meta,owner,result:null,pending:null,submission:null,error:null,
      completedElapsedMs:Math.max(0,Number(payload.run?.total_elapsed_ms)||0)};
    state.onlineRound=cloud;
    state.walkTransfer=command.mode==='tower';
    const scenario=puzzle.options || {allowMetro:command.scenario!=='noMetro',busSpeedFactor:1,walkSpeedFactor:1};
    const story=command.mode==='story' ? LEVELS.find(level=>level.id===puzzle.storyId) : null;
    const daily=command.mode==='daily' ? {
      id:'daily',mode:'random',cityId:meta.city,
      title:`每日挑战${meta.date?' · '+meta.date:''}`,goalText:'今日题目 · 路线越快排名越高',
      origin:{name:'起点',lng:puzzle.origin[0],lat:puzzle.origin[1]},
      dest:{name:'终点',lng:puzzle.destination[0],lat:puzzle.destination[1]},
    } : null;
    const level=story || daily || {
      id:command.mode==='tower'?'tower':'random',mode:'random',
      title:command.mode==='tower'?`无尽模式 · ${TOWER_SCENARIOS[command.scenario].label}`:`随机模式 · ${TOWER_SCENARIOS[meta.scenarioKey]?.label||'普通'}`,
      hudText:command.mode==='free' ? TOWER_SCENARIOS[meta.scenarioKey]?.sub : undefined, // 情景名已在左上角标题，HUD 只显示效果
      goalText:command.mode==='tower'?`第 ${payload.stage.stageNo} 层 · 要求比最优慢 ≤ ${towerLimitPercent(payload.stage.stageNo)}%`:'规划路线',
      origin:{name:'起点',lng:puzzle.origin[0],lat:puzzle.origin[1]},
      dest:{name:'终点',lng:puzzle.destination[0],lat:puzzle.destination[1]},
    };
    state.towerLayer=payload.stage.stageNo;
    if(command.mode==='tower')state.towerScenarioKey=command.scenario;
    state.towerLastPass=false;
    // 盲棋/真实乘坐这类只影响呈现与操作的标志不在服务端题目里，按畸变 key 从前端配置补上
    const presentationKey=command.mode==='tower' ? command.scenario : command.mode==='free' ? meta.scenarioKey : null;
    const presentation=TOWER_SCENARIOS[presentationKey]?.scenario || {};
    startLevel(level,{onlineStage:true,skipStory:!story,scenario:{noMetro:!scenario.allowMetro,busSpeedFactor:scenario.busSpeedFactor,walkSpeedFactor:scenario.walkSpeedFactor,
      blindMap:!!presentation.blindMap,realRide:!!presentation.realRide}});
    if(command.mode==='tower'){
      show('mode-hud');show('mode-hud-secondary');show('tower-timer');
      setText('tower-layer-label',`第 ${state.towerLayer} 层`);setText('tower-threshold-label',`时间 ≤ 最速${towerLimitPercent(state.towerLayer)}%`);
      startTowerTimer(payload.stage.startedAt,cloud.completedElapsedMs);
    }
    if($('force-walk-toggle')) $('force-walk-toggle').disabled=!state.walkTransfer;
    setText('result-sync','');hide('result-retry');
    return true;
}
export async function startOnline(command,{restart=false,city=null,date=null,scenarioKey=null}={}) {
  if(state.onlineStarting)return;
  state.onlineStarting=true;
  const owner=account.user?.id,epoch=state.onlineEpoch||0;
  try {
    if(!owner)throw new Error('请先登录。');
    const storyLevel=command.mode==='story' ? LEVELS.find(level=>level.id===command.levelId) : null;
    // 每日挑战的题目城市由服务端决定（与玩家当前选择的城市无关），先取今日概况再加载该城市数据
    if(command.mode==='daily' && !city){const info=await api('/daily');city=info.city;date=info.date;}
    const dataCity=storyLevel?.cityId || (command.mode==='daily' ? city : null);
    if(dataCity ? !(await ensureGameDataReady(dataCity)) : !(await ensureStopsReady()))return;
    showLoading('正在加载…');
    let payload=await api('/runs',command);
    if(restart && command.mode==='tower') {
      await api(`/runs/${payload.run.id}/abandon`,{});
      payload=await api('/runs',command);
    }
    if(payload.stage.status==='passed' && command.mode==='tower') payload.stage=await api(`/runs/${payload.run.id}/next`,{});
    activateOnline(payload,command,owner,epoch,{city,date,scenarioKey});
  } catch(error) {
    setStatus(error.message);
    if(command.mode==='story')showError('故事关卡启动失败：'+error.message);
    else showCenterToast(error.message);
  }
  finally {state.onlineStarting=false;hideLoading();}
}
export function serializeRoute() {
  if(!state.routeRides.length)throw new Error('正式对局需要提交完整乘车路线。');
  return state.routeRides.map((line,index)=>{
    if(!line){
      const fromStopId=state.routeStops[index]?.physicalStopId;
      const toStopId=state.routeStops[index+1]?.physicalStopId;
      if(!fromStopId || !toStopId)throw new Error('步行换乘站点数据不完整，请重新规划。');
      return {type:'walk',fromStopId,toStopId};
    }
    const fromStopId=state.routeStops[index]?.logical.stopByLine?.[String(line.id)];
    const toStopId=state.routeStops[index+1]?.logical.stopByLine?.[String(line.id)];
    if(!fromStopId || !toStopId)throw new Error('路线站点数据不完整，请刷新后重试。');
    return {type:'ride',lineId:String(line.id),fromStopId,toStopId};
  });
}
export async function submitOnlineResult() {
  const cloud=state.onlineRound;
  if(!cloud || cloud.owner!==account.user?.id)return;
  if(cloud.result){renderResult(cloud);return;}
  if(cloud.pending)return cloud.pending;
  cloud.error=null;
  showResultOverlay({title:'正在验证…',message:'',detail:'',showNext:false,showExit:false});
  hide('result-restart');hide('result-retry');setText('result-sync','');
  cloud.pending=(async()=>{
    try {
      cloud.submission ??= {stageId:cloud.stage.id,requestId:crypto.randomUUID(),route:serializeRoute()};
      cloud.result=await api(`/runs/${cloud.run.id}/submit`,cloud.submission);
      if(state.onlineRound!==cloud)return;
      if(cloud.command.mode==='tower') {
        state.towerLastPass=cloud.result.passed;
        const key=cloud.command.scenario;
        state.towerProgress[key]=cloud.result.passed?cloud.stage.stageNo+1:0;
        if(cloud.result.passed)state.towerBest[key]=Math.max(state.towerBest[key],cloud.stage.stageNo);
        if(cloud.result.passed)cloud.run.total_elapsed_ms=Number(cloud.result.total_elapsed_ms);
      }
      renderResult(cloud);
    }catch(error){
      cloud.error=error;
      if(state.onlineRound!==cloud)return;
      showResultOverlay({title:'记录尚未确认保存',message:error.message,detail:'请保留当前页面并重试保存；返回菜单会丢弃尚未提交的路线。',showNext:false});
      hide('result-restart');show('result-retry');setText('result-sync','未保存 / 等待确认');
    }finally{cloud.pending=null;}
  })();
  return cloud.pending;
}
function renderResult(cloud) {
  if(state.onlineRound!==cloud)return;
  const result=cloud.result,tower=cloud.command.mode==='tower';
  if(cloud.command.mode==='daily'){renderDailyResult(cloud);return;}
  if(tower)stopTowerTimer(Number(result.elapsed_ms),Number(result.total_elapsed_ms));
  if (cloud.command.mode === 'story' && result.passed) void loadStoryProgress();
  showResultOverlay({
    title:result.passed?(tower?`第 ${cloud.stage.stageNo} 层通过！`:'完成！'):'本次未通过',
    message:tower && result.passed?`下一层要求 ≤ ${towerLimitPercent(cloud.stage.stageNo+1)}%`:'',
    detail:`路线 ${(Number(result.duration_ms)/60000).toFixed(1)} 分钟 · 最优 ${(Number(result.optimal_duration_ms)/60000).toFixed(1)} 分钟 · 本局用时 ${(Number(result.elapsed_ms)/1000).toFixed(1)} 秒`,
    restartLabel:tower && result.passed?'下一层':'重新开始',showNext:false,showExit:tower&&result.passed,
    sign:tower?towerSign(result.passed,cloud.stage.stageNo):{outcome:result.passed?'pass':'fail'},
  });
  show('result-restart');hide('result-retry');setText('result-sync','');
}
/** 每日挑战结算：本次用时 + 今日最好与名次（名次取自当日排行，异步补上） */
function renderDailyResult(cloud) {
  const result=cloud.result;
  const minutes=value=>(Number(value)/60000).toFixed(1);
  showResultOverlay({
    title:'完成！',
    message:'正在获取今日排名…',
    detail:`公共交通用时 ${minutes(result.duration_ms)} 分钟`,
    restartLabel:'再试一次',showNext:false,showExit:false,viewMapLabel:'查看地图',sign:{outcome:'done'},
  });
  show('result-restart');hide('result-retry');setText('result-sync','');
  const date=cloud.meta?.date;
  if(!date){setText('result-message','每天可以多次尝试，排行按当日最好成绩计算。');return;}
  api(`/leaderboard?${new URLSearchParams({mode:'daily',date})}`).then(board=>{
    if(state.onlineRound!==cloud)return;
    const mine=board?.player || (board?.leaders||[]).find(row=>row.is_me);
    setText('result-message',mine
      ?`今日最好 ${minutes(mine.duration_ms)} 分钟 · 当前第 ${mine.rank} 名。`
      :'每天可以多次尝试，排行按当日最好成绩计算。');
  }).catch(()=>{ if(state.onlineRound===cloud)setText('result-message','每天可以多次尝试，排行按当日最好成绩计算。'); });
}

export async function restartOnline() {
  const cloud=state.onlineRound;
  if(!cloud || cloud.pending)return;
  if(cloud.command.mode==='tower' && cloud.result?.passed){
    if(state.onlineStarting)return;
    state.onlineStarting=true;
    const epoch=state.onlineEpoch||0;
    try{
      const stage=await api(`/runs/${cloud.run.id}/next`,{});
      activateOnline({run:cloud.run,stage},cloud.command,cloud.owner,epoch,cloud.meta);
    }catch(error){setStatus(error.message);showCenterToast(error.message);}
    finally{state.onlineStarting=false;}
    return;
  }
  return startOnline(cloud.command,{city:cloud.meta?.city,date:cloud.meta?.date,scenarioKey:cloud.meta?.scenarioKey});
}
