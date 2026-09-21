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
import { MAX_WALK_M, MERGE_DISTANCE_M, WALK_TRANSFER_MAX_M } from '../core/config.js';
import { showCenterToast, setStatus, setText, hide, show, $ } from '../core/dom.js';
import { resolveStop, getLine, getPhys, findStopInLine, stopIndexInLine, distM } from '../data/index-builder.js';
import { makeMassMarks, stopToData } from '../map/stop-marks.js';
import { fadeInOverlay, setMassMarksMap, removeOverlay } from '../map/anim.js';
import { hideBaseStops, updateStopsByZoom } from '../map/stop-layer.js';
import { addStopMarker, drawRideSegment, drawTransferWalk, drawWalkTransfer, rideEndpoint, drawWalkLeg, clearGroupOverlays } from '../map/route-layer.js';
import { onStopMouseOver, onStopMouseOut, clearHighlight, renderHighlight, cancelPreview } from '../map/hover.js';
import { clearOptimal } from '../map/optimal-layer.js';
import { haversineKm } from '../core/router-api.js';
import { rideStats } from './time-model.js';
import { computeOptimal } from './optimal.js';
import { renderRoutePanel } from '../ui/route-panel.js';
import { updateButtons, updateLegend } from '../ui/menu.js';

/** 候选站点层最多显示多少个点（避免海量点拖慢地图） */
const MAX_CANDIDATE_POINTS = 3000;

// ============ 起点：点第一个站 ============

/** 判断两个逻辑站是否同一个（id 可能来自不同来源，统一转字符串比较） */
function sameLogical(a, b) {
  return String(a.id) === String(b.id);
}

/** "下一步该点哪里"的状态栏提示（手机端是两阶段点击，桌面是单击） */
function ridingHint() {
  return state.isTouch
    ? '点一下沿途站高亮、再点一下确定换乘；点击「终」完成'
    : '点击沿途站点换乘，点击「终」完成';
}

/** 基础站点层的点击回调（由 app.js 注入到 map/stop-layer.js） */
export function onStopClick(e) {
  if (state.storyActive) return; // 剧情/教学期间禁止开始规划
  const phys = e && e.data;
  const logical = resolveStop(phys);
  if (!phys || !logical || state.routeStops.length) return;
  // 起点步行上限：不允许超过 1.5km
  if (haversineKm(state.ORIGIN, phys.lnglat) * 1000 > MAX_WALK_M) {
    showCenterToast('距离起点步行超过 1.5km，请选择更近的站点');
    return;
  }
  if (state.isTouch) {
    if (state.pendingStart && sameLogical(state.pendingStart.logical, logical)) {
      // 确定：全图显示下只用于查看，不允许确定
      if (state.showAllStops) { showCenterToast('请关闭全图显示后再确定'); return; }
      confirmStart();
    } else {
      // 预览：全图显示下也允许（方便查看该站换乘线路）
      previewStart({ logical, point: phys.lnglat });
    }
  } else {
    // 桌面：直接开始
    if (state.showAllStops) { showCenterToast('请关闭全图显示后继续'); return; }
    startRoute({ logical, point: phys.lnglat });
  }
}

/** 手机端选站 · 第一步：模拟"鼠标悬浮"效果（高亮该站 + 信息卡），不立即开始 */
function previewStart(d) {
  state.pendingStart = d;
  renderHighlight(d.logical);
  show('btn-group');
  hide('undo-btn');
  hide('show-all-btn');
  hide('tower-restart-btn');
  hide('force-walk-row'); // 尚未开始规划，不显示"强制步行"
  show('reset-btn');
  setText('reset-btn', '取消');
  setStatus('已高亮 ' + d.logical.name + '，再次点击确认起点');
}

/** 手机端选站 · 第二步：确认起点（再次点击同一站触发） */
export function confirmStart() {
  const d = state.pendingStart;
  if (!d) return;
  startRoute(d); // startRoute 内的 resetRoute 会清空 pendingStart
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
  setStatus('已选择 ' + d.logical.name + '，' + ridingHint());
}

// ============ 中间：点沿途站接一段乘车 ============

/** 候选站点层的点击回调（候选网络内的点） */
export function onCandidateStopClick(phys) {
  const logical = resolveStop(phys);
  if (!logical) return;
  // 手机预览起点阶段：起点也在候选网络里，再次点到它 = 确认起点
  if (state.pendingStart && sameLogical(state.pendingStart.logical, logical)) {
    if (state.showAllStops) { showCenterToast('请关闭全图显示后再确定'); return; }
    confirmStart();
    return;
  }
  if (!state.routeStops.length || state.finished) return;

  const prev = state.routeStops[state.routeStops.length - 1];
  if (sameLogical(logical, prev.logical)) return;
  if (state.routeStops.some((s) => sameLogical(s.logical, logical))) return;

  if (state.isTouch) {
    // 手机两阶段：第一次点候选站 = 悬浮高亮；再次点同一站 = 确定换乘（等价于桌面第一次点击）
    if (state.pendingCandidate && sameLogical(state.pendingCandidate.logical, logical)) {
      // 确定：全图显示下只用于查看，不允许确定
      if (state.showAllStops) { showCenterToast('请关闭全图显示后再确定'); return; }
      confirmCandidate(logical);
    } else {
      // 预览：全图显示下也允许
      previewCandidate(logical);
    }
  } else {
    if (state.showAllStops) { showCenterToast('请关闭全图显示后继续'); return; }
    commitCandidate(logical, prev);
  }
}

/** 手机端选下一站 · 第一步：模拟"鼠标悬浮"效果，不立即确定 */
function previewCandidate(logical) {
  state.pendingCandidate = { logical };
  renderHighlight(logical);
  setStatus('已高亮 ' + logical.name + '，再次点击确定换乘到该站');
}

/** 手机端选下一站 · 第二步：确定 */
function confirmCandidate(logical) {
  state.pendingCandidate = null;
  commitCandidate(logical, state.routeStops[state.routeStops.length - 1]);
}

/**
 * 切换"强制步行"临时开关（由 app.js 绑定复选框时调用）。
 * 切换后重渲染候选网络，让站点颜色即时反映"现在点任意站都会步行"。
 */
export function setForceWalk(on) {
  state.forceWalk = !!on;
  if (state.routeStops.length && !state.finished) {
    showCandidateNetwork(state.routeStops[state.routeStops.length - 1].logical);
  }
}

/** 确定换乘到某候选站（手机第二次点击 / 桌面点击都走这里） */
function commitCandidate(logical, prev) {
  // 强制步行：即使两站共线，也优先步行过去（距离需 ≤ 上限；失败则回退到乘车）
  if (state.walkTransfer && state.forceWalk) {
    if (commitWalkTransfer(logical, prev, true)) return;
  }
  const shared = sharedLines(prev.logical, logical);
  if (shared.length) {
    commitRide(logical, prev, shared[0]);
    return;
  }
  // 无共有线路：非强制时，若开启步行换乘且距离在 (合并距离, 上限] 之间，则步行过去
  //（force 已失败时不重复尝试，避免同一距离弹两次 toast）
  if (state.walkTransfer && !state.forceWalk) {
    commitWalkTransfer(logical, prev, false);
  }
}

/** 正常乘车换乘：两站有共有线路，沿该线接一段乘车 */
function commitRide(logical, prev, line) {
  // 到达点 = 该线路上的物理站坐标（乘车段终点，也是下一步步行的起点）
  const physStop = findStopInLine(line, logical);
  const point = physStop ? [physStop.lng, physStop.lat] : [logical.lng, logical.lat];
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
    if (prevLine) drawTransferWalk(rideEndpoint(prevLine, prev.logical), rideEndpoint(line, prev.logical));
  }

  clearHighlight(); // 清掉预览悬浮高亮
  showCandidateNetwork(cur.logical);
  renderRoutePanel();
  setStatus(ridingHint());
}

/**
 * 步行换乘（实验性，设置里开启）：两站无共有线路（或强制步行）时，
 * 玩家下车步行到下一站，时间按步行速度计算（不计固定换乘惩罚）。
 * @param {boolean} force 强制步行：即使两站共线也步行；非强制时要求距离 > 合并距离
 * @returns {boolean} 是否成功步行换乘
 */
function commitWalkTransfer(logical, prev, force) {
  const dM = distM(
    { lng: prev.point[0], lat: prev.point[1] },
    { lng: logical.lng, lat: logical.lat },
  );
  if (dM > WALK_TRANSFER_MAX_M) {
    showCenterToast('步行距离 ' + Math.round(dM) + ' 米，超过上限 ' + WALK_TRANSFER_MAX_M + ' 米，无法步行换乘');
    return false;
  }
  if (!force && dM <= MERGE_DISTANCE_M) {
    showCenterToast('两站无共有线路，无法换乘（步行距离 ' + Math.round(dM) + ' 米）');
    return false;
  }

  const cur = { logical, point: [logical.lng, logical.lat] };
  state.routeOverlayGroups.push([]);
  state.routeRides.push(null); // null = 步行换乘段（非乘车）
  state.routeStops.push(cur);
  addStopMarker(state.routeStops.length, cur.point);
  drawWalkTransfer(prev.point, cur.point);

  clearHighlight();
  showCandidateNetwork(cur.logical);
  renderRoutePanel();
  setStatus(ridingHint());
  return true;
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
  state.forceWalk = false;    // 重置"强制步行"临时开关
  const fwt = $('force-walk-toggle');
  if (fwt) fwt.checked = false;
  for (const g of state.routeOverlayGroups) clearGroupOverlays(g);
  state.routeOverlayGroups = [];
  clearCandidate();
  clearOptimal();
  clearHighlight();          // 清掉悬浮高亮，避免上一局的线路高亮残留
  state.showAllStops = false;
  state.pendingStart = null; // 取消手机两阶段预览（起点）
  state.pendingCandidate = null; // 取消手机两阶段预览（下一站）
  const sab = $('show-all-btn');
  if (sab) sab.textContent = '显示全图站点';
  updateButtons();
  updateLegend(); // 重新开始后恢复图例
  hide('route-panel');
  hide('btn-group');
  hide('result-overlay');
  hide('result-toggle-btn');
  updateStopsByZoom();
}

/** 撤回上一步：仅规划中可用（完成后由"重新开始"重置） */
export function undoRoute() {
  if (state.finished) return; // 完成后不可撤回
  // 手机端两阶段：预选中点"上一步"= 取消预选，而不是撤回已确认的路线
  if (state.pendingStart || state.pendingCandidate) {
    cancelPreview();
    return;
  }
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

/** 两站共有的可用线路，按"站数少优先，同站数地铁优先"排序；单向线只认前进方向 */
function sharedLines(s1, s2) {
  const set1 = new Set(s1.line_ids || []);
  const shared = [];
  for (const id of s2.line_ids || []) {
    if (!set1.has(id)) continue;
    const line = getLine(id);
    if (!line) continue;
    if (state.scenario.noMetro && line.mode === 'metro') continue;
    // 单向线（公交上下行/环线）：反向不可乘车，直接排除
    if (!rideStats(line, s1, s2)) continue;
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
 * 候选网络里要画的折线：单向线只画「当前站 → 线终点」的前进段（不画反向边），
 * 双向线画整条；单向环线画整圈（前进方向绕一圈回到本站）。
 */
function forwardLinePath(line, stop) {
  if (!line.oneWay) return line.path;
  if (line.isLoop) return line.path; // 单向环线：前进 = 整圈
  const phys = findStopInLine(line, stop);
  if (!phys || !line.path || line.path.length < 2) return line.path;
  let idx = 0, bd = Infinity;
  for (let i = 0; i < line.path.length; i++) {
    const dx = line.path[i][0] - phys.lng, dy = line.path[i][1] - phys.lat;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; idx = i; }
  }
  return line.path.slice(idx);
}

/**
 * 亮出候选网络：当前站可换乘的线路（浅色折线）+ 这些线路沿途的站点。
 * 沿途站点 = 只显示候选线路上真实经过的物理站（不显示合并进来的公交/地铁"小弟"）。
 * 例如地铁线过菜户营，只显示红色的地铁点；除非真有从当前站出发的公交线也过菜户营。
 * 单向线（公交上下行）只显示"前进方向"的下游站，不显示反向站（不画反向边）。
 * 仍按"换乘枢纽优先 + 就近优先"排序并设上限，避免海量点拖慢地图。
 */
function showCandidateNetwork(stop) {
  clearCandidate();
  const lines = allowedLines(stop.line_ids);

  for (const line of lines) {
    if (!line.path || line.path.length < 2) continue;
    const path = forwardLinePath(line, stop);
    if (!path || path.length < 2) continue;
    const poly = new AMap.Polyline({
      path, strokeColor: line.color,
      strokeWeight: line.mode === 'metro' ? 4 : 2.5, strokeOpacity: 0.7,
      lineJoin: 'round', zIndex: 180,
    });
    poly.setMap(state.map);
    fadeInOverlay(poly);
    state.candidateOverlays.push(poly);
  }

  // 预计算当前站在各单向线上的序号（过滤上游站用）
  const curIdxByLine = new Map();
  for (const line of lines) {
    if (line.oneWay && !line.isLoop) curIdxByLine.set(String(line.id), stopIndexInLine(line, stop));
  }

  const lineIdSet = new Set(lines.map((l) => String(l.id)));
  const curPt = { lng: stop.lng, lat: stop.lat };
  const onLogicals = [];
  const addedLogical = new Set(); // 已纳入的逻辑站 id（避免步行可达站与沿途站重复）
  for (const ls of state.logicalStops) {
    const ids = [];
    for (const lid of ls.line_ids) {
      if (!lineIdSet.has(lid)) continue;
      const line = getLine(lid);
      // 单向非环线：只纳下游站（>= 当前站序号），跳过上游（反向边）
      if (line && line.oneWay && !line.isLoop) {
        const curIdx = curIdxByLine.get(lid);
        if (curIdx != null && curIdx >= 0) {
          const lsIdx = stopIndexInLine(line, ls);
          if (lsIdx >= 0 && lsIdx < curIdx) continue;
        }
      }
      const pid = ls.stopByLine[lid];
      if (pid) ids.push(pid);
    }
    if (ids.length) {
      onLogicals.push({ ls, ids: Array.from(new Set(ids)), walkable: false });
      addedLogical.add(ls.id);
    }
  }

  // 步行换乘开启时，额外纳入「从当前站步行可达（>合并距离 且 ≤ 上限）的其它逻辑站」，
  // 用紫色点区分，玩家点击这些站会触发步行换乘（下车走过去）。
  if (state.walkTransfer) {
    for (const ls of state.logicalStops) {
      if (ls.id === stop.id || addedLogical.has(ls.id)) continue;
      const dM = distM(curPt, { lng: ls.lng, lat: ls.lat });
      if (dM <= MERGE_DISTANCE_M || dM > WALK_TRANSFER_MAX_M) continue;
      const ids = [];
      for (const lid of ls.line_ids) {
        const pid = ls.stopByLine[lid];
        if (pid) ids.push(pid);
      }
      if (ids.length) onLogicals.push({ ls, ids: Array.from(new Set(ids)), walkable: true });
    }
  }

  onLogicals.sort((a, b) => {
    const ha = a.ls.line_ids.length >= 2 ? 0 : 1; // 多线换乘枢纽优先
    const hb = b.ls.line_ids.length >= 2 ? 0 : 1;
    if (ha !== hb) return ha - hb;
    return distM({ lng: a.ls.lng, lat: a.ls.lat }, curPt) - distM({ lng: b.ls.lng, lat: b.ls.lat }, curPt);
  });

  const points = [];
  for (const { ids, walkable } of onLogicals) {
    for (const pid of ids) {
      const p = getPhys(pid);
      // 强制步行时，所有候选站（含地铁/公交沿途站）都标紫——点任意站都会步行过去
      if (p) points.push({ p, walkable: state.forceWalk ? true : walkable });
    }
    if (points.length >= MAX_CANDIDATE_POINTS) break;
  }

  state.candidateMarks = makeMassMarks(points.map(({ p, walkable }) => stopToData(p, walkable)));
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
