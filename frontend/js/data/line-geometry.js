/**
 * data/line-geometry.js —— 修补“只有站点坐标、没有走向”的线路形状（仅影响地图上的画法）
 *
 * 数据源里少数线路（约 1%）的 path 就是把站点直接连起来（点数 ≤ 站数 + 1），快线跨站时会画出一条十几公里的直线。
 * 这类线路几乎都有同名的另一条（上下行或另一个班次）带真实走向：逐段（相邻两站之间）到同名线路的 path 上
 * 找到对应的那一截借过来；找不到时才保留原来的直线。寻路与计时用的是站间距离，不受影响。
 */

const MATCH_M = 300; // 站点离借用线路 path 的最大距离

function distM(a, b) {
  const t = Math.PI / 180;
  const dLat = (b[1] - a[1]) * t, dLng = (b[0] - a[0]) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
}

function nearestIndex(path, p) {
  let best = -1, bd = Infinity;
  for (let i = 0; i < path.length; i++) {
    const d = distM(path[i], p);
    if (d < bd) { bd = d; best = i; }
  }
  return [best, bd];
}

function pathLength(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distM(points[i - 1], points[i]);
  return total;
}

/** path 只是站点连线（没有走向）的线路 */
export function hasBarePath(line) {
  return Array.isArray(line.path) && Array.isArray(line.stops) && line.stops.length >= 2
    && line.path.length <= line.stops.length + 1;
}

/** 在同名线路里找 a→b 这一段的真实走向；找不到返回 null */
function borrowSegment(siblings, a, b) {
  const straight = distM(a, b);
  let best = null;
  for (const sib of siblings) {
    const [ia, da] = nearestIndex(sib.path, a);
    const [ib, db] = nearestIndex(sib.path, b);
    if (ia < 0 || ib < 0 || ia === ib || da > MATCH_M || db > MATCH_M) continue;
    const seg = ia < ib ? sib.path.slice(ia, ib + 1) : sib.path.slice(ib, ia + 1).reverse();
    const len = pathLength(seg);
    if (len > straight * 3 + 2000) continue; // 绕了大圈，多半不是同一段
    const forward = ia < ib; // 同方向的线路优先（反方向的走向在道路另一侧，也可接受）
    if (!best || (forward && !best.forward) || (forward === best.forward && len < best.len)) best = { seg, len, forward };
  }
  return best ? best.seg : null;
}

/** 就地修补所有线路的 path；返回修补的线路数 */
export function repairBarePaths(lines) {
  const byName = new Map();
  for (const line of lines) {
    if (!byName.has(line.name)) byName.set(line.name, []);
    byName.get(line.name).push(line);
  }
  let repaired = 0;
  for (const line of lines) {
    if (!hasBarePath(line)) continue;
    const siblings = (byName.get(line.name) || []).filter((o) => o !== line && Array.isArray(o.path) && !hasBarePath(o));
    if (!siblings.length) continue;
    const out = [];
    let borrowed = false;
    for (let k = 0; k + 1 < line.stops.length; k++) {
      const a = [line.stops[k].lng, line.stops[k].lat];
      const b = [line.stops[k + 1].lng, line.stops[k + 1].lat];
      const seg = borrowSegment(siblings, a, b);
      if (seg) borrowed = true;
      for (const p of seg ? [a, ...seg, b] : [a, b]) {
        const last = out[out.length - 1];
        if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push(p);
      }
    }
    if (borrowed) {
      line.path = out;
      repaired++;
    }
  }
  return repaired;
}
