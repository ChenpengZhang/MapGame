/**
 * map/stop-layer.js —— 站点图层（基础站点渲染与显隐）
 *
 * 【这一层解决的问题：性能】
 *   北京数据有约 2.8 万个物理站点。如果一次性把所有点都画出来，
 *   低缩放级别下平移/缩放会掉帧。所以基础站点层按"视野渲染"：
 *     - 图层初始为空数据，只在需要显示时按当前视野填充（外扩 35% 边距防抖动）；
 *     - 公交点超过 MAX_BUS_RENDER(8000) 时做空间抽稀（网格逐级放大，每格留一个代表点）；
 *     - 地铁/公交各有显示缩放阈值（METRO_MIN_ZOOM / BUS_MIN_ZOOM），
 *       显隐变化时才做淡入淡出，缩放过程中不重复触发。
 *
 * 【交互回调由外部注入】
 *   renderStops(handlers) 的鼠标事件回调来自 app.js（点站开始规划、悬浮高亮），
 *   本模块不 import 任何 game/ 代码，保证地图层不反向依赖玩法层。
 *
 * 【图层术语】
 *   基础站点层（本文件）        浏览时可见的灰蓝/红点
 *   候选站点层（game/route.js） 开始规划后，当前站可达的线路与站点
 *   路线层（route-layer.js）    玩家已提交的乘车段/步行段
 *   最优路线层（optimal-layer） 系统算出的最优路线
 */

import { state } from '../core/state.js';
import { METRO_MIN_ZOOM, BUS_MIN_ZOOM, MAX_BUS_RENDER } from '../core/config.js';
import { setStatus, $ } from '../core/dom.js';
import { makeMassMarks, stopToData } from './stop-marks.js';
import { fadeInOverlay, captureMassMarksCanvas, removeOverlay } from './anim.js';
import { mapContainer } from './map-init.js';
import { cancelPreview } from './hover.js';

// ---------- 模块内部状态（只被本文件使用，因此不放进 core/state.js） ----------
let metroMarks = null;        // 地铁站点层（MassMarks）
let busMarks = null;          // 公交站点层（MassMarks）
let metroMarksShown = false;  // 当前是否可见（用于避免重复淡入淡出）
let busMarksShown = false;
let refreshTimer = null;      // 平移/缩放刷新防抖
let stopHandlers = {};        // { onClick, onMouseOver, onMouseOut }

// ============ 站点图层创建 ============

/**
 * 创建基础站点层并绑定交互。
 * @param {{onClick?:Function, onMouseOver?:Function, onMouseOut?:Function}} handlers 鼠标事件回调
 */
export function renderStops(handlers) {
  stopHandlers = handlers || {};

  // 基础站点层改为"按视野渲染"：初始空数据，显示时再按当前视野填充，
  // 避免 2.8 万公交站常驻渲染导致缩放/平移卡顿。
  metroMarks = makeMassMarks([]);
  busMarks = makeMassMarks([]);

  for (const m of [metroMarks, busMarks]) {
    m.setMap(state.map);
    m.hide();
    m.on('mouseover', (e) => { if (stopHandlers.onMouseOver) stopHandlers.onMouseOver(e); });
    m.on('mouseout', (e) => { if (stopHandlers.onMouseOut) stopHandlers.onMouseOut(e); });
    m.on('click', (e) => { if (stopHandlers.onClick) stopHandlers.onClick(e); });
  }

  metroMarksShown = false;
  busMarksShown = false;
  updateStopsByZoom();
  // 缩放过程中实时显隐（zoomchange 每次缩放级别变化都触发），缩放结束后刷新视野数据
  state.map.on('zoomchange', updateStopsByZoom);
  state.map.on('zoomend', () => { updateStopsByZoom(); scheduleRefreshStops(); });
  state.map.on('moveend', scheduleRefreshStops);
  // 手机端：点击地图空白处（非站点/路线）取消两阶段预选；缩放/点按钮不会走这里
  state.map.on('click', (e) => {
    if (!state.isTouch) return;
    const t = e && e.originalEvent && e.originalEvent.target;
    const onInteractive = t && t.closest ? t.closest('.leaflet-interactive') : null;
    if (!onInteractive) cancelPreview();
  });
}

// ============ 视野内取点与抽稀 ============

/** 视野内站点（外扩 35% 边距，避免边缘站点在平移时忽隐忽现）；mode 可只取 'metro' / 'bus' */
export function viewportStops(mode) {
  if (!state.map) return [];
  let list = state.physStops;
  const b = (state.map.getBounds && state.map.getBounds()) || null;
  if (b) {
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const padLng = (ne.getLng() - sw.getLng()) * 0.35;
    const padLat = (ne.getLat() - sw.getLat()) * 0.35;
    const minLng = sw.getLng() - padLng, maxLng = ne.getLng() + padLng;
    const minLat = sw.getLat() - padLat, maxLat = ne.getLat() + padLat;
    list = state.physStops.filter((p) => p.lng >= minLng && p.lng <= maxLng && p.lat >= minLat && p.lat <= maxLat);
  }
  if (mode) list = list.filter((p) => p.mode === mode);
  if (mode === 'bus' && list.length > MAX_BUS_RENDER) list = thinStopsSpatially(list, MAX_BUS_RENDER);
  return list;
}

/** 空间抽稀：网格越来越大，直到点数降到 maxCount 以内（每格保留一个代表点，分布均匀） */
function thinStopsSpatially(stops, maxCount) {
  if (stops.length <= maxCount) return stops;
  let cell = 0.001; // 约 100m 起步
  let out = stops;
  for (let iter = 0; iter < 24 && out.length > maxCount; iter++) {
    const seen = new Set();
    out = [];
    for (const p of stops) {
      const k = Math.floor(p.lng / cell) + ':' + Math.floor(p.lat / cell);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    cell *= 1.4;
  }
  return out.length <= maxCount ? out : out.slice(0, maxCount);
}

// ============ 数据刷新与显隐 ============

/** 更新站点层数据为当前视野内的站点（首次 setData 会创建 canvas，顺带捕获供淡入淡出使用） */
function setStopData(mm, data) {
  if (!mm) return;
  const container = mapContainer();
  const before = container ? new Set(container.querySelectorAll('canvas')) : null;
  mm.setData(data);
  if (container && (!mm.__canvas || !mm.__canvas.isConnected)) {
    mm.__canvas = null;
    captureMassMarksCanvas(mm, container, before, 0);
  }
}

/** 按当前视野刷新某一层的点数据 */
function refreshStopData(mm) {
  if (!mm) return;
  const mode = mm === metroMarks ? 'metro' : 'bus';
  setStopData(mm, viewportStops(mode).map(stopToData));
}

/** 刷新所有"正在显示"的层 */
export function refreshVisibleStops() {
  if (metroMarksShown) refreshStopData(metroMarks);
  if (busMarksShown) refreshStopData(busMarks);
}

/** 防抖：平移/缩放结束后 80ms 再刷新视野内站点，避免连续重绘 */
export function scheduleRefreshStops() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshVisibleStops();
  }, 80);
}

/**
 * 按当前缩放级别和游戏状态决定基础站点层是否显示。
 * 浏览态或"全图显示"开启时显示基础站点；规划中默认隐藏（由候选站点层接管）。
 */
export function updateStopsByZoom() {
  if (!state.map) return;
  const showBase = state.routeStops.length === 0 || state.showAllStops;
  const z = state.map.getZoom();
  setStopsVisible(metroMarks, showBase && !state.scenario.noMetro && z >= METRO_MIN_ZOOM, () => metroMarksShown, (v) => { metroMarksShown = v; });
  setStopsVisible(busMarks, showBase && z >= BUS_MIN_ZOOM, () => busMarksShown, (v) => { busMarksShown = v; }); // 公交站按缩放等级显隐
}

/** 站点层显隐：直接 show/hide，不依赖淡出动画回调（回调在 iOS Safari 等环境可能不触发，导致站点层卡住） */
function setStopsVisible(mm, show, getShown, setShown) {
  if (!mm) return;
  if (getShown() === show) return;
  setShown(show);
  if (show) {
    refreshStopData(mm); // 显示前按当前视野填充数据（视野渲染）
    mm.show();
  } else {
    // 隐藏用 hide() 而非 setMap(null)，这样后续 show() 还能恢复
    mm.hide();
  }
}

/** 开始规划时淡出基础站点层（候选站点层接管显示） */
export function hideBaseStops() {
  setStopsVisible(metroMarks, false, () => metroMarksShown, (v) => { metroMarksShown = v; });
  setStopsVisible(busMarks, false, () => busMarksShown, (v) => { busMarksShown = v; });
}

// ============ 规划中的"全图显示站点"开关 ============

/** 切换"全图显示站点"（开启时仍可预览站点，但确定/继续规划会被阻止；切换时取消手机端预选） */
export function toggleShowAllStops() {
  cancelPreview();
  state.showAllStops = !state.showAllStops;
  const btn = $('show-all-btn');
  if (btn) btn.textContent = state.showAllStops ? '关闭全图显示' : '显示全图站点';
  updateStopsByZoom();
  setStatus(state.showAllStops ? '全图显示中——可预览站点，确定前请先关闭' : '继续点击沿途站点换乘，或点击「终」完成');
}

// ============ 地铁底图 ============

/** 画灰色的地铁线作为背景（禁用地铁情景下不画） */
export function renderMetroContext() {
  if (state.scenario.noMetro) return;
  for (const line of state.linesMap.values()) {
    if (line.mode !== 'metro') continue;
    if (!line.path || line.path.length < 2) continue;
    const poly = new AMap.Polyline({
      path: line.path, strokeColor: '#e7b7b1', strokeWeight: 2,
      strokeOpacity: 0.55, lineJoin: 'round', zIndex: 50,
    });
    poly.setMap(state.map);
    fadeInOverlay(poly, 260);
    state.metroBase.push(poly);
  }
}

/** 情景切换时重画地铁底图（禁用↔启用）；硬移除旧底图，避免残留 */
export function applyScenario() {
  const old = state.metroBase;
  state.metroBase = [];
  for (const p of old) removeOverlay(p);
  if (!state.scenario.noMetro) renderMetroContext();
  updateStopsByZoom();
}
