/**
 * map/route-layer.js —— 玩家路线绘制层
 *
 * 【画什么】
 *   玩家每选一个站，就产生一组覆盖物（通过 group 分组，供"撤回"整组删除）：
 *     站点序号图钉 + 乘车段折线（线路色外框 + 白色内线）+ 换乘步行虚线
 *   起始步行段和终点步行段用绿色细虚线。
 *
 * 【两个关键实现】
 *   1) 折线只取线路上"两个站之间"的一段（lineSegmentPath）：
 *      地铁环线（内环/外环）在闭合路径上有两条弧，取站数少的那条，
 *      否则会出现"从西直门到积水潭绕着二环跑一圈"的荒谬画法。
 *   2) 悬停置顶（tagRouteOverlay）：鼠标移到某条路线时把整组提到最前（FRONT_Z），
 *      否则玩家路线会被最优路线的描边压住看不见。
 */

import { state } from '../core/state.js';
import { WALK_COLOR, WALK_LINE_WEIGHT, WALK_LINK_WEIGHT, ROUTE_COLOR, ROUTE_CASING, TRANSFER_WALK_MIN_M } from '../core/config.js';
import { findStopInLine } from '../data/index-builder.js';
import { fadeInOverlay, removeOverlay } from './anim.js';
import { activeWalk } from './walk.js';
import { haversineKm } from '../core/router-api.js';

/** 路线悬停置顶用的层级（比所有路线覆盖物都高） */
const FRONT_Z = 3000;

// ============ 分组管理（撤回的基本单位） ============

/** 当前正在写入的覆盖物分组（不存在则新建） */
export function currentGroup() {
  if (!state.routeOverlayGroups.length) state.routeOverlayGroups.push([]);
  return state.routeOverlayGroups[state.routeOverlayGroups.length - 1];
}

/** 整组移除（撤回一步、重置路线时用）；硬移除，避免淡出回调不触发导致残留 */
export function clearGroupOverlays(g) {
  for (const o of g) removeOverlay(o);
}

// ============ 站点序号图钉 ============

/** 在指定坐标画一个带序号的路线图钉（1、2、3…） */
export function addStopMarker(index, lnglat, g) {
  const m = new AMap.Marker({
    position: lnglat,
    content: '<div class="pin route">' + index + '</div>',
    offset: new AMap.Pixel(-12, -12), zIndex: 420,
  });
  m.setMap(state.map);
  (g || currentGroup()).push(m);
}

// ============ 悬停置顶 ============

/** 玩家路线 + 最优路线的全部覆盖物 */
function allRouteOverlays() {
  const arr = [];
  for (const g of state.routeOverlayGroups) for (const o of g) arr.push(o);
  for (const o of state.optimalOverlays) arr.push(o);
  return arr;
}

/**
 * 给覆盖物打上分组标记并绑定悬停置顶。
 * @param {object} overlay 覆盖物
 * @param {'player'|'optimal'} group 所属路线
 * @param {number} baseZ 该覆盖物的正常层级
 */
export function tagRouteOverlay(overlay, group, baseZ) {
  overlay._group = group;
  overlay._baseZ = baseZ;
  overlay.on('mouseover', () => raiseRouteGroup(group));
  overlay.on('mouseout', restoreRouteGroups);
  // 路线自己监听 mousemove 后，指针停在路线上时地图不会收到 mousemove；
  // 地图一收到 mousemove 就说明指针已离开路线，可作为 mouseout 丢失时的兜底。
  overlay.on('mousemove', () => {});
  if (!restoreOnMapMove && state.map) {
    restoreOnMapMove = true;
    state.map.on('mousemove', restoreRouteGroups);
  }
}

let raisedGroup = null;
let restoreOnMapMove = false;

/** 整组置顶；层级未变的覆盖物 setOptions 不会重排，避免反复移动鼠标下方的元素。 */
function raiseRouteGroup(group) {
  raisedGroup = group;
  for (const o of allRouteOverlays()) {
    if (o._group === group) o.setOptions({ zIndex: FRONT_Z });
    else o.setOptions({ zIndex: o._baseZ });
  }
}

function restoreRouteGroups() {
  if (!raisedGroup) return;
  raisedGroup = null;
  for (const o of allRouteOverlays()) o.setOptions({ zIndex: o._baseZ });
}

// ============ 乘车段 ============

/** 画一段已确认乘车路线（白色描边 + 深色实线），追加到当前分组。 */
export function drawRideSegment(line, fromStop, toStop) {
  const sub = lineSegmentPath(line, fromStop, toStop);
  if (!sub || sub.length < 2) return;
  const casing = new AMap.Polyline({
    path: sub, strokeColor: ROUTE_CASING, strokeWeight: 11,
    strokeOpacity: 1, lineJoin: 'round', zIndex: 395,
  });
  casing.setMap(state.map);
  tagRouteOverlay(casing, 'player', 395);
  fadeInOverlay(casing);
  currentGroup().push(casing);

  const main = new AMap.Polyline({
    path: sub, strokeColor: ROUTE_COLOR, strokeWeight: 6,
    strokeOpacity: 1, lineJoin: 'round', zIndex: 396,
  });
  main.setMap(state.map);
  tagRouteOverlay(main, 'player', 396);
  fadeInOverlay(main);
  currentGroup().push(main);
  animateTraveler(sub, line.mode === 'metro' ? 'metro' : 'bus');
}

/**
 * 该线路在该逻辑站上的"实际停靠坐标"（乘车段端点）。
 * 逻辑站可能合并了地铁站与同名公交站，它们在物理上相距较远，
 * 所以端点要按"线路"分别取，不能直接用逻辑站坐标。
 */
export function rideEndpoint(line, logicalStop) {
  const st = findStopInLine(line, logicalStop);
  if (!st || !line.path || line.path.length < 2) return null;
  const i = nearestPathIndex(line.path, [st.lng, st.lat]);
  return line.path[i];
}

/**
 * 换乘步行：换乘站上，上一乘车段的下车点 ↔ 下一乘车段的上车点（物理站可能相距较远）。
 * 距离超过阈值时画一段虚线表示步行；不计时（时间仍走原来的换乘惩罚）。
 */
export function drawTransferWalk(p1, p2) {
  if (!p1 || !p2) return;
  if (haversineKm(p1, p2) * 1000 < TRANSFER_WALK_MIN_M) return;
  const poly = new AMap.Polyline({
    path: [p1, p2], strokeColor: WALK_COLOR, strokeWeight: WALK_LINK_WEIGHT, strokeOpacity: 0.9,
    strokeStyle: 'dashed', dashArray: [6, 6], lineJoin: 'round', zIndex: 388,
  });
  poly.setMap(state.map);
  tagRouteOverlay(poly, 'player', 388);
  fadeInOverlay(poly);
  currentGroup().push(poly);
}

/**
 * 步行换乘段（实验性，设置里开启）：下车步行到下一个不共享线路的站。
 * 与 drawTransferWalk 不同，这一段【计入时间】（按步行速度），使用绿色虚线。
 */
export function drawWalkTransfer(p1, p2) {
  if (!p1 || !p2) return;
  const poly = new AMap.Polyline({
    path: [p1, p2], strokeColor: WALK_COLOR, strokeWeight: WALK_LINE_WEIGHT, strokeOpacity: 0.95,
    strokeStyle: 'dashed', dashArray: [12, 8], lineJoin: 'round', zIndex: 388,
  });
  poly.setMap(state.map);
  tagRouteOverlay(poly, 'player', 388);
  fadeInOverlay(poly);
  currentGroup().push(poly);
  animateTraveler([p1, p2], 'walk');
}

// ============ 折线取段工具（最优路线层也复用） ============

/**
 * 取线路上从 stopA 到 stopB 的折线子段（并保证方向是从 A 指向 B）。
 * 环线取较短的一侧。
 * @returns {Array<[number,number]>|null} 折线点数组；任一站不在线路上时返回 null
 */
export function lineSegmentPath(line, stopA, stopB) {
  const a = findStopInLine(line, stopA);
  const b = findStopInLine(line, stopB);
  if (!a || !b || !line.path || line.path.length < 2) return null;
  const ia = nearestPathIndex(line.path, [a.lng, a.lat]);
  const ib = nearestPathIndex(line.path, [b.lng, b.lat]);
  const i0 = Math.min(ia, ib), i1 = Math.max(ia, ib);

  let sub;
  if (line.oneWay) {
    // 单向线：按前进方向（seq 递增）取段；环线在 A.seq > B.seq 时走绕环（A→末站→首站→B）
    if (line.isLoop && a.seq > b.seq) {
      sub = line.path.slice(ia).concat(line.path.slice(0, ib + 1));
    } else {
      sub = line.path.slice(i0, i1 + 1);
    }
  } else if (line.isLoop && (line.path.length - i1) + i0 < i1 - i0) {
    // 双向环线：闭合路径上有两条弧，选较短的那条（走站少的那边）
    sub = line.path.slice(i1).concat(line.path.slice(0, i0 + 1));
  } else {
    sub = line.path.slice(i0, i1 + 1);
  }
  // 让折线从 stopA 走向 stopB：若首端更靠近 stopB 则反转
  const startNearB = haversineKm(sub[0], [b.lng, b.lat]) < haversineKm(sub[0], [a.lng, a.lat]);
  if (startNearB) sub = sub.slice().reverse();
  return sub;
}

/** 折线上离 pt 最近的点下标（用于把站点吸附到轨迹上） */
function nearestPathIndex(path, pt) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < path.length; i++) {
    const dx = path[i][0] - pt[0], dy = path[i][1] - pt[1];
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

// ============ 步行段 ============

/** 画一段绿色步行虚线；g 传入时追加到该分组，否则追加到当前分组；animate=false 时不播放行人动画 */
export function drawWalkPolyline(path, g, animate = true) {
  const poly = new AMap.Polyline({
    path, strokeColor: WALK_COLOR, strokeWeight: WALK_LINE_WEIGHT, strokeOpacity: 0.95,
    strokeStyle: 'dashed', dashArray: [12, 8], lineJoin: 'round', zIndex: 190,
  });
  poly.setMap(state.map);
  tagRouteOverlay(poly, 'player', 190);
  fadeInOverlay(poly);
  (g || currentGroup()).push(poly);
  if (animate) animateTraveler(path, 'walk');
}

/**
 * 取步行结果并画线。
 * @returns {Promise<{dist:number, min:number}>}
 */
export function drawWalkLeg(from, to, g, animate = true) {
  g = g || currentGroup();
  return activeWalk(from, to).then((r) => {
    drawWalkPolyline(r.path || [from, to], g, animate);
    return { dist: r.dist, min: r.min };
  });
}

// ============ 行进动画 ============

const TRAVELER_ICONS = { walk: 'walking', bus: 'bus', metro: 'metro' };
let activeTraveler = null;

/**
 * 每步确认后，让一个行人 / 公交 / 地铁小牌沿刚画好的路段从起点走到终点，随后消失。
 * 时长按路段长度在 0.8~2.4 秒之间伸缩；新动画开始时立即结束上一个，避免连续操作时叠在一起。
 */
export function animateTraveler(path, kind) {
  if (!state.map || !path || path.length < 2) return;
  stopTraveler();
  const cum = [0];
  for (let i = 1; i < path.length; i++) cum.push(cum[i - 1] + haversineKm(path[i - 1], path[i]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return;
  const duration = Math.min(2400, Math.max(800, 700 + total * 260));
  const marker = new AMap.Marker({
    position: path[0],
    content: `<div class="traveler ${kind}"><span class="icon icon-${TRAVELER_ICONS[kind] || 'walking'}"></span></div>`,
    offset: new AMap.Pixel(-12, -12), zIndex: 450, clickable: false,
  });
  marker.setMap(state.map);
  const t0 = performance.now();
  const anim = { marker, raf: 0 };
  activeTraveler = anim;
  let seg = 1;
  const frame = (now) => {
    if (activeTraveler !== anim) return;
    const t = Math.min(1, (now - t0) / duration);
    const d = total * (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2); // 缓入缓出
    while (seg < cum.length - 1 && cum[seg] < d) seg++;
    const a = path[seg - 1], b = path[seg];
    const span = cum[seg] - cum[seg - 1];
    const k = span > 0 ? (d - cum[seg - 1]) / span : 1;
    marker.setPosition([a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k]);
    if (t < 1) anim.raf = requestAnimationFrame(frame);
    else setTimeout(() => { if (activeTraveler === anim) stopTraveler(); }, 250);
  };
  anim.raf = requestAnimationFrame(frame);
}

/** 立即移除正在播放的行进动画（撤回、重置路线时也会调用） */
export function stopTraveler() {
  const anim = activeTraveler;
  activeTraveler = null;
  if (!anim) return;
  cancelAnimationFrame(anim.raf);
  anim.marker.setMap(null);
}
