/**
 * game/route.js —— 玩家路线规划流程（玩法核心）
 *
 * 【一次规划的完整生命周期】
 *   点第一个站           → startRoute：重置路线、画起点步行、淡出基础站点层、亮出候选网络
 *   点沿途站             → onCandidateStopClick：按"两站共有的线路"接一段乘车 + 换乘步行
 *   点"终"图钉           → finishRoute：画终点步行、算总耗时、触发最优路线计算
 *   点"上一步"           → undoRoute：按分组撤回最后一步
 *   点"取消"/切菜单/重开 → resetRoute：清空路线并恢复浏览态
 *
 * 【规则要点（都有踩坑背景，勿随意简化）】
 *   - 起终点步行上限 1.5km：超过则不允许选该站（避免"走 5 公里再坐地铁"的畸形解）；
 *   - 同一逻辑站不能重复经过；两站必须有共有线路才能乘车；
 *   - 换乘线路的优先级：站数少优先，站数相同地铁优先（避免地铁环线绕远、被慢车坑）；
 *   - 起点步行与终点步行的绘制是异步的（现在返回同步结果，但按其 Promise 语义写），
 *     回调里要确认"这一组覆盖物还在"（可能已被撤回/重置），否则会出现幽灵路线。
 */

import { state } from '../core/state.js';
import { MAX_WALK_M } from '../core/config.js';
import { showCenterToast, setStatus, setText, hide, show, $ } from '../core/dom.js';
import { resolveStop, getLine, getPhys, findStopInLine, distM } from '../data/index-builder.js';
import { makeMassMarks, stopToData } from '../map/stop-marks.js';
import { fadeInOverlay, setMassMarksMap, removeOverlay } from '../map/anim.js';
import { hideBaseStops, updateStopsByZoom } from '../map/stop-layer.js';
import { addStopMarker, drawRideSegment, drawTransferWalk, rideEndpoint, drawWalkLeg, clearGroupOverlays } from '../map/route-layer.js';
import { onStopMouseOver, onStopMouseOut } from '../map/hover.js';
import { clearOptimal } from '../map/optimal-layer.js';
import { haversineKm } from '../core/router-api.js';
import { rideStats } from './time-model.js';
import { computeOptimal } from './optimal.js';
import { renderRoutePanel } from '../ui/route-panel.js';
import { updateButtons, updateLegend } from '../ui/menu.js';

/** 候选站点层最多显示多少个点（避免海量点拖慢地图） */
const MAX_CANDIDATE_POINTS = 3000;

// ============ 起点：点第一个站 ============

/** 基础站点层的点击回调（由 app.js 注入到 map/stop-layer.js） */
export function onStopClick(e) {
  if (state.storyActive) return; // 剧情/教学期间禁止开始规划
  if (state.showAllStops) { showCenterToast('请关闭全图显示后继续'); return; }
  const phys = e && e.data;
  const logical = resolveStop(phys);
  if (!phys || !logical || state.routeStops.length) return;
  // 起点步行上限：不允许超过 1.5km
  if (haversineKm(state.ORIGIN, phys.lnglat) * 1000 > MAX_WALK_M) {
    showCenterToast('距离起点步行超过 1.5km，请选择更近的站点');
    return;
  }
  if (state.isTouch) {
    // 手机两阶段：第一次点预览换乘站；再次点击同一站 = 确认开始
    if (state.pendingStart && String(state.pendingStart.logical.id) === String(logical.id)) {
      confirmStart();
    } else {
      previewStart({ logical, point: phys.lnglat });
    }
  } else {
    startRoute({ logical, point: phys.lnglat });
  }
}

/** 手机端两阶段选站 · 第一步：预览换乘站，不立即开始路线 */
function previewStart(d) {
  state.pendingStart = d;
  hideBaseStops();                 // 只显示换乘站，避免与基础站点重叠
  showCandidateNetwork(d.logical); // 显示换乘站 + 可达线路
  show('btn-group');
  show('confirm-start-btn');
  hide('undo-btn');
  hide('show-all-btn');
  hide('tower-restart-btn');
  show('reset-btn');
  setText('reset-btn', '取消');
  updateLegend();
  setStatus('起点预览：' + d.logical.name + '，再次点击该站确认起点');
}

/** 手机端两阶段选站 · 第二步：确认（由 app.js 的「确认起点」按钮调用） */
export function confirmStart() {
  const d = state.pendingStart;
  if (!d) return;
  startRoute(d); // startRoute 内的 resetRoute 会清空 pendingStart 并隐藏确认按钮
}

/** 开始规划：以该站为首站 */
function startRoute(d) {
  resetRoute();
  state.routeOverlayGroups = [[]]; // 第一组：首站标记 + 首段步行
  state.routeStops = [d];
  updateLegend(); // 开始规划后隐藏图例
  addStopMarker(1, d.point);

  hideBaseStops();

  drawWalkLeg(state.ORIGIN, d.point).then((w) => {
    state.walkToFirstMin = w.min;
    renderRoutePanel();
  });

  showCandidateNetwork(d.logical);
  renderRoutePanel();
  show('btn-group');
  updateButtons();
  setStatus('已选择 ' + d.logical.name + '，点击沿途站点换乘，点击「终」完成');
}

// ============ 中间：点沿途站接一段乘车 ============

/** 候选站点层的点击回调（候选网络内的点） */
export function onCandidateStopClick(phys) {
  if (state.showAllStops) { showCenterToast('请关闭全图显示后继续'); return; }
  const logical = resolveStop(phys);
  if (!logical) return;
  // 手机两阶段预览态：起点也会出现在候选网络里，再次点到它 = 确认
  if (state.pendingStart && String(logical.id) === String(state.pendingStart.logical.id)) {
    confirmStart();
    return;
  }
  if (!state.routeStops.length || state.finished) return;

  const prev = state.routeStops[state.routeStops.length - 1];
  if (String(logical.id) === String(prev.logical.id)) return;
  if (state.routeStops.some((s) => String(s.logical.id) === String(logical.id))) return;

  const shared = sharedLines(prev.logical, logical);
  if (!shared.length) return;

  const line = shared[0]; // 站数更少优先（同站数时地铁优先）
  // 到达点 = 该线路上的物理站坐标（乘车段终点，也是下一步步行的起点）
  const physStop = findStopInLine(line, logical);
  const point = physStop ? [physStop.lng, physStop.lat] : (phys.lnglat || [logical.lng, logical.lat]);
  const cur = { logical, point };

  state.routeOverlayGroups.push([]); // 新组：本步站点标记 + 乘车段（供撤回）
  state.routeRides.push(line);
  state.routeStops.push(cur);
  addStopMarker(state.routeStops.length, cur.point);
  drawRideSegment(line, prev.logical, cur.logical);

  // 换乘步行虚线：换乘发生在 prev.logical（上一步终点=本步起点）。
  // 连接「上一条线在 prev 的下车点」↔「本条线在 prev 的上车点」，两者相距较远才画。
  if (state.routeRides.length >= 2) {
    const prevLine = state.routeRides[state.routeRides.length - 2];
    drawTransferWalk(rideEndpoint(prevLine, prev.logical), rideEndpoint(line, prev.logical));
  }

  showCandidateNetwork(cur.logical);
  renderRoutePanel();
  setStatus('继续点击沿途站点换乘，或点击「终」完成');
}

// ============ 终点：完成规划 ============

/** 点"终"图钉（或终点步行）后完成规划，并触发最优路线对比 */
export function finishRoute() {
  if (state.finished) return;

  // 未选择任何站点：直接从起点步行到终点
  if (!state.routeStops.length) {
    if (haversineKm(state.ORIGIN, state.DEST) * 1000 > MAX_WALK_M) {
      showCenterToast('起点到终点超过 1.5km，无法直接步行到达，请先选站点');
      return;
    }
    state.routeOverlayGroups.push([]);
    const g = state.routeOverlayGroups[state.routeOverlayGroups.length - 1];
    drawWalkLeg(state.ORIGIN, state.DEST, g).then((w) => {
      if (state.routeOverlayGroups[state.routeOverlayGroups.length - 1] !== g) return; // 已被撤回
      state.walkToFirstMin = w.min;
      state.walkToDestMin = 0;
      state.finished = true;
      clearCandidate();
      updateButtons();
      renderRoutePanel();
      computeOptimal();
    });
    return;
  }

  // 终点步行上限：不允许超过 1.5km
  const last = state.routeStops[state.routeStops.length - 1];
  if (haversineKm(last.point, state.DEST) * 1000 > MAX_WALK_M) {
    showCenterToast('距离终点步行超过 1.5km，请先换乘到更近的站点');
    return;
  }
  state.routeOverlayGroups.push([]); // 终点步行组
  const g = state.routeOverlayGroups[state.routeOverlayGroups.length - 1];
  drawWalkLeg(last.point, state.DEST, g).then((w) => {
    if (state.routeOverlayGroups[state.routeOverlayGroups.length - 1] !== g) return; // 已被撤回
    state.walkToDestMin = w.min;
    state.finished = true;
    clearCandidate();   // 到达后隐藏候选站点/线路
    updateButtons();    // 完成后切换为"重新开始"
    renderRoutePanel();
    computeOptimal();
  });
}

// ============ 重置与撤回 ============

/** 清空整条路线，回到"浏览/选起始站"状态（切关卡、切菜单、重开都会调用） */
export function resetRoute() {
  state.routeStops = [];
  state.routeRides = [];
  state.finished = false;
  state.walkToFirstMin = 0;
  state.walkToDestMin = 0;
  for (const g of state.routeOverlayGroups) clearGroupOverlays(g);
  state.routeOverlayGroups = [];
  clearCandidate();
  clearOptimal();
  state.showAllStops = false;
  state.pendingStart = null; // 取消手机两阶段预览
  const sab = $('show-all-btn');
  if (sab) sab.textContent = '显示全图站点';
  updateButtons();
  updateLegend(); // 重新开始后恢复图例
  hide('route-panel');
  hide('btn-group');
  hide('confirm-start-btn');
  hide('result-overlay');
  hide('result-toggle-btn');
  updateStopsByZoom();
}

/** 撤回上一步：仅规划中可用（完成后由"重新开始"重置） */
export function undoRoute() {
  if (state.finished) return; // 完成后不可撤回
  if (!state.routeStops.length) return;
  if (state.routeStops.length > 1) {
    const g = state.routeOverlayGroups.pop();
    clearGroupOverlays(g);
    state.routeRides.pop();
    state.routeStops.pop();
    const prev = state.routeStops[state.routeStops.length - 1];
    showCandidateNetwork(prev.logical);
    renderRoutePanel();
    setStatus('已撤回一步，可继续选择');
    return;
  }
  resetRoute();
}

// ============ 候选网络（当前站可换乘的线路 + 沿途站点） ============

/** 按设置返回可用线路（禁用地铁时过滤地铁线） */
function allowedLines(lineIds) {
  return (lineIds || []).map((id) => getLine(id)).filter((l) => l && (!state.scenario.noMetro || l.mode !== 'metro'));
}

/** 两站共有的可用线路，按"站数少优先，同站数地铁优先"排序 */
function sharedLines(s1, s2) {
  const set1 = new Set(s1.line_ids || []);
  const shared = [];
  for (const id of s2.line_ids || []) {
    if (!set1.has(id)) continue;
    const line = getLine(id);
    if (!line) continue;
    if (state.scenario.noMetro && line.mode === 'metro') continue;
    shared.push(line);
  }
  // 站数更少优先：避免地铁环线绕远、公交坐慢车；站数相同时地铁优先
  shared.sort((a, b) => {
    const stA = rideStats(a, s1, s2);
    const stB = rideStats(b, s1, s2);
    const segA = stA ? stA.segments : Infinity;
    const segB = stB ? stB.segments : Infinity;
    if (segA !== segB) return segA - segB;
    return (a.mode === 'metro' ? 0 : 1) - (b.mode === 'metro' ? 0 : 1);
  });
  return shared;
}

/**
 * 亮出候选网络：当前站可换乘的线路（浅色折线）+ 这些线路沿途的站点。
 * 沿途站点 = 只显示候选线路上真实经过的物理站（不显示合并进来的公交/地铁"小弟"）。
 * 例如地铁线过菜户营，只显示红色的地铁点；除非真有从当前站出发的公交线也过菜户营。
 * 仍按"换乘枢纽优先 + 就近优先"排序并设上限，避免海量点拖慢地图。
 */
function showCandidateNetwork(stop) {
  clearCandidate();
  const lines = allowedLines(stop.line_ids);

  for (const line of lines) {
    if (!line.path || line.path.length < 2) continue;
    const poly = new AMap.Polyline({
      path: line.path, strokeColor: line.color,
      strokeWeight: line.mode === 'metro' ? 4 : 2.5, strokeOpacity: 0.7,
      lineJoin: 'round', zIndex: 180,
    });
    poly.setMap(state.map);
    fadeInOverlay(poly);
    state.candidateOverlays.push(poly);
  }

  const lineIdSet = new Set(lines.map((l) => String(l.id)));
  const curPt = { lng: stop.lng, lat: stop.lat };
  const onLogicals = [];
  for (const ls of state.logicalStops) {
    const ids = [];
    for (const lid of ls.line_ids) {
      if (!lineIdSet.has(lid)) continue;
      const pid = ls.stopByLine[lid];
      if (pid) ids.push(pid);
    }
    if (ids.length) onLogicals.push({ ls, ids: Array.from(new Set(ids)) });
  }
  onLogicals.sort((a, b) => {
    const ha = a.ls.line_ids.length >= 2 ? 0 : 1; // 多线换乘枢纽优先
    const hb = b.ls.line_ids.length >= 2 ? 0 : 1;
    if (ha !== hb) return ha - hb;
    return distM({ lng: a.ls.lng, lat: a.ls.lat }, curPt) - distM({ lng: b.ls.lng, lat: b.ls.lat }, curPt);
  });

  const points = [];
  for (const { ids } of onLogicals) {
    for (const pid of ids) {
      const p = getPhys(pid);
      if (p) points.push(p);
    }
    if (points.length >= MAX_CANDIDATE_POINTS) break;
  }

  state.candidateMarks = makeMassMarks(points.map(stopToData));
  setMassMarksMap(state.candidateMarks, state.map);
  fadeInOverlay(state.candidateMarks);
  state.candidateMarks.on('click', (e) => {
    const dd = e && e.data;
    if (dd) onCandidateStopClick(dd);
  });
  state.candidateMarks.on('mouseover', onStopMouseOver);
  state.candidateMarks.on('mouseout', onStopMouseOut);
}

/** 隐藏并清空候选网络（硬移除，避免淡出回调不触发导致残留） */
export function clearCandidate() {
  const polylines = state.candidateOverlays;
  state.candidateOverlays = [];
  for (const o of polylines) removeOverlay(o);
  const mm = state.candidateMarks;
  state.candidateMarks = null;
  if (mm) removeOverlay(mm);
}
