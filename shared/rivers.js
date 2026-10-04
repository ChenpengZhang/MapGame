/*
 * 大江大河：禁止步行过江（前后端共用，UMD）
 *
 * 数据是江河中心线（data/rivers/<city>.json，GCJ-02），来自 OpenStreetMap，由 scripts/build-rivers.mjs 生成。
 * 规则：一段直线步行（起点→上车站、下车站→终点、步行换乘）只要穿过任何一条中心线，就视为“步行过江”，不允许。
 * 用法：
 *   const index = TransitRivers.buildRiverIndex(riverData);   // 每个城市建一次
 *   TransitRivers.crossesRiver(index, [lng, lat], [lng, lat]); // true = 这段步行要过江
 *   TransitRivers.clipWalkRange(index, center, radiusM);       // 步行范围圆按江岸截断后的多边形（无江时返回 null）
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TransitRivers = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CELL = 0.02; // 网格索引的格子大小（度，约 2km）

  /** 河流数据 → 线段网格索引；没有河流时返回 null */
  function buildRiverIndex(data) {
    const segments = [];
    for (const river of (data && data.rivers) || []) {
      for (const line of river.lines || []) {
        for (let i = 1; i < line.length; i++) {
          const a = line[i - 1], b = line[i];
          segments.push({ a, b, name: river.name });
        }
      }
    }
    if (!segments.length) return null;
    const grid = new Map();
    segments.forEach((s, id) => {
      const x0 = Math.floor(Math.min(s.a[0], s.b[0]) / CELL), x1 = Math.floor(Math.max(s.a[0], s.b[0]) / CELL);
      const y0 = Math.floor(Math.min(s.a[1], s.b[1]) / CELL), y1 = Math.floor(Math.max(s.a[1], s.b[1]) / CELL);
      for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
          const key = x + ':' + y;
          if (!grid.has(key)) grid.set(key, []);
          grid.get(key).push(id);
        }
      }
    });
    return { segments, grid };
  }

  /** 与包围盒 [minLng, minLat, maxLng, maxLat] 相交的格子里的线段（去重） */
  function candidates(index, box) {
    const out = new Set();
    const x0 = Math.floor(box[0] / CELL), x1 = Math.floor(box[2] / CELL);
    const y0 = Math.floor(box[1] / CELL), y1 = Math.floor(box[3] / CELL);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const ids = index.grid.get(x + ':' + y);
        if (ids) for (const id of ids) out.add(id);
      }
    }
    return out;
  }

  function cross(o, a, b) {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  }

  /** 线段 p1p2 与 q1q2 是否相交（含端点接触） */
  function segmentsIntersect(p1, p2, q1, q2) {
    const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2);
    const d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    return (d1 === 0 && onSegment(q1, q2, p1)) || (d2 === 0 && onSegment(q1, q2, p2))
      || (d3 === 0 && onSegment(p1, p2, q1)) || (d4 === 0 && onSegment(p1, p2, q2));
  }
  function onSegment(a, b, p) {
    return Math.min(a[0], b[0]) <= p[0] && p[0] <= Math.max(a[0], b[0])
      && Math.min(a[1], b[1]) <= p[1] && p[1] <= Math.max(a[1], b[1]);
  }

  /** 从 a 直线步行到 b 是否要过江 */
  function crossesRiver(index, a, b) {
    if (!index || !a || !b) return false;
    const box = [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
    for (const id of candidates(index, box)) {
      const s = index.segments[id];
      if (segmentsIntersect(a, b, s.a, s.b)) return true;
    }
    return false;
  }

  /**
   * 步行范围圆按江截断：从圆心向各个方向发射射线，碰到江就停在江边（中心线）。
   * 返回多边形顶点 [[lng, lat], ...]；范围内没有江时返回 null（照常画圆）。
   */
  function clipWalkRange(index, center, radiusM, steps = 180) {
    if (!index || !center) return null;
    const mPerLat = 110540;
    const mPerLng = 111320 * Math.cos(center[1] * Math.PI / 180);
    const dLat = radiusM / mPerLat, dLng = radiusM / mPerLng;
    const near = [...candidates(index, [center[0] - dLng, center[1] - dLat, center[0] + dLng, center[1] + dLat])];
    if (!near.length) return null;
    // 局部平面坐标（米），圆心为原点
    const toXY = (p) => [(p[0] - center[0]) * mPerLng, (p[1] - center[1]) * mPerLat];
    const segs = near.map((id) => [toXY(index.segments[id].a), toXY(index.segments[id].b)]);
    let clipped = false;
    const ring = [];
    for (let k = 0; k < steps; k++) {
      const theta = (2 * Math.PI * k) / steps;
      const dx = Math.cos(theta) * radiusM, dy = Math.sin(theta) * radiusM;
      let t = 1;
      for (const [p, q] of segs) {
        // 射线 O + t·D 与线段 p + u·(q−p) 求交
        const ex = q[0] - p[0], ey = q[1] - p[1];
        const den = dx * ey - dy * ex;
        if (Math.abs(den) < 1e-9) continue;
        const tt = (p[0] * ey - p[1] * ex) / den;
        const uu = (p[0] * dy - p[1] * dx) / den;
        if (tt >= 0 && tt < t && uu >= 0 && uu <= 1) t = tt;
      }
      if (t < 1) clipped = true;
      ring.push([center[0] + (dx * t) / mPerLng, center[1] + (dy * t) / mPerLat]);
    }
    return clipped ? ring : null;
  }

  return { buildRiverIndex, crossesRiver, clipWalkRange, segmentsIntersect };
});
