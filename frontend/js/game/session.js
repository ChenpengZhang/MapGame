/**
 * game/session.js —— 关卡会话：启动一局、应用情景、菜单导航、随机起终点
 *
 * 【它负责什么】
 *   把"要玩哪一关/哪种模式"变成一局可以开始玩的状态：
 *     设置起终点与情景 → 隐藏所有菜单 → 清空上一局路线 → 重画地铁底图与图钉
 *     → 放剧情/教学（如果有）→ 交还操作权（beginGameplay）。
 *   菜单之间的跳转（主菜单/故事/爬塔/自由/设置）也在这里，因为"切菜单"本质上就是
 *   "退出当前会话"，需要顺手做存档与清理。
 *
 * 【依赖方向】
 *   本模块在 game 层的顶端，可以 import ui/ 与 map/（game → ui/map 是允许的方向）；
 *   ui/ 与 map/ 不允许反过来 import 本模块——那会形成循环依赖。
 */

import { account } from '../core/account.js';
import { startOnline,leaveOnlineRound } from './online.js';
import { state } from '../core/state.js';
import { setStatus, toggleHidden,showCenterToast,setText,hide } from '../core/dom.js';
import { haversineKm } from '../core/router-api.js';
import { saveCityId } from '../core/storage.js';
import { cityById } from '../data/cities.js';
import { ensureGameDataReady, isGameDataReady } from './data-ready.js';
import { drawEndpoints, clearEndpoints, setMapLocked, setBlindMap } from '../map/map-init.js';
import { setDestIndicatorActive } from '../map/dest-indicator.js';
import { showTripCard, hideTripCard } from '../ui/trip-card.js';
import { showMapTutorial, clearMapTutorial, completeMapPractice } from '../map/tutorial-layer.js';
import { applyScenario, refreshVisibleStops, updateStopsByZoom, setTutorialBusStopsHidden } from '../map/stop-layer.js';
import { hideAllPanels, showPanel, setCityLabel, setModeHudVisible, updateFreeButton, updateStoryButton, buildStoryLevels, updateTowerMenuBest, buildCityMenu, setCitySelectLabel, toggleCityMenu } from '../ui/menu.js';
import { playStory, hideStory } from '../ui/story.js';
import { clearResult } from '../ui/result.js';
import { resetRoute, finishRoute } from './route.js';
import { saveTowerState } from './progress.js';
import { stopTowerTimer } from './tower-timer.js';
import { closeCustomEditor } from './custom-editor.js';
import { crossesRiver } from '../core/rivers.js';
import { startTrace, abandonTrace } from './trace.js';

// ============ 地图交互锁（剧情/教学期间禁止拖拽缩放） ============
// 锁定实现放在 map/map-init.js（它同时管滚轮缩放），这里只负责在合适的时机调用。

/** 把操作权交给玩家（剧情/教学结束后调用） */
export function beginGameplay(level) {
  setMapLocked(false);
  showMapTutorial(level.mapTutorial);
  startTrace(level); // 规划过程记录（玩家行为分析）；上一局没结束会先按“放弃”上报
}

// ============ 启动一局 ============

/**
 * 开始一关（故事关卡 / 自由模式随机关 / 爬塔某一层都走这里）。
 * @param {object} level 关卡对象（见 data/levels.js；自由与爬塔的关卡对象在运行时生成）
 * @param {{skipStory?: boolean, scenario?: object}} [opts]
 *        skipStory 跳过剧情直接开玩；scenario 覆盖关卡自带情景（自由模式勾选的情景走这里）
 */
export function startLevel(level, opts) {
  hide('error');
  const cityId = level.cityId || state.currentCityId;
  // 数据懒加载：首次点开始时数据可能还没下载。
  // 若未就绪 → 触发按需加载，加载完再真正开始本关（递归调用一次）。
  if (!isGameDataReady(cityId)) {
    setStatus('正在下载城市交通数据…');
    ensureGameDataReady(cityId).then((ready) => { if (ready) startLevel(level, opts); });
    return;
  }
  opts = opts || {};
  if(account.user && !opts.onlineStage && level.id !== 'tower' && level.id !== 'random' && level.id !== 'custom') {
    return startOnline({mode:'story',levelId:level.id});
  }
  if(!opts.onlineStage) leaveOnlineRound();
  state.currentLevel = level;
  state.answerView = !!level.answerView; // 每日挑战答案：只看不玩（见 game/daily-answer.js）
  state.gameMode = level.mode || 'standard'; // 固定关卡=standard；随机=random
  state.ORIGIN = [level.origin.lng, level.origin.lat];
  state.DEST = [level.dest.lng, level.dest.lat];
  state.ORIGIN_NAME = level.origin.name;
  state.DEST_NAME = level.dest.name;
  // 应用情景：优先 opts.scenario（自由模式勾选），其次 level.scenario（关卡自带），否则默认
  state.scenario = Object.assign({ noMetro: false, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 }, level.scenario, opts.scenario);

  state.towerActive = (level.id === 'tower');
  if (!state.towerActive) {
    const hasLimit=Number.isFinite(Number(level.timeLimitMin));
    // 顶部 HUD：限时关显示时限；随机模式显示本局抽到的情景（level.hudText）
    setModeHudVisible(hasLimit || !!level.hudText);
    toggleHidden('mode-hud-secondary',true);
    toggleHidden('tower-timer',true);
    if(hasLimit)setText('tower-layer-label','时间 ' + (level.goalText || `≤ ${Number(level.timeLimitMin)} 分钟`));
    else if(level.hudText)setText('tower-layer-label',level.hudText);
  }

  setCityLabel((cityById(cityId) || cityById('beijing')).name + ' · ' + level.title);
  hideAllPanels();
  hideStory();
  clearMapTutorial();
  setTutorialBusStopsHidden(!!level.mapTutorial?.mapPractice);
  resetRoute();
  applyScenario();
  // 终点图钉被点击 = 完成规划；回调由玩法层提供（地图层不 import game）
  // 新手教程点“起”聚焦得更近（约 1km），保证缩放后能看到公交站
  drawEndpoints({ onOriginFocus: completeMapPractice, originFocusM: level.mapTutorial?.mapPractice ? 1000 : undefined, onDestClick: () => finishRoute({ silentOutOfRange: true }), showWalkRanges: level.showWalkRanges !== false });
  void setBlindMap(!!state.scenario.blindMap, cityId); // 无尽“盲棋”：隐藏底图，只画城市轮廓
  showTripCard({ originName: state.ORIGIN_NAME, destName: state.DEST_NAME, km: haversineKm(state.ORIGIN, state.DEST) });
  setDestIndicatorActive(true);
  // 新一局的起点改变后立即按新范围重算基础站点颜色。
  refreshVisibleStops();

  if (opts.skipStory || !level.story || !level.story.length) {
    beginGameplay(level);
  } else {
    playStory(level, () => beginGameplay(level));
  }
}

// ============ 菜单导航 ============

/** 回主菜单：退出当前会话（爬塔中途退出会保存进度） */
export function showMenu() {
  // 盲棋中途退出时保持无底图：无尽的起终点会保留、可以续玩，
  // 若回主页就露出底图，玩家能先看清周围再回来继续。路线已完成（底图已揭晓）则照常恢复。
  const keepBlind = !!state.scenario?.blindMap && !state.finished;
  const wasOnline=!!state.onlineRound;
  abandonTrace(); // 规划到一半回主页：按“放弃”上报当时的过程
  leaveOnlineRound();
  if (state.editorActive) closeCustomEditor(); // 编辑中点了回主页：直接关闭编辑器（未保存的修改丢弃）
  state.answerView = false;
  state.customPlay = null; // 自定义关卡组：离开即结束本次游玩（登录玩家的进行中对局保留在服务端，可继续）
  // 先记下爬塔状态：resetRoute 会清掉 finished，必须在它之前取
  const tower = state.towerActive
    ? { key: state.towerScenarioKey, layer: state.towerLayer, finished: state.finished }
    : null;
  resetRoute();
  // 上一局的起终点：图钉、步行范围圈和坐标一起清掉。否则菜单后面（自定义模式的编辑器会露出地图）
  // 仍能看到旧的起终点，旧起点周围的站也还会被标成红色“步行可达”。
  clearEndpoints();
  state.ORIGIN = null;
  state.DEST = null;
  updateStopsByZoom();
  hideStory();
  clearMapTutorial();
  setMapLocked(false);
  if (!keepBlind) void setBlindMap(false);
  // 爬塔退出：保存最佳纪录；进度只在"未完成的中途退出"时记为当前层。
  // 已完成（通过→已推进到下一层 / 失败→已清空）时，进度已由 showTowerResult 正确更新，这里不再覆盖。
  if (tower && !wasOnline && !account.user) {
    if (tower.layer > state.towerBest[tower.key]) state.towerBest[tower.key] = tower.layer;
    if (!tower.finished) {
      state.towerProgress[tower.key] = tower.layer;
    }
    saveTowerState();
  }
  state.towerActive = false;
  stopTowerTimer();
  setModeHudVisible(false);
  hideTripCard();
  setDestIndicatorActive(false);
  const cityName = (cityById(state.currentCityId) || cityById('beijing')).name;
  setCityLabel(cityName);
  setCitySelectLabel(cityName);
  showPanel('main-menu');
  clearResult();
  updateFreeButton();  // 自由模式始终开放
  updateStoryButton(); // 各城市入口指向同一套故事关卡
}

/** Home 只负责离开；无尽模式未结束的本层按原始开始时间继续计时。 */
export function returnHome() {
  const runningTower=state.towerActive && !state.finished;
  showMenu();
  if(runningTower)showCenterToast('返回主页计时不会暂停');
}

/**
 * 切换城市：保存选择并刷新页面。
 * 切换 = 整页重载（和换高德 Key 一样）：所有状态（数据索引/寻路图/图层/关卡进度）
 * 天然清空，数据按新城市重新懒加载，最不容易出状态残留的 bug。
 */
export function selectCity(id) {
  if (!cityById(id)) return;
  saveCityId(id);
  location.reload();
}

/** 打开/关闭顶栏城市下拉（点击展开小三角时触发） */
export function openCityMenu() {
  buildCityMenu(selectCity);
  toggleCityMenu();
}

/** 打开共享故事关卡列表，关卡会自动加载自己的城市。 */
export function openStoryMenu() {
  buildStoryLevels(startLevel); // 卡片点击 → 直接开始该关
  showPanel('story-menu');
}

/** 打开无尽模式（爬塔）菜单 */
export function openTowerMenu() {
  updateTowerMenuBest();
  toggleHidden('tower-guest-notice', !!account.user);
  showPanel('tower-menu');
}

// ============ 随机起终点（自由模式 / 爬塔共用） ============

/** 随机偏移范围：离采样站点的距离（米） */
const RANDOM_OFFSET_MIN_M = 300;
const RANDOM_OFFSET_MAX_M = 1500; // 上限 1.5km，保证起终点步行不超过 1.5km

/**
 * 随机点：采样一个真实站点 + 随机偏移。
 * 按站点密度加权：城区站点密集→城区概率高；偏远郊区站点稀疏→很少出现；
 * 且点永不远离站点（步行可控）。
 */
export function randomPoint() {
  return randomPointWithComp().point;
}

/** 抽一个随机点，同时返回它所在的连通分量（供 sampleRandomEndpoints 校验主分量） */
function randomPointWithComp() {
  const city = cityById(state.currentCityId) || cityById('beijing');
  if (!state.physStops.length) return { point: city.center.slice(), comp: null };
  const stop = state.physStops[Math.floor(Math.random() * state.physStops.length)];
  const comp = state.componentOf.get(stop.logicalId) ?? null;
  const mPerDegLng = 111320 * Math.cos(stop.lat * Math.PI / 180); // 经度每度米数，随纬度变化
  // 偏移后的点不能落在江对岸（否则采样它的那个站反而走不到）；多试几次，都不行就用站点本身
  for (let attempt = 0; attempt < 8; attempt++) {
    const angle = Math.random() * 2 * Math.PI;
    const dist = RANDOM_OFFSET_MIN_M + Math.random() * (RANDOM_OFFSET_MAX_M - RANDOM_OFFSET_MIN_M);
    const dLat = (dist * Math.cos(angle)) / 111000; // 1° 纬度 ≈ 111km
    const dLng = (dist * Math.sin(angle)) / mPerDegLng;
    const point = [stop.lng + dLng, stop.lat + dLat];
    if (!crossesRiver([stop.lng, stop.lat], point)) return { point, comp };
  }
  return { point: [stop.lng, stop.lat], comp };
}

/**
 * 确保交通数据已就绪（自由模式/爬塔在抽随机点前调用）。
 * 数据没加载完就抽随机点会拿到空数据 → 两点重合；
 * 早期版本因此出现过"必须点两次才能开始"的 bug，这里保留这道防线。
 * 现在是主动触发懒加载（幂等），而不是被动轮询等 bootstrap 加载。
 * @returns {Promise<boolean>} 数据是否就绪
 */
export async function ensureStopsReady() {
  if (isGameDataReady(state.currentCityId)) return true;
  setStatus('数据加载中，请稍候…');
  const ready = await ensureGameDataReady();
  if (!ready) { setStatus('数据加载失败，请刷新重试'); return false; }
  return true;
}

/**
 * 抽一对随机起终点（迭代重抽并带次数上限，保证两点拉开距离、且不会栈溢出）。
 * 起终点必须落在「主连通分量」上：否则会抽到轮渡/离岛这类孤岛点，导致无解。
 * @returns {[number,number][]} [起点, 终点]
 */
export function sampleRandomEndpoints() {
  const main = state.mainComponent;
  for (let attempt = 0; attempt < 200; attempt++) {
    const o = randomPointWithComp();
    const d = randomPointWithComp();
    // 有连通分量信息时，起终点必须在主分量上；没有（数据未就绪）则跳过校验
    if (main && (o.comp !== main || d.comp !== main)) continue;
    if (haversineKm(o.point, d.point) < 3) continue;
    return [o.point, d.point];
  }
  // 兜底：极端情况抽不到（几乎不可能），退回任意两点
  return [randomPoint(), randomPoint()];
}
