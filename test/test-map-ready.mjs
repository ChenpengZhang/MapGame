import assert from 'node:assert/strict';
import { installAllStubs, elements } from './stubs.mjs';

installAllStubs();

const { state } = await import('../frontend/js/core/state.js');
const { initMap } = await import('../frontend/js/map/map-init.js');
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
