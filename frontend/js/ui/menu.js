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
import { LEVELS, TOWER_SCENARIOS } from '../data/levels.js';
import { CITIES, cityById } from '../data/cities.js';
import { loadAmapKey, loadAmapSecurity } from '../core/storage.js';

/** 互斥的五个主面板（同一时间只该出现一个；城市选择是顶栏下拉，不在此列） */
export const PANELS = ['main-menu', 'story-menu', 'tower-menu', 'daily-menu', 'settings-panel'];

/**
 * 同步"菜单态"：只要任意一个全屏面板可见，就给 #app 打上 .menu-open，
 * 由 CSS 隐藏地图上的游戏 UI（顶栏/图例/操作条等），避免从半透明菜单透出。
 * 面板显隐的唯一出口（hideAllPanels / showPanel / 设置开关）都会调用它，
 * 因此不需要在其它地方手工维护这个状态。
 */
export function refreshMenuChrome() {
  const menuOpen = PANELS.some((id) => {
    const el = $(id);
    return el && !el.classList.contains('hidden');
  });
  const app = $('app');
  if (app) app.classList.toggle('menu-open', menuOpen);
}

/** 隐藏所有主面板（开始一局、切关卡时用） */
export function hideAllPanels() {
  for (const id of PANELS) hide(id);
  refreshMenuChrome();
}

/** 只显示指定主面板 */
export function showPanel(id) {
  hideAllPanels();
  show(id);
  refreshMenuChrome();
}

// ============ 设置面板 ============

/** 打开设置面板并回填已保存的高德 Key 与步行换乘开关 */
export function openSettingsPanel() {
  const keyInput = $('amap-key-input');
  const secInput = $('amap-sec-input');
  const walkToggle = $('walk-transfer-toggle');
  if (keyInput) keyInput.value = loadAmapKey();
  if (secInput) secInput.value = loadAmapSecurity();
  if (walkToggle) walkToggle.checked = !!state.walkTransfer;
  show('settings-panel');
  refreshMenuChrome();
}

/** 关闭设置面板（不保存） */
export function closeSettingsPanel() {
  hide('settings-panel');
  refreshMenuChrome();
}

// ============ 状态驱动的局部刷新 ============

/** 地图左上角的标题（'北京' 或 '北京 · 关卡名'） */
export function setCityLabel(text) {
  setText('city-label', text);
}

/** 玩法 HUD（故事时限 / 无尽层数、阈值与计时）显隐 */
export function setModeHudVisible(visible) {
  toggleHidden('mode-hud', !visible);
  if(!visible)toggleHidden('tower-restart-btn',true);
}

/** 游戏地图中的站点图例始终显示；菜单遮罩仍通过 CSS 暂时隐藏它。 */
export function updateLegend() {
  toggleHidden('legend', false);
}

/** 随机模式始终开放（预留的解锁位，目前恒为解锁） */
export function updateFreeButton() {
  const free = $('free-btn');
  if (!free) return;
  free.classList.remove('locked');
  // 只改文字标签，保留左下角的图标贴纸（.btn-emoji）
  const label = free.querySelector('.btn-label');
  if (label) label.textContent = '随机模式';
  else free.textContent = '随机模式';
}

/**
 * 故事关卡共享一套剧本，每关自己指定城市，与自由模式城市选择无关。
 */
export function updateStoryButton() {
  const story = $('story-btn');
  if (!story) return;
  story.classList.remove('locked');
  const label = story.querySelector('.btn-label');
  if (label) label.textContent = '故事模式';
  else story.textContent = '故事模式';
}

// ============ 城市选择下拉 ============

/**
 * 渲染顶栏城市下拉菜单（含"当前城市"标记）。
 * @param {(id:string)=>void} onPick 点击某城市时的回调（由 session.selectCity 传入）
 */
export function buildCityMenu(onPick) {
  const menu = $('city-select-menu');
  if (!menu) return;
  menu.innerHTML = '';
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'city-search';
  search.placeholder = '搜索城市或拼音';
  search.setAttribute?.('aria-label', '搜索城市');
  const list = document.createElement('div');
  list.className = 'city-list';
  menu.appendChild(search);
  menu.appendChild(list);

  const render = () => {
    const matches = sortedCities().filter((c) => cityMatches(c, search.value));
    list.replaceChildren();
    if (!matches.length) {
      const empty = document.createElement('div');
      empty.className = 'city-empty';
      empty.textContent = '没有找到该城市';
      list.appendChild(empty);
      return matches;
    }
    const cur = state.currentCityId;
    let letter = null;
    for (const c of matches) {
      const initial = cityInitial(c);
      if (initial !== letter) {
        letter = initial;
        const head = document.createElement('div');
        head.className = 'city-letter';
        head.textContent = letter;
        list.appendChild(head);
      }
      const item = document.createElement('div');
      item.className = 'city-item' + (c.id === cur ? ' current' : '');
      item.textContent = c.name;
      item.addEventListener('click', () => onPick(c.id));
      list.appendChild(item);
    }
    return matches;
  };
  render();
  search.addEventListener('input', render);
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const first = render()[0];
      if (first) onPick(first.id);
    } else if (e.key === 'Escape') {
      closeCityMenu();
    }
  });
}

/** 可选城市（排除故事模式专用的小城市），按拼音排序（相同拼音按中文名） */
function sortedCities() {
  return CITIES.filter((c) => !c.storyOnly).sort((a, b) =>
    (a.pinyin || a.id).localeCompare(b.pinyin || b.id) || a.name.localeCompare(b.name, 'zh'));
}

/** 分组用的首字母（大写） */
function cityInitial(c) {
  return (c.pinyin || c.id).charAt(0).toUpperCase();
}

/** 搜索匹配：中文名包含、全拼（忽略空格）前缀/包含、或音节首字母缩写前缀 */
function cityMatches(c, query) {
  const q = String(query || '').trim().toLowerCase().replace(/\s+/g, '');
  if (!q) return true;
  const syllables = (c.pinyin || c.id).toLowerCase().split(/\s+/);
  const full = syllables.join('');
  const initials = syllables.map((x) => x.charAt(0)).join('');
  return c.name.includes(q) || full.includes(q) || initials.startsWith(q);
}

/** 更新顶栏当前城市名（如「北京」） */
export function setCitySelectLabel(name) {
  setText('city-select-current', name);
}

/** 打开/关闭城市下拉（切换 .open 类控制三角旋转 + .hidden 控制菜单显隐） */
export function toggleCityMenu() {
  const wrap = $('city-select');
  const menu = $('city-select-menu');
  if (!wrap || !menu) return;
  const willOpen = menu.classList.contains('hidden');
  menu.classList.toggle('hidden', !willOpen);
  wrap.classList.toggle('open', willOpen);
  if (willOpen) menu.querySelector?.('.city-search')?.focus?.();
}

/** 关闭城市下拉 */
export function closeCityMenu() {
  const wrap = $('city-select');
  const menu = $('city-select-menu');
  if (wrap) wrap.classList.remove('open');
  if (menu) menu.classList.add('hidden');
}

/** 按完成状态切换按钮：规划中=上一步+取消；完成后隐藏（由结果弹窗接管） */
export function updateButtons() {
  // 爬塔时显示"从第1层重来"，其它模式隐藏
  toggleHidden('tower-restart-btn', !state.towerActive);
  // "强制步行"只在【步行换乘开启 + 规划中 + 未完成】时出现
  toggleHidden('force-walk-row', !(state.walkTransfer && state.routeStops.length > 0 && !state.finished));
  if (state.finished) {
    hide('btn-group');
  } else {
    show('btn-group');
    // 无尽“真实乘坐”：上车后不能撤回、不能重排整条路线，也不能全图显示（出发前仍可取消预览）
    const realRide = !!state.scenario?.realRide;
    toggleHidden('undo-btn', realRide);
    // 规划中恢复"显示全图站点"（手机端预览阶段 hide 过）；新手第一关不提供这个功能
    toggleHidden('show-all-btn', !!state.currentLevel?.hideShowAllStops || realRide);
    toggleHidden('reset-btn', realRide && state.routeStops.length > 0);
    setText('reset-btn', '取消');
  }
}

// ============ 故事模式关卡列表 ============

/** 故事模式暂时只显示新手教程与后续关卡占位，等待内容设计。 */
export function buildStoryLevels(onPick) {
  const list = $('story-level-list');
  if (!list) return;
  list.innerHTML = '';
  const tutorial = document.createElement('button');
  tutorial.type = 'button';
  tutorial.className = 'story-placeholder';
  tutorial.innerHTML = '<span class="story-placeholder-number">1</span><span>新手教程</span><small>自由选线 · 体验换乘</small>';
  tutorial.addEventListener('click', () => onPick(LEVELS[0]));
  list.appendChild(tutorial);
  const upcoming = document.createElement('div');
  upcoming.className = 'story-placeholder upcoming';
  upcoming.innerHTML = '<span class="story-placeholder-number">…</span><span>后续关卡</span><small>敬请期待</small>';
  list.appendChild(upcoming);

}

// ============ 爬塔菜单的纪录文案 ============

/** 各畸变按钮 id（与 index.html 对应） */
const TOWER_MENU_IDS = { normal: 'tower-normal', noMetro: 'tower-no-metro', busBoost: 'tower-bus-boost', rain: 'tower-rain', blind: 'tower-blind', realRide: 'tower-real-ride' };

/** 刷新四个畸变按钮：标题/二级说明（单一来源 levels.js）+ "最佳 第 N 层 / 进行中 第 M 层" */
export function updateTowerMenuBest() {
  for (const [key, elId] of Object.entries(TOWER_MENU_IDS)) {
    const el = $(elId);
    if (!el) continue;
    const cfg = TOWER_SCENARIOS[key];
    if (cfg) {
      const label = el.querySelector('.tower-opt-label');
      const sub = el.querySelector('.tower-opt-sub');
      if (label) label.textContent = cfg.label;
      if (sub) sub.textContent = cfg.sub || '';
    }
    const best = state.towerBest[key] || 0;
    const prog = state.towerProgress[key] || 0;
    let txt = best > 0 ? ('最佳 第 ' + best + ' 层') : '暂无纪录';
    if (prog > 0) txt += '　·　进行中 第 ' + prog + ' 层';
    const slot = el.querySelector('.tower-best');
    if (slot) slot.textContent = txt;
  }
}
