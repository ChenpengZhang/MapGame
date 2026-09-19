/**
 * ui/route-panel.js —— 路线面板渲染（右下角的分段明细）
 *
 * 【它渲染什么】
 *   左侧面板按顺序列出：起点步行 → 等车 → 乘车（站数/距离/分钟）→ 换乘 → … → 终点步行，
 *   最后一行是总耗时；如果最优路线已算出，再追加一段"最优路线（系统）"和评分对比。
 *
 * 【分层约定（重要）】
 *   本模块是"哑"的渲染层：只读 state 和纯函数（game/time-model.js），
 *   不 import 任何 game 流程模块（route/optimal/session/flow），
 *   因此游戏流程可以放心地调用它而不会形成循环依赖。
 *
 * 【为什么用拼接字符串而不是 DOM API】
 *   面板行数在换乘多时会到几十行，字符串拼接 + 一次 innerHTML 只触发一次重排，
 *   比逐行 appendChild 更省。代价是这里的 HTML 片段必须自己保证转义/闭合。
 */

import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { haversineKm } from '../core/router-api.js';
import { getLine } from '../data/index-builder.js';
import { computeTotalMinutes, waitMin, rideStats, estimateRideMinutes, transferPenaltyMin, scoreFor } from '../game/time-model.js';

/** 折叠状态：null 表示尚未按设备初始化（手机默认收起、桌面默认展开） */
let collapsed = null;

/**
 * 把折叠状态应用到面板，并（重新）绑定「收起/展开」按钮。
 * 面板每次重绘都会用 innerHTML 重建，所以按钮的事件要在这里重新挂一次。
 */
function applyCollapse(panel) {
  if (collapsed === null) collapsed = !!state.isTouch;
  panel.classList.toggle('collapsed', collapsed);
  const btn = $('rp-toggle-btn');
  if (btn) {
    btn.textContent = collapsed ? '展开' : '收起';
    btn.addEventListener('click', toggleRoutePanel);
  }
}

/** 收起/展开路线面板（手机端面板太占地方时用） */
export function toggleRoutePanel() {
  collapsed = !collapsed;
  const panel = $('route-panel');
  if (panel) applyCollapse(panel);
}

/** 距离格式化：≥1km 显示一位小数，否则显示米 */
function fmtDist(km) {
  if (km == null || !(km > 0)) return '';
  if (km >= 1) return km.toFixed(1) + 'km';
  return Math.round(km * 1000) + 'm';
}

function walkRowHTML(fromName, toName, distKm, timeMin) {
  const d = (distKm != null && distKm > 0) ? '<span class="rp-km">' + fmtDist(distKm) + '</span>' : '';
  return '<div class="rp-row"><span class="rp-desc">🚶 <span class="rp-station">' + fromName + '</span> → <span class="rp-station">' + toName + '</span></span>' +
    '<span class="rp-metrics">' + d + '<span class="rp-time">' + timeMin.toFixed(0) + '分</span></span></div>';
}

function lineRowHTML(lineName, waitMinutes) {
  return '<div class="rp-row"><span class="rp-desc">🚌 <span class="rp-pill">' + lineName + '</span></span>' +
    '<span class="rp-metrics"><span class="rp-time">' + waitMinutes.toFixed(0) + '分</span></span></div>';
}

function rideRowHTML(fromName, toName, stops, distKm, rideMin) {
  let m = '';
  if (stops != null) m += '<span class="rp-stops">' + stops + '站</span>';
  if (distKm != null && distKm > 0) m += '<span class="rp-km">' + fmtDist(distKm) + '</span>';
  m += '<span class="rp-time">' + rideMin.toFixed(0) + '分</span>';
  return '<div class="rp-row"><span class="rp-desc"><span class="rp-station">' + fromName + '</span> → <span class="rp-station">' + toName + '</span></span>' +
    '<span class="rp-metrics">' + m + '</span></div>';
}

function transferRowHTML(label, penaltyMin) {
  const t = penaltyMin > 0 ? ('+' + penaltyMin.toFixed(0) + '分') : '0分';
  return '<div class="rp-row"><span class="rp-desc">　↪ <span class="rp-pill">' + label + '</span></span>' +
    '<span class="rp-metrics"><span class="rp-time">' + t + '</span></span></div>';
}

/** 重绘整个路线面板（每选一个站、撤回、完成后都会调用） */
export function renderRoutePanel() {
  const panel = $('route-panel');
  if (!panel) return;
  const rows = [];
  rows.push('<div class="rp-title"><span>路线规划</span><button type="button" class="rp-toggle" id="rp-toggle-btn">收起</button></div>');

  if (!state.routeStops.length) {
    // 纯步行路线（未选任何站点直接点终点）
    if (state.finished) {
      rows.push(walkRowHTML(state.ORIGIN_NAME, state.DEST_NAME, haversineKm(state.ORIGIN, state.DEST), state.walkToFirstMin));
    } else {
      rows.push('<div class="rp-desc" style="color:#888;">…（点击站点开始规划，或点击「终」图钉直接步行到终点）</div>');
    }
    rows.push('<div class="rp-total">总耗时约 ' + computeTotalMinutes().toFixed(0) + ' 分钟</div>');
    appendOptimalComparison(rows);
    panel.innerHTML = rows.join('');
    applyCollapse(panel);
    panel.classList.remove('hidden');
    return;
  }

  // 步行到首站
  rows.push(walkRowHTML(
    state.ORIGIN_NAME, state.routeStops[0].logical.name,
    haversineKm(state.ORIGIN, state.routeStops[0].point), state.walkToFirstMin
  ));

  for (let i = 0; i < state.routeRides.length; i++) {
    const line = state.routeRides[i];
    const from = state.routeStops[i].logical, to = state.routeStops[i + 1].logical;
    rows.push(lineRowHTML(line.name, waitMin(line)));
    const st = rideStats(line, from, to);
    rows.push(rideRowHTML(
      from.name, to.name,
      st ? st.segments : null,
      st && st.hasDist ? st.distanceKm : null,
      estimateRideMinutes(line, from, to)
    ));
    if (i < state.routeRides.length - 1) {
      const tp = transferPenaltyMin(line, state.routeRides[i + 1]);
      rows.push(transferRowHTML(tp > 0 ? '换乘' : '同站换乘', tp));
    }
  }

  if (state.finished) {
    const last = state.routeStops[state.routeStops.length - 1];
    rows.push(walkRowHTML(last.logical.name, state.DEST_NAME, haversineKm(last.point, state.DEST), state.walkToDestMin));
  } else {
    rows.push('<div class="rp-desc" style="color:#888;">…（继续选站，或点击「终」图钉完成）</div>');
  }
  rows.push('<div class="rp-total">总耗时约 ' + computeTotalMinutes().toFixed(0) + ' 分钟</div>');

  appendOptimalComparison(rows);

  panel.innerHTML = rows.join('');
  applyCollapse(panel);
  panel.classList.remove('hidden');
}

/** 追加"最优路线（系统）"明细与评分对比（无最优结果时什么都不做） */
function appendOptimalComparison(rows) {
  const opt = state.optimalResult;
  if (!opt) return;

  rows.push('<hr style="border:none;border-top:1px dashed #ccc;margin:6px 0;">');
  rows.push('<div class="rp-title" style="color:#00897b;">🏆 最优路线（系统）</div>');
  rows.push(walkRowHTML(
    state.ORIGIN_NAME, opt.board.name,
    haversineKm(state.ORIGIN, [opt.board.lng, opt.board.lat]), opt.walkToMin
  ));

  for (const leg of opt.legs) {
    if (leg.type === 'transfer') {
      const la = getLine(leg.fromLineId);
      const lb = getLine(leg.toLineId);
      const tp = (la && lb) ? transferPenaltyMin(la, lb) : 0;
      rows.push(transferRowHTML(tp > 0 ? '换乘' : '同站换乘', tp));
    } else {
      rows.push(lineRowHTML(leg.lineName, leg.waitMin));
      rows.push(rideRowHTML(leg.fromName, leg.toName, leg.stops, leg.distanceKm, leg.rideMin));
    }
  }
  rows.push(walkRowHTML(
    opt.alight.name, state.DEST_NAME,
    haversineKm([opt.alight.lng, opt.alight.lat], state.DEST), opt.walkFromMin
  ));
  rows.push('<div class="rp-total" style="color:#00897b;">最优总耗时约 ' + opt.totalMin.toFixed(0) + ' 分钟</div>');

  const playerTotal = computeTotalMinutes();
  const gap = playerTotal - opt.totalMin;
  const gapRatio = opt.totalMin > 0 ? gap / opt.totalMin : 0;
  const s = scoreFor(gapRatio);
  const gapTxt = gapRatio > 0.001
    ? ('比最优慢 ' + (gapRatio * 100).toFixed(0) + '%（+' + gap.toFixed(0) + ' 分钟）')
    : '与最优持平！';
  rows.push('<div style="color:' + s.color + ';font-weight:700;">评分：' + s.label + ' ' + s.stars + ' · ' + gapTxt + '</div>');
}
