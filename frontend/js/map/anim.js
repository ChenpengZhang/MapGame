/**
 * map/anim.js —— 覆盖物淡入淡出动画
 *
 * 【为什么单独一层】
 *   地图上所有覆盖物（线/圆/图钉/海量站点）都需要"出现得柔和、消失得干脆"。
 *   这段动画与覆盖物的具体类型有关（高德的 Polyline / Circle / MassMarks 改透明度的
 *   方式各不相同），所以需要一层适配，让上层只管说"淡入这个对象"。
 *
 * 【实现要点】
 *   - 用 requestAnimationFrame + easeOutCubic 做非线性缓动，比 CSS 过渡更可控；
 *   - 动画状态挂在覆盖物自身的 __tween 上，重复对同一对象调用会取消上一次动画；
 *   - MassMarks（海量点）没有透明度 API，只能通过它渲染出的 <canvas> 的 CSS opacity，
 *     所以需要 setMassMarksMap / captureMassMarksCanvas 在挂载时把 canvas 抓住。
 *     注意：免 Key 的 Leaflet 后端没有 canvas，会走 setOptions 兜底。
 */

import { state } from '../core/state.js';

export const ANIM_FADE_IN_MS = 220;
export const ANIM_FADE_OUT_MS = 180;

export function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

/**
 * 把覆盖物透明度从 from 过渡到 to（非线性缓动）；重复调用会取消上一次动画。
 * @param {object} o 覆盖物（作为动画状态的宿主）
 * @param {(alpha:number)=>void} setFn 实际写透明度的方法
 * @param {(alpha:number)=>number} getFn 读当前透明度的基准（由 overlayAlpha 提供）
 */
export function tweenAlpha(o, setFn, from, to, duration, onDone) {
  if (o.__tween) { o.__tween.cancel(); o.__tween = null; }
  const t0 = performance.now();
  let raf = 0, ended = false;
  const anim = { cancel() { if (raf) { cancelAnimationFrame(raf); raf = 0; } ended = true; } };
  o.__tween = anim;
  function frame(now) {
    if (ended) return;
    const t = Math.min(1, (now - t0) / duration);
    setFn(from + (to - from) * easeOutCubic(t));
    if (t < 1) raf = requestAnimationFrame(frame);
    else { o.__tween = null; if (onDone) onDone(); }
  }
  raf = requestAnimationFrame(frame);
}

/**
 * 取得该覆盖物的透明度读写器，返回 {set(alpha), get()}，alpha∈[0,1]；
 * 无法淡化的类型（如 Marker）返回 null。
 * 说明：Circle 的描边/填充透明度基数不同，MassMarks 的基准是 0.9，
 *       所以这里统一换算成 0~1 的"相对透明度"，上层不用关心。
 */
export function overlayAlpha(o) {
  if (!o) return null;
  if (o instanceof AMap.Polyline) {
    return { set: (a) => o.setOptions({ strokeOpacity: a }), get: () => o.getOptions().strokeOpacity };
  }
  if (o instanceof AMap.Circle) {
    const sb = o.__strokeBase != null ? o.__strokeBase : 1;
    const fb = o.__fillBase != null ? o.__fillBase : 0.25;
    return { set: (a) => o.setOptions({ strokeOpacity: a * sb, fillOpacity: a * fb }), get: () => sb };
  }
  if (o instanceof AMap.MassMarks) {
    const base = o.__baseOpacity != null ? o.__baseOpacity : 0.9;
    const c = o.__canvas;
    if (c && c.style) return { set: (a) => { c.style.opacity = a; }, get: () => base };
    return { set: (a) => { try { o.setOptions({ opacity: a }); } catch (e) {} }, get: () => base };
  }
  return null;
}

/** 淡入：从 0 过渡到该覆盖物本来的透明度 */
export function fadeInOverlay(o, duration) {
  if (!o) return;
  const info = overlayAlpha(o);
  if (!info) return;
  const to = Math.min(1, Math.max(0, info.get()));
  info.set(0);
  tweenAlpha(o, info.set, 0, to, duration || ANIM_FADE_IN_MS);
}

/** 淡出：过渡到 0 后从地图移除，再回调 onRemoved */
export function fadeOutOverlay(o, duration, onRemoved) {
  if (!o) { if (onRemoved) onRemoved(); return; }
  const info = overlayAlpha(o);
  if (!info) { try { o.setMap(null); } catch (e) {} if (onRemoved) onRemoved(); return; }
  const from = Math.min(1, Math.max(0, info.get()));
  tweenAlpha(o, info.set, from, 0, duration || ANIM_FADE_OUT_MS, () => {
    try { o.setMap(null); } catch (e) {}
    if (onRemoved) onRemoved();
  });
}

/**
 * 硬移除覆盖物：直接 setMap(null)，不依赖淡出动画的回调。
 * 清除类场景（重置路线、切候选网络、清最优）必须用它——
 * 动画回调在某些环境（后台标签/虚拟时钟）可能不触发，导致图层永久残留。
 */
export function removeOverlay(o) {
  if (!o) return;
  try { o.setMap(null); } catch (e) { /* 忽略 */ }
}

/**
 * MassMarks 渲染到一个 <canvas>；setMap 后捕获它，供透明度动画使用。
 * 递归重试是因为 canvas 可能不是同步挂载的（最多 20 帧，约 0.3 秒）。
 */
export function captureMassMarksCanvas(mm, container, before, tries) {
  if (!mm || mm.__canvas || !container) return;
  if (window.AMap && AMap.__backend === 'leaflet') return; // Leaflet 海量点无 canvas，淡化走 setOptions
  tries = tries || 0;
  if (tries > 20) return; // 空数据等极端情况没有 canvas，放弃
  const after = container.querySelectorAll('canvas');
  for (const c of after) if (!before.has(c)) { mm.__canvas = c; return; }
  requestAnimationFrame(() => captureMassMarksCanvas(mm, container, before, tries + 1));
}

/** 把 MassMarks 挂到指定地图上，并顺手捕获它的 canvas（先同步找一次，再异步兜底） */
export function setMassMarksMap(mm, targetMap) {
  const container = (state.map && state.map.getContainer) ? state.map.getContainer() : document.getElementById('map');
  const before = container ? new Set(container.querySelectorAll('canvas')) : new Set();
  mm.setMap(targetMap);
  if (targetMap && container) {
    const after = container.querySelectorAll('canvas');
    for (const c of after) if (!before.has(c)) { mm.__canvas = c; return; }
    captureMassMarksCanvas(mm, container, before, 0);
  }
}
