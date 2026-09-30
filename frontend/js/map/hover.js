/**
 * map/hover.js —— 站点悬浮高亮 + 信息卡
 *
 * 【交互设计】
 *   鼠标划过站点时：高亮该站所属的所有线路，并在地图角落弹出预览卡。
 *   路线规划开始后，已确认的当前站另用一张固定信息卡显示，预览下一站不会覆盖它。
 *   两个细节来自实际踩坑：
 *     1) 45ms 防抖：快速划过密集站点时只处理最后停留的那个，
 *        否则会反复创建/销毁上百条折线而卡顿；
 *     2) 悬浮层用 setMap(null) 立即销毁而不是淡出：密集区反复建线时淡出动画会堆积。
 *   覆盖物都设了 interactive:false —— 免 Key 的 OSM 后端下，高亮线若拦截鼠标，
 *   会导致"点一下站点高亮闪一下"的抖动。
 */

import { state } from '../core/state.js';
import { resolveStop, getLine } from '../data/index-builder.js';
import { hide, $ } from '../core/dom.js';
import { makeTransitLineLayers } from './transit-line-style.js';
import { makeMassMarks, stopToData } from './stop-marks.js';
import { lineSignClass, lineSignInnerHTML } from '../data/line-sign.js';
import { isMapPracticePending } from './tutorial-layer.js';

let hoverTimer = null;
const cards = {
  preview: { card: 'infocard', stop: 'info-stop', latin: 'info-latin', lines: 'info-lines', toggle: 'info-toggle', walk: 'info-walk', collapsed: null, lineCount: 0 },
  current: { card: 'current-infocard', stop: 'current-info-stop', latin: 'current-info-latin', lines: 'current-info-lines', toggle: 'current-info-toggle', walk: 'current-info-walk', collapsed: null, lineCount: 0 },
};

/** MassMarks 的 mouseover 回调：防抖后渲染高亮（触摸设备不使用悬浮事件） */
export function onStopMouseOver(e) {
  if (state.storyActive || state.editorActive) return; // 剧情/教学、关卡编辑期间禁止交互
  if (isMapPracticePending()) return; // 地图操作练习期间静默忽略站点预览
  if (state.isTouch) return;     // 触摸设备：合成 mouseover 会与两阶段点击打架
  if (state.pendingStart || state.pendingCandidate) return; // 已点击预览后保持红圈，不被悬浮覆盖
  const physical = e && e.data;
  const d = resolveStop(physical);
  if (!d) return;
  // 逻辑站可能由多个相邻物理站合并而来；红圈必须落在鼠标实际指向的那个点上。
  const point = physical && (physical.lnglat || (
    Number.isFinite(physical.lng) && Number.isFinite(physical.lat)
      ? [physical.lng, physical.lat]
      : null
  ));
  // 防抖：快速划过密集站点时只处理最后停留的那个，避免反复创建/销毁大量折线
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (state.storyActive || isMapPracticePending() || state.pendingStart || state.pendingCandidate) return;
    renderHighlight(d, point);
  }, 45);
}

/** MassMarks 的 mouseout 回调：取消防抖并清掉高亮（预览锁定时保持红圈） */
export function onStopMouseOut() {
  if (state.isTouch) return; // 触摸设备：缩放/点按钮会触发 mouseout，不能据此取消预选
  if (state.pendingStart || state.pendingCandidate) return;
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  clearHighlight();
}

/** 画出该站所属线路 + 高亮圈，并弹出信息卡；点击预览时按实际物理站坐标画圈。 */
export function renderHighlight(d, highlightPoint = null, onLineToggle = null) {
  clearHighlight();

  // 预览站点时临时画出该站全部线路，但不创建这些线路的站点层。
  // 当前可乘线路及其可点击站点仍由 route.js 的候选网络单独管理；两层分离后，
  // 无论第几次换乘都复用同一套预览逻辑，不会把未确认线路的站点提前放出来。
  const allLines = displayLines(d);
  drawPreviewLines(reachableSegments(d));

  const ring = new AMap.Circle({
    center: highlightPoint || [d.lng, d.lat], radius: 150, strokeColor: '#ffffff', strokeWeight: 2,
    fillColor: '#e74c3c', fillOpacity: 0.25, zIndex: 300,
    interactive: false, // OSM：高亮圈不拦截鼠标
  });
  ring.setMap(state.map);
  state.activeOverlays.push(ring);

  showInfoCard(d, allLines, 'preview', onLineToggle);
}

/**
 * 从该站出发实际能坐到的线路段：逐个方向取“本站之后”的路径与站点。
 * 单向线在本站之前的部分（车开过来的路）不画；在本站终止的方向不能上车，整条不画；
 * 双向线与环线照常画整条。这样预览与确认后的候选网络一致，不会出现“预览有、选中后消失”的半边。
 */
function reachableSegments(d) {
  const out = [];
  for (const id of d.line_ids || []) {
    const line = getLine(id);
    if (!line || !line.path || line.path.length < 2) continue;
    const stops = line.stops || [];
    const physId = d.stopByLine ? d.stopByLine[String(id)] : null;
    const i = physId == null ? -1 : stops.findIndex((st) => String(st.id) === String(physId));
    if (!line.oneWay || line.isLoop || i < 0) {
      out.push({ line, path: line.path, stops });
      continue;
    }
    if (i >= stops.length - 1) continue; // 本方向到此为止，无法从这里上车
    const here = stops[i];
    let start = 0, best = Infinity;
    line.path.forEach((p, k) => {
      const dd = (p[0] - here.lng) ** 2 + (p[1] - here.lat) ** 2;
      if (dd < best) { best = dd; start = k; }
    });
    const path = line.path.slice(start);
    if (path.length >= 2) out.push({ line, path, stops: stops.slice(i) });
  }
  return out;
}

/**
 * 画站点预览线路段，并把这些段经过的站点改成“线路色描边 + 白色空心圆”。
 * 预览站点层只做展示、不生成命中区：未确认线路的站点仍不可点击，
 * 候选站点始终由 route.js 的候选网络统一生成（其 zIndex 220 高于本层）。
 */
function drawPreviewLines(segments) {
  // 选中的线路优先占用重叠站点的颜色。
  const ordered = segments.slice().sort((a, b) =>
    (state.selectedLineName === b.line.name) - (state.selectedLineName === a.line.name));
  const stopPoints = [];
  const seenStops = new Set();
  for (const { line, path, stops } of ordered) {
    const selected = state.selectedLineName === line.name;
    const layers = makeTransitLineLayers({
      path,
      color: line.color,
      mode: line.mode,
      selected,
      zIndex: selected ? 210 : 200,
      opacity: selected ? 1 : 0.88,
      lineName: line.name,
      interactive: false,
    });
    for (const layer of layers) {
      layer.setMap(state.map);
      state.activeOverlays.push(layer);
    }
    for (const st of stops) {
      const id = String(st.id);
      if (seenStops.has(id) || !Number.isFinite(st.lng) || !Number.isFinite(st.lat)) continue;
      seenStops.add(id);
      stopPoints.push(stopToData(
        { id, name: st.name, lng: st.lng, lat: st.lat, mode: line.mode, logicalId: state.physToLogical.get(id) },
        false,
        line.color,
      ));
    }
  }
  if (!stopPoints.length) return;
  // 高于预览线路（200/210），低于候选站点（220），且不拦截鼠标。
  const marks = makeMassMarks(stopPoints, { allowWalkStyle: false, inverseLineStops: true, zIndex: 215, interactive: false });
  marks.setMap(state.map);
  state.activeOverlays.push(marks);
}

/** 清掉高亮覆盖物并隐藏信息卡（悬浮层即时销毁，不做淡出） */
export function clearHighlight() {
  const overlays = state.activeOverlays;
  state.activeOverlays = [];
  for (const o of overlays) o.setMap(null); // 悬浮层即时销毁，不做淡出（密集区反复建线会卡）
  const card = $('infocard');
  if (card) card.classList.add('hidden');
}

/** 固定显示已确认的当前站信息；下一站预览使用另一张卡，不会把它顶掉。 */
export function showCurrentStopInfo(d, onLineToggle) {
  showInfoCard(d, displayLines(d), 'current', onLineToggle);
}

/** 仅在整条路线被重置时清掉当前站信息。 */
export function clearCurrentStopInfo() {
  const card = $(cards.current.card);
  if (card) card.classList.add('hidden');
}

/** 清除预选状态和悬浮高亮，但不清已确认的路线。 */
export function cancelPreview() {
  state.pendingStart = null;
  state.pendingCandidate = null;
  clearHighlight();
}

/** 展开/收起信息卡里的"途经线路"列表 */
export function toggleInfoLines() {
  toggleCardLines('preview');
}

function toggleCardLines(kind) {
  const cfg = cards[kind];
  cfg.collapsed = !cfg.collapsed;
  const card = $(cfg.card);
  if (card) card.classList.toggle('collapsed', cfg.collapsed);
  const btn = $(cfg.toggle);
  if (btn) btn.textContent = cfg.collapsed ? ('展开 ' + cfg.lineCount + ' 条线路') : '收起';
}

function displayLines(d) {
  const shown = [], seen = new Set();
  for (const id of d.line_ids || []) {
    const line = getLine(id);
    if (!line || !line.path || line.path.length < 2 || seen.has(line.name)) continue;
    seen.add(line.name);
    shown.push(line);
  }
  return shown;
}

/** 信息卡内容：按公交/地铁标牌语言展示站名与途经线路（大站可折叠）。 */
function showInfoCard(d, lines, kind = 'preview', onLineToggle = null) {
  const cfg = cards[kind];
  const stopEl = $(cfg.stop);
  if (stopEl) stopEl.textContent = d.name;
  const hasMetro = lines.some((line) => line.mode === 'metro');
  const hasBus = lines.some((line) => line.mode !== 'metro');
  const latinEl = $(cfg.latin);
  if (latinEl) latinEl.textContent = '';

  const box = $(cfg.lines);
  if (box) {
    box.replaceChildren();
    for (const l of lines) {
      const selectable = typeof onLineToggle === 'function';
      const tag = document.createElement(selectable ? 'button' : 'span');
      tag.className = lineSignClass(l)
        + (selectable ? ' selectable' : '') + (state.selectedLineName === l.name ? ' selected' : '');
      tag.style.backgroundColor = l.color || (l.mode === 'metro' ? '#e74c3c' : '#f39c12');
      // 先赋纯文本，既为无 innerHTML 的简化环境兜底，也便于辅助技术读取原名称。
      tag.textContent = l.name;
      tag.innerHTML = lineSignInnerHTML(l);
      tag.setAttribute?.('aria-label', l.name);
      if (selectable) {
        tag.type = 'button';
        tag.setAttribute?.('aria-pressed', state.selectedLineName === l.name ? 'true' : 'false');
        tag.onclick = () => onLineToggle(l.name);
      }
      box.appendChild(tag);
    }
  }

  cfg.lineCount = lines.length;
  if (cfg.collapsed === null) cfg.collapsed = !!state.isTouch; // 手机默认收起，桌面默认展开
  const btn = $(cfg.toggle);
  if (btn) {
    btn.classList.toggle('hidden', lines.length <= 1); // 只有一条线路时无需折叠按钮
    btn.textContent = cfg.collapsed ? ('展开 ' + lines.length + ' 条线路') : '收起';
    btn.onclick = () => toggleCardLines(kind); // 两张卡独立折叠，互不影响
  }
  const card = $(cfg.card);
  if (card) {
    card.classList.remove('metro-board', 'bus-board', 'mixed-board');
    card.classList.add(hasMetro ? 'metro-board' : 'bus-board');
    if (hasMetro && hasBus) card.classList.add('mixed-board');
    // 只有一条线路时始终露出名称板，否则手机默认折叠后会无处点击取消选择。
    card.classList.toggle('collapsed', lines.length > 1 && cfg.collapsed);
    card.classList.remove('hidden');
  }

  const walkEl = $(cfg.walk);
  if (walkEl) walkEl.textContent = '';
}
