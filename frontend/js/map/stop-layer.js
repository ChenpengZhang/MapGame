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
import { METRO_MIN_ZOOM, BUS_MIN_ZOOM, TUTORIAL_BUS_MIN_ZOOM, MAX_BUS_RENDER } from '../core/config.js';
import { setStatus, $ } from '../core/dom.js';
import { makeMassMarks, stopToData } from './stop-marks.js';
import { clickWasPicked } from './native-picker.js';
import { fadeInOverlay, captureMassMarksCanvas, removeOverlay } from './anim.js';
import { mapContainer } from './map-init.js';
import { isWithinWalkRange } from './walk-range.js';

/** 公交站显示阈值：新手教程（地图练习关）放宽，其它模式用全局设置 */
export function busMinZoom() {
  return state.currentLevel?.mapTutorial?.mapPractice ? TUTORIAL_BUS_MIN_ZOOM : BUS_MIN_ZOOM;
}

// ---------- 模块内部状态（只被本文件使用，因此不放进 core/state.js） ----------
let metroMarks = null;        // 地铁站点层（MassMarks）
let busMarks = null;          // 公交站点层（MassMarks）
let originWalkMarks = null;   // 起点 1.5km 内的红色步行站（独立层，确认首站后销毁）
let metroMarksShown = false;  // 当前是否可见（用于避免重复淡入淡出）
let busMarksShown = false;
let originWalkMarksShown = false;
let refreshTimer = null;      // 平移/缩放刷新防抖
let stopHandlers = {};        // { onClick, onMouseOver, onMouseOut, onMapClick }
let mapListeners = null;

/** 切城前卸下旧站点与地图监听，避免两套城市同时接收点击。 */
export function disposeStops() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
  if (state.map && mapListeners) {
    for (const [event, handler] of mapListeners) state.map.off(event, handler);
  }
  mapListeners = null;
  for (const marks of [metroMarks, busMarks, originWalkMarks]) {
    marks?.setMap(null);
    if (marks?.__canvas?.isConnected) marks.__canvas.remove();
  }
  metroMarks = busMarks = originWalkMarks = null;
  metroMarksShown = busMarksShown = originWalkMarksShown = false;
  originWalkHasBus = false;
  stopHandlers = {};
}

// ============ 站点图层创建 ============

/**
 * 创建基础站点层并绑定交互。
 * @param {{onClick?:Function, onMouseOver?:Function, onMouseOut?:Function}} handlers 鼠标事件回调
 */
export function renderStops(handlers) {
  disposeStops();
  stopHandlers = handlers || {};

  // 基础站点层改为"按视野渲染"：初始空数据，显示时再按当前视野填充，
  // 避免 2.8 万公交站常驻渲染导致缩放/平移卡顿。
  metroMarks = makeMassMarks([], { allowWalkStyle: false });
  busMarks = makeMassMarks([], { allowWalkStyle: false });
  // 红色步行可达层必须固定压在蓝色公交层之上：缩放跨过显示级别时公交层会晚于它挂载，
  // 同一层级下后挂载者在上，会让可达站在缩放过程中先显示成蓝色、停止后才变红。
  originWalkMarks = makeMassMarks([], { allowWalkStyle: true, zIndex: 112 });

  for (const m of [metroMarks, busMarks, originWalkMarks]) {
    m.setMap(state.map);
    m.hide();
    m.on('mouseover', (e) => { if (stopHandlers.onMouseOver) stopHandlers.onMouseOver(e); });
    m.on('mouseout', (e) => { if (stopHandlers.onMouseOut) stopHandlers.onMouseOut(e); });
    m.on('click', (e) => { if (stopHandlers.onClick) stopHandlers.onClick(e); });
  }

  metroMarksShown = false;
  busMarksShown = false;
  originWalkMarksShown = false;
  updateStopsByZoom();
  // 缩放过程中实时显隐（zoomchange 每次缩放级别变化都触发），缩放结束后刷新视野数据
  const onZoomEnd = () => { updateStopsByZoom(); scheduleRefreshStops(); };
  // 两端一致：点击地图空白处取消预选；平移、缩放和点地图控件不会走取消逻辑。
  const onMapClick = (e) => {
    // 原生高德：点击已被 native-picker 当作站点/线路处理，不能再当成点空白取消刚选中的站
    if (clickWasPicked(e)) return;
    const original = e && (e.originalEvent || e.originEvent);
    const t = original && original.target;
    const onInteractive = t && t.closest ? t.closest('.leaflet-interactive') : null;
    if (!onInteractive && stopHandlers.onMapClick) stopHandlers.onMapClick(e);
  };
  mapListeners = [
    ['zoomchange', updateStopsByZoom], ['zoomend', onZoomEnd],
    ['moveend', scheduleRefreshStops], ['click', onMapClick],
  ];
  for (const [event, handler] of mapListeners) state.map.on(event, handler);
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
  if (mm === originWalkMarks) {
    const z = state.map ? state.map.getZoom() : 0;
    const walkable = viewportStops().filter((stop) =>
      isWithinWalkRange(stop, state.ORIGIN)
      && ((stop.mode === 'metro' && !state.scenario.noMetro && z >= METRO_MIN_ZOOM)
        || (stop.mode === 'bus' && z >= busMinZoom()))
    );
    setStopData(mm, walkable.map((stop) => stopToData(stop, true)));
    return;
  }
  const mode = mm === metroMarks ? 'metro' : 'bus';
  // 公交/地铁基础层永远保持蓝/橙；起点红色站由独立图层覆盖，避免状态混入后残留。
  setStopData(mm, viewportStops(mode).map((stop) => stopToData(stop, false)));
}

/** 刷新所有"正在显示"的层 */
export function refreshVisibleStops() {
  if (metroMarksShown) refreshStopData(metroMarks);
  if (busMarksShown) refreshStopData(busMarks);
  if (originWalkMarksShown) refreshStopData(originWalkMarks);
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
  // 真实乘坐：出发前只显示起点 1.5km 内可步行到达的站（红色层），不显示全城蓝/橙站点
  const showBase = !state.scenario?.realRide && (state.routeStops.length === 0 || state.showAllStops);
  const z = state.map.getZoom();
  setStopsVisible(metroMarks, showBase && !state.scenario.noMetro && z >= METRO_MIN_ZOOM, () => metroMarksShown, (v) => { metroMarksShown = v; });
  setStopsVisible(busMarks, showBase && z >= busMinZoom(), () => busMarksShown, (v) => { busMarksShown = v; }); // 公交站按缩放等级显隐
  const showOriginWalk = (showBase || !!state.scenario?.realRide) && state.routeStops.length === 0 && !!state.ORIGIN
    && ((!state.scenario.noMetro && z >= METRO_MIN_ZOOM) || z >= busMinZoom());
  setStopsVisible(originWalkMarks, showOriginWalk, () => originWalkMarksShown, (v) => { originWalkMarksShown = v; });
  // 红色层在地铁级别（13）就已显示，只含地铁站；缩放跨过公交级别时它不会重新 show，
  // 必须立刻补上公交步行站，否则蓝色公交层先出现、要等缩放停止才刷新成红色。
  const walkIncludesBus = showOriginWalk && z >= busMinZoom();
  if (originWalkMarksShown && walkIncludesBus !== originWalkHasBus) refreshStopData(originWalkMarks);
  originWalkHasBus = walkIncludesBus;
}
let originWalkHasBus = false; // 红色步行层当前数据是否已包含公交站

/** 站点层显隐：直接 show/hide，不依赖淡出动画回调（回调在 iOS Safari 等环境可能不触发，导致站点层卡住） */
function setStopsVisible(mm, show, getShown, setShown) {
  if (!mm) return;
  if (getShown() === show) return;
  setShown(show);
  if (show) {
    if (mm === originWalkMarks) {
      try { mm.setOptions({ opacity: 0.9 }); } catch (e) { /* 忽略不支持动态透明度的后端 */ }
      if (mm.__canvas?.style) { mm.__canvas.style.display = ''; mm.__canvas.style.opacity = '0.9'; }
    }
    refreshStopData(mm); // 显示前按当前视野填充数据（视野渲染）
    // hideBaseStops 会把图层从地图彻底卸载；恢复时显式重新挂载。
    mm.setMap(state.map);
    mm.show();
  } else {
    mm.hide();
  }
}

/**
 * 开始规划时移除基础站点层（候选站点层接管显示）。
 * 除了 hide 还要清空数据：部分地图后端会延迟隐藏 MassMarks canvas，若只 hide，
 * 起点范围内原先染红的步行站会在确认首站后短暂或持续残留。
 * 重置规划时 setStopsVisible 会按当前起点范围重新填充，不影响再次开始。
 */
export function hideBaseStops() {
  setStopsVisible(metroMarks, false, () => metroMarksShown, (v) => { metroMarksShown = v; });
  setStopsVisible(busMarks, false, () => busMarksShown, (v) => { busMarksShown = v; });
  setStopsVisible(originWalkMarks, false, () => originWalkMarksShown, (v) => { originWalkMarksShown = v; });
  setStopData(metroMarks, []);
  setStopData(busMarks, []);
  // 在清数据前后都把红色步行层透明度压到 0；即便原生地图保留旧 canvas 也不可见。
  try { originWalkMarks?.setOptions({ opacity: 0 }); } catch (e) { /* 忽略 */ }
  if (originWalkMarks?.__canvas?.style) {
    originWalkMarks.__canvas.style.opacity = '0';
    originWalkMarks.__canvas.style.display = 'none';
  }
  setStopData(originWalkMarks, []);
  // 原生高德的 MassMarks.hide() 在连续 setData/缩放时可能留下旧 canvas；
  // 从地图彻底卸载才能保证起点红色站立即消失。恢复时 setStopsVisible 会重新 setMap。
  metroMarks?.setMap(null);
  busMarks?.setMap(null);
  originWalkMarks?.setMap(null);
  // 原生高德可能保留已捕获的旧 canvas；步行层独立后可安全定向移除。
  if (originWalkMarks?.__canvas?.isConnected) originWalkMarks.__canvas.remove();
  if (originWalkMarks) originWalkMarks.__canvas = null;
}

// ============ 规划中的"全图显示站点"开关 ============

/** 切换"全图显示站点"（开启时仍可预览站点，但确定/继续规划会被阻止） */
export function toggleShowAllStops() {
  if (state.scenario?.realRide) return; // 真实乘坐不能全图显示
  if (stopHandlers.onMapClick) stopHandlers.onMapClick(null, true);
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
  // 盲棋不画灰色地铁底图：它本身就是一张“地图”，会泄露城市骨架
  if (!state.scenario.noMetro && !state.scenario.blindMap) renderMetroContext();
  updateStopsByZoom();
}
