/**
 * map/tutorial-layer.js —— 绑定地理坐标的关卡教学文字。
 *
 * 教学文案是地图覆盖物，而不是固定在屏幕角落的 UI：缩放和平移后仍会跟着
 * 对应站点移动。玩法层切换阶段时可以同时传入新的锚点，让提示跟随当前要点击的
 * 站点或终点，而不需要关心 Marker 的创建与销毁。
 */

import { state } from '../core/state.js';
import { MAX_WALK_M } from '../core/config.js';
import { busMinZoom } from './stop-layer.js';
import { haversineKm } from '../core/router-api.js';

let promptConfig = null;
let promptMarker = null;
let promptStage = null;
let promptPosition = null;
let busStopsRevealed = false;
let zoomListener = null;
let mapPracticeCompleted = false;
let boardingPreviewStarted = false;
let viewportListener = null;

/** 判断实际可见地图，不要求采用某一种聚焦操作。少量容差避免边缘反复跳步。 */
function originViewportReady() {
  if (!state.map || !state.ORIGIN || state.map.getZoom() < busMinZoom()) return false;
  const bounds = state.map.getBounds?.();
  if (!bounds) return false;
  const sw = bounds.getSouthWest(), ne = bounds.getNorthEast();
  const mapRect = document.getElementById('map')?.getBoundingClientRect?.();
  const barRect = document.getElementById('topbar')?.getBoundingClientRect?.();
  const inset = mapRect && barRect
    ? Math.max(0, Math.min(mapRect.bottom, barRect.bottom) - mapRect.top) / Math.max(1, mapRect.height) : 0;
  const topLat = ne.getLat() - (ne.getLat() - sw.getLat()) * inset;
  const center = [(sw.getLng() + ne.getLng()) / 2, (sw.getLat() + topLat) / 2];
  const width = haversineKm([sw.getLng(), center[1]], [ne.getLng(), center[1]]) * 1000;
  const height = haversineKm([center[0], sw.getLat()], [center[0], topLat]) * 1000;
  const [lng, lat] = state.ORIGIN;
  return lng >= sw.getLng() && lng <= ne.getLng() && lat >= sw.getLat() && lat <= topLat
    && haversineKm(center, state.ORIGIN) * 1000 <= (mapPracticeCompleted ? 850 : 650)
    && Math.min(width, height) <= (mapPracticeCompleted ? 4700 : 4200);
}

export function isMapPracticePending() {
  if (!promptConfig?.mapPractice || boardingPreviewStarted || state.routeStops.length) return false;
  mapPracticeCompleted = originViewportReady();
  return !mapPracticeCompleted;
}

export function completeMapPractice() {
  if (!promptConfig?.mapPractice) return;
  mapPracticeCompleted = originViewportReady();
  renderPrompt();
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function removeMarker() {
  cancelSlide();
  if (promptMarker) promptMarker.setMap(null);
  promptMarker = null;
}

function removeZoomListener() {
  if (state.map && zoomListener) state.map.off('zoomchange', zoomListener);
  zoomListener = null;
  if (state.map && viewportListener) {
    state.map.off('moveend', viewportListener);
    state.map.off('zoomend', viewportListener);
  }
  viewportListener = null;
}

/** 初始阶段在公交站首次达到显示级别前，先引导玩家放大地图。 */
function textForStage(stage) {
  if (stage === 'initial' && promptConfig?.waitForBusStops && !busStopsRevealed) {
    return promptConfig.beforeReveal;
  }
  return promptConfig?.[stage] ?? DEFAULT_STAGE_TEXT[stage];
}

/** 关卡未单独配置时使用的通用提示 */
const DEFAULT_STAGE_TEXT = {
  wrongLine: '这条线路到不了终点附近，换一条线路试试',
};

/**
 * 换乘教学（mapTutorial.transfer）。前半段与第一关完全相同（走到站、确认、选线路），
 * 直到玩家选中一条能到换乘站的线路才揭晓换乘站（高亮 + “乘坐公交抵达换乘站”）：
 *   rideToTransfer   选对线路后，提示移到换乘站；
 *   wrongLine        到达换乘站前选错线路，改为“到不了换乘站”；
 *   previewTransfer  预览换乘站时介绍预览板与线路图；
 *   到达换乘站还未选线路时，提示“点击你要换乘的线路抵达终点”，放在 arrivedPosition（换乘站与终点之间）。
 */
function transferReached() {
  const t = promptConfig?.transfer;
  return !!t && (state.routeStops || []).some((s) => s.logical?.name === t.stopName);
}

/**
 * 换乘站的实际坐标：换乘站有多个站台（道路两侧），配置里的坐标只是其中一个。
 * 到达后用实际下车站台；到达前用玩家所选线路停靠的站台（由玩法层 setTutorialTransferPoint 告知）。
 */
let transferPoint = null;
function transferPosition() {
  const t = promptConfig?.transfer;
  if (!t) return null;
  const arrived = (state.routeStops || []).find((s) => s.logical?.name === t.stopName);
  return arrived?.point || transferPoint || t.position;
}

/** 玩法层告知：玩家所选线路会在换乘站的哪个站台停靠（高亮与提示都对准这个站台） */
export function setTutorialTransferPoint(point) {
  transferPoint = Array.isArray(point) ? point : null;
}

function transferPrompt(stage) {
  const t = promptConfig?.transfer;
  if (!t) return null;
  if (stage === 'previewTransfer') return { text: t.previewMap, position: transferPosition() };
  if (stage === 'rideToTransfer') return { text: t.reach, position: transferPosition() };
  const stops = state.routeStops || [];
  if (!transferReached()) return stage === 'wrongLine' && t.wrongLine ? { text: t.wrongLine } : null;
  const atTransfer = stops[stops.length - 1]?.logical?.name === t.stopName;
  if (atTransfer && (stage === 'selectLine' || stage === 'finish')) {
    return { text: t.arrived, position: t.arrivedPosition || t.position };
  }
  return null;
}

/**
 * 错误操作（选错线路、选错站、走法已无法按时/不绕路到达）：隐藏所有其它提示，
 * 只在“上一步”按钮上方留一条“……，点击「上一步」返回”，并让按钮发光。
 * 期间其它阶段切换一律不显示，直到玩家撤回（clearTutorialMistake）。
 */
let mistakeReason = null;

export function showTutorialMistake(reason) {
  if (!promptConfig) return;
  mistakeReason = reason || '这一步走错了';
  renderPrompt();
}

export function clearTutorialMistake() {
  if (mistakeReason == null) return;
  mistakeReason = null;
  renderUndoTip(null);
  renderPrompt();
}

function renderUndoTip(text) {
  if (typeof document === 'undefined') return;
  const btn = document.getElementById('undo-btn');
  const old = document.getElementById('tutorial-undo-tip');
  if (old) old.parentNode?.removeChild?.(old);
  btn?.classList?.toggle('tutorial-undo-glow', !!text);
  const group = btn?.parentNode;
  if (!text || !group) return;
  const tip = document.createElement('div');
  tip.id = 'tutorial-undo-tip';
  tip.className = 'tutorial-undo-tip';
  tip.textContent = text;
  group.appendChild(tip);
  // 箭头对准“上一步”按钮中心（按钮组里还有其它按钮，位置随布局变化）
  const gr = group.getBoundingClientRect?.(), br = btn.getBoundingClientRect?.();
  if (gr && br && gr.width) tip.style?.setProperty?.('--arrow-right', Math.round(gr.right - (br.left + br.width / 2) - 7) + 'px');
}

/** 当前关卡的换乘教学配置（供玩法层判断所选线路能否到达换乘站） */
export function getTutorialTransfer() {
  return promptConfig?.transfer || null;
}

/**
 * 名称板旁的说明气泡（箭头指向名称板）。tipId 区分两处：
 *   tutorial-card-tip     预览换乘站时挂在预览名称板（#infocard）；
 *   tutorial-current-tip  选线路阶段挂在当前站名称板（#current-infocard），与地图上的提示同文，
 *                         告诉玩家“点名称板或点地图标线都可以”。
 */
function renderCardTip(tipId, cardId, text) {
  if (typeof document === 'undefined') return;
  const old = document.getElementById(tipId);
  if (old) old.parentNode?.removeChild?.(old);
  const card = document.getElementById(cardId);
  if (!text || !card) return;
  const tip = document.createElement('div');
  tip.id = tipId;
  tip.className = 'tutorial-card-tip';
  tip.textContent = text;
  card.appendChild(tip);
}

function renderPrompt() {
  removeMarker();
  renderGuidePanel();
  // 此教程仅使用文字框，保留普通游戏的站点、线路与起终点图层。
  if (promptConfig?.panelOnly) return;
  if (mistakeReason != null && promptConfig) {
    // 错误状态：清掉地图提示、高亮、注释、名称板气泡与 HUD 闪烁，只留“上一步”提示
    for (const m of highlightMarkers.concat(noteMarkers)) m.setMap(null);
    highlightMarkers = [];
    noteMarkers = [];
    renderedKey = null;
    setHudFlash(false);
    renderCardTip('tutorial-card-tip', 'infocard', null);
    renderCardTip('tutorial-current-tip', 'current-infocard', null);
    renderUndoTip(mistakeReason + '，点击「上一步」返回');
    return;
  }
  syncAnnotations();
  renderCardTip('tutorial-card-tip', 'infocard', promptStage === 'previewTransfer' ? promptConfig?.transfer?.previewCard : null);
  const override = transferPrompt(promptStage);
  const text = promptConfig ? (override ? override.text : textForStage(promptStage)) : null;
  // 选线路阶段（含换乘站上的“点击你要换乘的线路”）在名称板旁再放一份同样的提示
  const choosingLine = promptStage === 'selectLine' || (!!override && override.text === promptConfig?.transfer?.arrived);
  renderCardTip('tutorial-current-tip', 'current-infocard', choosingLine && !promptConfig?.panel ? text : null);
  // mapTutorial.anchors[阶段] 可把某一步的提示固定到指定坐标（如“直接点击目标站”锚在目标站）
  const anchor = promptConfig?.anchors?.[promptStage];
  const position = override?.position || anchor || promptPosition || promptConfig?.position;
  if (!promptConfig || !state.map || !position) return;
  if (!text) return;
  promptMarker = new AMap.Marker({
    position,
    content: `<div class="map-tutorial-label">${escapeHtml(text)}</div>`,
    offset: new AMap.Pixel(0, 0),
    zIndex: 460,
    clickable: false,
  });
  promptMarker.setMap(state.map);
}

/** 记下文字框底边位置，手机端把操作按钮放在它正下方（文案长短不同，框高会变） */
let guideResizeBound = false;
function syncGuideBottom() {
  const panel = document.getElementById('tutorial-guide');
  const app = document.getElementById('app');
  if (!panel || !app?.style?.setProperty || !panel.getBoundingClientRect) return;
  const measure = () => {
    const rect = panel.getBoundingClientRect();
    const base = app.getBoundingClientRect?.().top || 0;
    if (rect.height) app.style.setProperty('--tutorial-guide-bottom', Math.round(rect.bottom - base) + 'px');
  };
  measure();
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(measure); // 换行后的实际高度
  if (!guideResizeBound && typeof window !== 'undefined' && window.addEventListener) {
    guideResizeBound = true;
    window.addEventListener('resize', measure);
  }
}

/** 固定文字框随真实操作推进；地图仍可拖动、缩放和点击。 */
function renderGuidePanel() {
  if (typeof document === 'undefined') return;
  const panel = document.getElementById('tutorial-guide');
  if (!panel) return;
  const enabled = !!promptConfig?.panel;
  panel.classList.toggle('hidden', !enabled);
  if (!enabled) return;
  const stops = state.routeStops || [];
  const rides = (state.routeRides || []).filter(Boolean);
  const currentName = stops[stops.length - 1]?.logical?.name || '';
  const pendingName = state.pendingStart?.logical?.name || state.pendingCandidate?.logical?.name || '';
  const hasRidden = rides.length > 0;
  const tap = state.isTouch ? '轻触' : '单击';
  let title, text, action;
  if (isMapPracticePending()) {
    title = '熟悉地图操作';
    text = state.isTouch
      ? '单指拖动地图，双指缩放。起点周围的红圈表示 1.5 公里步行范围，圈内的站点可以步行到达。'
      : '按住鼠标左键拖动地图，滚动滚轮缩放。起点周围的红圈表示 1.5 公里步行范围，圈内的站点可以步行到达。';
    action = '查看起点附近的公交站\n提示：点击「起」可快速聚焦。';
  } else if (promptStage === 'initial' && !busStopsRevealed) {
    title = '查看附近站点';
    text = `将地图移到「起」附近并放大，即可看到公交站。也可以${tap}「起」快速聚焦；红圈内的站点都可以步行到达。`;
    action = '查看起点附近的公交站\n提示：放大地图可显示站点。';
  } else if (promptStage === 'initial') {
    title = '选择上车站';
    text = state.isTouch
      ? '在起点红圈的步行范围内挑选一个公交站，轻触即可锁定站点，查看站名和经过的线路，并进入线路选择。可以取消选择，也可以轻触其他站点更换。'
      : '在起点红圈的步行范围内挑选一个公交站。将鼠标移到站点上可以预览站名和经过的线路；单击一下即可锁定车站，进入线路选择。可以取消选择，也可以单击其他站点更换。';
    action = '选择一个上车站\n提示：点空白处或「取消」可取消选择。';
  } else if (state.pendingStart && !stops.length) {
    title = '确认上车站';
    text = `已锁定「${pendingName}」。再次${tap}「${pendingName}」即可确认步行到这里上车。确认前也可以${tap}站点名称板中的线路名称或地图上的线路标线选择线路，只有一条线路时会自动选中。`;
    action = `再次${tap}「${pendingName}」确认\n提示：仍可取消选择或点击其他站点更换。`;
  } else if (promptStage === 'confirm') {
    title = '确认这一段行程';
    text = `再次${tap}「${pendingName}」即可确认到达这里，将这一段行程加入路线。也可以${tap}其他可达站点，继续比较下车位置。`;
    action = '提示：「上一步」可撤回已确认的选择。';
  } else if (promptStage === 'finish') {
    title = '步行到达终点';
    text = `从「${currentName}」已能步行到达终点。${tap}地图上的「终」即可完成最后一段步行并结束路线，查看本次旅程的用时。`;
    action = '步行到达终点\n提示：最后一段步行也会计入用时。';
  } else if (promptStage === 'rideStop') {
    title = '预览下车站';
    text = `沿「${state.selectedLineName || '当前线路'}」选择想下车的站点，${tap}一次即可预览。可以一次乘过多个站；到不了终点附近时，可以在途中下车换乘。`;
    action = '预览一个下车站\n提示：点一次查看，再点一次确认。';
    if (alightHintPoint) action += `在「${promptConfig.alightHint.stopName}」下车换乘。`;
  } else {
    title = hasRidden ? '换乘或继续乘车' : '查看并选择线路';
    text = hasRidden
      ? `在「${currentName}」的站点名称板中${tap}线路名称，或${tap}地图标线，即可选择接下来乘坐的线路。选择另一条线路就是换乘，也可以沿原线路继续乘车。`
      : `在站点名称板中${tap}线路名称，或${tap}地图标线，即可选择线路并查看沿途站点。可以自由比较多条线路；只有一条时会自动选中。`;
    action = hasRidden
      ? '选择接下来的线路\n提示：选好后可预览沿途的下车站。'
      : '选择一条线路\n提示：选好后可预览沿途的下车站。';
  }
  document.getElementById('tutorial-guide-title').textContent = title;
  document.getElementById('tutorial-guide-text').textContent = text;
  document.getElementById('tutorial-guide-action').textContent = action;
  syncGuideBottom();
  panel.classList.remove('guide-mistake');
}

/**
 * 站点高亮（脉冲圆环 + 名牌），用 DOM Marker 而不是站点图层，任何缩放等级都可见；
 * 不可点击，点击会穿透到下面的真实站点。来源：
 *   mapTutorial.transfer    换乘站，整关常驻，名牌为“换乘站 · 站名”；
 *   mapTutorial.highlights  [{ stopName, position, text, side, phase }]；phase 默认 'beforeStart'
 *                           （出发前显示，帮助选择首站），'afterStart' 为出发后显示（如目标站）。
 * 起点步行注释（notes 中 at:'origin'）同样只在出发前显示——确认首站后起点红圈也会隐藏。
 */
let highlightMarkers = [];
let noteMarkers = [];
let renderedKey = null; // 上次渲染依据的“是否已出发 | 换乘站是否已揭晓”，不变就不重建（避免脉冲动画重启）
let transferRevealed = false; // 换乘站高亮在玩家选对线路后才出现，回到出发前再隐藏

function hasStarted() {
  return (state.routeStops || []).length > 0;
}

/** side：名牌位置，默认在圆点正下方；'left' / 'right' 放在圆点两侧，供相邻站点错开名牌 */
function highlightMarker(position, caption, side) {
  const sideClass = side === 'left' || side === 'right' ? ' caption-' + side : '';
  const marker = new AMap.Marker({
    position,
    content: `<div class="transfer-highlight${sideClass}"><span class="transfer-highlight-ring"></span>`
      + `<span class="transfer-highlight-dot"></span>`
      + `<span class="transfer-highlight-name">${escapeHtml(caption)}</span></div>`,
    offset: new AMap.Pixel(0, 0),
    zIndex: 455,
    clickable: false,
  });
  marker.setMap(state.map);
  return marker;
}

function noteMarker(center, text) {
  const marker = new AMap.Marker({
    position: [center[0], center[1] - MAX_WALK_M / 111000], // 红圈底端：顶部留给时间 HUD 和操作提示
    content: `<div class="map-tutorial-note">${escapeHtml(text)}</div>`,
    offset: new AMap.Pixel(0, 0),
    zIndex: 440,
    clickable: false,
  });
  marker.setMap(state.map);
  return marker;
}

function clearAnnotations() {
  alightHintPoint = null;
  for (const m of highlightMarkers.concat(noteMarkers)) m.setMap(null);
  highlightMarkers = [];
  noteMarkers = [];
  renderedKey = null;
  transferRevealed = false;
  transferPoint = null;
  setHudFlash(false);
}

/** 限时关卡（mapTutorial.flashHud）出发前让顶部时间 HUD 高亮闪烁，确认首站后停止。 */
function setHudFlash(on) {
  if (typeof document === 'undefined') return;
  document.getElementById('mode-hud')?.classList?.toggle('hud-flash', !!on);
}

/** 按“是否已出发”同步高亮、注释与 HUD 闪烁；每次切换教学阶段时调用。 */
function syncAnnotations() {
  if (!promptConfig || !state.map) return;
  if (promptConfig.panelOnly) return;
  const started = hasStarted();
  if (!started) { transferRevealed = false; transferPoint = null; }
  if (promptStage === 'rideToTransfer' || promptStage === 'previewTransfer' || transferReached()) transferRevealed = true;
  const tPos = transferRevealed ? transferPosition() : null;
  const key = started + '|' + transferRevealed + '|' + (tPos ? tPos.join(',') : '');
  if (key === renderedKey) return;
  for (const m of highlightMarkers.concat(noteMarkers)) m.setMap(null);
  highlightMarkers = [];
  noteMarkers = [];
  renderedKey = key;
  const t = promptConfig.transfer;
  if (t && tPos) highlightMarkers.push(highlightMarker(tPos, '换乘站 · ' + t.stopName));
  for (const h of promptConfig.highlights || []) {
    const afterStart = h.phase === 'afterStart';
    if (afterStart === started) highlightMarkers.push(highlightMarker(h.position, h.text, h.side));
  }
  for (const note of promptConfig.notes || []) {
    if (note.at === 'origin' && started) continue;
    const center = note.at === 'dest' ? state.DEST : state.ORIGIN;
    if (center && note.text) noteMarkers.push(noteMarker(center, note.text));
  }
  setHudFlash(!!promptConfig.flashHud && !started);
}

// ============ 下车换乘提示（自由教程 mapTutorial.alightHint） ============
// 玩家所乘线路会经过建议的换乘站时，只在右侧文字框里建议在此下车（地图上不加高亮）；
// 到站、撤回或改选线路后由玩法层重新设置。
let alightHintPoint = null;

/** 玩法层告知所乘线路在建议换乘站的站台坐标；传 null 取消提示 */
export function setTutorialAlightHint(point) {
  alightHintPoint = promptConfig?.alightHint && Array.isArray(point) ? point : null;
  renderGuidePanel();
}

/** 自由教程的建议下车站配置（无则为 null） */
export function getTutorialAlightHint() {
  return promptConfig?.alightHint || null;
}

/** 为当前关卡启用地图教学；传空值时关闭。 */
export function showMapTutorial(config) {
  removeZoomListener();
  removeMarker();
  clearAnnotations();
  mistakeReason = null;
  promptConfig = config || null;
  mapPracticeCompleted = false;
  boardingPreviewStarted = false;
  syncAnnotations();
  promptStage = null;
  promptPosition = null;
  busStopsRevealed = !promptConfig?.waitForBusStops
    || !!(state.map && state.map.getZoom() >= busMinZoom());
  if (!promptConfig) return;
  if (promptConfig.mapPractice && state.map) {
    viewportListener = () => {
      if (boardingPreviewStarted || state.routeStops.length) return;
      mapPracticeCompleted = originViewportReady();
      // 尚未预览站点时检查视野；开始预览后不再回到地图操作。
      renderPrompt();
    };
    state.map.on('moveend', viewportListener);
    state.map.on('zoomend', viewportListener);
  }
  if (promptConfig.waitForBusStops && !busStopsRevealed && state.map) {
    zoomListener = () => {
      // 这是单向状态：一旦玩家看见过公交站，之后缩小地图也不再退回放大提示。
      if (busStopsRevealed || state.map.getZoom() < busMinZoom()) return;
      busStopsRevealed = true;
      if (promptStage === 'initial') renderPrompt();
    };
    state.map.on('zoomchange', zoomListener);
  }
  setMapTutorialStage('initial');
}

/** 当前关卡是否为该站配置了换乘教学（供玩法层判断预览的是不是换乘站） */
export function isTutorialTransferStop(logical) {
  const t = promptConfig?.transfer;
  return !!(t && logical && logical.name === t.stopName);
}

/**
 * 切换地图教学文案；传入坐标时把提示移动到本步骤的操作目标。
 * options.animateFrom：提示先出现在该坐标，再缓动平移到 position。
 */
export function setMapTutorialStage(stage, position = null, options = {}) {
  cancelSlide();
  if (promptConfig?.mapPractice && state.pendingStart && (stage === 'selectLine' || stage === 'confirm')) {
    boardingPreviewStarted = true;
  }
  promptStage = stage;
  if (Array.isArray(position)) promptPosition = position;
  else if (stage === 'initial') promptPosition = null;
  const from = options.animateFrom;
  if (!Array.isArray(from) || !Array.isArray(position) || (transferPrompt(stage) && stage !== 'rideToTransfer')) { renderPrompt(); return; }
  promptPosition = from;
  renderPrompt();
  promptPosition = position;
  const marker = promptMarker;
  if (!marker || !marker.setPosition) return;
  const t0 = performance.now();
  const frame = (now) => {
    if (promptMarker !== marker) return;
    const t = Math.min(1, (now - t0) / SLIDE_MS);
    const k = 1 - Math.pow(1 - t, 3);
    marker.setPosition([from[0] + (position[0] - from[0]) * k, from[1] + (position[1] - from[1]) * k]);
    slideRaf = t < 1 ? requestAnimationFrame(frame) : 0;
  };
  slideRaf = requestAnimationFrame(frame);
}

const SLIDE_MS = 900;
let slideRaf = 0;
function cancelSlide() {
  if (slideRaf) cancelAnimationFrame(slideRaf);
  slideRaf = 0;
}

/** 重新开始本关时恢复第一步提示。 */
export function resetMapTutorialPrompt() {
  if (alightHintPoint) setTutorialAlightHint(null);
  if (promptConfig) setMapTutorialStage('initial');
}

/** 离开关卡或完成教学步骤后彻底清理。 */
export function clearMapTutorial() {
  mistakeReason = null;
  renderUndoTip(null);
  removeZoomListener();
  removeMarker();
  clearAnnotations();
  renderCardTip('tutorial-card-tip', 'infocard', null);
  renderCardTip('tutorial-current-tip', 'current-infocard', null);
  promptConfig = null;
  promptStage = null;
  promptPosition = null;
  busStopsRevealed = false;
  boardingPreviewStarted = false;
  renderGuidePanel();
}
