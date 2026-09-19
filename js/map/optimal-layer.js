/**
 * map/optimal-layer.js —— 最优路线绘制层（青绿色）
 *
 * 【画什么】
 *   系统算出的最优路线：起点步行（虚线）→ 各乘车段（白描边 + 青色主线）→
 *   换乘点橙色"换"图钉 → 终点步行（虚线）。
 *   与玩家路线配色区分开（玩家是深色黑线），并共用"悬停整组置顶"的交互。
 *
 * 【与玩家路线层的关系】
 *   折线取段（lineSegmentPath）和置顶分组（tagRouteOverlay）是两套路线共用的能力，
 *   实现在 route-layer.js 里，本模块直接复用，避免两份环线取段逻辑走偏。
 */

import { state } from '../core/state.js';
import { OPTIMAL_COLOR, OPTIMAL_CASING, TRANSFER_WALK_MIN_M } from '../core/config.js';
import { getLine, getLogical } from '../data/index-builder.js';
import { fadeInOverlay, removeOverlay } from './anim.js';
import { tagRouteOverlay, lineSegmentPath } from './route-layer.js';
import { activeWalk } from './walk.js';
import { haversineKm } from '../core/router-api.js';

/**
 * 绘制最优路线全过程（覆盖物统一记录在 state.optimalOverlays 里，便于整体清除）。
 * @param {object} result router.findOptimalRoute 的返回值
 *        { board:{lng,lat,name}, alight:{...}, legs:[...], walkToMin, walkFromMin, totalMin }
 */
export function drawOptimalRoute(result) {
  clearOptimalOverlays();
  activeWalk(state.ORIGIN, [result.board.lng, result.board.lat]).then((r) => { if (r.path) drawOptimalWalk(r.path); });

  let prevAlight = null;
  for (const leg of result.legs) {
    if (leg.type !== 'ride') continue;
    const line = getLine(leg.lineId);
    const from = getLogical(leg.fromLogicalId);
    const to = getLogical(leg.toLogicalId);
    if (!line || !from || !to) continue;
    const sub = lineSegmentPath(line, from, to);
    if (sub && sub.length >= 2) {
      drawOptimalRide(sub);
      // 换乘步行虚线：上一乘车段下车点 ↔ 本乘车段上车点
      if (prevAlight) drawOptimalTransferWalk(prevAlight, sub[0]);
      prevAlight = sub[sub.length - 1];
    }
  }
  activeWalk([result.alight.lng, result.alight.lat], state.DEST).then((r) => { if (r.path) drawOptimalWalk(r.path); });
}

/** 最优路线的步行段（青色虚线） */
function drawOptimalWalk(path) {
  const poly = new AMap.Polyline({
    path, strokeColor: OPTIMAL_COLOR, strokeWeight: 4, strokeOpacity: 0.9,
    strokeStyle: 'dashed', dashArray: [10, 8], lineJoin: 'round', zIndex: 382,
  });
  poly.setMap(state.map);
  tagRouteOverlay(poly, 'optimal', 382);
  fadeInOverlay(poly);
  state.optimalOverlays.push(poly);
}

/** 最优路线的一段乘车（白描边 + 青色主线，两条折线） */
function drawOptimalRide(path) {
  const casing = new AMap.Polyline({ path, strokeColor: OPTIMAL_CASING, strokeWeight: 11, strokeOpacity: 0.9, lineJoin: 'round', zIndex: 384 });
  casing.setMap(state.map);
  tagRouteOverlay(casing, 'optimal', 384);
  fadeInOverlay(casing);
  state.optimalOverlays.push(casing);

  const main = new AMap.Polyline({ path, strokeColor: OPTIMAL_COLOR, strokeWeight: 7, strokeOpacity: 0.95, lineJoin: 'round', zIndex: 385 });
  main.setMap(state.map);
  tagRouteOverlay(main, 'optimal', 385);
  fadeInOverlay(main);
  state.optimalOverlays.push(main);
}

/** 标记最优路线的换乘点（橙色"换"图钉） */
export function drawOptimalTransfers(result) {
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
    state.optimalOverlays.push(m);
  }
}

/** 最优路线的换乘步行虚线（与玩家路线同规则：超过阈值才画） */
function drawOptimalTransferWalk(p1, p2) {
  if (!p1 || !p2) return;
  if (haversineKm(p1, p2) * 1000 < TRANSFER_WALK_MIN_M) return;
  const poly = new AMap.Polyline({
    path: [p1, p2], strokeColor: OPTIMAL_COLOR, strokeWeight: 3, strokeOpacity: 0.9,
    strokeStyle: 'dashed', dashArray: [6, 6], lineJoin: 'round', zIndex: 383,
  });
  poly.setMap(state.map);
  tagRouteOverlay(poly, 'optimal', 383);
  fadeInOverlay(poly);
  state.optimalOverlays.push(poly);
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
