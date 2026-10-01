/**
 * map/dest-indicator.js —— 终点方向指示
 *
 * 终点不在可见区域（地图减去面板遮挡）时，在可见区域边缘显示一枚指向终点的标签。点击行为（飞到终点）由 app.js 绑定。
 * 投影用 getBounds 线性插值（经度线性、纬度走墨卡托），两种地图后端通用。
 */

import { state } from '../core/state.js';
import { $ } from '../core/dom.js';
import { overlayRects } from './map-init.js';

const EDGE_MARGIN = 16;
let active = false;
let bound = false;
let frame = 0;

/** 一局开始时打开、回菜单时关闭 */
export function setDestIndicatorActive(on) {
  active = !!on;
  if (active) bindMap();
  scheduleDestIndicator();
}

/** 路线或视野变化后主动刷新位置 */
export function scheduleDestIndicator() {
  if (frame) return;
  const raf = globalThis.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
  frame = raf(() => { frame = 0; update(); });
}

function bindMap() {
  if (bound || !state.map) return;
  bound = true;
  // Leaflet 兼容层平移中触发 move，原生高德触发 mapmove；两边都注册，没有的事件不会触发
  for (const event of ['move', 'mapmove', 'moveend', 'zoomend', 'resize']) {
    state.map.on(event, scheduleDestIndicator);
  }
}

function mercY(lat) {
  const r = Math.max(-85, Math.min(85, lat)) * Math.PI / 180;
  return Math.log(Math.tan(Math.PI / 4 + r / 2));
}

function update() {
  const el = $('dest-indicator');
  if (!el) return;
  const hideIt = () => el.classList.add('hidden');
  if (!active || !state.map || !state.DEST || !state.map.getBounds) return hideIt();
  const mapEl = $('map');
  const appEl = $('app');
  const rect = mapEl?.getBoundingClientRect?.();
  const appRect = appEl?.getBoundingClientRect?.();
  if (!rect || !rect.width || !rect.height || !appRect) return hideIt();

  const b = state.map.getBounds();
  const sw = b?.getSouthWest?.(), ne = b?.getNorthEast?.();
  if (!sw || !ne) return hideIt();
  const west = sw.getLng(), east = ne.getLng(), south = sw.getLat(), north = ne.getLat();
  if (!(east > west) || !(north > south)) return hideIt();
  const [lng, lat] = state.DEST;
  const x = (lng - west) / (east - west) * rect.width;
  const y = (mercY(north) - mercY(lat)) / (mercY(north) - mercY(south)) * rect.height;

  // 可见区域 = 地图减去横跨整屏的条带（顶栏、手机底部抽屉）；其它面板只在标签落到它上面时局部避让，
  // 这样左上角的路线面板不会让整条上边都往下缩，标签能贴着真正的屏幕边缘。
  const { rects } = overlayRects();
  let T = EDGE_MARGIN, B = rect.height - EDGE_MARGIN, L = EDGE_MARGIN, R = rect.width - EDGE_MARGIN;
  for (const o of rects) {
    if (!o.band) continue;
    if ((o.top + o.bottom) / 2 < rect.height / 2) T = Math.max(T, o.bottom + EDGE_MARGIN);
    else B = Math.min(B, o.top - EDGE_MARGIN);
  }
  if (R - L < 80 || B - T < 60) return hideIt();
  const blockers = rects.filter((o) => !o.band);
  const covered = blockers.some((o) => x >= o.left && x <= o.right && y >= o.top && y <= o.bottom);
  if (x >= L && x <= R && y >= T && y <= B && !covered) return hideIt();

  el.classList.remove('hidden');

  // 从可见区域中心沿终点方向射出，与边框求交，再按标签自身尺寸往里收
  const cx = (L + R) / 2, cy = (T + B) / 2;
  const dx = x - cx, dy = y - cy;
  const tx = dx ? ((dx > 0 ? R : L) - cx) / dx : Infinity;
  const ty = dy ? ((dy > 0 ? B : T) - cy) / dy : Infinity;
  const t = Math.min(tx, ty);
  const hw = (el.offsetWidth || 110) / 2, hh = (el.offsetHeight || 30) / 2;
  let px = Math.max(L + hw, Math.min(R - hw, cx + dx * t));
  let py = Math.max(T + hh, Math.min(B - hh, cy + dy * t));
  [px, py] = avoidPanels(px, py, hw, hh, blockers, { L, T, R, B }, ty <= tx);
  el.style.left = `${Math.round(px + rect.left - appRect.left)}px`;
  el.style.top = `${Math.round(py + rect.top - appRect.top)}px`;
  el.style.setProperty('--dest-angle', `${Math.round(Math.atan2(y - py, x - px) * 180 / Math.PI)}deg`);
}

/**
 * 标签压到面板上时沿所在的边滑开：在上/下边就左右移，在左/右边就上下移，取离原位置最近的空位。
 * 几块面板相邻时重复几次。
 */
function avoidPanels(px, py, hw, hh, blockers, box, horizontalEdge) {
  const m = EDGE_MARGIN / 2;
  for (let pass = 0; pass < 4; pass++) {
    const hit = blockers.find((o) => px + hw > o.left - m && px - hw < o.right + m && py + hh > o.top - m && py - hh < o.bottom + m);
    if (!hit) break;
    const options = horizontalEdge
      ? [[hit.left - m - hw, py], [hit.right + m + hw, py], [px, hit.bottom + m + hh], [px, hit.top - m - hh]]
      : [[px, hit.top - m - hh], [px, hit.bottom + m + hh], [hit.left - m - hw, py], [hit.right + m + hw, py]];
    const inside = options.filter(([ox, oy]) => ox - hw >= box.L && ox + hw <= box.R && oy - hh >= box.T && oy + hh <= box.B);
    if (!inside.length) break;
    inside.sort((a, b) => Math.hypot(a[0] - px, a[1] - py) - Math.hypot(b[0] - px, b[1] - py));
    [px, py] = inside[0];
  }
  return [px, py];
}
