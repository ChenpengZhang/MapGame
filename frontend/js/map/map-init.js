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
import { MAX_WALK_M } from '../core/config.js';
import { $ } from '../core/dom.js';
import { cityById } from '../data/cities.js';
import { loadWalkCache } from './walk.js';
import { createWalkRangeCircle, walkRangeBounds } from './walk-range.js';
import { installNativePicker, isNativeAmap } from './native-picker.js';

// 地图 SDK 需异步加载；用户可能在底图完成前就点击了故事关卡。
// 用一次性就绪信号让数据/站点层等待地图，而不是对空的 state.map 注册事件。
let finishMapSetup;
const mapSetup = new Promise((resolve) => { finishMapSetup = resolve; });

export async function waitForMap() {
  if (state.map) return;
  const error = await mapSetup;
  if (error) throw error;
}

export function failMapSetup(error) {
  finishMapSetup(error || new Error('地图初始化失败'));
}

/** 创建地图并做首屏准备（交通数据懒加载，由 game/data-ready.js 在进入游戏时触发） */
export function initMap() {
  const city = cityById(state.currentCityId) || cityById('beijing');
  // 原生高德用它自带的滚轮缩放：逐帧设置小数缩放级别时，高德会先拉伸上一级瓦片（看起来先放大、发虚），
  // 停下后再加载正确级别的瓦片缩回去。兼容层（Leaflet）的 scrollWheel:false 表示启用 Leaflet 自身的滚轮缩放。
  // 关闭双击缩放：选站和确认是连点同一个站两下，会被地图当成双击先放大一级，随后“聚焦可达站”又缩回去。
  state.map = new AMap.Map('map', { center: city.center, zoom: 11, viewMode: '2D', scrollWheel: isNativeAmap(), doubleClickZoom: false });
  installNativePicker(state.map); // 原生高德：按像素距离拾取站点/线路（必须先于其它地图点击监听注册）
  setupZoomInertia();
  loadWalkCache();
  finishMapSetup(null);
}

// ============ 缩放惯性 ============

let zoomSpeed = 0.5; // 设置里的"缩放速度"滑块（0-1，默认 0.5）

/** 设置面板的"缩放速度"滑块调用它（0~1） */
export function setZoomSpeed(v) {
  zoomSpeed = v;
  state.map?.setWheelZoomSpeed?.(v);
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
    // 双击缩放始终关闭（见 initMap）
    try { state.map.setStatus({ dragEnable: !locked, zoomEnable: !locked, doubleClickZoom: false }); } catch (e) { /* 忽略 */ }
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
  if (state.map.enableNativeWheelZoom) {
    // Leaflet 自身的缩放动画避免逐帧 setView 重置瓦片造成闪屏。
    state.map.enableNativeWheelZoom(zoomSpeed);
    return;
  }
  if (isNativeAmap()) return; // 原生高德：滚轮交给高德自己处理（见 initMap）
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
    if (Math.abs(velocity) < EPS) { stop(); return; }
    if (now - lastStep < STEP_MS) { requestAnimationFrame(tick); return; }
    lastStep = now;
    applyZoom(state.map.getZoom() + velocity);
    velocity *= DECAY;
    if (Math.abs(velocity) < EPS) { stop(); return; }
    requestAnimationFrame(tick);
  }
  function stop() {
    running = false;
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

// ============ 起终点图钉与步行范围 ============

/**
 * 重画起终点图钉并适配视野。
 * @param {{onDestClick?: Function, showWalkRanges?: boolean}} [handlers]
 *        终点（"终"）被点击时的回调，以及是否显示 1.5km 步行范围圈：
 *        玩法层用它来触发"完成规划"，地图层不关心具体做什么。
 */
export function drawEndpoints(handlers) {
  const onDestClick = (handlers && handlers.onDestClick) || null;
  const showWalkRanges = !handlers || handlers.showWalkRanges !== false;
  for (const overlay of state.endpointOverlays) overlay.setMap(null);
  state.endpointOverlays = [];
  state.originWalkRangeCircle = null;
  state.destinationWalkRangeCircle = null;
  if (!state.ORIGIN || !state.DEST) return;

  // 范围圈先画、图钉后画，确保图钉始终位于圆圈上方。教学关可按关卡配置隐藏。
  if (showWalkRanges) {
    state.originWalkRangeCircle = createWalkRangeCircle(state.ORIGIN);
    state.destinationWalkRangeCircle = createWalkRangeCircle(state.DEST);
    for (const circle of [state.originWalkRangeCircle, state.destinationWalkRangeCircle]) {
      circle.setMap(state.map);
      state.endpointOverlays.push(circle);
    }
  }

  const o = new AMap.Marker({
    position: state.ORIGIN, content: '<div class="pin origin flash">起</div>',
    offset: new AMap.Pixel(-12, -12), zIndex: 400,
  });
  o.setMap(state.map);
  state.endpointOverlays.push(o);
  o.on('click', () => focusWalkRange(state.ORIGIN, handlers?.onOriginFocus));

  const d = new AMap.Marker({
    position: state.DEST, content: '<div class="pin dest flash">终</div>',
    offset: new AMap.Pixel(-12, -12), zIndex: 400,
  });
  d.setMap(state.map);
  state.endpointOverlays.push(d);
  d.on('click', () => {
    if (state.storyActive) return;
    focusWalkRange(state.DEST);
    if (onDestClick) onDestClick();
  });

  endpointsShowWalkRanges = showWalkRanges;
  fitEndpoints({ animate: false });
}

let endpointsShowWalkRanges = true;

/**
 * 视野同时容纳起点和终点（开局时直接跳转；点行程牌时平滑飞过去）。
 * 有范围圈时纳入完整圆圈；隐藏范围圈的教学关只适配两个图钉。
 */
export function fitEndpoints({ animate = true } = {}) {
  if (!state.map || !state.ORIGIN || !state.DEST) return;
  const bounds = endpointsShowWalkRanges
    ? walkRangeBounds([state.ORIGIN, state.DEST])
    : {
        sw: [Math.min(state.ORIGIN[0], state.DEST[0]), Math.min(state.ORIGIN[1], state.DEST[1])],
        ne: [Math.max(state.ORIGIN[0], state.DEST[0]), Math.max(state.ORIGIN[1], state.DEST[1])],
      };
  if (!bounds) return;
  const target = new AMap.Bounds(bounds.sw, bounds.ne);
  if (!animate) { state.map.setBounds(target, false, [40, 40, 40, 40]); return; }
  if (state.storyActive || state.mapLocked) return; // 剧情/教学锁定视野时不响应
  const padding = overlayPadding(40);
  if (state.map.focusBounds) state.map.focusBounds(target, padding);
  else if (!focusBoundsNative(target, padding)) fitMapBounds(target, padding);
}

/** 聚焦终点的步行范围（终点方向指示被点击时） */
export function focusDestination() {
  if (state.DEST) focusWalkRange(state.DEST);
}

/** 聚焦单个步行圈，短边方向在圈外留出约 150 米。 */
function focusWalkRange(center, onFocused) {
  if (!state.map || state.storyActive) return;
  const bounds = walkRangeBounds([center], MAX_WALK_M + 150);
  if (!bounds) return;
  const target = new AMap.Bounds(bounds.sw, bounds.ne);
  const mapRect = $('map')?.getBoundingClientRect?.();
  const barRect = $('topbar')?.getBoundingClientRect?.();
  const topInset = mapRect && barRect
    ? Math.max(0, Math.min(mapRect.bottom, barRect.bottom) - mapRect.top) : 0;
  const padding = [topInset, 0, 0, 0];
  if (state.map.focusBounds) state.map.focusBounds(target, padding, onFocused);
  else if (!focusBoundsNative(target, padding, onFocused)) {
    if (onFocused) {
      const done = () => { state.map.off('moveend', done); onFocused(); };
      state.map.on('moveend', done);
    }
    fitMapBounds(target, padding);
  }
}

// ============ 确认站点后：聚焦到所有可达站 ============

/**
 * 地图上被界面遮住的边距 [上, 右, 下, 左]：按当前实际显示的面板计算，桌面/手机、不同屏幕尺寸自动适配。
 */
/**
 * 当前显示在地图上的界面面板，按地图容器坐标给出矩形 { left, top, right, bottom }。
 * 横跨大半个地图宽度的（顶栏、手机底部抽屉）标记为 band。
 */
export function overlayRects() {
  const map = $('map')?.getBoundingClientRect?.();
  if (!map || !map.width) return { map: null, rects: [] };
  const rects = [];
  for (const id of ['topbar', 'left-col', 'tutorial-guide', 'btn-group', 'mode-hud', 'tower-restart-btn', 'legend']) {
    const el = $(id);
    if (!el || el.classList?.contains('hidden')) continue;
    const r = el.getBoundingClientRect?.();
    if (!r || !r.width || !r.height) continue;
    if (r.bottom <= map.top || r.top >= map.bottom || r.right <= map.left || r.left >= map.right) continue;
    rects.push({
      id, band: r.width >= map.width * 0.6,
      left: r.left - map.left, top: r.top - map.top, right: r.right - map.left, bottom: r.bottom - map.top,
    });
  }
  return { map, rects };
}

export function overlayPadding(margin = 28) {
  const pad = [margin, margin, margin, margin];
  const { map, rects } = overlayRects();
  if (!map) return pad;
  for (const r of rects) {
    if (r.id === 'legend' || r.id === 'tower-restart-btn') continue; // 小角标，不值得为它缩小视野
    // 每块面板只需要在一条边上让位：取让出空间最少的那条边
    //（顶栏、居中的 HUD → 上；手机底部抽屉、右下按钮 → 下；桌面左侧高面板 → 左或上，取较省的一边）
    const need = [r.bottom, map.width - r.left, map.height - r.top, r.right];
    const side = need.indexOf(Math.min(...need));
    pad[side] = Math.max(pad[side], need[side] + margin);
  }
  // 小屏上遮挡太多时收缩留白，保证至少留出 40% 的可见区域
  for (const [a, b, size] of [[0, 2, map.height], [1, 3, map.width]]) {
    const total = pad[a] + pad[b], max = size * 0.6;
    if (total > max) { pad[a] = Math.round(pad[a] * max / total); pad[b] = Math.round(pad[b] * max / total); }
  }
  return pad;
}

/** 平滑聚焦到一组点（避开界面遮挡）；点很近时最多放大到 maxZoom，避免贴得太近 */
export function focusOnPoints(points, { maxZoom = 16 } = {}) {
  const valid = (points || []).filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!state.map || !valid.length) return;
  let minLng = Math.min(...valid.map((p) => p[0])), maxLng = Math.max(...valid.map((p) => p[0]));
  let minLat = Math.min(...valid.map((p) => p[1])), maxLat = Math.max(...valid.map((p) => p[1]));
  const eps = 0.002; // 只有一个点时给出一个最小范围
  if (maxLng - minLng < eps) { minLng -= eps; maxLng += eps; }
  if (maxLat - minLat < eps) { minLat -= eps; maxLat += eps; }
  const target = new AMap.Bounds([minLng, minLat], [maxLng, maxLat]);
  const padding = overlayPadding();
  if (state.map.focusBounds) state.map.focusBounds(target, padding, null, { maxZoom });
  else if (!focusBoundsNative(target, padding, null, maxZoom)) fitMapBounds(target, padding);
}

// ============ 原生高德：平滑聚焦 ============
// Leaflet 兼容层自带 focusBounds（flyToBounds）。原生高德先用 getFitZoomAndCenterByBounds 求出目标缩放与中心，
// 再交给高德自带的过渡动画（setZoomAndCenter 的 duration 参数）一次完成。
// 不要逐帧调用 setZoomAndCenter 自己插值：高德每次都会重排瓦片、重绘海量点并触发缩放事件，
// 表现为“先放大、卡一下、再缩回正确大小”。
// 手动拖动/滚轮/触摸会打断高德自己的动画；被打断时不报告聚焦完成（与兼容层一致）。

const FOCUS_MS = 800;
let focusToken = 0;       // 每次聚焦递增；过期的完成回调直接丢弃
let focusInterruptBound = null;

function cancelNativeFocus() {
  focusToken++;
}

/**
 * 本项目统一用 [上, 右, 下, 左] 表示视野留白（与 Leaflet 兼容层一致）；
 * 原生高德的 avoid 参数顺序是 [上, 下, 左, 右]，调用高德接口前在这里换序。
 */
function nativeAvoid(padding = [0, 0, 0, 0]) {
  return [padding[0] || 0, padding[2] || 0, padding[3] || 0, padding[1] || 0];
}

/** 立即适配视野（padding 为 [上, 右, 下, 左]），两种底图通用 */
export function fitMapBounds(bounds, padding = [0, 0, 0, 0]) {
  if (!state.map) return;
  state.map.setBounds(bounds, false, state.map.focusBounds ? padding : nativeAvoid(padding));
}

/** 成功发起动画返回 true；地图不支持所需接口时返回 false，由调用方退回 setBounds */
function focusBoundsNative(target, padding, onFocused, maxZoom = null) {
  const map = state.map;
  if (!map.getFitZoomAndCenterByBounds || !map.setZoomAndCenter) return false;
  const fit = map.getFitZoomAndCenterByBounds(target, nativeAvoid(padding), maxZoom ?? undefined);
  if (!fit || fit.length < 2) return false;
  // 取整数级别：高德的缩放动画会先走到整数级再落到小数级（表现为先放大再缩回），
  // 小数级别下文字标注也会发虚。向下取整保证目标范围仍然完整可见。
  const zoom = Math.floor(maxZoom ? Math.min(fit[0], maxZoom) : fit[0]);
  const center = fit[1];

  const container = map.getContainer?.();
  if (container && focusInterruptBound !== container) {
    focusInterruptBound = container;
    for (const ev of ['pointerdown', 'wheel', 'touchstart']) {
      container.addEventListener(ev, cancelNativeFocus, { capture: true, passive: true });
    }
  }
  const token = ++focusToken;
  const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  map.setZoomAndCenter(zoom, center, !!reduced, reduced ? undefined : FOCUS_MS);
  if (onFocused) {
    // 动画结束（或立即跳转）后回调；期间玩家手动操作则作废
    setTimeout(() => { if (token === focusToken) onFocused(); }, reduced ? 0 : FOCUS_MS + 60);
  }
  return true;
}

/** 确认首站后隐藏起点范围；取消整条规划时重新显示。终点范围不受影响。 */
export function setOriginWalkRangeVisible(visible) {
  const circle = state.originWalkRangeCircle;
  if (circle) circle.setMap(visible ? state.map : null);
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

// ============ 盲棋：隐藏底图，只画城市轮廓 ============

let outlineOverlays = [];
let savedBaseLayers = null; // 原生高德：盲棋期间暂存的底图图层
let outlineRequest = 0;

/**
 * 切换“盲棋”呈现：blind=true 时隐藏底图瓦片、给地图容器换成素色底，并按城市行政边界画轮廓线；
 * blind=false 时恢复底图并清掉轮廓。站点、线路、路线等覆盖物不受影响。
 * 边界文件为 DataV 行政区 GeoJSON（GCJ-02），与转换脚本裁剪公交用的是同一份。
 */
export async function setBlindMap(blind, cityId = state.currentCityId) {
  const request = ++outlineRequest;
  for (const o of outlineOverlays) o.setMap(null);
  outlineOverlays = [];
  if (!state.map) return;
  if (state.map.setBaseLayerVisible) state.map.setBaseLayerVisible(!blind);
  else if (state.map.getLayers && state.map.setLayers) {
    // 原生高德：进入盲棋时记下原有图层（默认是矢量底图）再清空；退出时原样放回。
    // 不能用 new AMap.TileLayer() 代替——那是栅格瓦片，文字被烘焙在图片里，会整体变大变糊。
    if (blind && !savedBaseLayers) {
      savedBaseLayers = state.map.getLayers();
      state.map.setLayers([]);
    } else if (!blind && savedBaseLayers) {
      state.map.setLayers(savedBaseLayers);
      savedBaseLayers = null;
    }
  }
  $('map')?.classList.toggle('blind-map', !!blind);
  if (!blind) return;
  try {
    const geo = await fetch(`data/boundaries/${cityId}.json`).then((r) => (r.ok ? r.json() : null));
    if (!geo || request !== outlineRequest) return;
    const geometry = geo.features?.[0]?.geometry;
    const polygons = geometry?.type === 'MultiPolygon' ? geometry.coordinates : geometry ? [geometry.coordinates] : [];
    for (const polygon of polygons) {
      for (const ring of polygon) {
        const line = new AMap.Polyline({
          path: ring, strokeColor: '#5b6b7b', strokeWeight: 2, strokeOpacity: 0.8,
          lineJoin: 'round', zIndex: 40, interactive: false,
        });
        line.setMap(state.map);
        outlineOverlays.push(line);
      }
    }
  } catch (e) { /* 边界缺失时只是没有轮廓，不影响游玩 */ }
}

