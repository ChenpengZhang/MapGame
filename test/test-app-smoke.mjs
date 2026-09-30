/**
 * test-app-smoke.mjs —— 前端分层拆分后的"无浏览器"冒烟测试
 *
 * 【为什么需要它】
 *   app.js 被拆成分层模块后，最大的风险不再是"算法错了"，而是
 *   "某个 import 写错 / 少导出一个函数 / 模块之间有循环依赖"——
 *   这类错误在浏览器里表现为整页白屏，而且很难定位。
 *   本测试在 Node 里用一组最小桩件（document / localStorage / fetch / AMap）
 *   把整套模块图加载起来，然后真的跑一遍主流程：
 *     加载数据 → 建索引 → 建寻路图 → 渲染图层 → 选站 → 换乘 → 完成
 *     → 算最优路线 → 结算弹窗 → 爬塔一局 → 剧情/教学流程 → 回主菜单
 *
 * 【用法】
 *   node test/test-app-smoke.mjs          # 用 data/sample.json（快，默认）
 *   MG_FULL=1 node test/test-app-smoke.mjs # 用全量 beijing-transit.json（慢，验证真实规模）
 *
 * 【边界】这是冒烟测试，不替代浏览器验证：桩件只覆盖"能跑到"的 API，
 *   地图真实渲染效果仍需在浏览器里用 node server.js 打开确认。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// 项目根目录（本文件位于 test/ 下，向上一级即项目根）
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const require = createRequire(import.meta.url);
const USE_FULL = process.env.MG_FULL === '1';

// ======================================================================
// 1. 浏览器环境桩件（只实现被用到的部分）
// ======================================================================

function makeEl(id) {
  const el = {
    id,
    tagName: 'DIV',
    textContent: '',
    innerHTML: '',
    value: '',
    checked: false,
    style: {},
    isConnected: true,
    children: [],
    __ev: {},
    classList: {
      _set: new Set(),
      add(...c) { for (const x of c) this._set.add(x); },
      remove(...c) { for (const x of c) this._set.delete(x); },
      toggle(c, force) {
        const want = force === undefined ? !this._set.has(c) : !!force;
        if (want) this._set.add(c); else this._set.delete(c);
      },
      contains(c) { return this._set.has(c); },
    },
    addEventListener(type, fn) { (this.__ev[type] = this.__ev[type] || []).push(fn); },
    dispatch(type, evt) { for (const fn of this.__ev[type] || []) fn(evt || {}); },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...children) { this.children = children; this.textContent = ''; },
    querySelector() { return makeEl(id + '::child'); },
    querySelectorAll() { return []; },
  };
  return el;
}

function makeCanvas() {
  return {
    tagName: 'CANVAS',
    width: 0,
    height: 0,
    style: {},
    isConnected: true,
    getContext() {
      return { beginPath() {}, arc() {}, fill() {}, stroke() {}, fillStyle: '', lineWidth: 0, strokeStyle: '' };
    },
    toDataURL() { return 'data:image/png;base64,AAAA'; },
  };
}

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, makeEl(id));
    return elements.get(id);
  },
  createElement(tag) { return tag === 'canvas' ? makeCanvas() : makeEl('new-' + tag); },
  head: makeEl('head'),
  body: makeEl('body'),
  querySelectorAll() { return []; },
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.innerHeight = 800;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), 16);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);

const store = new Map();
globalThis.localStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, String(v)); },
  removeItem: (k) => { store.delete(k); },
};

/** fetch 桩：默认把全量数据当 404（走 sample 兜底），MG_FULL=1 时读真实全量数据。
 *  与真实服务器一致：先剥掉 URL 里的 ?v= 查询串（版本号只用于缓存，不影响文件路径）。 */
globalThis.fetch = async (url) => {
  const u = String(url).split('?')[0];
  if (u.includes('beijing-transit.json') && !USE_FULL) {
    return { ok: false, status: 404, headers: { get: () => null }, json: async () => { throw new Error('404'); } };
  }
  const text = fs.readFileSync(path.join(ROOT, u), 'utf8');
  return { ok: true, status: 200, headers: { get: () => null }, json: async () => JSON.parse(text) };
};

// ---- 高德 API 桩（与 amap-polyfill.js 的接口面保持一致） ----
const created = { massMarks: [], polylines: [], markers: [] };

class BoundsStub {
  constructor(sw, ne) { this.sw = sw; this.ne = ne; }
  getSouthWest() { return { getLng: () => this.sw[0], getLat: () => this.sw[1] }; }
  getNorthEast() { return { getLng: () => this.ne[0], getLat: () => this.ne[1] }; }
}
class MapStub {
  constructor(id, opts) {
    this.id = id;
    this.center = (opts && opts.center) || [0, 0];
    this.zoom = (opts && opts.zoom) || 10;
    this.__ev = {};
    this.container = makeEl('map-container');
  }
  getContainer() { return this.container; }
  getZoom() { return this.zoom; }
  setZoom(z) { this.zoom = z; }
  setZoomAndCenter(z) { this.zoom = z; }
  getCenter() { return this.center; }
  setBounds() { for (const handler of [...(this.__ev.moveend || [])]) handler({}); }
  /** 覆盖整个北京的视野，保证 viewportStops 的过滤分支能跑到 */
  getBounds() { return new BoundsStub([115.0, 39.0], [117.5, 41.0]); }
  setStatus() {}
  on(evt, fn) { (this.__ev[evt] = this.__ev[evt] || []).push(fn); }
  off(evt, fn) { this.__ev[evt] = (this.__ev[evt] || []).filter((listener) => listener !== fn); }
  emit(evt) { for (const fn of this.__ev[evt] || []) fn(); }
}
class OverlayStub {
  constructor(opts) { this.__opts = Object.assign({ strokeOpacity: 1, opacity: 0.9 }, opts); this.__ev = {}; this.map = null; }
  setMap(m) { this.map = m; }
  setOptions(o) { Object.assign(this.__opts, o); }
  getOptions() { return this.__opts; }
  on(evt, fn) { (this.__ev[evt] = this.__ev[evt] || []).push(fn); }
}
class PolylineStub extends OverlayStub { constructor(o) { super(o); created.polylines.push(this); } }
class CircleStub extends OverlayStub {}
class MarkerStub extends OverlayStub {
  constructor(o) { super(o); created.markers.push(this); }
  setPosition(position) { this.__opts.position = position; }
}
class MassMarksStub extends OverlayStub {
  constructor(data, opts) {
    super(opts);
    this.data = data;
    this.__baseOpacity = 0.9;
    this.shown = false;
    created.massMarks.push(this);
  }
  setData(d) { this.data = d; }
  show() { this.shown = true; }
  hide() { this.shown = false; }
}

globalThis.AMap = {
  __polyfill: true, // 桩对象模拟的是 Leaflet 兼容层接口（原生高德另走 native-picker）
  __backend: 'leaflet', // 与免 Key 默认路径一致（massmarks 无 canvas）
  Map: MapStub,
  MassMarks: MassMarksStub,
  Polyline: PolylineStub,
  Circle: CircleStub,
  Marker: MarkerStub,
  Bounds: BoundsStub,
  Pixel: class { constructor(x, y) { this.x = x; this.y = y; } },
  Size: class { constructor(w, h) { this.w = w; this.h = h; } },
  plugin: (name, cb) => setTimeout(cb, 0),
};

// ======================================================================
// 2. 加载 router.js（UMD → window.TransitRouter），再导入被测模块
// ======================================================================

globalThis.window.TransitRouter = require('../shared/router.js');

const { state } = await import('../frontend/js/core/state.js');
const { account } = await import('../frontend/js/core/account.js');
const { buildGraph, haversineKm } = await import('../frontend/js/core/router-api.js');
const { loadTransitData } = await import('../frontend/js/data/loader.js');
const { buildIndex } = await import('../frontend/js/data/index-builder.js');
const { LEVELS } = await import('../frontend/js/data/levels.js');
const { stopToData } = await import('../frontend/js/map/stop-marks.js');
const { initMap } = await import('../frontend/js/map/map-init.js');
const { renderMetroContext, renderStops, toggleShowAllStops } = await import('../frontend/js/map/stop-layer.js');
const { onStopMouseOver, onStopMouseOut } = await import('../frontend/js/map/hover.js');
const { onStopClick, onCandidateStopClick, cancelRoutePreview, finishRoute, resetRoute, undoRoute } = await import('../frontend/js/game/route.js');
const { startLevel, showMenu,returnHome, openStoryMenu, openTowerMenu, sampleRandomEndpoints } = await import('../frontend/js/game/session.js');
const { startTower, resetTowerFromLayer1, towerThreshold,openTowerResetConfirm,closeTowerResetConfirm,exitTowerAfterResult } = await import('../frontend/js/game/tower.js');
const { nextLevel, restartLevel } = await import('../frontend/js/game/flow.js');
const { clearGuestTowerState,loadTowerState,saveTowerState } = await import('../frontend/js/game/progress.js');
const { startFreeGame, scenarioHudText } = await import('../frontend/js/game/free.js');
const { openTowerLeaderboard, closeTowerLeaderboard } = await import('../frontend/js/game/leaderboard.js');
const { serializeRoute } = await import('../frontend/js/game/online.js');
const { startTowerTimer,stopTowerTimer } = await import('../frontend/js/game/tower-timer.js');
const { showResultOverlay } = await import('../frontend/js/ui/result.js');
const { storyNext } = await import('../frontend/js/ui/story.js');
const { updateButtons } = await import('../frontend/js/ui/menu.js');
const app = await import('../frontend/js/app.js'); // 入口（会自行 bootstrap：桩件里 loadScript 永不回调，属预期）

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const el = (id) => document.getElementById(id);

/**
 * 补齐线路的站间距 d（公里）。
 * 【背景】data/sample.json 的 stops 只有 id/name/lng/lat/seq，没有 d；
 *   而寻路器（router.js relaxRide）必须有 d>0 才建立乘车边，
 *   因此在演示数据下"最优路线"恒为"未找到可行路线"（只有步行可达）。
 *   全量 beijing-transit.json 有 d，不受影响。这里按相邻站球面距离补上，仅用于测试。
 */
function fillMissingSegments(data) {
  let filled = 0;
  for (const line of data.lines || []) {
    const stops = line.stops || [];
    for (let i = 0; i < stops.length; i++) {
      if (typeof stops[i].d === 'number' && stops[i].d > 0) continue;
      if (i + 1 >= stops.length) { stops[i].d = null; continue; }
      const a = stops[i], b = stops[i + 1];
      stops[i].d = Math.round(haversineKm([a.lng, a.lat], [b.lng, b.lat]) * 1000) / 1000;
      filled++;
    }
  }
  if (!USE_FULL && filled) console.log('  ℹ 已为 sample.json 补出 ' + filled + ' 段站间距 d（仅测试用）');
}

let pass = 0, fail = 0;
async function step(name, fn) {
  try {
    await fn();
    console.log('  \u2713 ' + name);
    pass++;
  } catch (e) {
    console.error('  \u2717 ' + name + '\n      ' + (e && e.message));
    fail++;
  }
}

console.log(`\n=== 冒烟测试（数据：${USE_FULL ? '全量 beijing-transit.json' : 'sample.json'}）===\n`);

// ======================================================================
// 3. 主流程
// ======================================================================

await step('模块图加载：分层模块互相 import 无缺失、无循环求值错误', () => {
  assert.ok(app, 'app.js 已加载');
  assert.equal(typeof onStopClick, 'function');
  assert.equal(typeof startLevel, 'function');
  assert.equal(typeof nextLevel, 'function');
});

await step('数据加载 + 索引构建（物理站/逻辑站/线路）', async () => {
  const { data, source } = await loadTransitData();
  assert.ok(/sample|全量/.test(source), '数据来源说明：' + source);
  fillMissingSegments(data); // 仅测试用：sample.json 缺站间距 d，寻路器需要它才建得出乘车边
  const graph = buildGraph(data.lines);
  buildIndex(data, graph);
  state.loadedCityId = 'beijing';
  assert.equal(state.linesMap.size, data.lines.length, '线路数一致');
  assert.ok(state.physStops.length > 0, '物理站已建立');
  assert.ok(state.logicalStops.length > 0, '逻辑站已建立');
  assert.ok(state.physStops.every((p) => state.logicalById.has(p.logicalId)), '每个物理站都能映射到逻辑站');
  assert.equal(state.routerGraph, graph, '前端索引与最优路线共用同一份寻路图');
  assert.equal(state.logicalStops.length, graph.logicalById.size, '前端与寻路器的逻辑站数量一致');
});

await step('首屏图层：地图初始化 + 地铁底图 + 站点层（含视野过滤分支）', () => {
  initMap();
  renderMetroContext();
  renderStops({ onClick: onStopClick, onMouseOver: onStopMouseOver, onMouseOut: onStopMouseOut, onMapClick: cancelRoutePreview });
  assert.ok(state.map, '地图实例已创建');
  assert.equal(created.massMarks.length, 3, '地铁、公交和起点步行三个独立站点图层已创建');
});

await step('选起点：点击站点开始规划并亮出候选网络', () => {
  const line = [...state.linesMap.values()].find((l) => l.mode === 'metro' && l.stops.length > 12);
  assert.ok(line, '找到一条可用的地铁线路');
  const physA = state.physStops.find((p) => p.id === String(line.stops[0].id));
  const physB = state.physStops.find((p) => p.id === String(line.stops[10].id));
  assert.ok(physA && physB, '取到线路上的两个站');

  startLevel({
    id: 'smoke', series: 0, title: '冒烟测试', timeLimitMin: 200,
    origin: { name: physA.name, lng: physA.lng, lat: physA.lat },
    dest: { name: physB.name, lng: physB.lng, lat: physB.lat },
    goalText: '测试目标', success: '成功', fail: '失败',
  }, { skipStory: true });

  assert.equal(state.routeStops.length, 0, '开局时路线为空');
  onStopClick({ data: stopToData(physA) });
  onStopClick({ data: stopToData(physA) });
  assert.equal(state.routeStops.length, 1, '首站已选中');
  assert.equal(state.routeRides.length, 0, '尚未乘车');
  assert.ok(!el('legend').classList.contains('hidden'), '确认起始站后左下角图例仍应显示');
  assert.ok(state.candidateMarks && state.candidateMarks.data.length > 0, '候选站点层已填充数据');
  assert.ok(state.candidateOverlays.length > 0, '候选线路已绘制');

  // 存起来给下一步用
  globalThis.__smokeA = physA;
  globalThis.__smokeB = physB;
});

await step('设置里的步行换乘按钮直接控制状态和候选图层', () => {
  const toggle = el('walk-transfer-toggle');
  toggle.checked = true;
  toggle.dispatch('change', { currentTarget: toggle });
  assert.equal(state.walkTransfer, true, '勾选设置按钮后应立即开启步行换乘');

  toggle.checked = false;
  toggle.dispatch('change', { currentTarget: toggle });
  assert.equal(state.walkTransfer, false, '取消设置按钮后应立即关闭步行换乘');
  assert.equal(state.forceWalk, false, '关闭设置按钮后应同步关闭强制步行');
  assert.ok(state.candidateMarks.data.every((point) => point.style !== 2), '关闭后候选数据不应有红色步行站');
  assert.equal(state.candidateMarks.__opts.style[2].url, state.candidateMarks.__opts.style[1].url, '关闭后候选图层不应装载红色步行图标');
  assert.equal(localStorage.getItem('mg_walk_transfer'), '0', '关闭状态应写入持久化设置');
});

await step('步行换乘：确认红色步行站后接一段步行（地图点数据只有 lnglat）', () => {
  const toggle = el('walk-transfer-toggle');
  toggle.checked = true;
  toggle.dispatch('change', { currentTarget: toggle });
  const walkPoint = state.candidateMarks.data.find((point) => point.style === 2);
  assert.ok(walkPoint, '候选层中应有红色步行可达站');
  const before = state.routeStops.length;
  onCandidateStopClick(walkPoint);
  onCandidateStopClick(walkPoint);
  assert.equal(state.routeStops.length, before + 1, '确认后路线增加一站');
  assert.equal(state.routeRides.at(-1), null, '新增一段为步行换乘');
  assert.ok(state.routeStops.at(-1).point.every(Number.isFinite), '新站坐标有效（不是 NaN）');
  if (state.selectedLineName) undoRoute(); // 到站自动选中的唯一线路先被撤回
  undoRoute();
  assert.equal(state.routeStops.length, before, '撤回步行换乘');
  toggle.checked = false;
  toggle.dispatch('change', { currentTarget: toggle });
});

await step('换乘一步：两站共线 → 接一段乘车 + 站点序号图钉', () => {
  const physB = globalThis.__smokeB;
  const before = state.routeOverlayGroups.length;
  onCandidateStopClick(stopToData(physB));
  onCandidateStopClick(stopToData(physB));
  assert.equal(state.routeRides.length, 1, '已接上一条线路');
  assert.equal(state.routeStops.length, 2, '路线链有两站');
  assert.ok(state.routeOverlayGroups.length > before, '新开了一个撤回分组');
  assert.ok(created.polylines.length > 0, '乘车段折线已绘制');
});

await step('完成规划 → 计算最优路线 → 经事件总线弹出结算窗', async () => {
  finishRoute();
  await wait(400);
  assert.equal(state.finished, true, '规划已完成');
  assert.ok(state.optimalResult, '最优路线未算出：状态栏=' + el('status').textContent);
  assert.ok(state.optimalResult.totalMin > 0, '最优总耗时为正数');
  assert.ok(state.optimalResult.totalMin <= 100000, '最优总耗时在合理范围');
  assert.ok(!el('result-overlay').classList.contains('hidden'), '结算弹窗已弹出（证明 bus → flow → ui/result 链路通）');
  assert.ok(el('result-title').textContent.length > 0, '结算标题已写入');
  assert.ok(/用时/.test(el('result-times').textContent), '结算明细已写入：' + el('result-times').textContent);
  assert.ok(!el('route-panel').classList.contains('hidden'), '路线面板已显示');
});

await step('撤回与重置', () => {
  resetRoute();
  assert.equal(state.routeStops.length, 0, '路线已清空');
  assert.equal(state.finished, false);
  assert.equal(state.optimalResult, null, '最优路线已清除');
  undoRoute(); // 空路线撤回不应报错
  toggleShowAllStops();
  assert.equal(state.showAllStops, true, '全图显示开关生效');
  toggleShowAllStops();
  assert.equal(state.showAllStops, false);
});

await step('两端统一两阶段选站 + 两局残留检查', async () => {
  const physA = globalThis.__smokeA, physB = globalThis.__smokeB;
  state.isTouch = true; // 模拟触摸设备
  const start = () => startLevel({
    id: 'smoke-mobile', series: 0, title: '手机测试', timeLimitMin: 200,
    origin: { name: physA.name, lng: physA.lng, lat: physA.lat },
    dest: { name: physB.name, lng: physB.lng, lat: physB.lat },
    goalText: '', success: '', fail: '',
  }, { skipStory: true });

  start();
  // 起点：第一次点 = 悬浮高亮（不开始）
  onStopClick({ data: stopToData(physA) });
  assert.equal(state.routeStops.length, 0, '起点第一次点只预览');
  assert.ok(state.pendingStart, '已记录待确认起点');
  assert.ok(state.candidateMarks, '预览阶段显示经过线路的候选站点');

  // 起点：再次点击同一站确认
  onStopClick({ data: stopToData(physA) });
  assert.equal(state.routeStops.length, 1, '再次点击同一站后开始');
  assert.equal(state.pendingStart, null, '确认后清空待确认起点');

  // 下一站：第一次点 = 悬浮高亮（不确定）
  onCandidateStopClick(stopToData(physB));
  assert.equal(state.routeStops.length, 1, '下一站第一次点只预览');
  assert.ok(state.pendingCandidate, '已记录待确认下一站');

  // 下一站：再次点击同一站确认
  onCandidateStopClick(stopToData(physB));
  assert.equal(state.routeStops.length, 2, '再次点击同一站后换乘');
  assert.equal(state.pendingCandidate, null, '确认后清空待确认下一站');

  finishRoute();
  await wait(400);
  assert.equal(state.finished, true, '第一局完成');
  assert.equal(state.candidateMarks, null, '完成后候选站点已清空');
  assert.equal(state.candidateOverlays.length, 0, '完成后候选线路已清空');

  // 第二局：重新开始，不应残留第一局状态
  restartLevel();
  assert.equal(state.routeStops.length, 0, '重开后路线清空');
  assert.equal(state.finished, false, '重开后 finished 复位');
  assert.equal(state.candidateMarks, null, '重开后无候选站点残留');
  assert.equal(state.candidateOverlays.length, 0, '重开后无候选线路残留');
  assert.equal(state.pendingStart, null, '重开后无起点预览残留');
  assert.equal(state.pendingCandidate, null, '重开后无下一站预览残留');

  // 第二局应能正常重新预览
  onStopClick({ data: stopToData(physA) });
  assert.equal(state.routeStops.length, 0, '第二局预览不立即开始');
  assert.ok(state.pendingStart, '第二局能正常预览起点');

  state.isTouch = false; // 还原，避免影响后续步骤
  resetRoute();
});

await step('全图显示下可预览、但确定被阻止', () => {
  const physA = globalThis.__smokeA;
  state.isTouch = true;
  startLevel({
    id: 'smoke-showall', series: 0, title: '全图显示', timeLimitMin: 200,
    origin: { name: physA.name, lng: physA.lng, lat: physA.lat },
    dest: { name: physA.name, lng: physA.lng + 0.02, lat: physA.lat },
    goalText: '', success: '', fail: '',
  }, { skipStory: true });

  toggleShowAllStops();
  assert.equal(state.showAllStops, true, '开启全图显示');

  // 全图显示下第一次点 = 仍可预览（高亮），不开始
  onStopClick({ data: stopToData(physA) });
  assert.ok(state.pendingStart, '全图显示下仍可预览起点');
  assert.equal(state.routeStops.length, 0, '预览不立即开始');

  // 全图显示下再次点击同一站 = 确定被阻止
  onStopClick({ data: stopToData(physA) });
  assert.ok(state.pendingStart, '全图显示下确定被阻止，待确认状态保留');
  assert.equal(state.routeStops.length, 0, '全图显示下确定未生效');

  // 关闭全图显示后：切换会取消预览，再重新预览并确定
  toggleShowAllStops();
  assert.equal(state.showAllStops, false, '关闭全图显示');
  assert.equal(state.pendingStart, null, '切换后清空预览');
  onStopClick({ data: stopToData(physA) });
  onStopClick({ data: stopToData(physA) });
  assert.equal(state.routeStops.length, 1, '关闭全图显示后确定恢复');

  state.isTouch = false;
  resetRoute();
});

await step('爬塔：开一层并判定阈值', async () => {
  startTower('normal');
  await wait(100);
  assert.equal(state.towerActive, true);
  assert.equal(state.towerLayer, 1);
  assert.ok(state.ORIGIN && state.DEST, '随机起终点已生成');
  assert.ok(haversineKm(state.ORIGIN, state.DEST) >= 3, '两点间距足够远');
  assert.equal(towerThreshold(1), 1.0);
  assert.equal(towerThreshold(12), 0.01);
  assert.equal(towerThreshold(99), 0.01, '第 12 层后维持 1%');

  // 退出重进应沿用同一组起终点（防止"无限重开刷起终点"）
  const savedOrigin = state.ORIGIN.slice();
  const savedDest = state.DEST.slice();
  returnHome();
  assert.equal(el('center-toast').classList.contains('hidden'),false,'中途回主页时显示计时不暂停提示');
  startTower('normal');
  await wait(100);
  assert.deepEqual(state.ORIGIN, savedOrigin, '退出重进后起点不变');
  assert.deepEqual(state.DEST, savedDest, '退出重进后终点不变');

  resetTowerFromLayer1();
  await wait(100);
  assert.equal(state.towerLayer, 1);
});

await step('爬塔：通过后返回主页进度不丢、中途退出记录当前层', async () => {
  // 场景 1：通过第 1 层后直接返回主页（模拟 showTowerResult 已把进度推进到第 2 层）
  startTower('normal');
  await wait(100);
  state.finished = true;            // 本局已完成
  state.towerProgress.normal = 2;   // showTowerResult 通过时已设置
  showMenu();
  assert.equal(state.towerProgress.normal, 2, '通过后返回主页，进度应保留在第 2 层');

  // 场景 2：中途退出（未完成）应记录当前层
  startTower('normal');
  await wait(100);
  state.towerLayer = 3;
  state.finished = false;           // 未完成
  state.towerProgress.normal = 0;   // 先清空，模拟无进度
  showMenu();
  assert.equal(state.towerProgress.normal, 3, '中途退出应记录当前层第 3 层');

  resetTowerFromLayer1();           // 清理，避免影响后续步骤
  await wait(100);
});

await step('随机模式：情景随机，局内 HUD 显示本局情景', async () => {
  await startFreeGame();
  await wait(100);
  assert.equal(state.gameMode, 'random');
  assert.ok(el('tower-layer-label').textContent.length > 0, '顶部 HUD 显示本局情景效果');
  assert.equal(el('mode-hud').classList.contains('hidden'), false, '随机模式显示情景 HUD');
  await startFreeGame('rain');
  await wait(100);
  assert.equal(state.scenario.walkSpeedFactor, 0.5, '雨天的步行系数已应用');
  assert.equal(state.scenario.busSpeedFactor, 0.5, '雨天的公交系数已应用');
  assert.equal(el('tower-layer-label').textContent, scenarioHudText('rain'));
  await startFreeGame('realRide');
  await wait(100);
  assert.equal(state.scenario.realRide, true, '随机也可能抽到真实乘坐');
  assert.equal(el('tower-layer-label').textContent, '无撤回/全图显示', 'HUD 只显示效果，情景名在左上角标题');
});

await step('自由选线换乘教程：欢迎、提示、换乘、撤回与通关', async () => {
  const lv = LEVELS[0];
  const { isMapPracticePending } = await import('../frontend/js/map/tutorial-layer.js');
  const { ensureGameDataReady } = await import('../frontend/js/game/data-ready.js');
  assert.equal(await ensureGameDataReady(lv.cityId), true);
  startLevel(lv);
  assert.equal(state.storyActive, true, '开场先显示欢迎说明');
  assert.ok(el('story-text').textContent.includes('尽可能快地抵达'));
  assert.equal(el('story-welcome-title').textContent, '欢迎来到 TransitGuesser');
  assert.ok(el('tutorial-guide').classList.contains('hidden'), '欢迎说明与操作框不重叠');
  storyNext();
  assert.equal(state.storyActive, false, '开始后可自由操作地图');
  assert.ok(!el('tutorial-guide').classList.contains('hidden'));
  assert.ok(state.originWalkRangeCircle && state.destinationWalkRangeCircle, '保留普通玩法步行范围');
  assert.ok(!created.markers.some(m => m.map && /map-tutorial-label|transfer-highlight|map-tutorial-note/.test(String(m.__opts.content))), '不添加地图教学标注');
  const originalGetBounds = state.map.getBounds;
  const originalSetBounds = state.map.setBounds;
  const wideBounds = new BoundsStub([state.ORIGIN[0] - .08, state.ORIGIN[1] - .08], [state.ORIGIN[0] + .08, state.ORIGIN[1] + .08]);
  let viewBounds = wideBounds;
  state.map.getBounds = () => viewBounds;
  state.map.setBounds = (bounds) => {
    viewBounds = bounds;
    for (const handler of [...(state.map.__ev.moveend || [])]) handler({});
  };
  const { walkRangeBounds } = await import('../frontend/js/map/walk-range.js');
  const focusedBounds = walkRangeBounds([state.ORIGIN], 1650);
  const adjustView = (bounds) => {
    viewBounds = bounds;
    for (const handler of [...(state.map.__ev.moveend || [])]) handler({});
  };
  state.map.setZoom(15);
  for (const handler of state.map.__ev.zoomchange || []) handler({});
  assert.ok(el('tutorial-guide-title').textContent.includes('熟悉地图'), '手动缩放不会跳过第一步');
  assert.equal(el('tutorial-guide-title').textContent, '熟悉地图操作', '标题只使用步骤名称');
  const practiceStop = state.physStops.find(p => p.name === '迎宾桥');
  const previousToast = el('center-toast').textContent;
  onStopMouseOver({ data: stopToData(practiceStop) });
  await wait(60);
  assert.ok(el('infocard').classList.contains('hidden'), '地图操作阶段不显示悬停预览');
  onStopClick({ data: stopToData(practiceStop) });
  assert.equal(state.pendingStart, null, '地图操作阶段误点不锁定站点');
  assert.equal(el('center-toast').textContent, previousToast, '地图操作阶段误点静默忽略');
  const originPin = state.endpointOverlays.find(m => String(m.__opts?.content).includes('pin origin'));
  const destinationPin = state.endpointOverlays.find(m => String(m.__opts?.content).includes('pin dest'));
  destinationPin.__ev.click[0]();
  assert.ok(el('tutorial-guide-title').textContent.includes('熟悉地图'), '聚焦终点不能完成起点目标');
  adjustView(new BoundsStub(focusedBounds.sw, focusedBounds.ne));
  assert.equal(el('tutorial-guide-title').textContent, '选择上车站', '手动移到起点并放大也能进入下一步');
  assert.ok(el('tutorial-guide-text').textContent.includes('起点红圈的步行范围'), '说明从哪里选择上车站');
  assert.ok(el('tutorial-guide-text').textContent.includes('将鼠标移到站点上'), '说明悬停预览的操作方式');
  assert.ok(el('tutorial-guide-text').textContent.includes('单击一下即可锁定'), '说明单击锁定站点');
  adjustView(wideBounds);
  assert.ok(el('tutorial-guide-title').textContent.includes('熟悉地图'), '视野太宽时退回地图操作');
  originPin.__ev.click[0]();
  assert.equal(el('tutorial-guide-title').textContent, '选择上车站');
  const alternate = state.physStops.find(p => p.name === '州文体艺术中心');
  onStopMouseOver({ data: stopToData(alternate) });
  await wait(60);
  assert.ok(!el('infocard').classList.contains('hidden'), '选站阶段悬停可预览');
  assert.equal(state.pendingStart, null, '悬停不锁定站点');
  assert.equal(el('tutorial-guide-title').textContent, '选择上车站', '悬停不推进教程');
  onStopClick({ data: stopToData(alternate) });
  assert.equal(state.pendingStart.logical.name, alternate.name, '允许自由预览其他上车站');
  assert.equal(el('tutorial-guide-title').textContent, '确认上车站', '单击锁定后进入线路选择');
  const previewLine = el('info-lines').children[0];
  assert.equal(typeof previewLine.onclick, 'function', '锁定站点后线路名称板可选择');
  previewLine.onclick();
  previewLine.onclick();
  assert.equal(state.selectedLineName, previewLine.textContent, '锁定期间可取消并重新选择线路');
  cancelRoutePreview(null, true);
  assert.equal(state.pendingStart, null, '可取消锁定的上车站');
  assert.equal(el('tutorial-guide-title').textContent, '选择上车站', '取消后继续自由选择站点');
  const line3 = state.linesMap.get('L_2e1682b2b792');
  const line2 = state.linesMap.get('L_d3aa69375f93');
  const physical = (line, name) => {
    const stop = line.stops.find(s => s.name === name);
    return state.physStops.find(p => String(p.id) === String(stop.id));
  };
  const board = physical(line3, '迎宾桥');
  const transfer = physical(line3, '博州妇幼保健院');
  const dest = physical(line2, '博尔塔拉火车站');
  assert.ok(board && transfer && dest, '测试旅程使用真实公交站');
  onStopClick({ data: stopToData(board) });
  assert.ok(el('tutorial-guide-text').textContent.includes(board.name));
  adjustView(wideBounds);
  assert.equal(el('tutorial-guide-title').textContent, '确认上车站', '锁定后缩小不再退回地图操作');
  assert.equal(state.pendingStart.logical.name, board.name, '缩放保留预览');
  assert.equal(isMapPracticePending(), false, '开始预览后不再限制地图视野');
  adjustView(new BoundsStub(focusedBounds.sw, focusedBounds.ne));
  assert.equal(el('tutorial-guide-title').textContent, '确认上车站', '恢复视野后继续线路选择');
  assert.equal(state.selectedLineName, '3路', '预览只有一条线路时自动选择，同名上下行合并计算');
  onStopClick({ data: stopToData(board) });
  assert.equal(state.routeStops.length, 1);
  assert.equal(state.selectedLineName, '3路', '确认上车后保留单线路自动选择');
  const pickLine = name => {
    if (state.selectedLineName !== name) el('current-info-lines').children.find(tag => tag.textContent === name).onclick();
  };
  pickLine('3路');
  assert.ok(el('tutorial-guide-text').textContent.includes('3路'));
  assert.ok(el('tutorial-guide-text').textContent.includes('途中下车换乘'), '无需一条线直接到终点');
  assert.equal(el('tutorial-guide-action').textContent, '预览一个下车站\n提示：点一次查看，再点一次确认。在「博州妇幼保健院」下车换乘。', '乘上 3路 后在提示里建议换乘站');
  const intermediate = physical(line3, '天山南路');
  onCandidateStopClick(stopToData(intermediate));
  onCandidateStopClick(stopToData(intermediate));
  assert.equal(state.routeStops.at(-1).logical.name, intermediate.name, '可自由选择中间下车站');
  if (state.selectedLineName) undoRoute();
  undoRoute();
  assert.equal(state.routeStops.length, 1, '可撤回自己的选择');
  pickLine('3路');
  onCandidateStopClick(stopToData(transfer));
  onCandidateStopClick(stopToData(transfer));
  assert.equal(state.routeStops.length, 2);
  assert.equal(state.selectedLineName, null, '换乘站有多条线路时保持手动选择');
  assert.ok(el('tutorial-guide-title').textContent.includes('换乘'), '到达中途站后介绍换乘');
  assert.ok(el('tutorial-guide-text').textContent.includes(transfer.name));
  assert.ok(!el('tutorial-guide-action').textContent.includes('下车换乘'), '到达换乘站后不再建议下车');
  pickLine('2路');
  onCandidateStopClick(stopToData(dest));
  assert.ok(el('tutorial-guide-text').textContent.includes(dest.name));
  onCandidateStopClick(stopToData(dest));
  assert.deepEqual(state.routeRides.map(line => line.name), ['3路', '2路']);
  assert.ok(el('tutorial-guide-title').textContent.includes('终点'));
  const { findOptimalRoute } = await import('../frontend/js/core/router-api.js');
  const { routerWalkFn } = await import('../frontend/js/map/walk.js');
  const best = await findOptimalRoute(state.routerGraph, state.ORIGIN, state.DEST,
    { allowMetro: true, busSpeedFactor: 1 }, routerWalkFn);
  assert.equal(best.legs.filter(leg => leg.type === 'ride').length, 2, '固定起终点的最快路线恰好换乘一次');
  finishRoute();
  await wait(100);
  assert.equal(state.finished, true, '普通规则到达即可通关');
  assert.ok(el('tutorial-guide').classList.contains('hidden'));
  adjustView(wideBounds);
  restartLevel();
  assert.equal(state.finished, false);
  assert.ok(!el('tutorial-guide').classList.contains('hidden'), '重玩恢复文字操作框');
  assert.ok(el('tutorial-guide-title').textContent.includes('熟悉地图'), '重玩从地图操作练习开始');
  resetRoute();
  state.map.getBounds = originalGetBounds;
  state.map.setBounds = originalSetBounds;
});

await step('教学关通关后回菜单，旧北京关不再进入', async () => {
  assert.deepEqual(LEVELS.map((l) => l.id), ['guided_intro'], '故事模式只保留新的操作教程');
  state.currentLevel = LEVELS[LEVELS.length - 1];
  nextLevel();
  assert.ok(!el('main-menu').classList.contains('hidden'), '最后一关完成后回到主菜单');
  assert.equal(state.storyUnlocked, LEVELS.length + 1, '全部教学关已通关');
  updateButtons();
  openStoryMenu();
  assert.ok(el('story-level-list').children[0].innerHTML.includes(LEVELS[0].title), '选关显示新手教程入口');
  openTowerMenu();
  assert.equal(el('tower-guest-notice').classList.contains('hidden'),false,'游客进入无尽模式时显示存档提醒');
  account.user={id:'test-user',name:'测试玩家'};
  openTowerMenu();
  assert.equal(el('tower-guest-notice').classList.contains('hidden'),true,'登录玩家不显示游客提醒');
  account.user=null;
  showMenu();
  assert.equal(state.towerActive, false, '已退出爬塔');
  assert.ok(!el('main-menu').classList.contains('hidden'), '主菜单已显示');
  assert.ok(el('result-overlay').classList.contains('hidden'), '结果弹窗已清掉');
});

await step('无尽排行榜：按层数展示，并显示累计实际用时', async () => {
  const originalFetch=globalThis.fetch;
  globalThis.fetch=async url=>String(url).includes('/leaderboard?')
    ? {ok:true,status:200,json:async()=>({leaders:[{rank:'1',name:'测试玩家',cleared_layers:4,total_elapsed_ms:5421000}],player:{rank:'27',name:'当前玩家',cleared_layers:2,total_elapsed_ms:120000}})}
    : originalFetch(url);
  try {
    openTowerLeaderboard();await wait(0);
    assert.ok(!el('leaderboard-dialog').classList.contains('hidden'),'排行榜已打开');
    const row=el('leaderboard-list').children[0];
    assert.equal(row.children[1].textContent,'测试玩家');
    assert.equal(row.children[2].textContent,'4 层');
    assert.equal(row.children[3].textContent,'01:30:21.000');
    assert.equal(el('leaderboard-list').children[2].children[1].textContent,'当前玩家');
    assert.equal(el('leaderboard-list').children[2].children[0].textContent,'#27');
    closeTowerLeaderboard();
    assert.ok(el('leaderboard-dialog').classList.contains('hidden'),'排行榜已关闭');
  } finally { globalThis.fetch=originalFetch; }
});

await step('在线无尽：步行换乘序列化、计时器和通关退出', async () => {
  state.routeStops=[{physicalStopId:'A'},{physicalStopId:'B'}];state.routeRides=[null];
  assert.deepEqual(serializeRoute(),[{type:'walk',fromStopId:'A',toStopId:'B'}]);
  startTowerTimer(Date.now()-65000,120000);
  assert.equal(el('tower-timer').textContent,'01:05/03:05');
  stopTowerTimer();
  openTowerResetConfirm();
  assert.equal(el('tower-reset-dialog').classList.contains('hidden'),false);
  closeTowerResetConfirm();
  assert.equal(el('tower-reset-dialog').classList.contains('hidden'),true);
  showResultOverlay({showExit:true});
  assert.equal(el('result-exit').classList.contains('hidden'),false);
  showResultOverlay({showExit:false});
  assert.equal(el('result-exit').classList.contains('hidden'),true);
  state.towerActive=true;state.finished=true;
  startTowerTimer(Date.now()-1000,120000);
  exitTowerAfterResult();
  const frozen=el('tower-timer').textContent;
  await wait(300);
  assert.equal(el('tower-timer').textContent,frozen,'通关退出后计时已冻结');
  assert.equal(el('main-menu').classList.contains('hidden'),false,'通关退出回到主页');
});

await step('每日挑战面板：今日题目、游客提示、我的名次', async () => {
  const { openDailyMenu } = await import('../frontend/js/game/daily.js');
  const originalFetch = globalThis.fetch;
  const closesAt = new Date(Date.now() + 5 * 3600000).toISOString();
  const json = (body) => ({ ok: true, status: 200, json: async () => body });
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.endsWith('/api/daily')) return json({ id: 'd1', date: '2026-09-29', city: 'beijing', scenario: 'normal', opensAt: closesAt, closesAt });
    if (u.includes('/leaderboard?') && u.includes('mode=daily')) {
      return json({ leaders: [{ rank: '1', name: '甲', duration_ms: 1500000, achieved_at: '2026-09-29T08:05:09' }], player: { rank: '23', name: '测试玩家', duration_ms: 1860000, is_me: true } });
    }
    return originalFetch(url);
  };
  try {
    account.user = null;
    await openDailyMenu();
    await wait(20);
    assert.equal(el('daily-menu').classList.contains('hidden'), false, '每日挑战面板已打开');
    assert.match(el('daily-info').textContent, /2026-09-29 · 北京 · 距本题截止还有 \d+ 小时/, '显示日期、城市与倒计时');
    assert.equal(el('daily-start').textContent, '登录后挑战', '游客需要先登录');
    assert.equal(el('daily-guest-notice').classList.contains('hidden'), false, '游客看到登录说明');
    account.user = { id: 'test-user', name: '测试玩家' };
    await openDailyMenu();
    await wait(20);
    assert.equal(el('daily-start').textContent, '开始挑战');
    assert.equal(el('daily-mine').textContent, '今日最好 31.0 分钟 · 第 23 名', '前 20 名以外也显示自己的名次');
    assert.equal(el('daily-board').children.length, 3, '前 20 + 分隔行 + 自己');
    assert.equal(el('daily-board').children[0].children[3].textContent, '08:05:09', '第二排名键完成时间显示在列表中');
  } finally {
    globalThis.fetch = originalFetch;
    account.user = null;
    showMenu();
  }
});

await step('存档写入（爬塔纪录 best/progress，按城市分开存）', () => {
  // 爬塔存档按城市分 key：当前测试城市是默认的 beijing
  assert.ok(store.has('mg_tower_state_beijing'), '爬塔纪录已落盘（按城市分 key）');
  const saved = JSON.parse(store.get('mg_tower_state_beijing'));
  assert.ok(saved.best && typeof saved.best.normal === 'number', 'best 结构正确');
  assert.ok(saved.progress && typeof saved.progress.normal === 'number', 'progress 结构正确');
  assert.ok(saved.elapsed && typeof saved.elapsed.normal === 'number', 'elapsed 结构正确');
});

await step('爬塔存档 dataVersion 校验：旧版本 round 被清除、best/progress 保留', () => {
  // 模拟旧版本存档（无 dataVersion）——旧起终点可能落在已删除线路/孤岛上，必须丢弃
  store.set('mg_tower_state_beijing', JSON.stringify({
    best: { normal: 5 }, progress: { normal: 3 },
    round: { normal: { layer: 3, origin: [116.4, 39.9], dest: [116.5, 40.0] } },
  }));
  state.towerBest = { normal: 0, noMetro: 0, busBoost: 0, rain: 0 };
  state.towerProgress = { normal: 0, noMetro: 0, busBoost: 0, rain: 0 };
  state.towerRound = { normal: null, noMetro: null, busBoost: null, rain: null };
  loadTowerState();
  assert.equal(state.towerBest.normal, 5, 'best 应保留');
  assert.equal(state.towerProgress.normal, 3, 'progress 应保留');
  assert.equal(state.towerRound.normal, null, '旧版本 round 应被清除');

  // 当前版本存档：round 应正常还原
  state.towerRound.normal = { layer: 3, origin: [116.4, 39.9], dest: [116.5, 40.0] };
  saveTowerState();
  state.towerRound.normal = null;
  loadTowerState();
  assert.ok(state.towerRound.normal, '当前版本 round 应保留');
  assert.deepEqual(state.towerRound.normal.origin, [116.4, 39.9], 'round 起终点应还原');
});

await step('登录切换前清除游客无尽记录', () => {
  store.set('mg_tower_state_shanghai','{}');
  clearGuestTowerState();
  assert.equal(store.has('mg_tower_state_beijing'),false);
  assert.equal(store.has('mg_tower_state_shanghai'),false);
});

await step('随机起终点落在主连通分量（componentOf/mainComponent 已建）', () => {
  assert.ok(state.mainComponent, 'mainComponent 应已计算');
  assert.ok(state.componentOf.size > 0, 'componentOf 应已填充');
  for (let i = 0; i < 10; i++) {
    const [o, d] = sampleRandomEndpoints();
    assert.ok(Array.isArray(o) && o.length === 2 && Number.isFinite(o[0]) && Number.isFinite(o[1]), '起点坐标合法');
    assert.ok(Array.isArray(d) && d.length === 2 && Number.isFinite(d[0]) && Number.isFinite(d[1]), '终点坐标合法');
  }
});

// ======================================================================
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
