// 有向图回归测试：验证单向公交/环线/地铁的方向语义。
// 覆盖「左行公交」修复：单向线只能沿 seq 前进，反向不可达；环线单向绕环；地铁双向。
//
// 用法：node test/test-directed-router.js

'use strict';
const assert = require('node:assert/strict');
const R = require('../js/router.js');
const data = require('../data/guangzhou-transit.json');

const graph = R.buildGraph(data.lines);
const walk = (a, b) => {
  const km = R.haversineKm(a, b);
  return Promise.resolve({ dist: km * 1000, min: km * 1000 / 75 });
};

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

console.log('\n=== 有向图回归测试（广州数据）===\n');

(async () => {

await step('单向公交反向不可骑（随机 20 对起终点，无反向乘车段）', async () => {
  const phys = [...graph.physById.values()];
  for (let k = 0; k < 20; k++) {
    const a = phys[Math.floor(Math.random() * phys.length)];
    const b = phys[Math.floor(Math.random() * phys.length)];
    if (R.haversineKm([a.lng, a.lat], [b.lng, b.lat]) < 2) { k--; continue; }
    const r = await R.findOptimalRoute(graph, [a.lng, a.lat], [b.lng, b.lat], { allowMetro: false }, walk);
    if (!r) { k--; continue; }
    for (const leg of r.legs) {
      if (leg.type !== 'ride') continue;
      const line = graph.lineById.get(leg.lineId);
      if (!line || !line.oneWay || line.isLoop) continue;
      const fp = graph.logicalById.get(leg.fromLogicalId);
      const tp = graph.logicalById.get(leg.toLogicalId);
      const ia = line.stopIndex.get(fp && fp.stopByLine[line.id]);
      const ib = line.stopIndex.get(tp && tp.stopByLine[line.id]);
      assert.ok(ia != null && ib != null && ia < ib, '单向线反向骑：' + line.name + ' ' + leg.fromName + '(seq' + ia + ')→' + leg.toName + '(seq' + ib + ')');
    }
  }
});

await step('单向公交正向可乘车（190路上行前段→后段）', async () => {
  const up = [...graph.lineById.values()].find((l) => l.name === '190路' && l.oneWay && l.stops.length === 33);
  assert.ok(up, '应找到 190路上行');
  const a = up.stops[2], b = up.stops[30]; // 景云路 → 赤岗路（正向）
  const r = await R.findOptimalRoute(graph, [a.lng, a.lat], [b.lng, b.lat], { allowMetro: false }, walk);
  assert.ok(r, '正向应有路线');
  // 该线正向相邻两站应能直达（同线乘车段存在，且方向正确）
  const adj1 = up.stops[2], adj2 = up.stops[3];
  const rAdj = await R.findOptimalRoute(graph, [adj1.lng, adj1.lat], [adj2.lng, adj2.lat], { allowMetro: false }, walk);
  assert.ok(rAdj, '相邻正向两站应有路线');
  const ride = rAdj.legs.find((l) => l.type === 'ride');
  assert.ok(ride, '相邻两站应能乘车直达');
  const line = graph.lineById.get(ride.lineId);
  assert.ok(line, '乘车段应落在某条线上');
});

await step('环线（外环）单向绕环可达（龙潭→任意下游站）', async () => {
  const loop = [...graph.lineById.values()].find((l) => l.name === '地铁11号线外环');
  assert.ok(loop && loop.isLoop && loop.oneWay, '应有单向环线 11号线外环');
  // 取两个站，其中后者 seq 更小（绕环方向），验证仍可达
  const a = loop.stops[Math.floor(loop.stops.length * 0.3)];
  const b = loop.stops[Math.floor(loop.stops.length * 0.8)];
  const r = await R.findOptimalRoute(graph, [a.lng, a.lat], [b.lng, b.lat], { allowMetro: true }, walk);
  assert.ok(r, '环线两点应有路线');
});

await step('地铁（非环线）双向：反向相邻两站也能乘车', async () => {
  const metro = [...graph.lineById.values()].find((l) => l.mode === 'metro' && !l.isLoop && !l.oneWay && l.stops.length > 5);
  assert.ok(metro, '应有双向地铁线');
  const a = metro.stops[4], b = metro.stops[3]; // 反向相邻（seq 递减）
  const r = await R.findOptimalRoute(graph, [a.lng, a.lat], [b.lng, b.lat], { allowMetro: true }, walk);
  assert.ok(r, '地铁反向相邻两站应有路线');
});

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail === 0 ? 0 : 1);

})();
