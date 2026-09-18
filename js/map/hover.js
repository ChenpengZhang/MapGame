/**
 * map/hover.js —— 站点悬浮高亮 + 信息卡
 *
 * 【交互设计】
 *   鼠标划过站点时（仅未开始规划时有效）：高亮该站所属的所有线路，并在地图角落弹出信息卡。
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

let hoverTimer = null;

/** MassMarks 的 mouseover 回调：防抖后渲染高亮 */
export function onStopMouseOver(e) {
  if (state.storyActive) return; // 剧情/教学期间禁止交互
  const d = resolveStop(e && e.data);
  if (!d) return;
  // 防抖：快速划过密集站点时只处理最后停留的那个，避免反复创建/销毁大量折线
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    renderHighlight(d);
  }, 45);
}

/** MassMarks 的 mouseout 回调：取消防抖并清掉高亮 */
export function onStopMouseOut() {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  clearHighlight();
}

/** 画出该站所属线路 + 高亮圈，并弹出信息卡 */
function renderHighlight(d) {
  clearHighlight();

  const shown = [];
  for (const id of d.line_ids || []) {
    const line = getLine(id);
    if (!line || !line.path || line.path.length < 2) continue;
    const isMetro = line.mode === 'metro';
    const poly = new AMap.Polyline({
      path: line.path, strokeColor: line.color, strokeWeight: isMetro ? 5 : 3,
      strokeOpacity: 0.95, lineJoin: 'round', zIndex: isMetro ? 210 : 200,
      interactive: false, // OSM：高亮线不拦截鼠标，否则悬浮点点位会闪烁
    });
    poly.setMap(state.map);
    state.activeOverlays.push(poly);
    shown.push(line);
  }

  const ring = new AMap.Circle({
    center: [d.lng, d.lat], radius: 150, strokeColor: '#ffffff', strokeWeight: 2,
    fillColor: '#e74c3c', fillOpacity: 0.25, zIndex: 300,
    interactive: false, // OSM：高亮圈不拦截鼠标
  });
  ring.setMap(state.map);
  state.activeOverlays.push(ring);

  showInfoCard(d, shown);
}

/** 清掉高亮覆盖物并隐藏信息卡（悬浮层即时销毁，不做淡出） */
export function clearHighlight() {
  const overlays = state.activeOverlays;
  state.activeOverlays = [];
  for (const o of overlays) o.setMap(null); // 悬浮层即时销毁，不做淡出（密集区反复建线会卡）
  const card = $('infocard');
  if (card) card.classList.add('hidden');
}

/** 信息卡内容：站名（含地铁/公交）+ 途经线路小标签 */
function showInfoCard(d, lines) {
  const stopEl = $('info-stop');
  if (stopEl) stopEl.textContent = d.name + (d.mode === 'metro' ? '（地铁）' : '（公交）');

  const box = $('info-lines');
  if (box) {
    box.innerHTML = '';
    for (const l of lines) {
      const tag = document.createElement('span');
      tag.className = 'line-tag';
      tag.style.backgroundColor = l.color || (l.mode === 'metro' ? '#e74c3c' : '#f39c12');
      tag.textContent = l.name;
      box.appendChild(tag);
    }
  }

  const walkEl = $('info-walk');
  if (walkEl) walkEl.textContent = '';
  const card = $('infocard');
  if (card) card.classList.remove('hidden');
}
