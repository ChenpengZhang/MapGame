/**
 * map/native-picker.js —— 原生高德下的站点 / 线路拾取
 *
 * 【为什么需要】
 *   Leaflet 兼容层（amap-polyfill.js）给每个站点另画透明命中圆（桌面 9px、触屏 16px 半径），
 *   线路也有独立的透明宽热区，点选手感宽松。原生高德则：
 *     - MassMarks 只按图标本身（公交点 7px）命中，几乎点不中；
 *     - 折线（可见线路与透明热区）叠在海量点之上，会吞掉本该落在站点上的点击。
 *   因此原生高德下不依赖它自己的覆盖物事件，而是统一在地图点击 / 移动时按屏幕像素距离拾取：
 *   先找命中半径内最近的站点（高层级图层优先），没有站点再找命中的候选线路。
 *   折线一律设为 bubble（事件冒泡到地图），不再拦截点击。
 *
 * 拾取监听在 map-init 创建地图后立即注册，保证先于“点地图空白取消预览”执行。
 */

import { state } from '../core/state.js';

const massLayers = new Set(); // { mm, z }
const pickLines = new Set();  // { overlay, path, width, onClick }
let hovered = null;           // { entry, data } 当前悬停的站点
let lastPickAt = -1;          // 最近一次拾取命中的时间，供“点空白取消”判断同一次点击

/** 这次地图点击是否已被拾取器当作站点/线路点击处理（此时不应再按点空白处理） */
export function clickWasPicked(e) {
  return !!(e && e.__picked) || (lastPickAt >= 0 && performance.now() - lastPickAt < 400);
}

export function isNativeAmap() {
  return !!(window.AMap && !AMap.__polyfill);
}

function hitRadius() {
  // 原生高德的点更小更密，命中放宽到 14/22；Leaflet 兼容层保持原来的 9/16
  if (isNativeAmap()) return state.isTouch ? 22 : 14;
  return state.isTouch ? 16 : 9;
}

/**
 * 接管一个 MassMarks 的交互：事件处理函数由本模块在拾取命中时调用，
 * 不再交给高德（避免它自己的小范围命中与本模块重复触发）。
 */
export function makeMassMarksPickable(mm, data, zIndex) {
  const entry = { mm, z: zIndex, data: data || [], onMap: false, hidden: false, handlers: {} };
  mm.on = (type, cb) => { (entry.handlers[type] = entry.handlers[type] || []).push(cb); };
  const setData = mm.setData.bind(mm);
  mm.setData = (d) => { entry.data = d || []; setData(d); };
  const setMap = mm.setMap.bind(mm);
  mm.setMap = (m) => { entry.onMap = !!m; if (!m) massLayers.delete(entry); else massLayers.add(entry); setMap(m); };
  const show = mm.show.bind(mm), hide = mm.hide.bind(mm);
  mm.show = () => { entry.hidden = false; show(); };
  mm.hide = () => { entry.hidden = true; hide(); };
  return mm;
}

/** 注册一条可点选的线路热区（折线本身不接事件，由拾取器按像素距离判断） */
export function registerPickableLine(overlay, path, width, onClick) {
  const entry = { overlay, path, width, onClick };
  pickLines.add(entry);
  const setMap = overlay.setMap.bind(overlay);
  overlay.setMap = (m) => { if (!m) pickLines.delete(entry); else pickLines.add(entry); setMap(m); };
}

function toPixel(map, lnglat) {
  // 原生高德需要 LngLat 对象；兼容层直接收数组（并按数组缓存坐标换算）
  const ll = Array.isArray(lnglat) && isNativeAmap() && AMap.LngLat ? new AMap.LngLat(lnglat[0], lnglat[1]) : lnglat;
  const p = map.lngLatToContainer(ll);
  return p ? [p.getX ? p.getX() : p.x, p.getY ? p.getY() : p.y] : null;
}

/** 命中半径内最近的站点；图层按 zIndex 从高到低，某层有命中就不再看下层 */
function pickStop(map, px) {
  const r = hitRadius();
  const layers = [...massLayers].filter((l) => l.onMap && !l.hidden).sort((a, b) => b.z - a.z);
  for (const layer of layers) {
    let best = null, bestD = r * r;
    for (const d of layer.data) {
      if (!d || !d.lnglat) continue;
      const p = toPixel(map, d.lnglat);
      if (!p) continue;
      const dx = p[0] - px[0], dy = p[1] - px[1];
      const dd = dx * dx + dy * dy;
      if (dd <= bestD) { bestD = dd; best = d; }
    }
    if (best) return { entry: layer, data: best };
  }
  return null;
}

function segmentDistance2(p, a, b) {
  const vx = b[0] - a[0], vy = b[1] - a[1];
  const len2 = vx * vx + vy * vy;
  const t = len2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / len2)) : 0;
  const x = a[0] + t * vx - p[0], y = a[1] + t * vy - p[1];
  return x * x + y * y;
}

function pickLine(map, px) {
  let best = null, bestD = Infinity;
  for (const line of pickLines) {
    const half = line.width / 2;
    let prev = null;
    for (const pt of line.path) {
      const p = toPixel(map, pt);
      if (prev && p) {
        const d = segmentDistance2(px, prev, p);
        if (d <= half * half && d < bestD) { bestD = d; best = line; }
      }
      prev = p;
    }
  }
  return best;
}

function markPicked(e) {
  lastPickAt = performance.now();
  try { if (e) e.__picked = true; } catch { /* 事件对象不可写时靠时间戳判断 */ }
}

function fire(entry, type, data) {
  for (const cb of entry.handlers[type] || []) cb({ data });
}

/**
 * 在新建的地图上安装拾取（map-init 创建地图后立即调用）。两种底图都用它拾取站点：
 * 原生高德的海量点命中范围太小；Leaflet 兼容层的站点画在 canvas 上，多块 canvas 叠放时只有最上面一块能收到鼠标。
 */
export function installNativePicker(map) {
  if (!map?.on || !map.lngLatToContainer) return;
  const native = isNativeAmap();
  // 原生高德：所有折线/圆的事件冒泡到地图，它们不再拦截落在站点上的点击
  // 不能用 class extends 继承高德的内部构造器（可能导致所有折线创建失败）；
  // 用普通包装函数调用原构造器，并共享原型，instanceof AMap.Polyline 仍然成立。
  for (const name of native ? ['Polyline', 'Circle'] : []) {
    const Base = AMap[name];
    if (!Base || Base.__bubblePatched) continue;
    const Wrapped = function (opts) { return new Base({ bubble: true, ...opts }); };
    Wrapped.prototype = Base.prototype;
    Wrapped.__bubblePatched = true;
    AMap[name] = Wrapped;
  }
  // 不依赖高德的地图 click 事件（被覆盖物/海量点吞掉时根本不触发），直接监听地图容器的原生指针事件：
  // 按下与抬起位置相距很近、时间很短才算一次点击（拖动平移不算）。捕获阶段执行，先于高德自身处理。
  const container = map.getContainer?.() || document.getElementById('map');
  const localPx = (ev) => { const r = container.getBoundingClientRect(); return [ev.clientX - r.left, ev.clientY - r.top]; };
  let down = null;
  container.addEventListener('pointerdown', (ev) => {
    down = ev.isPrimary ? { px: localPx(ev), t: performance.now() } : null;
  }, true);
  container.addEventListener('pointerup', (ev) => {
    if (!down || !ev.isPrimary) return;
    const px = localPx(ev);
    const moved = Math.hypot(px[0] - down.px[0], px[1] - down.px[1]);
    const quick = performance.now() - down.t < 600;
    down = null;
    if (moved > 6 || !quick) return;
    try {
      const stop = pickStop(map, px);
      if (stop) { markPicked(null); fire(stop.entry, 'click', stop.data); return; }
      const line = pickLine(map, px);
      if (line) { markPicked(null); line.onClick({ pixel: { x: px[0], y: px[1] } }); }
    } catch (err) {
      console.error('[native-picker] 站点/线路拾取失败', err);
    }
  }, true);
  // Leaflet 兼容层：站点点击已由上面处理，吞掉随后的 click，
  // 以免同一次点击再落到下面的线路热区或被地图当成“点空白取消”
  if (!native) {
    container.addEventListener('click', (ev) => {
      if (lastPickAt >= 0 && performance.now() - lastPickAt < 400) { ev.stopPropagation(); ev.preventDefault(); }
    }, true);
  }
  let frame = 0, lastPx = null;
  container.addEventListener('mousemove', (ev) => {
    if (state.isTouch) return;
    lastPx = localPx(ev);
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      if (!lastPx) return;
      try {
        const hit = pickStop(map, lastPx);
        if (hovered && (!hit || hit.data !== hovered.data)) { fire(hovered.entry, 'mouseout', hovered.data); hovered = null; }
        if (hit && !hovered) { hovered = hit; fire(hit.entry, 'mouseover', hit.data); }
        map.setDefaultCursor?.(hit ? 'pointer' : 'default');
      } catch (err) {
        console.error('[native-picker] 悬停拾取失败', err);
      }
    });
  });
}
