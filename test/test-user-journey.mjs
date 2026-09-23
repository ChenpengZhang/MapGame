// 完整用户旅程测试：从进入界面 → 选故事关卡 → 过剧情/教学 → 规划路线 → 结算 →
// 下一关 → 退出回主菜单，全程走真实 handler，模拟一个用户的完整操作流。
//
// 用法：node test/test-user-journey.mjs

import assert from 'node:assert/strict';
import { installAllStubs, elements, created, store } from './stubs.mjs';

installAllStubs({ useFull: true }); // 全量 beijing-transit.json（故事关卡坐标都在北京，需真实站点）

const { state } = await import('../frontend/js/core/state.js');
const { buildGraph } = await import('../frontend/js/core/router-api.js');
const { loadTransitData } = await import('../frontend/js/data/loader.js');
const { buildIndex } = await import('../frontend/js/data/index-builder.js');
const { LEVELS } = await import('../frontend/js/data/levels.js');
const { stopToData } = await import('../frontend/js/map/stop-marks.js');
const { initMap } = await import('../frontend/js/map/map-init.js');
const { renderMetroContext, renderStops } = await import('../frontend/js/map/stop-layer.js');
const { onStopMouseOver, onStopMouseOut } = await import('../frontend/js/map/hover.js');
const { onStopClick, onCandidateStopClick, finishRoute } = await import('../frontend/js/game/route.js');
const { startLevel, showMenu, openStoryMenu, openTowerMenu } = await import('../frontend/js/game/session.js');
const { nextLevel, restartLevel } = await import('../frontend/js/game/flow.js');
const { openFreeMenu } = await import('../frontend/js/game/free.js');
const { storyNext, tutorialNext } = await import('../frontend/js/ui/story.js');
const app = await import('../frontend/js/app.js'); // 入口（bootstrap：桩件里 loadScript 永不回调，属预期）

const el = (id) => elements.get(id);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.error('  \u2717 ' + name + '\n      ' + (e && e.message)); fail++; }
}

console.log('\n=== 完整用户旅程测试（进入 → 选关 → 游玩 → 退出）===\n');

// ============ 1. 进入界面 + 数据就绪 ============
await step('进入界面：加载数据、建索引、铺地图、显示主菜单', async () => {
  const { data } = await loadTransitData();
  const graph = buildGraph(data.lines);
  buildIndex(data, graph);
  assert.equal(state.routerGraph, graph, '前端索引与最优路线共用同一份寻路图');
  initMap();
  renderMetroContext();
  renderStops({ onClick: onStopClick, onMouseOver: onStopMouseOver, onMouseOut: onStopMouseOut });
  assert.ok(state.map, '地图已创建');
  assert.ok(state.physStops.length > 0, '物理站已建立');
  assert.ok(!el('main-menu').classList.contains('hidden'), '主菜单已显示');
});

// ============ 2. 选故事关卡 ============
await step('选择故事模式 → 选第 1 关', () => {
  openStoryMenu();
  assert.ok(!el('story-menu').classList.contains('hidden'), '选关菜单已打开');
  const lv = LEVELS[0];
  startLevel(lv);
  assert.equal(state.currentLevel, lv, '已进入第 1 关');
  assert.equal(state.storyActive, true, '剧情期间地图锁定');
  assert.ok(!el('story-dialog').classList.contains('hidden'), '剧情对话框已打开');
});

// ============ 3. 过剧情 + 教学 ============
await step('跳过剧情 → 跳过教学 → 交还操作权', () => {
  const lv = LEVELS[0];
  for (let i = 0; i < lv.story.length; i++) storyNext();
  assert.equal(state.storyActive, false, '剧情结束后解锁地图');
  for (let i = 0; i < 4; i++) tutorialNext();
  assert.ok(el('tutorial-bubble').classList.contains('hidden'), '教学气泡已收起');
  assert.equal(el('tower-layer-label').textContent,'≤ 80 分钟','故事时限已在中央浮层显示');
});

// ============ 4. 规划路线（起点 → 换乘 → 终点）+ 结算 ============
await step('规划路线并结算：选起点 → 换乘 → 点「终」→ 出结算', async () => {
  // 用一条真实线路上的一对站开一关可解的自定义关（故事/教学已在第 1 关验过）
  const line = [...state.linesMap.values()].find((l) => l.mode === 'metro' && l.stops.length > 12);
  assert.ok(line, '找到一条可用的地铁线');
  const physA = state.physStops.find((p) => p.id === String(line.stops[0].id));
  const physB = state.physStops.find((p) => p.id === String(line.stops[10].id));
  assert.ok(physA && physB, '取到线路上的两个站');

  startLevel({
    id: 'journey-play', series: 0, title: '旅程试玩', timeLimitMin: 200,
    origin: { name: physA.name, lng: physA.lng, lat: physA.lat },
    dest: { name: physB.name, lng: physB.lng, lat: physB.lat },
    goalText: '', success: '', fail: '',
  }, { skipStory: true });

  onStopClick({ data: stopToData(physA) });
  assert.equal(state.routeStops.length, 1, '首站已选中');
  assert.ok(state.candidateMarks && state.candidateMarks.data.length > 0, '候选站点已亮出');
  onCandidateStopClick(stopToData(physB));
  assert.ok(state.routeStops.length >= 2, '已换乘到沿途站');

  finishRoute();
  await wait(400); // 等异步的终点步行 + 最优路线计算
  assert.equal(state.finished, true, '规划已完成');
  assert.ok(!el('result-overlay').classList.contains('hidden'), '结算弹窗已弹出');
  assert.ok(/用时/.test(el('result-times').textContent), '结算明细已写入');
  assert.ok(state.optimalResult, '最优路线已算出');
});

// ============ 5. 下一关 ============
await step('进入下一关', () => {
  // 先回到第 1 关（真实关卡），再点「下一关」进第 2 关（试玩关不在关卡列表里，nextLevel 找不到下一关）
  startLevel(LEVELS[0], { skipStory: true });
  nextLevel();
  assert.equal(state.currentLevel, LEVELS[1], '已进入第 2 关');
  assert.equal(state.routeStops.length, 0, '新关卡路线已清空');
  restartLevel();
  assert.equal(state.routeStops.length, 0, '重开后路线仍为空');
});

// ============ 7. 退出回主菜单（清场） ============
await step('退出回主菜单：各模式入口都回来、状态清干净', () => {
  showMenu();
  assert.ok(!el('main-menu').classList.contains('hidden'), '主菜单已显示');
  assert.equal(state.towerActive, false, '退出后爬塔状态复位');
  assert.equal(state.finished, false, '退出后 finished 复位');
  assert.equal(state.routeStops.length, 0, '退出后路线清空');
  // 三个模式入口都能再次打开（无残留弹窗）
  openStoryMenu();
  openTowerMenu();
  openFreeMenu();
  showMenu();
  assert.ok(!el('main-menu').classList.contains('hidden'), '反复进出后主菜单仍正常');
});

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail === 0 ? 0 : 1);
