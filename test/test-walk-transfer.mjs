/**
 * test/test-walk-transfer.mjs —— 步行换乘专项验证（无浏览器，Node 直接跑）
 *
 * 验证 computeTotalMinutes 对 routeRides 里的 null（步行换乘段）正确按步行速度计时，
 * 且不计固定换乘惩罚；步行时间随情景 walkSpeedFactor 缩放。
 */

import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.window = globalThis;
globalThis.window.TransitRouter = require('../shared/router.js');
globalThis.document = { getElementById: () => null, createElement: () => ({}), head: {}, body: {}, querySelectorAll: () => [], addEventListener() {} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };

const { state } = await import('../frontend/js/core/state.js');
const { computeTotalMinutes } = await import('../frontend/js/game/time-model.js');
const { haversineKm } = await import('../frontend/js/core/router-api.js');

const S1 = { logical: { id: 'a', name: '甲站' }, point: [116.4000, 39.9000] };
const S2 = { logical: { id: 'b', name: '乙站' }, point: [116.4000, 39.9067] }; // 约 745m 北
const S3 = { logical: { id: 'c', name: '丙站' }, point: [116.4050, 39.9067] }; // 约 425m 东

// 乘车段用空 stops 的假线路：rideStats 返回 null → estimateRideMinutes 走兜底
//（地铁 2.5 分 / 公交 2.0 分），让测试聚焦在步行段计时。
const metroLine = { id: 'm1', mode: 'metro', name: '地铁X', stops: [] };
const busLine = { id: 'b1', mode: 'bus', name: '公交Y', stops: [] };

const walkMin = (a, b, factor) => (haversineKm(a.point, b.point) * 1000) / (75 * factor);

// ---- 组 A：乘车 + 步行换乘 + 终点步行 ----
state.scenario = { noMetro: false, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 };
state.walkToFirstMin = 2;
state.walkToDestMin = 3;
state.finished = true;
state.routeStops = [S1, S2, S3];
state.routeRides = [metroLine, null]; // 甲 --乘车--> 乙 --步行--> 丙
const tA = computeTotalMinutes();
const expA = 2 + 2.5 + 2.5 + walkMin(S2, S3, 1) + 3; // 等车2.5 + 乘车兜底2.5 + 步行
assert.ok(Math.abs(tA - expA) < 0.01, `组A 期望 ${expA.toFixed(2)} 实得 ${tA.toFixed(2)}`);
console.log('  ✓ 组A（乘车→步行换乘→终点）总时间 =', tA.toFixed(2));

// ---- 组 B：步行换乘在第一段（甲 --步行--> 乙 --乘车--> 丙）----
state.routeStops = [S1, S2, S3];
state.routeRides = [null, busLine];
const tB = computeTotalMinutes();
const expB = 2 + walkMin(S1, S2, 1) + 5 + 2.0 + 3; // 步行 + 等车5 + 乘车兜底2.0
assert.ok(Math.abs(tB - expB) < 0.01, `组B 期望 ${expB.toFixed(2)} 实得 ${tB.toFixed(2)}`);
console.log('  ✓ 组B（步行换乘→乘车）总时间 =', tB.toFixed(2));

// ---- 组 C：情景 walkSpeedFactor 影响步行换乘（大雨 0.5 → 时间翻倍）----
state.scenario = { noMetro: false, busSpeedFactor: 1.0, walkSpeedFactor: 0.5 };
state.routeStops = [S1, S2];
state.routeRides = [null];
state.finished = false;
state.walkToFirstMin = 0;
state.walkToDestMin = 0;
const tC = computeTotalMinutes();
const expC = walkMin(S1, S2, 0.5); // 步行时间 = 距离 / (75*0.5)
assert.ok(Math.abs(tC - expC) < 0.01, `组C 期望 ${expC.toFixed(2)} 实得 ${tC.toFixed(2)}`);
console.log('  ✓ 组C（大雨 walkSpeedFactor=0.5）步行换乘时间 =', tC.toFixed(2));

console.log('\n=== 步行换乘时间模型：全部通过 ===');
