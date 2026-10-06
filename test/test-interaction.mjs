// 前端交互行为测试：在桩件（DOM/地图）上走真实的 handler 流程。
// 重点覆盖「用户能感知到的」前端 bug：
//   1) 悬浮信息卡重名去重（公交上下行同名，只显示一次）
//   2) 两端统一的两阶段选站（第一次点 = 预览，第二次点同一物理站 = 确认）
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
    replaceChildren(...c) { this.children = c; },
    setAttribute() {},
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
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };

// 高德桩件：记录创建出来的覆盖物，供断言
const created = { polylines: [], massMarks: [], circles: [], markers: [] };
class OverlayStub {
  constructor(opts) { this.__opts = Object.assign({ strokeOpacity: 1, opacity: 0.9 }, opts); this.map = null; this.__ev = {}; }
  setMap(m) { this.map = m; }
  setOptions(o) { Object.assign(this.__opts, o); }
  getOptions() { return this.__opts; }
  on(t, fn) { (this.__ev[t] = this.__ev[t] || []).push(fn); }
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
  __polyfill: true, // 桩对象模拟的是 Leaflet 兼容层接口（原生高德另走 native-picker）
  Polyline: PolylineStub, Circle: CircleStub, Marker: MarkerStub, MassMarks: MassMarksStub,
  Map: MapStub, Pixel: class { constructor(x, y) { this.x = x; this.y = y; } },
  Size: class { constructor(w, h) { this.width = w; this.height = h; } },
  Bounds: class { constructor(sw, ne) { this.sw = sw; this.ne = ne; } },
  LngLat: class { constructor(lng, lat) { this.lng = lng; this.lat = lat; } },
};

globalThis.window.TransitRouter = require('../shared/router.js');
globalThis.window.TransitFormat = require('../shared/transit-format.js');

// ============ 导入被测模块 ============
const { state } = await import('../frontend/js/core/state.js');
const { WALK_STOP_COLOR, LINE_PALETTE } = await import('../frontend/js/core/config.js');
const { buildIndex, getLine, getLogical } = await import('../frontend/js/data/index-builder.js');
const { renderHighlight, clearHighlight, onStopMouseOver } = await import('../frontend/js/map/hover.js');
const { onStopClick, onCandidateStopClick, cancelRoutePreview, resetRoute, setForceWalk, setWalkTransferEnabled } = await import('../frontend/js/game/route.js');
const { stopToData } = await import('../frontend/js/map/stop-marks.js');
const { isWithinWalkRange, createWalkRangeCircle } = await import('../frontend/js/map/walk-range.js');
const { initMap, drawEndpoints } = await import('../frontend/js/map/map-init.js');
const { renderStops } = await import('../frontend/js/map/stop-layer.js');

let pass = 0, fail = 0;
function check(name, fn) {
  try { fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.error('  \u2717 ' + name + '\n      ' + (e && e.message)); fail++; }
}

console.log('\n=== 前端交互行为测试（广州真实数据）===\n');

const data = window.TransitFormat.decode(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'guangzhou-transit.json'), 'utf8')));
buildIndex(data);
state.map = new AMap.Map();
state.scenario = { noMetro: false, busSpeedFactor: 1, walkSpeedFactor: 1 };
initMap();
renderStops({ onMapClick: cancelRoutePreview });

check('线路色板恢复初版原色，不再做明暗偏移', () => {
  assert.deepEqual(LINE_PALETTE.slice(0, 7), [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6',
  ]);
});

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
drawEndpoints();

check('起终点显示1.5km范围圈，且只有起点范围内的基础站使用步行红色', () => {
  assert.equal(WALK_STOP_COLOR, '#e74c3c', '步行站配色应为红色');
  const circle = createWalkRangeCircle(state.ORIGIN);
  assert.equal(circle.__opts.radius, 1500, '步行范围圈半径应为1.5km');
  assert.equal(circle.__opts.strokeColor, '#e74c3c', '步行范围圈应为红色');
  assert.equal(isWithinWalkRange(midStop, state.ORIGIN), true, '起点附近站应位于步行范围内');
  const farStop = { lng: midStop.lng + 0.1, lat: midStop.lat + 0.1, mode: 'bus', id: 'far' };
  assert.equal(isWithinWalkRange(farStop, state.ORIGIN), false, '圈外站不应视为起点步行站');
  assert.equal(stopToData(midStop, true).style, 2, '圈内站应使用红色步行样式');
  assert.equal(stopToData(farStop, false).style, 1, '圈外公交站应保持蓝色公交样式');
});

check('悬浮信息卡：同名上下行只显示一条线路（去重）', () => {
  created.polylines.length = 0;
  renderHighlight(midLogical);
  // 信息卡 line-tag 数量 = 去重后的线路名数
  const box = elements.get('info-lines');
  const tagNames = box.children.map((c) => c.textContent);
  const uniqueNames = [...new Set(tagNames)];
  assert.equal(tagNames.length, uniqueNames.length, '信息卡出现重名线路：' + tagNames.join(', '));
  assert.ok(tagNames.includes('190路'), '信息卡应含 190路');
  assert.ok(elements.get('infocard').classList.contains('bus-board'), '公交站应使用方形公交站牌样式');
  assert.match(box.children.find((c) => c.textContent === '190路').innerHTML, /line-main.*190.*line-suffix.*路/s, '“路”应作为缩小后缀跟排');
  // 地图只画从本站出发可达的线路段：每个停靠本站的方向各画“本站之后”的一段，
  // 每段由“彩色外线 + 白色内线”两层组成；名称板仍按线路名去重。
  assert.equal(created.polylines.length % 2, 0, '每个线路段应生成两层反相折线');
  assert.ok(created.polylines.length >= uniqueNames.length * 2, '每条可乘线路至少画出一段');
  const line190 = [...state.linesMap.values()].find((line) => line.name === '190路' && line.oneWay
    && line.stops.some((st) => String(st.id) === String(midLogical.stopByLine[String(line.id)])));
  if (line190) {
    const drawn190 = created.polylines.filter((poly) => poly.__lineName === '190路' && poly.__transitLineLayer === 'outer');
    assert.ok(drawn190.every((poly) => poly.__opts.path.length < line190.path.length), '单向线不应画出本站之前（车开过来）的部分');
  }
  assert.notEqual(created.polylines[0].__opts.strokeColor, '#ffffff', '外层应使用线路颜色');
  assert.equal(created.polylines[1].__opts.strokeColor, '#ffffff', '内层应使用反相白线');
  assert.ok(created.polylines[0].__opts.strokeWeight > created.polylines[1].__opts.strokeWeight, '彩色外线应包住白色内线');
  clearHighlight();
});

check('公交线路名前后说明均缩小，字母数字线路号保持为主体', () => {
  const prefixedLine = [...state.linesMap.values()].find((line) => line.name === '南沙K7路');
  assert.ok(prefixedLine, '测试数据应包含南沙K7路');
  const physical = prefixedLine.stops[0];
  const logical = getLogical(state.physToLogical.get(String(physical.id)));
  renderHighlight(logical);
  const tag = elements.get('info-lines').children.find((item) => item.textContent === prefixedLine.name);
  assert.ok(tag, '公交名称板应包含南沙K7路');
  assert.match(tag.innerHTML, /line-prefix.*南沙.*line-main.*K7.*line-suffix.*路/s, '前缀和“路”应缩小，K7 保持为大号主体');
  clearHighlight();
});

check('带数字的长名称仍突出数字，并缩小全部前后缀', () => {
  const numberedLine = [...state.linesMap.values()].find((line) => line.name === '高峰快线21路');
  assert.ok(numberedLine, '测试数据应包含高峰快线21路');
  const physical = numberedLine.stops[0];
  const logical = getLogical(state.physToLogical.get(String(physical.id)));
  renderHighlight(logical);
  const tag = elements.get('info-lines').children.find((item) => item.textContent === numberedLine.name);
  assert.ok(tag, '公交名称板应包含高峰快线21路');
  assert.doesNotMatch(tag.className, /text-line/, '只要含数字就不应使用纯文字样式');
  assert.match(tag.innerHTML, /line-prefix.*高峰快线.*line-main.*21.*line-suffix.*路/s, '数字应放大，所有前后文字应缩小');
  clearHighlight();
});

check('完全没有数字的线路整体缩小并居中', () => {
  const textLine = [...state.linesMap.values()].find((line) => line.name === '同成社区接驳专线');
  assert.ok(textLine, '测试数据应包含同成社区接驳专线');
  const physical = textLine.stops[0];
  const logical = getLogical(state.physToLogical.get(String(physical.id)));
  renderHighlight(logical);
  const tag = elements.get('info-lines').children.find((item) => item.textContent === textLine.name);
  assert.ok(tag, '公交名称板应包含纯文字线路');
  assert.match(tag.className, /text-line/, '无数字线路应使用整体小字号样式');
  assert.match(tag.innerHTML, /line-main[^>]*>同成社区接驳专线</, '无数字线路应保持完整名称');
  assert.doesNotMatch(tag.innerHTML, /line-prefix|line-suffix/, '无数字线路不应被拆分');
  clearHighlight();
});

check('地铁牌使用“大数字 + 右上号线 + 右下 Line N”的线网图式样', () => {
  const metroLine = [...state.linesMap.values()].find((line) => line.mode === 'metro' && /号线/.test(line.name));
  assert.ok(metroLine, '测试数据应包含带“号线”的地铁线路');
  const metroStop = metroLine.stops[Math.floor(metroLine.stops.length / 2)];
  const metroLogical = getLogical(state.physToLogical.get(String(metroStop.id)));
  renderHighlight(metroLogical);
  assert.ok(elements.get('infocard').classList.contains('metro-board'), '地铁站应使用线网图式名称板');
  const metroTag = elements.get('info-lines').children.find((tag) => tag.textContent === metroLine.name);
  assert.ok(metroTag, '名称板应包含目标地铁线路');
  assert.match(metroTag.innerHTML, /metro-line-main.*\d+.*metro-line-side.*metro-line-suffix.*号线.*metro-line-en.*Line\s+\d+/s, '地铁牌应显示大数字、右上号线和右下 Line N');
  clearHighlight();
});

const hoverData = stopToData(state.physById.get(String(midStop.id)));
onStopMouseOver({ data: hoverData });
await new Promise((resolve) => setTimeout(resolve, 60));
check('鼠标悬浮时红圈落在实际物理站点，而非合并后的逻辑站中心', () => {
  assert.deepEqual(created.circles.at(-1).__opts.center, hoverData.lnglat);
  clearHighlight();
});

check('手机和电脑统一两阶段选站：第一次预览、再次点击同一物理站确认', () => {
  state.isTouch = true;
  resetRoute();
  const d = stopToData(state.physById.get(String(midStop.id)));
  onStopClick({ data: d });
  assert.equal(state.routeStops.length, 0, '第一次点应只预览');
  assert.ok(state.pendingStart, '应记录待确认起点');
  assert.deepEqual(created.circles.at(-1).__opts.center, d.lnglat, '红圈应画在实际点击的物理站坐标');
  assert.ok(!elements.get('btn-group').classList.contains('hidden'), '第一次预览应显示操作区');
  assert.ok(!elements.get('reset-btn').classList.contains('hidden'), '第一次预览应显示取消按钮');
  assert.ok(elements.get('undo-btn').classList.contains('hidden'), '起点确认前不应显示上一步');
  assert.ok(elements.get('show-all-btn').classList.contains('hidden'), '起点确认前不应显示全图站点按钮');
  onStopClick({ data: d });
  assert.equal(state.routeStops.length, 1, '再次点击同一物理站后应确认起点');
  assert.equal(state.originWalkRangeCircle.map, null, '确认首站后应隐藏起点步行范围圈');
  assert.equal(state.destinationWalkRangeCircle.map, state.map, '确认首站后终点范围圈应继续显示');
  assert.equal(created.massMarks[0].data.length, 0, '确认首站后应清空地铁基础站点层');
  assert.equal(created.massMarks[1].data.length, 0, '确认首站后应清空公交基础站点层，避免起点红色站残留');
  assert.equal(created.massMarks[2].data.length, 0, '确认首站后应清空独立的起点红色站点层');
  assert.equal(created.massMarks[0].map, null, '确认首站后应从地图卸载地铁基础站点层');
  assert.equal(created.massMarks[1].map, null, '确认首站后应从地图卸载公交基础站点层');
  assert.equal(created.massMarks[2].map, null, '确认首站后应从地图卸载独立的起点红色站点层');
  assert.ok(state.candidateMarks.data.every((point) => point.style !== 2), '关闭步行换乘时新的候选层不应含红色步行站');
  assert.equal(state.candidateMarks.__opts.style[2].url, state.candidateMarks.__opts.style[1].url, '关闭步行换乘的候选层不应装载红色步行图标');
  state.isTouch = false;
  resetRoute();
  assert.equal(state.originWalkRangeCircle.map, state.map, '重置规划后应恢复起点步行范围圈');
});

onStopClick({ data: stopToData(state.physById.get(String(midStop.id))) });
await new Promise((resolve) => setTimeout(resolve, 140));
check('平移和缩放保留预览，单击地图空白处取消', () => {
  for (const handler of state.map.__ev.moveend || []) handler({});
  for (const handler of state.map.__ev.zoomend || []) handler({});
  assert.ok(state.pendingStart, '平移或缩放不应取消预览');
  for (const handler of state.map.__ev.click || []) handler({ originalEvent: { target: makeEl('map-blank') } });
  assert.equal(state.pendingStart, null, '单击地图空白处应取消预览');
});

check('确认当前站后保留公交名称板，预览下一站时同时显示两张', () => {
  state.isTouch = false;
  resetRoute();
  onStopClick({ data: stopToData(state.physById.get(String(midStop.id))) });
  onStopClick({ data: stopToData(state.physById.get(String(midStop.id))) });
  const currentCard = elements.get('current-infocard');
  assert.ok(currentCard && !currentCard.classList.contains('hidden'), '确认起点后应保留当前站信息卡');
  assert.match(elements.get('current-info-stop').textContent, new RegExp(midLogical.name));

  state.isTouch = true;
  const nextStop = line190Up.stops[7];
  onCandidateStopClick(stopToData(state.physById.get(String(nextStop.id))));
  const previewCard = elements.get('infocard');
  assert.ok(!currentCard.classList.contains('hidden'), '预览下一站时当前站信息卡不应消失');
  assert.ok(previewCard && !previewCard.classList.contains('hidden'), '预览下一站时应显示预览信息卡');
  const currentLines = elements.get('current-info-lines').children.map((c) => c.textContent);
  const previewLines = elements.get('info-lines').children.map((c) => c.textContent);
  assert.ok(currentLines.includes('190路') && previewLines.includes('190路'), '两张卡可同时显示相同公交名称');

  onCandidateStopClick(stopToData(state.physById.get(String(nextStop.id))));
  assert.ok(previewCard.classList.contains('hidden'), '确认下一站后应收起预览卡');
  assert.match(elements.get('current-info-stop').textContent, new RegExp(nextStop.name));
  state.isTouch = false;
  resetRoute();
});

check('关闭步行换乘后不显示也不能点击起点以外的步行站', () => {
  resetRoute();
  onStopClick({ data: stopToData(state.physById.get(String(midStop.id))) });
  onStopClick({ data: stopToData(state.physById.get(String(midStop.id))) });

  setWalkTransferEnabled(true);
  const staleWalkPoint = state.candidateMarks.data.find((point) => point.style === 2);
  assert.ok(staleWalkPoint, '开启步行换乘后应有红色步行候选站');
  assert.equal(isWithinWalkRange(staleWalkPoint, [midStop.lng, midStop.lat]), true, '步行候选站应按当前物理站重新裁剪');
  assert.equal(state.originWalkRangeCircle.map, null, '重新裁剪步行候选站时不应恢复起点范围圈');

  setForceWalk(true);
  assert.equal(state.forceWalk, true, '开启步行换乘时可启用强制步行');
  setWalkTransferEnabled(false);
  assert.equal(state.forceWalk, false, '关闭步行换乘时应同步关闭强制步行');
  assert.ok(state.candidateMarks.data.every((point) => point.style !== 2), '关闭后候选层不应保留红色步行站');

  onCandidateStopClick(staleWalkPoint);
  assert.equal(state.pendingCandidate, null, '关闭后旧步行站事件也不应进入预选');
  resetRoute();
});

check('选择线路后只显示该线路及其站点，并按该线路乘车', () => {
  state.isTouch = false;
  resetRoute();
  onStopClick({ data: stopToData(state.physById.get(String(midStop.id))) });
  const lockedLineTag = elements.get('info-lines').children.find(tag => tag.textContent === '夜9路');
  assert.equal(typeof lockedLineTag?.onclick, 'function', '锁定上车站后可以直接选线');
  lockedLineTag.onclick();
  assert.equal(state.selectedLineName, '夜9路');
  assert.equal(state.routeStops.length, 0, '锁定期间选线不提前确认步行');
  onStopClick({ data: stopToData(state.physById.get(String(midStop.id))) });
  assert.equal(state.selectedLineName, '夜9路', '确认步行后保留已选线路');
  elements.get('current-info-lines').children.find(tag => tag.textContent === '夜9路').onclick();

  const target = state.logicalStops.find((s) => s.name === '体育中心');
  assert.ok(target, '应找到体育中心');
  const selectedLine = [...state.linesMap.values()].find((line) =>
    line.name === '夜9路' && window.TransitRouter.rideStatsBetween(state.routerGraph, line, midLogical.id, target.id, {}));
  const fasterLine = [...state.linesMap.values()].find((line) =>
    line.name === '810路' && window.TransitRouter.rideStatsBetween(state.routerGraph, line, midLogical.id, target.id, {}));
  assert.ok(selectedLine && fasterLine, '两站之间应同时有夜9路和810路');
  const selectedStats = window.TransitRouter.rideStatsBetween(state.routerGraph, selectedLine, midLogical.id, target.id, {});
  const fasterStats = window.TransitRouter.rideStatsBetween(state.routerGraph, fasterLine, midLogical.id, target.id, {});
  assert.ok(selectedStats.stops > fasterStats.stops, '夜9路应比810路经过更多站，用于验证不再自动择快');

  const currentBox = elements.get('current-info-lines');
  const allCurrentLineNames = currentBox.children.map((tag) => tag.textContent);
  const candidateCountBefore = state.candidateMarks.data.length;
  const inverseStop = state.candidateMarks.data.find((point) => point.lineColor && point.style > 2);
  assert.ok(inverseStop, '候选线路站点应使用白心、线路色外圈的反相图标');
  assert.ok(state.candidateMarks.__opts.style.length > 3, '候选图层应创建线路色反相站点样式');
  const selectedTag = currentBox.children.find((tag) => tag.textContent === '夜9路');
  assert.ok(selectedTag && typeof selectedTag.onclick === 'function', '当前站线路名称板应可点击');
  const mapLine = state.candidateOverlays.find((line) => line.__lineName === '夜9路' && line.__transitLineLayer === 'outer');
  assert.ok(mapLine, '地图上应绘制候选线路');
  assert.ok(!mapLine.__ev.click?.length, '可见双层线不应重复接收点击');
  const mapLineInner = state.candidateOverlays.find((line) => line.__lineName === '夜9路' && line.__transitLineLayer === 'inner');
  assert.equal(mapLine.__opts.strokeWeight, 6, '未选中的公交彩色外线应为 6px');
  assert.equal(mapLineInner?.__opts.strokeWeight, 2, '公交白色内线应为 2px');
  assert.equal(mapLineInner?.__opts.strokeColor, '#ffffff', '候选线路应包含白色反相内线');
  const mapLineHitArea = state.candidateOverlays.find((line) => line.__lineName === '夜9路' && line.__lineHitArea);
  assert.ok(mapLineHitArea && mapLineHitArea.__opts.strokeWeight >= 16 && mapLineHitArea.__ev.click?.length, '候选线路应有唯一的宽透明点击热区');
  mapLineHitArea.__ev.click[0]({});
  mapLineHitArea.__ev.click[0]({}); // 模拟地图把同一物理点击重复派发；不得立刻反选
  assert.equal(state.selectedLineName, '夜9路');
  const selectedMapLine = state.candidateOverlays.find((line) =>
    line.__lineName === '夜9路' && line.__transitLineLayer === 'outer');
  assert.equal(selectedMapLine?.__opts.strokeWeight, 8, '选中的公交彩色外线应加粗到 8px');
  // 同一逻辑站的上下行站台视为合并：出发站选中线路后，停靠本站的每个方向各画一组
  // “彩线 + 白线 + 点击热区”（各自只画本站之后的部分），具体方向由下一站决定。
  const selectedOverlays = state.candidateOverlays.filter((line) => line.__lineName === '夜9路');
  const servingDirections = [...state.linesMap.values()].filter((line) => line.name === '夜9路'
    && midLogical.line_ids.includes(String(line.id)));
  assert.ok(selectedOverlays.length >= 3 && selectedOverlays.length % 3 === 0, '每个方向应有一组彩线、白线和点击热区');
  assert.ok(selectedOverlays.length / 3 <= servingDirections.length, '只画停靠本站的方向');
  assert.deepEqual(currentBox.children.map((tag) => tag.textContent), allCurrentLineNames, '选中后应保留当前站全部线路');
  assert.match(currentBox.children.find((tag) => tag.textContent === '夜9路').className, /selected/, '所选线路名称板应高亮');
  assert.ok(state.candidateMarks.data.length < candidateCountBefore, '选择线路后应移除其它线路的候选站');
  assert.ok(!state.candidateOverlays.some((line) => line.__opts.zIndex === 180), '其它线路应从地图隐藏');
  assert.ok(state.candidateOverlays.some((line) => line.__opts.zIndex === 190), '所选线路应在地图上高亮');

  cancelRoutePreview(null, true);
  assert.equal(state.selectedLineName, null, '点击地图其它位置应取消线路选择');
  assert.equal(state.candidateMarks.data.length, candidateCountBefore, '取消线路选择后应恢复全部候选站');
  currentBox.children.find((tag) => tag.textContent === '夜9路').onclick();

  state.isTouch = true;
  const targetPhys = state.physById.get(String(target.stopByLine[String(selectedLine.id)]));
  const selectedCandidatePointCount = state.candidateMarks.data.length;
  onCandidateStopClick(stopToData(targetPhys));
  const previewLineNames = elements.get('info-lines').children.map((tag) => tag.textContent);
  assert.ok(previewLineNames.includes('夜9路'), '下一站预览应包含当前所选线路');
  assert.ok(previewLineNames.includes('810路'), '下一站预览还应显示该站可换乘的其它公交');
  const previewMapLineNames = state.activeOverlays.map((overlay) => overlay.__lineName).filter(Boolean);
  assert.ok(previewMapLineNames.includes('夜9路'), '站点预览应画出当前线路');
  assert.ok(previewMapLineNames.includes('810路'), '站点预览应画出其它可换乘线路');
  assert.equal(state.candidateMarks.data.length, selectedCandidatePointCount, '预览其它线路时不应提前显示它们的站点');
  onCandidateStopClick(stopToData(targetPhys));
  assert.equal(state.routeRides.at(-1).name, '夜9路', '即使另有更快线路，也应采用玩家选择的夜9路');
  assert.equal(state.selectedLineName, null, '到达下一站后线路选择应重置');

  const nextBox = elements.get('current-info-lines');
  const cancelTag = nextBox.children.find((tag) => tag.textContent === '夜9路');
  cancelTag?.onclick();
  cancelTag?.onclick();
  assert.equal(state.selectedLineName, null, '再次点击已选线路应取消选择');
  state.isTouch = false;
  resetRoute();
});

check('选择单向环线后可跨越首尾站顺行乘车', () => {
  state.isTouch = false;
  resetRoute();
  const loop = [...state.linesMap.values()].find((line) => line.isLoop && line.oneWay && line.stops.length > 6);
  assert.ok(loop, '应找到单向环线');
  const fromPhys = state.physById.get(String(loop.stops[loop.stops.length - 3].id));
  const toPhys = state.physById.get(String(loop.stops[2].id));
  const fromLogical = getLogical(state.physToLogical.get(String(fromPhys.id)));
  const toLogical = getLogical(state.physToLogical.get(String(toPhys.id)));
  state.ORIGIN = [fromPhys.lng, fromPhys.lat];
  onStopClick({ data: stopToData(fromPhys) });
  onStopClick({ data: stopToData(fromPhys) });
  const loopTag = elements.get('current-info-lines').children.find((tag) => tag.textContent === loop.name);
  assert.ok(loopTag, '当前站应显示环线名称板');
  loopTag.onclick();
  onCandidateStopClick(stopToData(toPhys));
  onCandidateStopClick(stopToData(toPhys));
  assert.equal(state.routeRides.at(-1).id, loop.id, '跨首尾站时仍应采用所选环线');
  const stats = window.TransitRouter.rideStatsBetween(state.routerGraph, loop, fromLogical.id, toLogical.id, {});
  assert.ok(stats && stats.stops > 0, '环线应按顺行绕环计算站数');
  resetRoute();
  state.ORIGIN = [midStop.lng, midStop.lat];
});

check('候选网络只显示前进方向（不画反向边）', () => {
  // 起点：190路上行第 5 站（老干大学），前进方向应只含它之后的站（seq>5）
  created.massMarks.length = 0;
  onStopClick({ data: stopToData(state.physById.get(String(midStop.id))) });
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
