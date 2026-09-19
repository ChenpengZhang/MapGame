/**
 * map/map-init.js —— 地图实例、缩放惯性、起终点图钉
 *
 * 【职责】
 *   1) 创建高德/Leaflet（兼容层）地图实例并保存到 state.map；
 *   2) 接管滚轮缩放，实现"带惯性的平滑缩放"（高德默认缩放太生硬）；
 *   3) 画起终点图钉，并适配视野到起终点范围。
 *
 * 【注意：本模块不 import 任何 game/ 代码】
 *   终点图钉被点击时要"完成规划"，但那是玩法逻辑。
 *   所以 drawEndpoints 接收一个回调参数，由 game 层传进来（见 game/session.js），
 *   地图层因此不需要知道"完成规划"这件事的存在。
 */

import { state } from '../core/state.js';
import { setStatus, $ } from '../core/dom.js';
import { cityById } from '../data/cities.js';
import { loadWalkCache } from './walk.js';

/** 创建地图并做首屏准备（交通数据懒加载，由 game/data-ready.js 在进入游戏时触发） */
export function initMap() {
  const city = cityById(state.currentCityId) || cityById('beijing');
  state.map = new AMap.Map('map', { center: city.center, zoom: 11, viewMode: '2D', scrollWheel: false });
  setupZoomInertia();
  loadWalkCache();
  setStatus('选择关卡开始游戏');
}

// ============ 缩放惯性 ============

let zoomSpeed = 0.5; // 设置里的"缩放速度"滑块（0-1，默认 0.5）

/** 设置面板的"缩放速度"滑块调用它（0~1） */
export function setZoomSpeed(v) {
  zoomSpeed = v;
}

/**
 * 锁定/解锁地图操作（剧情播放期间锁定）。
 * storyActive 只放在这里改：它同时影响站点点击（map/hover.js、game/route.js）
 * 与滚轮缩放（本文件 setupZoomInertia），是"剧情中禁止交互"的唯一开关。
 */
export function setMapLocked(locked) {
  state.mapLocked = locked;
  state.storyActive = locked;
  if (state.map) {
    try { state.map.setStatus({ dragEnable: !locked, zoomEnable: !locked, doubleClickZoom: !locked }); } catch (e) { /* 忽略 */ }
  }
}

/**
 * 缩放惯性：接管滚轮，用"速度 + 指数衰减"实现带惯性的平滑缩放。
 * 关键取舍（原注释保留）：每帧 33ms（约 30fps）而不是 60fps——
 * 海量站点下少一半重绘，缩放明显更顺。
 */
function setupZoomInertia() {
  const el = document.getElementById('map');
  if (!el || !state.map) return;
  let velocity = 0;        // 缩放速度（zoom/步）
  let running = false;
  let lastStep = 0;
  const STEP_MS = 33;      // 约 30fps：比 60fps 少一半重绘，海量点缩放不卡
  const DECAY = 0.80;      // 每步衰减系数（惯性，越小惯性越弱）
  const EPS = 0.0004;      // 停止阈值
  const SPEED_SCALE = 1.3; // 缩放速度整体调快 30%
  function gain() { return (0.004 + zoomSpeed * 0.096) * SPEED_SCALE; } // 单格速度增量：0→慢，1→快
  function maxV() { return (0.03 + zoomSpeed * 0.11) * SPEED_SCALE; }   // 连续滚动速度上限

  function applyZoom(z) {
    z = Math.min(19, Math.max(3, z));
    try { state.map.setZoomAndCenter(z, state.map.getCenter(), true); }
    catch (e) { state.map.setZoom(z); }
  }
  function tick(now) {
    if (Math.abs(velocity) < EPS) { running = false; return; }
    if (now - lastStep < STEP_MS) { requestAnimationFrame(tick); return; }
    lastStep = now;
    applyZoom(state.map.getZoom() + velocity);
    velocity *= DECAY;
    if (Math.abs(velocity) < EPS) { running = false; return; }
    requestAnimationFrame(tick);
  }
  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) return;   // 保留 Ctrl/⌘+滚轮给浏览器
    if (state.storyActive) return;        // 剧情/教学期间禁止缩放
    e.preventDefault();
    e.stopPropagation();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 33;                              // 行模式
    else if (e.deltaMode === 2) d *= (window.innerHeight || 800); // 页模式
    const dir = d > 0 ? -1 : 1;                                   // 向下滚=缩小
    const inc = gain() * Math.min(1.5, Math.abs(d) / 100);        // 连续滚动累积加速
    velocity += dir * inc;
    const cap = maxV();
    velocity = Math.max(-cap, Math.min(cap, velocity));
    if (!running) { running = true; requestAnimationFrame(tick); }
  }
  el.addEventListener('wheel', onWheel, { passive: false });
}

// ============ 起终点图钉 ============

/**
 * 重画起终点图钉并适配视野。
 * @param {{onDestClick?: Function}} [handlers] 终点（"终"）被点击时的回调：
 *        玩法层用它来触发"完成规划"，地图层不关心具体做什么。
 */
export function drawEndpoints(handlers) {
  const onDestClick = (handlers && handlers.onDestClick) || null;
  for (const m of state.endpointMarkers) m.setMap(null);
  state.endpointMarkers = [];
  if (!state.ORIGIN || !state.DEST) return;

  const o = new AMap.Marker({
    position: state.ORIGIN, content: '<div class="pin origin flash">起</div>',
    offset: new AMap.Pixel(-12, -12), zIndex: 400,
  });
  o.setMap(state.map);
  state.endpointMarkers.push(o);

  const d = new AMap.Marker({
    position: state.DEST, content: '<div class="pin dest flash">终</div>',
    offset: new AMap.Pixel(-12, -12), zIndex: 400,
  });
  d.setMap(state.map);
  state.endpointMarkers.push(d);
  if (onDestClick) d.on('click', () => onDestClick());

  // 视野适配起终点
  const sw = [Math.min(state.ORIGIN[0], state.DEST[0]), Math.min(state.ORIGIN[1], state.DEST[1])];
  const ne = [Math.max(state.ORIGIN[0], state.DEST[0]), Math.max(state.ORIGIN[1], state.DEST[1])];
  state.map.setBounds(new AMap.Bounds(sw, ne), false, [60, 60, 60, 60]);
}

/**
 * 判断当前是否运行在免 Key 的 Leaflet 兼容后端上。
 * 【当前未被调用】——amap-polyfill.js 内部已有同样判断，
 * 保留此函数仅为调试时在控制台手动确认后端类型。
 */
export function isLeafletBackend() {
  return !!(window.AMap && AMap.__backend === 'leaflet');
}

/** 供调试/测试使用：直接取地图容器 DOM（原代码里散落着同样的表达式） */
export function mapContainer() {
  return (state.map && state.map.getContainer) ? state.map.getContainer() : $('map');
}
