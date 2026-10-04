import assert from 'node:assert/strict';
import { installWindowsAmapWheel } from '../frontend/js/map/amap-wheel.js';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const timers = new Map();
let sequence = 0;
globalThis.setTimeout = (fn) => { timers.set(++sequence, fn); return sequence; };
globalThis.clearTimeout = (id) => timers.delete(id);
try {
  const handlers = new Map();
  const element = {
    clientHeight: 800,
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type) { handlers.delete(type); },
  };
  const calls = [];
  const map = { getZoom: () => 11, getZooms: () => [3, 19], setZoom: (...args) => calls.push(args) };
  for (const platform of ['MacIntel', 'iPhone', 'Linux armv8l']) {
    installWindowsAmapWheel(map, element, { platform });
    assert.equal(handlers.size, 0, `${platform} must keep native input`);
  }
  let locked = false;
  const dispose = installWindowsAmapWheel(map, element, { platform: 'Win32', isLocked: () => locked });
  function wheel(overrides = {}) {
    let consumed = false;
    handlers.get('wheel')({ deltaY: -120, deltaMode: 0, preventDefault() { consumed = true; }, stopImmediatePropagation() {}, ...overrides });
    return consumed;
  }
  const flush = () => { const pending = [...timers.values()]; timers.clear(); pending.forEach(fn => fn()); };
  assert.equal(wheel({ ctrlKey: true }), false, 'pinch/browser zoom stays native');
  assert.equal(wheel({ metaKey: true }), false);
  assert.equal(timers.size, 0);
  for (let i = 0; i < 10; i++) wheel({ deltaY: -12 });
  assert.equal(timers.size, 1, 'high frequency input must be coalesced');
  flush();
  assert.ok(Math.abs(calls[0][0] - 11.4) < 1e-9, 'small inputs accumulate without increasing total travel');
  assert.deepEqual(calls[0].slice(1), [false, 320], 'one SDK animation per input batch');
  handlers.get('pointerdown')();
  wheel({ deltaY: -3, deltaMode: 1 });
  flush();
  assert.ok(Math.abs(calls[1][0] - 11.16) < 1e-9, 'line deltas normalize to pixels');
  wheel();
  locked = true;
  flush();
  assert.equal(calls.length, 2, 'locking cancels queued zoom');
  locked = false;
  for (let i = 0; i < 100; i++) wheel();
  flush();
  assert.equal(calls.at(-1)[0], 19, 'respect map zoom limits');
  wheel();
  dispose();
  assert.equal(timers.size, 0);
  assert.equal(handlers.size, 0);
  console.log('Windows AMap wheel: batching, animation, units, limits, locks, cleanup and platform isolation passed');
} finally {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
}
