import assert from 'node:assert/strict';
import { installAllStubs, elements, created } from './stubs.mjs';
import fs from 'node:fs';
import vm from 'node:vm';

installAllStubs();

const { state } = await import('../frontend/js/core/state.js');
const { initMap, drawEndpoints } = await import('../frontend/js/map/map-init.js');
const { walkRangeBounds } = await import('../frontend/js/map/walk-range.js');
const { ensureGameDataReady } = await import('../frontend/js/game/data-ready.js');

// 回归：地图 SDK 尚未完成时点开体积很小的文山教学关，不能对 null 地图调用 on。
let settled = false;
const loading = ensureGameDataReady('wenshan').then((ready) => { settled = true; return ready; });
await Promise.resolve();
assert.equal(settled, false, '等待地图初始化后再渲染站点');
assert.equal(state.map, null);

initMap();
assert.equal(await loading, true);
assert.equal(state.loadedCityId, 'wenshan');
assert.equal(state.physStops.length, 9);
assert.ok(elements.get('error')?.classList.contains('hidden') ?? true);

console.log('地图初始化前进入教学关：通过');

state.ORIGIN = [105.05, 24.05];
state.DEST = [105.08, 24.08];
let focused, completed = 0;
state.map.setBounds = (bounds) => { focused = bounds; };
drawEndpoints({ onDestClick: () => completed++ });
const originPin = state.endpointOverlays.find(o => o.__opts?.content?.includes('pin origin'));
const destPin = state.endpointOverlays.find(o => o.__opts?.content?.includes('pin dest'));
for (const [pin, center] of [[originPin, state.ORIGIN], [destPin, state.DEST]]) {
  pin.__ev.click[0]();
  const circleBounds = walkRangeBounds([center]);
  const sw = focused.getSouthWest(), ne = focused.getNorthEast();
  const targetBounds = walkRangeBounds([center], 1650);
  assert.deepEqual([sw.getLng(), sw.getLat()], targetBounds.sw, '圈外留出150米，不额外加像素边距');
  assert.deepEqual([ne.getLng(), ne.getLat()], targetBounds.ne);
  assert.ok(sw.getLng() < circleBounds.sw[0] && ne.getLng() > circleBounds.ne[0]);
  assert.ok(sw.getLat() < circleBounds.sw[1] && ne.getLat() > circleBounds.ne[1]);
  assert.ok(Math.abs((sw.getLng() + ne.getLng()) / 2 - center[0]) < 1e-9);
}
assert.equal(completed, 1, '终点聚焦后仍执行原有操作');
const beforeLock = focused;
state.storyActive = true;
originPin.__ev.click[0]();
destPin.__ev.click[0]();
assert.equal(focused, beforeLock, '欢迎说明期间不改变地图');
assert.equal(completed, 1);
console.log('起终点点击聚焦：通过');

state.storyActive = false;
const visibleBounds = walkRangeBounds([state.ORIGIN], 1650);
state.map.getBounds = () => new AMap.Bounds(visibleBounds.sw, visibleBounds.ne);
const zoomTo = (z) => { state.map.setZoom(z); for (const handler of state.map.__ev.zoomchange || []) handler({}); };
const redBusShown = () => created.massMarks.some(m => m.shown && m.data.some(p => p.style === 2));
// 普通模式：公交站仍要放大到 15 级才显示（控制大城市的点密度）
state.currentLevel = { id: 'random' };
zoomTo(13);
assert.ok(!redBusShown(), '普通模式 13 级不显示公交站');
zoomTo(15);
assert.ok(redBusShown(), '普通模式 15 级显示公交站');
// 新手教程：点起点聚焦步行圈约为 13.x 级，教程内放宽到 13 级即显示
zoomTo(11);
state.currentLevel = { id: 'guided_intro', mapTutorial: { mapPractice: true } };
zoomTo(13);
assert.ok(redBusShown(), '新手教程在步行圈聚焦尺度显示红色公交站');
state.currentLevel = null;

// 在兼容层验证真实聚焦入口：只启动一次，手动输入或动画结束后不再控制视野。
const events = {}, motions = { stops: 0, flights: 0, wheelEnabled: 0 };
const leaflet = {
  options: {},
  getContainer: () => ({ addEventListener: (name, fn) => { events[name] = fn; } }),
  on: (name, fn) => { events[name] = fn; },
  stop: () => { motions.stops++; },
  flyToBounds: (_bounds, options) => { motions.flights++; motions.framing = options; },
  scrollWheelZoom: { enable: () => { motions.wheelEnabled++; } },
};
const context = vm.createContext({ window: {}, L: {
  map: () => leaflet, tileLayer: () => ({ addTo() {} }),
  point: (x, y) => ({ x, y }),
} });
vm.runInContext(fs.readFileSync(new URL('../frontend/js/amap-polyfill.js', import.meta.url), 'utf8'), context);
const map = new context.window.AMap.Map('map');
const target = new context.window.AMap.Bounds([82, 44], [82.1, 44.1]);
map.enableNativeWheelZoom();
assert.equal(motions.wheelEnabled, 1);
let focusCompleted = 0;
map.focusBounds(target, [54, 0, 0, 0], () => focusCompleted++);
assert.equal(motions.framing.paddingTopLeft.y, 54, '聚焦排除顶部栏，让圆圈居中于可见区域');
assert.equal(motions.framing.paddingBottomRight.y, 0);
assert.equal(motions.flights, 1);
events.wheel();
assert.equal(focusCompleted, 0, '手动中断不会报告聚焦完成');
assert.equal(map._focusing, false, '滚轮立即接管聚焦');
const stopped = motions.stops;
events.pointerdown();
events.wheel();
assert.equal(motions.stops, stopped, '取消后不反复停止后续手动操作');
assert.equal(motions.flights, 1, '手动输入不会重新聚焦');
map.focusBounds(target, [0, 0, 0, 0], () => focusCompleted++);
assert.equal(focusCompleted, 0, '动画结束前不推进教程');
events.moveend();
assert.equal(focusCompleted, 1, '动画完成时推进一次');
events.moveend();
assert.equal(focusCompleted, 1, '后续平移不重复完成教学步骤');
events.pointerdown();
assert.equal(map._focusing, false, '动画完成清除聚焦状态');
console.log('聚焦取消与站点显示：通过');
