// 禁止步行过江：shared/rivers.js 的判断与截断、寻路器跳过过江的上下车站（真实数据：武汉长江 / 汉江）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const rivers = require('../shared/rivers.js');
const router = require('../shared/router.js');
const read = (p) => JSON.parse(readFileSync(new URL(p, import.meta.url)));

const index = rivers.buildRiverIndex(read('../data/rivers/wuhan.json'));
assert.ok(index, '武汉有江河数据');
assert.equal(rivers.buildRiverIndex(null), null, '没有江河数据的城市返回 null');

const HANKOU = [114.288, 30.585];       // 江汉路一带
const WUCHANG = [114.305, 30.548];      // 黄鹤楼一带
const HANYANG = [114.265, 30.555];      // 汉阳
assert.equal(rivers.crossesRiver(index, HANKOU, WUCHANG), true, '汉口 → 武昌 要过长江');
assert.equal(rivers.crossesRiver(index, HANKOU, [114.27, 30.59]), false, '汉口内部步行不过江');
assert.equal(rivers.crossesRiver(index, HANYANG, [114.268, 30.58]), true, '汉阳 → 汉口 要过汉江');

// 江边的步行圈被截断：所有顶点与圆心在同一岸，且确实有顶点被截短
const center = [114.294223, 30.569097]; // 沿江大道王家巷站，长江北岸，离中心线约 425m
const ring = rivers.clipWalkRange(index, center, 1500);
assert.ok(ring && ring.length === 180, '江边的步行圈返回截断后的多边形');
assert.ok(ring.every((p) => !rivers.crossesRiver(index, center, [center[0] + (p[0] - center[0]) * 0.999, center[1] + (p[1] - center[1]) * 0.999])), '截断后的范围都在同一岸');
const dist = (a, b) => router.haversineKm(a, b) * 1000;
assert.ok(ring.some((p) => dist(center, p) < 600), '朝江的方向被截短到江心');
assert.equal(rivers.clipWalkRange(index, [114.42, 30.48], 1500), null, '远离江的地方照常画圆');

// 寻路器：挂上过江判断后，起点附近江对岸的站不会被选为上车站
const data = require('../shared/transit-format.js').decode(read('../data/wuhan-transit.json'));
const graph = router.buildGraph(data.lines);
graph.rivers = { crosses: (a, b) => rivers.crossesRiver(index, a, b) };
const walk = async (a, b) => ({ min: dist(a, b) / 75 });
const best = await router.findOptimalRoute(graph, center, [114.2, 30.62], { allowMetro: true }, walk);
assert.ok(best, '江边起点仍能找到路线');
const boardPoint = [best.board.lng, best.board.lat];
assert.equal(rivers.crossesRiver(index, center, boardPoint), false, '上车站与起点在同一岸');

console.log('\n=== 禁止步行过江：通过 ===\n');
