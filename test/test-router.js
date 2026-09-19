'use strict';

// 本地寻路器测试脚本（Node）
// 用法：node test/test-router.js
// 用直线距离×步行速度模拟步行时间，验证寻路算法本身。

const router = require('../js/router.js');

const data = require('../data/beijing-transit.json');

const ORIGIN = [116.3971, 39.9163]; // 故宫
const DEST = [116.4615, 39.9095];   // 国贸

// 直线距离 / 4.5 km/h 的步行估算（真实运行时替换为高德步行导航）
function straightWalkFn(a, b) {
  const km = router.haversineKm(a, b);
  return Promise.resolve({ dist: km * 1000, min: (km / 4.5) * 60 });
}

function fmtMin(min) {
  const m = Math.round(min);
  return m + ' 分钟';
}

function printRoute(label, r) {
  console.log('===== ' + label + ' =====');
  if (!r) { console.log('  无可行路线'); return; }
  console.log('  上车站：' + r.board.name + '（' + r.board.mode + '）');
  console.log('  下车站：' + r.alight.name + '（' + r.alight.mode + '）');
  console.log('  步行去站 ' + fmtMin(r.walkToMin) + '，步行到终点 ' + fmtMin(r.walkFromMin));
  for (const leg of r.legs) {
    if (leg.type === 'transfer') {
      console.log('    ↪ 换乘：' + leg.fromLineName + ' → ' + leg.toLineName + '（@' + leg.stopName + '）');
    } else {
      console.log('    🚌 ' + leg.lineName + '（' + leg.mode + '）：' + leg.fromName + ' → ' + leg.toName +
        '，' + leg.stops + ' 站 / ' + leg.distanceKm.toFixed(1) + ' km，等车' + fmtMin(leg.waitMin) + ' + 乘车' + fmtMin(leg.rideMin));
    }
  }
  console.log('  换乘次数：' + r.transferCount);
  console.log('  总耗时约 ' + fmtMin(r.totalMin));
}

async function main() {
  console.log('数据：' + data.count + ' 条线路，构建图…');
  const t0 = Date.now();
  const graph = router.buildGraph(data.lines);
  console.log('建图完成：逻辑站 ' + graph.logicalById.size + ' / 物理站 ' + graph.physById.size + '（' + (Date.now() - t0) + ' ms）');

  const t1 = Date.now();
  const r1 = await router.findOptimalRoute(graph, ORIGIN, DEST, {}, straightWalkFn);
  console.log('寻路耗时 ' + (Date.now() - t1) + ' ms');
  printRoute('正常模式（故宫 → 国贸）', r1);

  console.log('');
  const t2 = Date.now();
  const r2 = await router.findOptimalRoute(graph, ORIGIN, DEST, { allowMetro: false }, straightWalkFn);
  console.log('寻路耗时 ' + (Date.now() - t2) + ' ms');
  printRoute('禁用地铁模式（故宫 → 国贸）', r2);
}

main().catch((e) => { console.error(e); process.exit(1); });
