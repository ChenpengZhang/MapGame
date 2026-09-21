// 前端交互行为测试：在桩件（DOM/地图）上走真实的 handler 流程。
// 重点覆盖「用户能感知到的」前端 bug：
//   1) 悬浮信息卡重名去重（公交上下行同名，只显示一次）
//   2) 手机两阶段选站（第一次点 = 预览，第二次点 = 确认）
//   3) 候选网络只显示前进方向（单向公交不画反向边）
//
// 用法：node test/test-interaction.mjs

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// ============ 浏览器桩件（最小集） ============
function makeEl(id) {
  return {
    id, textContent: '', innerHTML: '', className: '', style: {}, value: '', checked: false,
    children: [], __ev: {}, isConnected: true,
    classList: {
      _set: new Set(),
      add(...c) { for (const x of c) this._set.add(x); },
      remove(...c) { for (const x of c) this._set.delete(x); },
      toggle(c, force) { const w = force === undefined ? !this._set.has(c) : !!force; if (w) this._set.add(c); else this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(t, fn) { (this.__ev[t] = this.__ev[t] || []).push(fn); },
    appendChild(c) { this.children.push(c); return c; },
    querySelector() { return makeEl(id + '::child'); },
    querySelectorAll() { return []; },
  };
}
const elements = new Map();
function makeCanvas() {
  return {
    tagName: 'CANVAS', width: 0, height: 0, style: {}, isConnected: true,
    getContext() { return { beginPath() {}, arc() {}, fill() {}, stroke() {}, fillStyle: '', lineWidth: 0, strokeStyle: '' }; },
    toDataURL() { return 'data:image/png;base64,AAAA'; },
  };
}
globalThis.document = {
  getElementById(id) { if (!elements.has(id)) elements.set(id, makeEl(id)); return elements.get(id); },
  createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeEl('new-' + tag); },
  head: makeEl('head'), body: makeEl('body'),
  querySelectorAll() { return []; }, addEventListener() {},
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

// 高德桩件：记录创建出来的覆盖物，供断言
const created = { polylines: [], massMarks: [], circles: [], markers: [] };
class OverlayStub {
  constructor(opts) { this.__opts = Object.assign({ strokeOpacity: 1, opacity: 0.9 }, opts); this.map = null; }
  setMap(m) { this.map = m; }
  setOptions(o) { Object.assign(this.__opts, o); }
  getOptions() { return this.__opts; }
  on() {}
}
class PolylineStub extends OverlayStub { constructor(o) { super(o); created.polylines.push(this); } }
class CircleStub extends OverlayStub { constructor(o) { super(o); created.circles.push(this); } }
class MarkerStub extends OverlayStub { constructor(o) { super(o); created.markers.push(this); } }
class MassMarksStub extends OverlayStub {
  constructor(data, opts) { super(opts); this.data = data; this.shown = false; created.massMarks.push(this); }
  setData(d) { this.data = d; } show() { this.shown = true; } hide() { this.shown = false; }
}
class MapStub {
  constructor() { this.__ev = {}; this.zoom = 12; this.container = makeEl('map-container'); }
  getContainer() { return this.container; }
  getZoom() { return this.zoom; } getCenter() { return [0, 0]; }
  getBounds() { return { getSouthWest: () => ({ getLng: () => 0, getLat: () => 0 }), getNorthEast: () => ({ getLng: () => 1, getLat: () => 1 }) }; }
  on(t, fn) { (this.__ev[t] = this.__ev[t] || []).push(fn); }
  setStatus() {} setZoomAndCenter() {} setBounds() {}
}
globalThis.AMap = {
  Polyline: PolylineStub, Circle: CircleStub, Marker: MarkerStub, MassMarks: MassMarksStub,
  Map: MapStub, Pixel: class { constructor(x, y) { this.x = x; this.y = y; } },
  Size: class { constructor(w, h) { this.width = w; this.height = h; } },
  LngLat: class { constructor(lng, lat) { this.lng = lng; this.lat = lat; } },
};

globalThis.window.TransitRouter = require('../js/router.js');

// ============ 导入被测模块 ============
const { state } = await import('../js/core/state.js');
const { buildIndex, getLine, getLogical } = await import('../js/data/index-builder.js');
const { renderHighlight, clearHighlight } = await import('../js/map/hover.js');
const { onStopClick, resetRoute } = await import('../js/game/route.js');
const { stopToData } = await import('../js/map/stop-marks.js');
const { initMap } = await import('../js/map/map-init.js');
const { renderStops } = await import('../js/map/stop-layer.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.error('  \u2717 ' + name + '\n      ' + (e && e.message)); fail++; }
}

console.log('\n=== 前端交互行为测试（广州真实数据）===\n');

const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'guangzhou-transit.json'), 'utf8'));
buildIndex(data);
state.map = new AMap.Map();
state.scenario = { noMetro: false, busSpeedFactor: 1, walkSpeedFactor: 1 };
initMap();

// 找一个同时在上行和下行的公交站（190路：上下行同名）
const line190Up = [...state.linesMap.values()].find((l) => l.name === '190路' && l.stops.length === 33);
const line190Down = [...state.linesMap.values()].find((l) => l.name === '190路' && l.stops.length === 29);
assert.ok(line190Up && line190Down, '应找到 190路 上下行两条');

// 找 190路 上行的一个站点（非端点，方便测候选方向）
const midStop = line190Up.stops[5]; // 老干大学（上行中间站）
const midLogicalId = state.physToLogical.get(String(midStop.id));
const midLogical = getLogical(midLogicalId);
assert.ok(midLogical, '应能解析到逻辑站');

// 设置起终点，onStopClick 需要校验「起点步行 ≤ 1.5km」
state.ORIGIN = [midStop.lng, midStop.lat];
state.DEST = [midStop.lng + 0.1, midStop.lat + 0.1];

check('悬浮信息卡：同名上下行只显示一条线路（去重）', () => {
  created.polylines.length = 0;
  renderHighlight(midLogical);
  // 信息卡 line-tag 数量 = 去重后的线路名数
  const box = elements.get('info-lines');
  const tagNames = box.children.map((c) => c.textContent);
  const uniqueNames = [...new Set(tagNames)];
  assert.equal(tagNames.length, uniqueNames.length, '信息卡出现重名线路：' + tagNames.join(', '));
  assert.ok(tagNames.includes('190路'), '信息卡应含 190路');
  // 高亮折线数 = 去重后的线路数（190路上下行只画一条）
  assert.equal(created.polylines.length, uniqueNames.length, '高亮折线应去重，实际 ' + created.polylines.length + ' vs ' + uniqueNames.length);
  clearHighlight();
});

check('手机两阶段选站：第一次点只预览、第二次点确认（单向公交起点）', () => {
  state.isTouch = true;
  resetRoute();
  const d = stopToData(state.physById.get(String(midStop.id)));
  onStopClick({ data: d });
  assert.equal(state.routeStops.length, 0, '第一次点应只预览');
  assert.ok(state.pendingStart, '应记录待确认起点');
  onStopClick({ data: d });
  assert.equal(state.routeStops.length, 1, '第二次点应确认起点');
  state.isTouch = false;
  resetRoute();
});

check('候选网络只显示前进方向（不画反向边）', () => {
  // 起点：190路上行第 5 站（老干大学），前进方向应只含它之后的站（seq>5）
  created.massMarks.length = 0;
  onStopClick({ data: stopToData(state.physById.get(String(midStop.id))) });
  assert.equal(state.routeStops.length, 1, '起点已确认');
  // 候选站 massMarks：应只包含该线前进方向的站（不包含上游站）
  const marks = created.massMarks[created.massMarks.length - 1];
  assert.ok(marks && Array.isArray(marks.data), '应有候选站 MassMarks');
  const candidateIds = new Set((marks.data || []).map((x) => x.id));
  // 上游站（seq<5，如 雕塑公园 seq4）不应出现在候选里
  const upStream = line190Up.stops[3]; // 雕塑公园
  assert.ok(!candidateIds.has(upStream.id), '上游站不应出现在候选（不画反向边）：' + upStream.name);
  // 下游站（seq>5，如 麓景路）应出现在候选里
  const downStream = line190Up.stops[7];
  assert.ok(candidateIds.has(downStream.id), '下游站应出现在候选：' + downStream.name);
  resetRoute();
});

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail === 0 ? 0 : 1);
