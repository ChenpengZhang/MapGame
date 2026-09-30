import { EVENTS,emit } from '../core/bus.js';
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
import { setOriginWalkRangeVisible, setBlindMap } from '../map/map-init.js';
import { clearMapTutorial, resetMapTutorialPrompt, setMapTutorialStage, isTutorialTransferStop, getTutorialTransfer, setTutorialTransferPoint, setTutorialAlightHint, getTutorialAlightHint, showTutorialMistake, clearTutorialMistake, isMapPracticePending } from '../map/tutorial-layer.js';
import { addStopMarker, stopTraveler, drawRideSegment, drawTransferWalk, drawWalkTransfer, rideEndpoint, drawWalkLeg, clearGroupOverlays } from '../map/route-layer.js';
import { makeTransitLineLayers } from '../map/transit-line-style.js';
import { isNativeAmap, registerPickableLine } from '../map/native-picker.js';
import { onStopMouseOver, onStopMouseOut, clearHighlight, renderHighlight, cancelPreview, showCurrentStopInfo, clearCurrentStopInfo } from '../map/hover.js';
import { clearOptimal } from '../map/optimal-layer.js';
import { haversineKm, findOptimalRoute } from '../core/router-api.js';
import { routerWalkFn } from '../map/walk.js';
import { rideStats, computeTotalMinutes } from './time-model.js';
import { stopTowerTimer } from './tower-timer.js';
import { computeOptimal } from './optimal.js';
import { renderRoutePanel } from '../ui/route-panel.js';
import { updateButtons, updateLegend } from '../ui/menu.js';

/** 候选站点层最多显示多少个点（避免海量点拖慢地图） */
const MAX_CANDIDATE_POINTS = 3000;
let ignoreMapCancelUntil = 0; // 站点点击也可能冒泡成地图 click，短暂忽略同一次点击
let lastCandidateLineClick = { id: null, at: 0 }; // 双层折线/地图实现可能重复派发同一次点击

// ============ 起点：点第一个站 ============

/** 判断两个逻辑站是否同一个（id 可能来自不同来源，统一转字符串比较） */
function sameLogical(a, b) {
  return String(a.id) === String(b.id);
}

/** "下一步该点哪里"的状态栏提示。两端都用再次点击同一站确认。 */
function ridingHint() {
  return '点一下沿途站预览、再点同一站确定换乘；点击「终」完成';
}

function physicalPoint(phys) {
  return phys && (phys.lnglat || [phys.lng, phys.lat]);
}

/** 同名上下行算一条线路；终点站无后续站点的方向不算可乘。 */
function selectOnlyLine(stop) {
  const names = new Set((stop.line_ids || []).map(getLine).filter((line) => {
    if (!line || (state.scenario.noMetro && line.mode === 'metro')) return false;
    const index = stopIndexInLine(line, stop);
    return index >= 0 && (!line.oneWay || line.isLoop || index < line.stops.length - 1);
  }).map((line) => line.name));
  state.selectedLineName = names.size === 1 ? [...names][0] : null;
  state.selectedLineId = null;
}

/** 同一物理点允许 id 相同，或同名线路拆点后坐标完全重合。 */
function samePhysicalSelection(pending, phys) {
  if (!pending || !phys) return false;
  const pendingId = pending.physicalStopId ?? pending.phys?.id;
  if (pendingId != null && String(pendingId) === String(phys.id)) return true;
  const a = pending.point || physicalPoint(pending.phys), b = physicalPoint(phys);
  // 同一站点可能按线路拆成多个物理点。它们在地图上重叠时，第二次
  // 点击可能命中相邻拆分点；按像素看是“同一位置”，不能要求坐标完全相等。
  // 这里仅放宽到 20m，仍小于相邻站点通常间距，避免误把附近站点当成确认。
  return !!(a && b && haversineKm(a, b) * 1000 <= 20);
}

/** 点当前站线路板：选中后只显示并采用该线路；再次点击则恢复全部线路。 */
function toggleCurrentLine(lineName, lineId = null) {
  if ((!state.routeStops.length && !state.pendingStart) || state.finished) return;
  clearTutorialMistake(); // 选错线路后改选/取消线路本身就是纠正，不必再点上一步
  if (state.selectedLineName === lineName) {
    state.selectedLineName = null;
    state.selectedLineId = null;
  } else {
    state.selectedLineName = lineName;
    state.selectedLineId = lineId == null ? null : String(lineId);
  }
  state.pendingCandidate = null;
  clearHighlight();
  if (!state.routeStops.length) {
    const pending = state.pendingStart;
    renderHighlight(pending.logical, pending.point, toggleCurrentLine);
    showCandidateNetwork(pending.logical, pending.point, pending.physicalStopId);
    setMapTutorialStage('selectLine', pending.point);
    setStatus(state.selectedLineName
      ? `已锁定 ${pending.logical.name}，已选择 ${state.selectedLineName}；再次点击站点确认，点击空白处取消`
      : `已锁定 ${pending.logical.name}，请选择线路；点击空白处取消`);
    return;
  }
  const current = state.routeStops[state.routeStops.length - 1];
  showCurrentStopInfo(current.logical, toggleCurrentLine);
  showCandidateNetwork(current.logical, current.point, current.physicalStopId);
  promptRideStage(current);
  setStatus(state.selectedLineName
    ? `已选择 ${state.selectedLineName}，请预览并确定下一站`
    : ridingHint());
}

/**
 * 教学提示：未选线路时停在当前站；选定线路后提示移到该线路上离终点最近的下游站（下车站），
 * 并从当前站平移过去，让新手看清“坐到哪里下车”。
 */
function promptRideStage(current) {
  if (state.currentLevel?.mapTutorial?.panelOnly) {
    const hint = getTutorialAlightHint();
    const reached = hint && state.routeStops.some((s) => s.logical?.name === hint.stopName);
    setTutorialAlightHint(hint && !reached && state.selectedLineName ? linePlatform(current, hint.stopName) : null);
    const nearDest = haversineKm(current.point, state.DEST) * 1000 <= MAX_WALK_M;
    setMapTutorialStage(nearDest ? 'finish' : state.selectedLineName ? 'rideStop' : 'selectLine');
    return;
  }
  if (!state.selectedLineName) {
    setMapTutorialStage('selectLine', current.point);
    return;
  }
  // 换乘教学：到达换乘站前，只看所选线路能否坐到换乘站
  const transfer = getTutorialTransfer();
  if (transfer && !state.routeStops.some((s) => s.logical?.name === transfer.stopName)) {
    // 找到所选线路在换乘站停靠的实际站台：换乘站道路两侧各有站台，高亮要对准玩家会下车的那个
    const platform = linePlatform(current, transfer.stopName);
    setTutorialTransferPoint(platform);
    if (platform) setMapTutorialStage('rideToTransfer', platform, { animateFrom: current.point });
    else showTutorialMistake('这条线路到不了换乘站');
    return;
  }
  const alight = alightHintPoint(current);
  // 所选线路到不了终点步行范围：不能再提示“乘车到目的地附近”并把提示移到无关的远处站点
  if (!alight || haversineKm(alight, state.DEST) * 1000 > MAX_WALK_M) {
    showTutorialMistake('这条线路到不了终点附近');
    return;
  }
  setMapTutorialStage('rideStop', alight, { animateFrom: current.point });
}

/** 当前可乘（已按所选线路过滤）的线路里，从 current 往后停靠 stopName 的实际站台坐标；没有则 null */
function linePlatform(current, stopName) {
  for (const line of allowedLines(current.logical.line_ids, current.physicalStopId)) {
    const stops = line.stops || [];
    const from = stopIndexInLine(line, current.logical);
    const st = stops.find((x, i) => x.name === stopName && (!line.oneWay || line.isLoop || i > from));
    if (st) return [st.lng, st.lat];
  }
  return null;
}

function alightHintPoint(current) {
  if (!state.DEST) return null;
  // 同名线路的各个方向都算：换乘站上两个方向都可乘，取能到达终点附近的那个方向
  const lines = allowedLines(current.logical.line_ids, current.physicalStopId);
  let best = null, bestD = Infinity;
  for (const line of lines) {
    const from = stopIndexInLine(line, current.logical);
    (line.stops || []).forEach((st, i) => {
      if (line.oneWay && !line.isLoop && from >= 0 && i <= from) return; // 单向线只取下游站
      const d = haversineKm([st.lng, st.lat], state.DEST);
      if (d < bestD) { bestD = d; best = [st.lng, st.lat]; }
    });
  }
  return best;
}

/** 地图线路点击与名称板点击使用完全相同的选择逻辑。 */
function onCandidateLineClick(line, event) {
  const original = event && (event.originalEvent || event.originEvent);
  original?.stopPropagation?.();
  event?.stopPropagation?.();
  const now = Date.now();
  const id = String(line.id);
  if (lastCandidateLineClick.id === id && now - lastCandidateLineClick.at < 160) return;
  lastCandidateLineClick = { id, at: now };
  // 高德线路点击可能继续冒泡为地图点击，短暂屏蔽同一次空白取消。
  ignoreMapCancelUntil = Date.now() + 120;
  // 与名称板一致只按线路名选择：同名上下行在数据里是两条单向线，按 id 选会只高亮一个方向。
  // 实际乘车方向由到达站台与下一站决定（allowedLines / sharedLines 会排除逆行方向）。
  toggleCurrentLine(line.name);
}

/** 基础站点层的点击回调（由 app.js 注入到 map/stop-layer.js） */
export function onStopClick(e) {
  if (state.storyActive) return; // 剧情/教学期间禁止开始规划
  if (isMapPracticePending()) {
    clearHighlight();
    return;
  }
  const phys = e && e.data;
  const logical = resolveStop(phys);
  if (!phys || !logical || state.routeStops.length) return;
  // 起点步行上限：不允许超过 1.5km
  if (haversineKm(state.ORIGIN, phys.lnglat) * 1000 > MAX_WALK_M) {
    showCenterToast('距离起点步行超过 1.5km，请选择更近的站点');
    return;
  }
  ignoreMapCancelUntil = Date.now() + 120;
  if (samePhysicalSelection(state.pendingStart, phys)) {
    confirmStart();
    return;
  }
  previewStart({ logical, point: phys.lnglat,physicalStopId:String(phys.id) });
}

/** 两端统一的第一步：预览线路和站点，红圈严格落在实际点击的物理站坐标。 */
function previewStart(d) {
  state.pendingStart = d;
  state.pendingCandidate = null;
  selectOnlyLine(d.logical);
  renderHighlight(d.logical, d.point, toggleCurrentLine);
  showCandidateNetwork(d.logical, d.point, d.physicalStopId); // 起点预览也展示所有经过线路及沿途站点
  // 起点尚未确认时也给出明确的取消入口；其它规划按钮要等确认起点后再出现。
  show('btn-group');
  hide('undo-btn');
  hide('show-all-btn');
  hide('force-walk-row');
  setText('reset-btn', '取消');
  setMapTutorialStage('selectLine', d.point);
  setStatus('已锁定 ' + d.logical.name + '，可以选择线路；再次点击同一站确认，点击地图空白处取消');
}

/** 第二步：再次点击同一物理站确认起点。 */
function confirmStart() {
  const d = state.pendingStart;
  if (!d) return;
  if (state.showAllStops) { showCenterToast('请关闭全图显示后再确定'); return; }
  startRoute(d); // startRoute 内的 resetRoute 会清空 pendingStart
}

/** 开始规划：以该站为首站 */
function startRoute(d) {
  const chosenLineName = state.selectedLineName;
  const chosenLineId = state.selectedLineId;
  resetRoute();
  state.routeOverlayGroups = [[]]; // 第一组：首站标记 + 首段步行
  state.routeStops = [d];
  selectOnlyLine(d.logical);
  if (chosenLineName) {
    state.selectedLineName = chosenLineName;
    state.selectedLineId = chosenLineId;
  }
  // 起点步行阶段已经完成：隐藏原起点范围。候选步行站会由当前站重新计算，
  // 因而与原范围重叠的站只要仍在当前站 1.5km 内就会自然保留。
  setOriginWalkRangeVisible(false);
  showCurrentStopInfo(d.logical, toggleCurrentLine);
  updateLegend(); // 规划过程中也保留站点图例
  addStopMarker(1, d.point);

  hideBaseStops();

  drawWalkLeg(state.ORIGIN, d.point).then((w) => {
    state.walkToFirstMin = w.min;
    renderRoutePanel();
  });

  showCandidateNetwork(d.logical, d.point, d.physicalStopId);
  promptRideStage(d);
  checkTutorialProgress();
  renderRoutePanel();
  show('btn-group');
  updateButtons();
  setStatus('已选择 ' + d.logical.name + '，' + ridingHint());
}

// ============ 中间：点沿途站接一段乘车 ============

/** 候选站点层的点击回调（候选网络内的点） */
export function onCandidateStopClick(phys) {
  // 设置关闭后拒绝旧图层中可能残留的步行站点击；普通线路站不受影响。
  if (phys && phys.style === 2 && !state.walkTransfer) return;
  const logical = resolveStop(phys);
  if (!logical) return;
  ignoreMapCancelUntil = Date.now() + 120;
  // 起点预览期间候选网络已出现；点击其中任一站改为预览那个起点。
  if (!state.routeStops.length && state.pendingStart) {
    if (samePhysicalSelection(state.pendingStart, phys)) {
      confirmStart();
      return;
    }
    onStopClick({ data: phys });
    return;
  }
  if (!state.routeStops.length || state.finished) return;


  const prev = state.routeStops[state.routeStops.length - 1];
  if (sameLogical(logical, prev.logical)) return;
  if (state.routeStops.some((s) => sameLogical(s.logical, logical))) return;

  if (samePhysicalSelection(state.pendingCandidate, phys)) {
    confirmCandidate();
    return;
  }
  previewCandidate(logical,phys);
}

/** 下一站第一步：在实际点击的物理站坐标上预览。 */
function previewCandidate(logical,phys) {
  state.pendingCandidate = { logical,phys };
  const point = physicalPoint(phys);
  renderHighlight(logical, point);
  // 换乘教学：预览换乘站时改为介绍预览板与线路图（到达后不再重复）
  const firstTransferPreview = isTutorialTransferStop(logical)
    && !state.routeStops.some((s) => sameLogical(s.logical, logical));
  setMapTutorialStage(firstTransferPreview ? 'previewTransfer' : 'confirm', point);
  setStatus('已预览 ' + logical.name + '，再次点击同一站确定；点击地图空白处取消');
}

/** 下一站第二步：再次点击同一物理站确定。 */
function confirmCandidate() {
  const pending = state.pendingCandidate;
  if (!pending) return;
  if (state.showAllStops) { showCenterToast('请关闭全图显示后再确定'); return; }
  state.pendingCandidate = null;
  commitCandidate(pending.logical, state.routeStops[state.routeStops.length - 1],pending.phys);
}

/** 地图空白处取消预览；拖动、缩放不会调用此函数。 */
export function cancelRoutePreview(_event, force = false) {
  if (!force && Date.now() < ignoreMapCancelUntil) return;
  const wasStart = !!state.pendingStart && !state.routeStops.length;
  const hadPreview = !!(state.pendingStart || state.pendingCandidate);
  const hadLineSelection = !!state.selectedLineName && !!state.routeStops.length && !state.finished;
  if (!hadPreview && !hadLineSelection) return;
  if (hadPreview) cancelPreview();
  if (wasStart) {
    state.selectedLineName = null;
    state.selectedLineId = null;
    clearCandidate();
    hide('btn-group');
    resetMapTutorialPrompt();
  }
  if (hadLineSelection) {
    clearTutorialMistake();
    state.selectedLineName = null;
    state.selectedLineId = null;
    const current = state.routeStops[state.routeStops.length - 1];
    showCurrentStopInfo(current.logical, toggleCurrentLine);
    showCandidateNetwork(current.logical, current.point, current.physicalStopId);
  }
  if (state.routeStops.length) {
    const current = state.routeStops[state.routeStops.length - 1];
    promptRideStage(current);
  }
  setStatus(state.routeStops.length ? ridingHint() : '请选择起点附近的站点');
}

/**
 * 切换"强制步行"临时开关（由 app.js 绑定复选框时调用）。
 * 切换后重渲染候选网络，让站点颜色即时反映"现在点任意站都会步行"。
 */
export function setForceWalk(on) {
  state.forceWalk = !!on && state.walkTransfer;
  if (state.routeStops.length && !state.finished) {
    const current = state.routeStops[state.routeStops.length - 1];
    showCandidateNetwork(current.logical, current.point, current.physicalStopId);
  }
}

/**
 * 开关步行换乘并立即刷新候选网络。
 * 关闭时同时清掉强制步行，保证红色步行站既不显示也不能由残留事件选中。
 */
export function setWalkTransferEnabled(on) {
  state.walkTransfer = !!on;
  if (!state.walkTransfer) {
    state.forceWalk = false;
    const toggle = $('force-walk-toggle');
    if (toggle) toggle.checked = false;
  }
  updateButtons();
  if (state.routeStops.length && !state.finished) {
    const current = state.routeStops[state.routeStops.length - 1];
    showCandidateNetwork(current.logical, current.point, current.physicalStopId);
  }
}

/** 确定换乘到某候选站（第二次点击同一物理站走这里） */
function commitCandidate(logical, prev,selectedPhys) {
  // 强制步行：即使两站共线，也优先步行过去（距离需 ≤ 上限；失败则回退到乘车）
  if (state.walkTransfer && state.forceWalk) {
    if (commitWalkTransfer(logical, prev, true,selectedPhys)) return;
  }
  const shared = sharedLines(prev.logical, logical);
  if (shared.length) {
    commitRide(logical, prev, shared[0]);
    return;
  }
  // 无共有线路：非强制时，若开启步行换乘且距离在 (合并距离, 上限] 之间，则步行过去
  //（force 已失败时不重复尝试，避免同一距离弹两次 toast）
  if (state.walkTransfer && !state.forceWalk) {
    commitWalkTransfer(logical, prev, false,selectedPhys);
  }
}

/**
 * 首段乘车确定后，把首站悄悄修正到该线路实际停靠的站台。
 * 逻辑站会合并同名的多个站台（上下行、不同线路），玩家点的可能是另一侧站台；
 * 起点步行若仍按点到的站台计时，会比系统最优（按实际上车站台计时）少算一段，出现“比最快还快”。
 */
function alignFirstStopToLine(first, line) {
  const phys = findStopInLine(line, first.logical);
  if (!phys || String(phys.id) === String(first.physicalStopId)) return;
  const point = [phys.lng, phys.lat];
  first.point = point;
  first.physicalStopId = String(phys.id);
  const g = state.routeOverlayGroups[0];
  if (!g) return;
  clearGroupOverlays(g);
  g.length = 0;
  addStopMarker(1, point, g);
  drawWalkLeg(state.ORIGIN, point, g, false).then((w) => { // 不重播行人动画，接下来播放的是乘车动画
    if (state.routeOverlayGroups[0] !== g) return; // 已被撤回/重置
    state.walkToFirstMin = w.min;
    renderRoutePanel();
  });
}

// ============ 教学关：错误操作检测 ============

let tutorialBest = null; // { key, totalMin, plan }：本局最优用时与最优路线的站序（每局只算一次）

/** 从 from 出发、只能在该站上车（不能再步行去别的站）时到终点的最快用时；到不了返回 Infinity */
async function fastestFrom(from) {
  const opts = { allowMetro: !state.scenario.noMetro, busSpeedFactor: state.scenario.busSpeedFactor };
  const walk = (a, b) => {
    const leavingStop = Math.abs(a[0] - from[0]) < 1e-9 && Math.abs(a[1] - from[1]) < 1e-9;
    const toDest = Math.abs(b[0] - state.DEST[0]) < 1e-9 && Math.abs(b[1] - state.DEST[1]) < 1e-9;
    // 已在站上：不能再步行去别的站上车，但可以直接走到终点（与“点终点完成”一致）
    if (leavingStop && !toDest && haversineKm(a, b) * 1000 > 60) return Promise.resolve({ dist: Infinity, min: Infinity });
    return routerWalkFn(a, b);
  };
  const r = await findOptimalRoute(state.routerGraph, from, state.DEST, opts, walk);
  return r && Number.isFinite(r.totalMin) && r.totalMin < 1e5 ? r.totalMin : Infinity;
}

/** 最优路线的站序（站名）：上车站，然后每一段乘车的下车站（同站换乘只出现一次） */
function planStops(best) {
  const rides = (best?.legs || []).filter((leg) => leg.type === 'ride');
  if (!rides.length) return [];
  // 按站名比对：同名站台可能分属不同的合并组，玩家点哪一侧都算同一站
  return [rides[0].fromName, ...rides.map((leg) => leg.toName)].map(String);
}

/**
 * 教学关要求玩家“一次走对”：每确认一步都与最优路线的站序比对，
 * 上车站不对、下车站坐短/坐长、多下一次车都算错误操作；
 * 站序对了但总用时仍超标（如同一段路坐了慢车）也算错误。
 * 出错时只留“点击上一步返回”一条提示。计算异步进行，结果回来时若路线已变化则丢弃。
 */
async function checkTutorialProgress() {
  const level = state.currentLevel;
  // 自由操作教程只解释操作，不以最优线路、站序或时限评判玩家。
  if (level?.mapTutorial?.panelOnly) return;
  if (!level?.mapTutorial || !state.routerGraph || !state.routeStops.length || state.finished) return;
  const revision = state.routeRevision || 0;
  const steps = state.routeStops.length;
  await new Promise((resolve) => setTimeout(resolve, 0)); // 等首段步行计时落定
  try {
    const key = level.id + '|' + state.ORIGIN.join(',');
    if (tutorialBest?.key !== key) {
      const opts = { allowMetro: !state.scenario.noMetro, busSpeedFactor: state.scenario.busSpeedFactor };
      const best = await findOptimalRoute(state.routerGraph, state.ORIGIN, state.DEST, opts, routerWalkFn);
      tutorialBest = { key, totalMin: best ? best.totalMin : Infinity, plan: planStops(best) };
    }
    if ((state.routeRevision || 0) !== revision || state.routeStops.length !== steps || state.finished) return;
    const plan = tutorialBest.plan;
    const index = steps - 1;
    const current = state.routeStops[index];
    if (plan.length && String(current.logical.name) !== plan[index]) {
      showTutorialMistake(index === 0 ? '从这个站出发不是最佳选择'
        : index >= plan.length ? '已经可以下车走到终点了，不需要再坐' : '这一站下车不对，要一次坐到合适的站');
      return;
    }
    const limit = Number.isFinite(Number(level.timeLimitMin)) ? Number(level.timeLimitMin) : tutorialBest.totalMin * 1.3;
    const remaining = await fastestFrom(current.point);
    if ((state.routeRevision || 0) !== revision || state.routeStops.length !== steps || state.finished) return;
    if (computeTotalMinutes() + remaining > limit + 0.01) {
      showTutorialMistake(Number.isFinite(Number(level.timeLimitMin)) ? '这样走会超过时限' : '这样走会绕远路');
    }
  } catch (e) { /* 检测失败不影响正常游玩 */ }
}

/** 正常乘车换乘：两站有共有线路，沿该线接一段乘车 */
function commitRide(logical, prev, line) {
  if (!state.routeRides.length && prev === state.routeStops[0]) alignFirstStopToLine(prev, line);
  // 到达点 = 该线路上的物理站坐标（乘车段终点，也是下一步步行的起点）
  const physStop = findStopInLine(line, logical);
  const point = physStop ? [physStop.lng, physStop.lat] : [logical.lng, logical.lat];
  const cur = { logical, point,physicalStopId:physStop ? String(physStop.id) : null };

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

  state.selectedLineName = null; // 线路选择只约束当前这一段；到站后重新选择
  state.selectedLineId = null;
  selectOnlyLine(cur.logical);
  clearHighlight(); // 清掉预览悬浮高亮
  showCurrentStopInfo(cur.logical, toggleCurrentLine);
  showCandidateNetwork(cur.logical, cur.point, cur.physicalStopId);
  if (state.currentLevel?.mapTutorial?.panelOnly) promptRideStage(cur);
  else setMapTutorialStage('finish', state.DEST);
  renderRoutePanel();
  setStatus(ridingHint());
  checkTutorialProgress();
}

/**
 * 步行换乘：两站无共有线路（或强制步行）时，
 * 玩家下车步行到下一站，时间按步行速度计算（不计固定换乘惩罚）。
 * @param {boolean} force 强制步行：即使两站共线也步行；非强制时要求距离 > 合并距离
 * @returns {boolean} 是否成功步行换乘
 */
function commitWalkTransfer(logical, prev, force,selectedPhys) {
  // selectedPhys 可能是地图点数据（stopToData：坐标在 lnglat 里，没有 lng/lat），按 id 取回真实物理站
  const targetPhys = (selectedPhys && (getPhys(String(selectedPhys.id)) || (selectedPhys.lnglat
    ? { ...selectedPhys, lng: selectedPhys.lnglat[0], lat: selectedPhys.lnglat[1] } : selectedPhys)))
    || getPhys(Object.values(logical.stopByLine || {})[0]);
  if (!targetPhys || !Number.isFinite(targetPhys.lng) || !Number.isFinite(targetPhys.lat)) return false;
  const dM = distM(
    { lng: prev.point[0], lat: prev.point[1] },
    { lng: targetPhys.lng, lat: targetPhys.lat },
  );
  if (dM > WALK_TRANSFER_MAX_M) {
    showCenterToast('步行距离 ' + Math.round(dM) + ' 米，超过上限 ' + WALK_TRANSFER_MAX_M + ' 米，无法步行换乘');
    return false;
  }
  if (!force && dM <= MERGE_DISTANCE_M) {
    showCenterToast('两站无共有线路，无法换乘（步行距离 ' + Math.round(dM) + ' 米）');
    return false;
  }

  const cur = { logical, point: [targetPhys.lng,targetPhys.lat],physicalStopId:String(targetPhys.id) };
  state.routeOverlayGroups.push([]);
  state.routeRides.push(null); // null = 步行换乘段（非乘车）
  state.routeStops.push(cur);
  addStopMarker(state.routeStops.length, cur.point);
  drawWalkTransfer(prev.point, cur.point);

  selectOnlyLine(cur.logical);
  clearHighlight();
  showCurrentStopInfo(cur.logical, toggleCurrentLine);
  showCandidateNetwork(cur.logical, cur.point, cur.physicalStopId);
  if (state.currentLevel?.mapTutorial?.panelOnly) promptRideStage(cur);
  else setMapTutorialStage('selectLine', cur.point);
  renderRoutePanel();
  setStatus(ridingHint());
  checkTutorialProgress();
  return true;
}

// ============ 终点：完成规划 ============

/** 点"终"图钉（或终点步行）后完成规划，并触发最优路线对比 */
export function finishRoute({ silentOutOfRange = false } = {}) {
  if (state.finished) return;
  if (isMapPracticePending()) return;

  // 未选择任何站点：直接从起点步行到终点
  if (!state.routeStops.length) {
    if (haversineKm(state.ORIGIN, state.DEST) * 1000 > MAX_WALK_M) {
      if (!silentOutOfRange) showCenterToast('起点到终点超过 1.5km，无法直接步行到达，请先选站点');
      return;
    }
    clearMapTutorial();
    state.routeOverlayGroups.push([]);
    const g = state.routeOverlayGroups[state.routeOverlayGroups.length - 1];
    drawWalkLeg(state.ORIGIN, state.DEST, g).then((w) => {
      if (state.routeOverlayGroups[state.routeOverlayGroups.length - 1] !== g) return; // 已被撤回
      state.walkToFirstMin = w.min;
      state.walkToDestMin = 0;
      state.finished = true;
      if(state.towerActive)stopTowerTimer();
      clearCandidate();
      updateButtons();
      renderRoutePanel();
      revealBlindMap();
      emit(EVENTS.ROUTE_FINISHED);
      computeOptimal();
    });
    return;
  }

  // 终点步行上限：不允许超过 1.5km
  const last = state.routeStops[state.routeStops.length - 1];
  if (haversineKm(last.point, state.DEST) * 1000 > MAX_WALK_M) {
    if (!silentOutOfRange) showCenterToast('距离终点步行超过 1.5km，请先换乘到更近的站点');
    return;
  }
  clearMapTutorial();
  state.routeOverlayGroups.push([]); // 终点步行组
  const g = state.routeOverlayGroups[state.routeOverlayGroups.length - 1];
  drawWalkLeg(last.point, state.DEST, g).then((w) => {
    if (state.routeOverlayGroups[state.routeOverlayGroups.length - 1] !== g) return; // 已被撤回
    state.walkToDestMin = w.min;
    state.finished = true;
    state.selectedLineName = null;
    state.selectedLineId = null;
    showCurrentStopInfo(last.logical); // 完成后保留名称板，但不再允许改变线路选择
    if(state.towerActive)stopTowerTimer();
    clearCandidate();   // 到达后隐藏候选站点/线路
    updateButtons();    // 完成后切换为"重新开始"
    renderRoutePanel();
    revealBlindMap();
    emit(EVENTS.ROUTE_FINISHED);
    computeOptimal();
  });
}

/** 盲棋：路线完成后揭晓底图，方便对照自己的路线与最优路线 */
function revealBlindMap() {
  if (state.scenario?.blindMap) void setBlindMap(false);
}

// ============ 重置与撤回 ============

/** 清空整条路线，回到"浏览/选起始站"状态（切关卡、切菜单、重开都会调用） */
export function resetRoute() {
  state.routeRevision=(state.routeRevision||0)+1;
  clearTutorialMistake();
  state.routeStops = [];
  state.routeRides = [];
  state.finished = false;
  state.walkToFirstMin = 0;
  state.walkToDestMin = 0;
  state.forceWalk = false;    // 重置"强制步行"临时开关
  state.selectedLineName = null;
  state.selectedLineId = null;
  const fwt = $('force-walk-toggle');
  if (fwt) fwt.checked = false;
  stopTraveler();
  for (const g of state.routeOverlayGroups) clearGroupOverlays(g);
  state.routeOverlayGroups = [];
  clearCandidate();
  clearOptimal();
  clearHighlight();          // 清掉悬浮高亮，避免上一局的线路高亮残留
  clearCurrentStopInfo();    // 清掉已确认站的信息卡
  state.showAllStops = false;
  state.pendingStart = null; // 清除起点预览
  state.pendingCandidate = null; // 清除下一站预览
  setOriginWalkRangeVisible(true);
  const sab = $('show-all-btn');
  if (sab) sab.textContent = '显示全图站点';
  updateButtons();
  updateLegend(); // 确保重新开始后图例仍显示
  hide('route-panel');
  hide('btn-group');
  hide('result-overlay');
  hide('result-toggle-btn');
  updateStopsByZoom();
  resetMapTutorialPrompt();
}

/** 撤回上一步：仅规划中可用（完成后由"重新开始"重置） */
export function undoRoute() {
  if (state.finished) return; // 完成后不可撤回
  // 真实乘坐：已确认的站和车都不能撤回；只允许取消尚未确认的预览
  if (state.scenario?.realRide && !(state.pendingStart || state.pendingCandidate)) {
    showCenterToast('真实乘坐模式下不能撤回');
    return;
  }
  clearTutorialMistake();
  // 预选中点"上一步"= 取消预选，而不是撤回已确认的路线
  if (state.pendingStart || state.pendingCandidate) {
    cancelRoutePreview(null, true);
    return;
  }
  if (!state.routeStops.length) return;
  // 已选线路时，“上一步”先撤销线路选择（选错线路是最常见的错误操作）
  if (state.selectedLineName) {
    toggleCurrentLine(state.selectedLineName);
    return;
  }
  if (state.routeStops.length > 1) {
    stopTraveler();
    const g = state.routeOverlayGroups.pop();
    clearGroupOverlays(g);
    state.routeRides.pop();
    state.routeStops.pop();
    state.selectedLineName = null;
    state.selectedLineId = null;
    const prev = state.routeStops[state.routeStops.length - 1];
    clearHighlight();
    showCurrentStopInfo(prev.logical, toggleCurrentLine);
    showCandidateNetwork(prev.logical, prev.point, prev.physicalStopId);
    if (state.currentLevel?.mapTutorial?.panelOnly) promptRideStage(prev);
    else setMapTutorialStage('selectLine', prev.point);
    renderRoutePanel();
    setStatus('已撤回一步，可继续选择');
    return;
  }
  resetRoute();
}

// ============ 候选网络（当前站可换乘的线路 + 沿途站点） ============

/** 按设置返回可用线路（禁用地铁时过滤地铁线） */
function allowedLines(lineIds, currentPhysicalStopId = null) {
  let lines = (lineIds || []).map((id) => getLine(id)).filter((l) => l
    && (!state.scenario.noMetro || l.mode !== 'metro'));
  if (state.selectedLineId) {
    lines = lines.filter((line) => String(line.id) === String(state.selectedLineId));
  } else if (state.selectedLineName) {
    lines = lines.filter((line) => line.name === state.selectedLineName);
  }
  // 同一逻辑站的各个站台（上下行、不同线路）视为合并：选线路时两个方向都保留，由下一站决定方向。
  // 唯一例外是“下车后又选回刚坐的同一条线”：只保留到达站台所在方向，避免把回头车也画出来。
  const arrivedLine = state.routeRides?.[state.routeRides.length - 1];
  const continuingLine = !!arrivedLine && arrivedLine.name === state.selectedLineName;
  if (state.selectedLineName && !state.selectedLineId && currentPhysicalStopId != null && continuingLine) {
    // 在终点站台（单向线的最后一站）上已无法继续前进，这类方向不算“同站台可乘”，
    // 否则在首末站（如可克达拉 63路 的人民医院）会只剩一条到此为止的线，玩家无车可坐。
    const exact = lines.filter((line) => {
      const stops = line.stops || [];
      const i = stops.findIndex((stop) => String(stop.id) === String(currentPhysicalStopId));
      return i >= 0 && (!line.oneWay || line.isLoop || i < stops.length - 1);
    });
    if (exact.length) lines = exact;
  }
  return dedupeDirectionVariants(lines);
}

/** 同名同方向的近终点数据变体只保留覆盖站点更多的一条。 */
function dedupeDirectionVariants(lines) {
  const result = [];
  for (const line of lines) {
    if (!line.oneWay || !line.stops?.length) {
      result.push(line);
      continue;
    }
    const terminal = line.stops[line.stops.length - 1];
    const index = result.findIndex((other) => {
      if (!other.oneWay || other.name !== line.name || !other.stops?.length) return false;
      const otherTerminal = other.stops[other.stops.length - 1];
      return distM(terminal, otherTerminal) <= 1000;
    });
    if (index < 0) {
      result.push(line);
    } else if (line.stops.length > result[index].stops.length) {
      result[index] = line;
    }
  }
  return result;
}

/** 两站共有的可用线路，按"站数少优先，同站数地铁优先"排序；单向线只认前进方向 */
function sharedLines(s1, s2) {
  const set1 = new Set(s1.line_ids || []);
  const shared = [];
  for (const id of s2.line_ids || []) {
    if (!set1.has(id)) continue;
    const line = getLine(id);
    if (!line) continue;
    if (state.selectedLineId && String(line.id) !== String(state.selectedLineId)) continue;
    if (state.selectedLineName && line.name !== state.selectedLineName) continue;
    if (state.scenario.noMetro && line.mode === 'metro') continue;
    // 单向线（公交上下行/环线）：反向不可乘车，直接排除
    if (!rideStats(line, s1, s2)) continue;
    shared.push(line);
  }
  // 站数更少优先：避免地铁环线绕远、公交坐慢车；站数相同时地铁优先
  // 玩家指定线路后直接采用它；同名上下行中 rideStats 已排除错误方向，环线则允许顺行绕环。
  if (state.selectedLineName) return shared;
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
 * 添加一条候选线路及其透明点击热区。
 * 可见线保持原宽度；独立热区让细公交线在桌面和触屏上都更容易点中。
 */
function addCandidateLine(line, path) {
  const selected = state.selectedLineName === line.name;
  const zIndex = selected ? 190 : 180;
  const chooseLine = (event) => onCandidateLineClick(line, event);
  const layers = makeTransitLineLayers({
    path,
    color: line.color,
    mode: line.mode,
    selected,
    zIndex,
    opacity: selected ? 1 : 0.88,
    lineName: line.name,
    interactive: false,
  });
  for (const layer of layers) {
    layer.setMap(state.map);
    fadeInOverlay(layer);
    state.candidateOverlays.push(layer);
  }

  // 近乎透明而非完全透明，以兼容会忽略 opacity:0 图形命中的地图实现。
  const hitArea = new AMap.Polyline({
    path, strokeColor: line.color,
    strokeWeight: state.isTouch ? 24 : 16,
    strokeOpacity: 0.01,
    lineJoin: 'round', zIndex: zIndex + 1, interactive: true,
  });
  hitArea.__lineName = line.name;
  hitArea.__hitWidth = state.isTouch ? 24 : 16;
  hitArea.__lineId = String(line.id);
  hitArea.__lineHitArea = true;
  // 原生高德：折线热区不接事件（会吞掉站点点击），由 native-picker 按像素距离拾取
  if (isNativeAmap()) registerPickableLine(hitArea, path, hitArea.__hitWidth, chooseLine);
  else hitArea.on('click', chooseLine);
  hitArea.setMap(state.map);
  state.candidateOverlays.push(hitArea);
}

/**
 * 亮出候选网络：当前站可换乘的线路（浅色折线）+ 这些线路沿途的站点。
 * 沿途站点 = 只显示候选线路上真实经过的物理站（不显示合并进来的公交/地铁"小弟"）。
 * 例如地铁线过菜户营，只显示橙色的地铁点；除非真有从当前站出发的公交线也过菜户营。
 * 单向线（公交上下行）只显示"前进方向"的下游站，不显示反向站（不画反向边）。
 * 仍按"换乘枢纽优先 + 就近优先"排序并设上限，避免海量点拖慢地图。
 */
function showCandidateNetwork(stop, centerPoint = null, currentPhysicalStopId = null) {
  clearCandidate();
  const lines = allowedLines(stop.line_ids, currentPhysicalStopId);

  for (const line of lines) {
    if (!line.path || line.path.length < 2) continue;
    const path = forwardLinePath(line, stop);
    if (!path || path.length < 2) continue;
    addCandidateLine(line, path);
  }

  // 预计算当前站在各单向线上的序号（过滤上游站用）
  const curIdxByLine = new Map();
  for (const line of lines) {
    if (line.oneWay && !line.isLoop) curIdxByLine.set(String(line.id), stopIndexInLine(line, stop));
  }

  const lineIdSet = new Set(lines.map((l) => String(l.id)));
  // 步行范围以玩家实际确认的物理站坐标为中心，不能使用合并逻辑站的代表坐标。
  const center = centerPoint || [stop.lng, stop.lat];
  const curPt = { lng: center[0], lat: center[1] };
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
  // 用红色小点区分，玩家点击这些站会触发步行换乘（下车走过去）。
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
      const line = p && lines.find((candidate) => p.line_ids?.has(String(candidate.id)));
      // 强制步行时，所有候选站（含地铁/公交沿途站）都标红——点任意站都会步行过去
      if (p) points.push({ p, walkable: state.forceWalk ? true : walkable, lineColor: line?.color });
    }
    if (points.length >= MAX_CANDIDATE_POINTS) break;
  }

  state.candidateMarks = makeMassMarks(
    points.map(({ p, walkable, lineColor }) => stopToData(p, walkable, lineColor)),
    // 保证站点命中圆位于线路透明热区之上；地图站优先响应，空白线段仍可选线路。
    { allowWalkStyle: state.walkTransfer, inverseLineStops: true, zIndex: 220 }
  );
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
