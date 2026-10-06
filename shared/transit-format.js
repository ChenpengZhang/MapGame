/**
 * shared/transit-format.js —— 城市交通数据文件格式（format 2）的编码与解码
 *
 * 前端、后端、测试与数据脚本共用（UMD：Node 里 require，浏览器里挂 window.TransitFormat）。
 * 解码结果与旧格式（format 1）的内存结构完全相同：{ city, …, lines: [{ id, name, …, stops: [{id,name,lng,lat,seq,d}], path: [[lng,lat]] }] }，
 * 下游代码不用关心文件格式；另外带上预先算好的逻辑站分组 logical 与合并规则版本 mergeRules。
 *
 * format 2 相比旧格式：
 *   - stops：每个物理站只存一次 [id, name, lng, lat]；线路里只存下标（旧格式同一个站随每条线重复存）。
 *     同一物理站在各线路里的坐标最多相差约 1 米（站 id 自带 5 位小数坐标），统一取首次出现的坐标——
 *     这正是寻路器原本使用的坐标。各线路对站名的写法（如“××站”与“××”）不同时，按位置单独记下，解码后不变。
 *   - path：坐标 ×10⁶ 取整后与前一点做差的扁平整数数组（6 位小数可无损还原）。
 *   - logical：建图时“哪些物理站合并成同一个逻辑站”的结果（物理站下标分组），由转换脚本用 shared/router.js
 *     的同一套合并逻辑算好；加载时直接使用，跳过最耗时的合并计算。合并规则改动时 mergeRules 对不上，自动回退现算。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TransitFormat = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const SCALE = 1e6;
  const META_KEYS = ['city', 'source', 'generated_at', 'count', 'note'];
  const LINE_KEYS = ['id', 'name', 'mode', 'oneWay', 'front', 'terminal', 'start_time', 'end_time'];

  /**
   * 旧格式数据 + 建好的图 → format 2 对象。
   * @param {object} data 旧格式 { city, …, lines }
   * @param {object} graph router.buildGraph(data.lines) 的结果（提供逻辑站分组）
   * @param {number} mergeRules router.MERGE_RULES_VERSION
   */
  function encode(data, graph, mergeRules) {
    const out = { format: 2 };
    for (const key of META_KEYS) if (data[key] !== undefined) out[key] = data[key];
    out.mergeRules = mergeRules;
    const index = new Map();
    const stops = [];
    for (const line of data.lines) {
      for (const s of line.stops) {
        if (index.has(String(s.id))) continue;
        index.set(String(s.id), stops.length);
        stops.push([String(s.id), s.name, s.lng, s.lat]);
      }
    }
    out.stops = stops;
    out.lines = data.lines.map((line) => {
      const l = {};
      for (const key of LINE_KEYS) if (line[key] !== undefined) l[key] = line[key];
      l.stops = line.stops.map((s) => index.get(String(s.id)));
      l.d = line.stops.map((s) => (typeof s.d === 'number' ? s.d : null));
      const names = [];
      line.stops.forEach((s, i) => { if (s.name !== stops[l.stops[i]][1]) names.push(i, s.name); });
      if (names.length) l.names = names; // [位置, 站名, 位置, 站名, …]：这条线对该站的不同写法
      const path = [];
      let px = 0, py = 0;
      for (const [x, y] of line.path || []) {
        const X = Math.round(x * SCALE), Y = Math.round(y * SCALE);
        path.push(X - px, Y - py);
        px = X; py = Y;
      }
      l.path = path;
      return l;
    });
    // 逻辑站分组：按建图时的顺序（保证解码后建出的图与现算完全一致）
    const groups = new Map();
    for (const p of graph.physList) {
      const logicalId = graph.physToLogical.get(p.id);
      if (!groups.has(logicalId)) groups.set(logicalId, []);
      groups.get(logicalId).push(index.get(p.id));
    }
    out.logical = [...groups.values()];
    return out;
  }

  /** 文件内容（已 JSON.parse）→ 旧格式内存结构；旧格式原样返回（sample.json 等） */
  function decode(obj) {
    if (!obj || obj.format !== 2) return obj;
    const out = {};
    for (const key of META_KEYS) if (obj[key] !== undefined) out[key] = obj[key];
    const stops = obj.stops;
    out.lines = obj.lines.map((l) => {
      const line = {};
      for (const key of LINE_KEYS) if (l[key] !== undefined) line[key] = l[key];
      line.stops = l.stops.map((k, i) => {
        const s = stops[k];
        return { id: s[0], name: s[1], lng: s[2], lat: s[3], seq: i + 1, d: l.d[i] };
      });
      if (l.names) for (let i = 0; i < l.names.length; i += 2) line.stops[l.names[i]].name = l.names[i + 1];
      const flat = l.path;
      const path = new Array(flat.length / 2);
      let x = 0, y = 0;
      for (let i = 0, j = 0; i < flat.length; i += 2, j++) {
        x += flat[i]; y += flat[i + 1];
        path[j] = [x / SCALE, y / SCALE];
      }
      line.path = path;
      return line;
    });
    out.mergeRules = obj.mergeRules;
    out.logical = obj.logical.map((group) => group.map((k) => stops[k][0])); // 物理站 id 分组
    return out;
  }

  return { encode, decode };
});
