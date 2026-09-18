/**
 * ui/menu.js —— 菜单 / 设置面板 / 图例 / 底部按钮（哑渲染层）
 *
 * 【分两部分】
 *   1) 面板显隐原语：hideAllPanels / showPanel —— 所有"切菜单"都走这几个函数，
 *      避免像重构前那样在 6 个地方各写 4 行 classList 操作（漏一个就会两个菜单叠在一起）。
 *   2) 状态驱动的局部刷新：图例、底部按钮、城市标题、爬塔 HUD、自由模式按钮。
 *      这些只读 core/state.js，不调用 game 逻辑，所以 game 层可以放心调用它们。
 *
 * 【面板与"界面上还有弹窗"的区别】
 *   结果弹窗（#result-overlay）不在这里，它在 ui/result.js；
 *   剧情对话框/教学泡泡在 ui/story.js。
 */

import { state } from '../core/state.js';
import { $, hide, show, setText, toggleHidden } from '../core/dom.js';
import { LEVELS } from '../data/levels.js';
import { loadAmapKey, loadAmapSecurity } from '../core/storage.js';

/** 互斥的五个主面板（同一时间只该出现一个） */
export const PANELS = ['main-menu', 'story-menu', 'tower-menu', 'free-menu', 'settings-panel'];

/** 隐藏所有主面板（开始一局、切关卡时用） */
export function hideAllPanels() {
  for (const id of PANELS) hide(id);
}

/** 只显示指定主面板 */
export function showPanel(id) {
  hideAllPanels();
  show(id);
}

// ============ 设置面板 ============

/** 打开设置面板并回填已保存的高德 Key */
export function openSettingsPanel() {
  const keyInput = $('amap-key-input');
  const secInput = $('amap-sec-input');
  if (keyInput) keyInput.value = loadAmapKey();
  if (secInput) secInput.value = loadAmapSecurity();
  show('settings-panel');
}

/** 关闭设置面板（不保存） */
export function closeSettingsPanel() {
  hide('settings-panel');
}

// ============ 状态驱动的局部刷新 ============

/** 地图左上角的标题（'北京' 或 '北京 · 关卡名'） */
export function setCityLabel(text) {
  setText('city-label', text);
}

/** 爬塔 HUD（层数/阈值）显隐 */
export function setTowerHudVisible(visible) {
  toggleHidden('tower-hud', !visible);
}

/** 图例只在"浏览/选起始站"的初始阶段显示；开始规划后隐藏 */
export function updateLegend() {
  toggleHidden('legend', state.routeStops.length > 0);
}

/** 自由模式始终开放（预留的解锁位，目前恒为解锁） */
export function updateFreeButton() {
  const free = $('free-btn');
  if (!free) return;
  free.classList.remove('locked');
  free.textContent = '🆓 自由模式';
}

/** 按完成状态切换按钮：规划中=上一步+取消；完成后隐藏（由结果弹窗接管） */
export function updateButtons() {
  // 爬塔时显示"从第1层重来"，其它模式隐藏
  toggleHidden('tower-restart-btn', !state.towerActive);
  if (state.finished) {
    hide('btn-group');
  } else {
    show('btn-group');
    show('undo-btn');
    setText('reset-btn', '取消');
  }
}

// ============ 故事模式关卡列表 ============

/**
 * 渲染关卡卡片（锁住的显示 🔒）。
 * @param {(level:object)=>void} onPick 点击已解锁关卡时的回调（由 game/session.js 传入 startLevel）
 */
export function buildStoryLevels(onPick) {
  const list = $('story-level-list');
  if (!list) return;
  list.innerHTML = '';
  LEVELS.forEach((lv, i) => {
    const unlocked = i < state.storyUnlocked;
    const card = document.createElement('div');
    card.className = 'story-level' + (unlocked ? ' unlocked' : ' locked');
    card.innerHTML =
      '<div class="slv-num">' + (unlocked ? String(lv.series) : '🔒') + '</div>' +
      '<div class="slv-title">' + lv.title + '</div>';
    if (unlocked) card.addEventListener('click', () => onPick(lv));
    list.appendChild(card);
  });
}

// ============ 爬塔菜单的纪录文案 ============

/** 各畸变按钮 id（与 index.html 对应） */
const TOWER_MENU_IDS = { normal: 'tower-normal', noMetro: 'tower-no-metro', busBoost: 'tower-bus-boost', rain: 'tower-rain' };

/** 刷新四个畸变按钮上的"最佳 第 N 层 / 进行中 第 M 层" */
export function updateTowerMenuBest() {
  for (const [key, elId] of Object.entries(TOWER_MENU_IDS)) {
    const el = $(elId);
    if (!el) continue;
    const best = state.towerBest[key] || 0;
    const prog = state.towerProgress[key] || 0;
    let txt = best > 0 ? ('最佳 第 ' + best + ' 层') : '暂无纪录';
    if (prog > 0) txt += '　·　进行中 第 ' + prog + ' 层';
    const slot = el.querySelector('.tower-best');
    if (slot) slot.textContent = txt;
  }
}
