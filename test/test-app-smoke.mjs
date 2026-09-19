/**
 * test-app-smoke.mjs —— 前端分层拆分后的"无浏览器"冒烟测试
 *
 * 【为什么需要它】
 *   app.js 被拆成 30 个模块后，最大的风险不再是"算法错了"，而是
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

/** fetch 桩：默认把全量数据当 404（走 sample 兜底），MG_FULL=1 时读真实全量数据 */
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('beijing-transit.json') && !USE_FULL) {
    return { ok: false, status: 404, json: async () => { throw new Error('404'); } };
  }
  const text = fs.readFileSync(path.join(ROOT, u), 'utf8');
  return { ok: true, status: 200, json: async () => JSON.parse(text) };
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
  setBounds() {}
  /** 覆盖整个北京的视野，保证 viewportStops 的过滤分支能跑到 */
  getBounds() { return new BoundsStub([115.0, 39.0], [117.5, 41.0]); }
  setStatus() {}
  on(evt, fn) { (this.__ev[evt] = this.__ev[evt] || []).push(fn); }
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
class MarkerStub extends OverlayStub { constructor(o) { super(o); created.markers.push(this); } }
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

globalThis.window.TransitRouter = require('../js/router.js');

const { state } = await import('../js/core/state.js');
const { buildGraph, haversineKm } = await import('../js/core/router-api.js');
const { loadTransitData } = await import('../js/data/loader.js');
const { buildIndex } = await import('../js/data/index-builder.js');
const { LEVELS } = await import('../js/data/levels.js');
const { stopToData } = await import('../js/map/stop-marks.js');
const { initMap } = await import('../js/map/map-init.js');
const { renderMetroContext, renderStops, toggleShowAllStops } = await import('../js/map/stop-layer.js');
const { onStopMouseOver, onStopMouseOut } = await import('../js/map/hover.js');
const { onStopClick, onCandidateStopClick, finishRoute, resetRoute, undoRoute } = await import('../js/game/route.js');
const { startLevel, showMenu, openStoryMenu, openTowerMenu } = await import('../js/game/session.js');
const { startTower, resetTowerFromLayer1, towerThreshold } = await import('../js/game/tower.js');
const { nextLevel, restartLevel } = await import('../js/game/flow.js');
const { openFreeMenu, startFreeGame } = await import('../js/game/free.js');
const { storyNext, tutorialNext } = await import('../js/ui/story.js');
const { updateButtons } = await import('../js/ui/menu.js');
const app = await import('../js/app.js'); // 入口（会自行 bootstrap：桩件里 loadScript 永不回调，属预期）

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

await step('模块图加载：30 个模块互相 import 无缺失、无循环求值错误', () => {
  assert.ok(app, 'app.js 已加载');
  assert.equal(typeof onStopClick, 'function');
  assert.equal(typeof startLevel, 'function');
  assert.equal(typeof nextLevel, 'function');
});

await step('数据加载 + 索引构建（物理站/逻辑站/线路）', async () => {
  const { data, source } = await loadTransitData();
  assert.ok(/sample|全量/.test(source), '数据来源说明：' + source);
  fillMissingSegments(data); // 仅测试用：sample.json 缺站间距 d，寻路器需要它才建得出乘车边
  buildIndex(data);
  assert.equal(state.linesMap.size, data.lines.length, '线路数一致');
  assert.ok(state.physStops.length > 0, '物理站已建立');
  assert.ok(state.logicalStops.length > 0, '逻辑站已建立');
  assert.ok(state.physStops.every((p) => state.logicalById.has(p.logicalId)), '每个物理站都能映射到逻辑站');
  state.routerGraph = buildGraph(data.lines);
  assert.ok(state.routerGraph, '寻路图已建立');
});

await step('首屏图层：地图初始化 + 地铁底图 + 站点层（含视野过滤分支）', () => {
  initMap();
  renderMetroContext();
  renderStops({ onClick: onStopClick, onMouseOver: onStopMouseOver, onMouseOut: onStopMouseOut });
  assert.ok(state.map, '地图实例已创建');
  assert.equal(created.massMarks.length, 2, '地铁/公交两个站点图层已创建');
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
  assert.equal(state.routeStops.length, 1, '首站已选中');
  assert.equal(state.routeRides.length, 0, '尚未乘车');
  assert.ok(state.candidateMarks && state.candidateMarks.data.length > 0, '候选站点层已填充数据');
  assert.ok(state.candidateOverlays.length > 0, '候选线路已绘制');

  // 存起来给下一步用
  globalThis.__smokeA = physA;
  globalThis.__smokeB = physB;
});

await step('换乘一步：两站共线 → 接一段乘车 + 站点序号图钉', () => {
  const physB = globalThis.__smokeB;
  const before = state.routeOverlayGroups.length;
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

await step('手机两阶段选站 + 两局残留检查', async () => {
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
  assert.equal(state.candidateMarks, null, '预览阶段不显示候选网络');

  // 起点：再次点击同一站 = 确认
  onStopClick({ data: stopToData(physA) });
  assert.equal(state.routeStops.length, 1, '起点再次点击确认后开始');
  assert.equal(state.pendingStart, null, '确认后清空待确认起点');

  // 下一站：第一次点 = 悬浮高亮（不确定）
  onCandidateStopClick(stopToData(physB));
  assert.equal(state.routeStops.length, 1, '下一站第一次点只预览');
  assert.ok(state.pendingCandidate, '已记录待确认下一站');

  // 下一站：再次点击同一站 = 确认
  onCandidateStopClick(stopToData(physB));
  assert.equal(state.routeStops.length, 2, '下一站再次点击确认后换乘');
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
  showMenu();
  startTower('normal');
  await wait(100);
  assert.deepEqual(state.ORIGIN, savedOrigin, '退出重进后起点不变');
  assert.deepEqual(state.DEST, savedDest, '退出重进后终点不变');

  resetTowerFromLayer1();
  await wait(100);
  assert.equal(state.towerLayer, 1);
});

await step('自由模式：勾选晴雨情景开局', async () => {
  el('free-no-metro').checked = false;
  el('free-bus-boost').checked = false;
  el('free-rain').checked = true;
  await startFreeGame();
  await wait(100);
  assert.equal(state.gameMode, 'random');
  assert.equal(state.scenario.walkSpeedFactor, 0.5, '雨天的步行系数已应用');
  assert.equal(state.scenario.busSpeedFactor, 0.5, '雨天的公交系数已应用');
});

await step('剧情 → 教学 → 交还操作权（回调驱动的 UI 流程）', () => {
  const lv = LEVELS[0];
  startLevel(lv);
  assert.equal(state.storyActive, true, '剧情期间地图锁定');
  assert.ok(!el('story-dialog').classList.contains('hidden'), '剧情对话框已打开');
  for (let i = 0; i < lv.story.length; i++) storyNext();
  assert.equal(state.storyActive, false, '教学开始后解锁地图');
  assert.ok(el('story-dialog').classList.contains('hidden'), '剧情对话框已收起');
  assert.ok(!el('tutorial-bubble').classList.contains('hidden'), '教学气泡已打开');
  for (let i = 0; i < 4; i++) tutorialNext();
  assert.ok(el('tutorial-bubble').classList.contains('hidden'), '教学气泡已收起');
  assert.equal(el('status').textContent, lv.goalText, '状态栏已交还给玩家目标');
});

await step('菜单与关卡衔接：下一关 / 重开 / 回主菜单', () => {
  nextLevel();
  assert.equal(state.currentLevel, LEVELS[1], '已进入第 2 关');
  restartLevel();
  assert.equal(state.routeStops.length, 0, '重开后路线清空');
  updateButtons();
  openStoryMenu();
  openTowerMenu();
  openFreeMenu();
  showMenu();
  assert.equal(state.towerActive, false, '已退出爬塔');
  assert.ok(!el('main-menu').classList.contains('hidden'), '主菜单已显示');
  assert.ok(el('result-overlay').classList.contains('hidden'), '结果弹窗已清掉');
});

await step('存档写入（爬塔纪录 best/progress）', () => {
  assert.ok(store.has('mg_tower_state'), '爬塔纪录已落盘');
  const saved = JSON.parse(store.get('mg_tower_state'));
  assert.ok(saved.best && typeof saved.best.normal === 'number', 'best 结构正确');
  assert.ok(saved.progress && typeof saved.progress.normal === 'number', 'progress 结构正确');
});

// ======================================================================
console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
process.exit(fail === 0 ? 0 : 1);
