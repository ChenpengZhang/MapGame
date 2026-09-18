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

import { state } from '../core/state.js';
import { setStatus } from '../core/dom.js';
import { haversineKm } from '../core/router-api.js';
import { TUTORIAL_COMMON } from '../data/levels.js';
import { drawEndpoints, setMapLocked } from '../map/map-init.js';
import { applyScenario } from '../map/stop-layer.js';
import { hideAllPanels, showPanel, setCityLabel, setTowerHudVisible, updateFreeButton, buildStoryLevels, updateTowerMenuBest } from '../ui/menu.js';
import { playStory, playHint, hideStoryAndTutorial } from '../ui/story.js';
import { clearResult } from '../ui/result.js';
import { resetRoute, finishRoute } from './route.js';
import { saveTowerState } from './progress.js';

// ============ 地图交互锁（剧情/教学期间禁止拖拽缩放） ============
// 锁定实现放在 map/map-init.js（它同时管滚轮缩放），这里只负责在合适的时机调用。

/** 把操作权交给玩家（剧情/教学结束后调用） */
export function beginGameplay(level) {
  setMapLocked(false);
  setStatus((level && level.goalText) || '点击站点开始规划');
}

// ============ 启动一局 ============

/**
 * 开始一关（故事关卡 / 自由模式随机关 / 爬塔某一层都走这里）。
 * @param {object} level 关卡对象（见 data/levels.js；自由与爬塔的关卡对象在运行时生成）
 * @param {{skipStory?: boolean, scenario?: object}} [opts]
 *        skipStory 跳过剧情直接开玩；scenario 覆盖关卡自带情景（自由模式勾选的情景走这里）
 */
export function startLevel(level, opts) {
  opts = opts || {};
  state.currentLevel = level;
  state.gameMode = level.mode || 'standard'; // 固定关卡=standard；随机=random
  state.ORIGIN = [level.origin.lng, level.origin.lat];
  state.DEST = [level.dest.lng, level.dest.lat];
  state.ORIGIN_NAME = level.origin.name;
  state.DEST_NAME = level.dest.name;
  // 应用情景：优先 opts.scenario（自由模式勾选），其次 level.scenario（关卡自带），否则默认
  state.scenario = Object.assign({ noMetro: false, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 }, level.scenario, opts.scenario);

  state.towerActive = (level.id === 'tower');
  if (!state.towerActive) setTowerHudVisible(false);

  setCityLabel('北京 · ' + level.title);
  hideAllPanels();
  hideStoryAndTutorial();
  resetRoute();
  applyScenario();
  // 终点图钉被点击 = 完成规划；回调由玩法层提供（地图层不 import game）
  drawEndpoints({ onDestClick: finishRoute });

  if (opts.skipStory || !level.story || !level.story.length) {
    beginGameplay(level);
  } else {
    playStory(level, () => {
      // 第一关：完整教学；情景关卡：弹出情景提示；其余：直接进入玩法
      if (level.series === 1) playHint([level.goalText || ''].concat(TUTORIAL_COMMON), () => beginGameplay(level));
      else if (level.scenarioHint) playHint([level.scenarioHint], () => beginGameplay(level));
      else beginGameplay(level);
    });
  }
}

// ============ 菜单导航 ============

/** 回主菜单：退出当前会话（爬塔中途退出会保存进度） */
export function showMenu() {
  resetRoute();
  hideStoryAndTutorial();
  setMapLocked(false);
  // 爬塔中途退出：保存当前层与最佳纪录
  if (state.towerActive) {
    if (state.towerLayer > state.towerBest[state.towerScenarioKey]) state.towerBest[state.towerScenarioKey] = state.towerLayer;
    state.towerProgress[state.towerScenarioKey] = state.towerLayer;
    saveTowerState();
  }
  state.towerActive = false;
  setTowerHudVisible(false);
  setCityLabel('北京');
  setStatus('选择游戏模式');
  showPanel('main-menu');
  clearResult();
  updateFreeButton(); // 自由模式始终开放
}

/** 打开故事模式关卡列表 */
export function openStoryMenu() {
  buildStoryLevels(startLevel); // 卡片点击 → 直接开始该关
  showPanel('story-menu');
  setStatus('选择关卡');
}

/** 打开无尽模式（爬塔）菜单 */
export function openTowerMenu() {
  updateTowerMenuBest();
  showPanel('tower-menu');
  setStatus('选择畸变开始爬塔');
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
  if (!state.physStops.length) return [116.4, 39.9];
  const stop = state.physStops[Math.floor(Math.random() * state.physStops.length)];
  const angle = Math.random() * 2 * Math.PI;
  const dist = RANDOM_OFFSET_MIN_M + Math.random() * (RANDOM_OFFSET_MAX_M - RANDOM_OFFSET_MIN_M);
  const dLat = (dist * Math.cos(angle)) / 111000; // 1° 纬度 ≈ 111km
  const dLng = (dist * Math.sin(angle)) / 85000;  // 1° 经度 ≈ 85km（北京纬度）
  return [stop.lng + dLng, stop.lat + dLat];
}

/**
 * 等数据加载完再继续（最多等 15 秒）。
 * 数据没加载完就抽随机点会拿到空数据 → 两点重合；
 * 早期版本因此出现过"必须点两次才能开始"的 bug，这里保留这道防线。
 * @returns {Promise<boolean>} 数据是否就绪
 */
export async function ensureStopsReady() {
  if (state.physStops.length) return true;
  setStatus('数据加载中，请稍候…');
  for (let i = 0; i < 75 && !state.physStops.length; i++) {
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!state.physStops.length) { setStatus('数据加载失败，请刷新重试'); return false; }
  return true;
}

/**
 * 抽一对随机起终点（迭代重抽并带次数上限，保证两点拉开距离、且不会栈溢出）。
 * @returns {[number,number][]} [起点, 终点]
 */
export function sampleRandomEndpoints() {
  let o = randomPoint();
  let d = randomPoint();
  for (let i = 0; i < 50 && haversineKm(o, d) < 3; i++) d = randomPoint();
  return [o, d];
}
