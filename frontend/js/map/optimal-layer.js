/**
 * map/optimal-layer.js —— 最优路线绘制层（青绿色）
 *
 * 【画什么】
 *   系统算出的最优路线：起点步行（虚线）→ 各乘车段（青色外框 + 白色内线）→
 *   换乘点橙色"换"图钉 → 终点步行（虚线）。
 *   与玩家路线配色区分开（玩家是深色黑线），并共用"悬停整组置顶"的交互。
 *
 * 【与玩家路线层的关系】
 *   折线取段（lineSegmentPath）和置顶分组（tagRouteOverlay）是两套路线共用的能力，
 *   实现在 route-layer.js 里，本模块直接复用，避免两份环线取段逻辑走偏。
 */

import { state } from '../core/state.js';
import { WALK_COLOR, WALK_LINE_WEIGHT, WALK_LINK_WEIGHT, OPTIMAL_COLOR, OPTIMAL_CASING, TRANSFER_WALK_MIN_M } from '../core/config.js';
import { getLine, getLogical } from '../data/index-builder.js';
import { fadeInOverlay, removeOverlay } from './anim.js';
import { tagRouteOverlay, lineSegmentPath } from './route-layer.js';
import { lineSignClass, lineSignInnerHTML, escapeHtml } from '../data/line-sign.js';
import { activeWalk } from './walk.js';
import { haversineKm } from '../core/router-api.js';

/**
 * 绘制最优路线全过程（覆盖物默认记录在 state.optimalOverlays 里，便于整体清除）。
 * @param {object} result router.findOptimalRoute 的返回值
 *        { board:{lng,lat,name}, alight:{...}, legs:[...], walkToMin, walkFromMin, totalMin }
 * @param {{origin?: number[], dest?: number[], sink?: object[]}} [opts]
 *        关卡编辑器不用当前对局的起终点，覆盖物也放进自己的数组；
 *        sink.dead 为真（调用方已清掉这批覆盖物）时，异步算完的步行段不再画上去。
 */
export function drawOptimalRoute(result, { origin = state.ORIGIN, dest = state.DEST, sink = null } = {}) {
  if (!sink) { clearOptimalOverlays(); sink = state.optimalOverlays; }
  const add = (overlay) => { overlay.setMap(state.map); sink.push(overlay); };
  const walk = (a, b) => activeWalk(a, b).then((r) => { if (r.path && !sink.dead) drawOptimalWalk(r.path, add); });
  walk(origin, [result.board.lng, result.board.lat]);

  let prevAlight = null;
  for (const leg of result.legs) {
    if (leg.type !== 'ride') continue;
    const line = getLine(leg.lineId);
    const from = getLogical(leg.fromLogicalId);
    const to = getLogical(leg.toLogicalId);
    if (!line || !from || !to) continue;
    const sub = lineSegmentPath(line, from, to);
    if (sub && sub.length >= 2) {
      drawOptimalRide(sub, add);
      // 换乘步行虚线：上一乘车段下车点 ↔ 本乘车段上车点
      if (prevAlight) drawOptimalTransferWalk(prevAlight, sub[0], add);
      prevAlight = sub[sub.length - 1];
    }
  }
  walk([result.alight.lng, result.alight.lat], dest);
}

/**
 * 在最优路线旁放站名牌：每段乘车的上车站（站名 + 线路牌），以及下车站（只有站名）；
 * 下车站与下一段的上车站是同一站时只放一块。站名牌不接收点击。
 */
export function drawRouteStationSigns(result, sink) {
  const rides = result.legs.filter((leg) => leg.type === 'ride');
  rides.forEach((leg, i) => {
    const line = getLine(leg.lineId);
    const from = getLogical(leg.fromLogicalId);
    const to = getLogical(leg.toLogicalId);
    if (!line || !from || !to) return;
    addStationSign(from, line, sink);
    const next = rides[i + 1];
    if (!next || next.fromLogicalId !== leg.toLogicalId) addStationSign(to, null, sink);
  });
}

function addStationSign(stop, line, sink) {
  const mode = line ? line.mode : (stop.mode || 'bus');
  const tag = line
    ? `<span class="${lineSignClass(line)}" style="background-color:${escapeHtml(line.color || (line.mode === 'metro' ? '#e74c3c' : '#f39c12'))}">${lineSignInnerHTML(line)}</span>`
    : '';
  const marker = new AMap.Marker({
    position: [stop.lng, stop.lat],
    content: `<div class="rss-anchor"><div class="route-stop-sign ${mode === 'metro' ? 'metro' : 'bus'}">`
      + `<span class="rss-name">${escapeHtml(stop.name)}</span>${tag}</div></div>`,
    offset: new AMap.Pixel(0, 0), zIndex: 420, clickable: false, bubble: true,
  });
  marker.setMap(state.map);
  sink.push(marker);
}

/** 最优路线的步行段（与玩家步行统一为绿色细虚线） */
function drawOptimalWalk(path, add) {
  const poly = new AMap.Polyline({
    path, strokeColor: WALK_COLOR, strokeWeight: WALK_LINE_WEIGHT, strokeOpacity: 0.9,
    strokeStyle: 'dashed', dashArray: [10, 8], lineJoin: 'round', zIndex: 382,
  });
  add(poly);
  tagRouteOverlay(poly, 'optimal', 382);
  fadeInOverlay(poly);
}

/** 最优路线的一段乘车（白色描边 + 青色实线，两条折线） */
function drawOptimalRide(path, add) {
  const casing = new AMap.Polyline({ path, strokeColor: OPTIMAL_CASING, strokeWeight: 11, strokeOpacity: 0.9, lineJoin: 'round', zIndex: 384 });
  add(casing);
  tagRouteOverlay(casing, 'optimal', 384);
  fadeInOverlay(casing);

  const main = new AMap.Polyline({ path, strokeColor: OPTIMAL_COLOR, strokeWeight: 7, strokeOpacity: 0.95, lineJoin: 'round', zIndex: 385 });
  add(main);
  tagRouteOverlay(main, 'optimal', 385);
  fadeInOverlay(main);
}

/** 标记最优路线的换乘点（橙色"换"图钉）；sink 同 drawOptimalRoute（关卡编辑器传自己的数组） */
export function drawOptimalTransfers(result, sink = state.optimalOverlays) {
  for (const leg of result.legs) {
    if (leg.type !== 'transfer') continue;
    const log = getLogical(leg.logicalId);
    if (!log) continue;
    const m = new AMap.Marker({
      position: [log.lng, log.lat],
      content: '<div class="pin transfer">换</div>',
      offset: new AMap.Pixel(-12, -12),
      zIndex: 430,
    });
    m.setMap(state.map);
    sink.push(m);
  }
}

/** 最优路线的换乘步行虚线（与玩家路线同规则：超过阈值才画） */
function drawOptimalTransferWalk(p1, p2, add) {
  if (!p1 || !p2) return;
  if (haversineKm(p1, p2) * 1000 < TRANSFER_WALK_MIN_M) return;
  const poly = new AMap.Polyline({
    path: [p1, p2], strokeColor: WALK_COLOR, strokeWeight: WALK_LINK_WEIGHT, strokeOpacity: 0.9,
    strokeStyle: 'dashed', dashArray: [6, 6], lineJoin: 'round', zIndex: 383,
  });
  add(poly);
  tagRouteOverlay(poly, 'optimal', 383);
  fadeInOverlay(poly);
}

/** 移除并清空最优路线覆盖物（硬移除，避免残留） */
export function clearOptimalOverlays() {
  const overlays = state.optimalOverlays;
  state.optimalOverlays = [];
  for (const o of overlays) removeOverlay(o);
}

/** 清除最优路线（覆盖物 + 结果数据） */
export function clearOptimal() {
  clearOptimalOverlays();
  state.optimalResult = null;
}
