// 原生高德拾取（frontend/js/map/native-picker.js）：用最小的“原生高德”桩验证按像素距离拾取站点与线路。
// 桩地图把经纬度直接当作屏幕像素（lngLatToContainer 为恒等），便于构造距离。
import assert from 'node:assert/strict';

let pass = 0, fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.log('  ✗ ' + name + '\n      ' + e.message); }
}

globalThis.window = globalThis;
globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
class Overlay { constructor(o) { this.opts = o; this.map = null; } setMap(m) { this.map = m; } }
class MassMarks { constructor(d, o) { this.data = d; this.opts = o; this.map = null; } setMap(m) { this.map = m; } setData(d) { this.data = d; } show() {} hide() {} on() { throw new Error('原生高德事件不应被注册'); } }
class LngLat { constructor(lng, lat) { this.lng = lng; this.lat = lat; } }
globalThis.AMap = { Polyline: Overlay, Circle: Overlay, MassMarks, LngLat }; // 没有 __polyfill：视为原生高德

const { state } = await import('../frontend/js/core/state.js');
const picker = await import('../frontend/js/map/native-picker.js');

const listeners = {};
const domListeners = {};
const container = {
  addEventListener(type, cb) { (domListeners[type] = domListeners[type] || []).push(cb); },
  getBoundingClientRect() { return { left: 0, top: 0 }; },
};
const map = {
  on(type, cb) { (listeners[type] = listeners[type] || []).push(cb); },
  lngLatToContainer(ll) { assert.ok(ll instanceof LngLat, '应传入 AMap.LngLat'); return { x: ll.lng, y: ll.lat }; },
  setDefaultCursor() {},
  getContainer() { return container; },
};
const click = (x, y) => {
  const ev = { clientX: x, clientY: y, isPrimary: true };
  domListeners.pointerdown.forEach((cb) => cb(ev));
  domListeners.pointerup.forEach((cb) => cb(ev));
};
const move = (x, y) => domListeners.mousemove.forEach((cb) => cb({ clientX: x, clientY: y }));
const tick = () => new Promise((r) => setTimeout(r, 5));

state.isTouch = false;
picker.installNativePicker(map);

await check('折线与圆被改为事件冒泡到地图（不再拦截站点点击）', () => {
  const line = new AMap.Polyline({ path: [] });
  assert.equal(line.opts.bubble, true);
  assert.ok(line instanceof AMap.Polyline, '包装后 instanceof 仍成立（anim.js 依赖它判断覆盖物类型）');
  assert.equal(new AMap.Circle({}).opts.bubble, true);
});

const base = picker.makeMassMarksPickable(new MassMarks([], {}), [{ lnglat: [100, 100], id: 'base' }], 110);
const top = picker.makeMassMarksPickable(new MassMarks([], {}), [{ lnglat: [104, 100], id: 'top' }], 220);
const clicks = [];
base.on('click', (e) => clicks.push(e.data.id));
top.on('click', (e) => clicks.push(e.data.id));
base.setMap(map); top.setMap(map);

await check('命中半径（桌面 14px）内取最近站点，高层级图层优先', () => {
  clicks.length = 0;
  click(101, 100);             // 两层都在范围内：高层级（220）胜出
  assert.deepEqual(clicks, ['top']);
  click(101, 100);
  assert.ok(picker.clickWasPicked({}), '命中站点后紧随的地图 click 不能再被当作点空白取消');
  clicks.length = 1;
  top.hide(); clicks.length = 0;
  click(101, 100);             // 高层隐藏后落到底层
  assert.deepEqual(clicks, ['base']);
  top.show();
});

await check('超出命中半径不触发；触屏半径 22px', () => {
  clicks.length = 0;
  top.hide();
  click(100, 118);
  assert.deepEqual(clicks, []);
  state.isTouch = true;
  try {
    click(100, 118);
    assert.deepEqual(clicks, ['base']);
  } finally {
    state.isTouch = false;
    top.show();
  }
});

await check('没有站点时按像素距离拾取候选线路热区', () => {
  const hits = [];
  const hitArea = new AMap.Polyline({ path: [[0, 300], [400, 300]] });
  hitArea.setMap(map);
  picker.registerPickableLine(hitArea, [[0, 300], [400, 300]], 16, () => hits.push('line'));
  click(200, 306);             // 距线 6px < 宽度一半 8px
  click(200, 320);             // 20px：不命中
  assert.deepEqual(hits, ['line']);
  hitArea.setMap(null);        // 从地图移除后不再拾取
  click(200, 306);
  assert.deepEqual(hits, ['line']);
});

await check('悬停进出站点触发 mouseover / mouseout', async () => {
  const events = [];
  base.on('mouseover', () => events.push('over'));
  base.on('mouseout', () => events.push('out'));
  top.hide();
  move(100, 101); await tick();
  move(150, 150); await tick();
  assert.deepEqual(events, ['over', 'out']);
});

console.log(`\n=== 结果：${pass} 通过 / ${fail} 失败 ===\n`);
if (fail) process.exit(1);
