'use strict';

// 端到端 benchmark：本地寻路器的耗时估计 vs 高德真实耗时（calibrate-samples.json）。
// 用法：node benchmark.js
// 跑两版参数：① 当前默认参数；② calibrate.js 锚点法校准后的参数。

const router = require('./shared/router.js');

const data = require('./data/beijing-transit.json');
const samples = require('./data/calibrate-samples.json').samples;

function median(arr) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}
function mean(arr) {
  if (!arr.length) return NaN;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// 按公交快车/慢车巡航速度重算每线的 busVmaxKmh（默认 express=36.45, local=16）
function applyBusCaps(graph, expressKmh, localKmh) {
  for (const l of graph.lineById.values()) {
    if (l.mode !== 'bus') continue;
    const ds = l.stops.map((s) => s.d).filter((x) => typeof x === 'number' && x > 0);
    const avg = ds.length ? ds.reduce((a, b) => a + b, 0) / ds.length : 0;
    const t = Math.max(0, Math.min(1, (avg - 0.5) / (2.0 - 0.5)));
    l.busVmaxKmh = localKmh + t * (expressKmh - localKmh);
  }
}

async function runConfig(name, cfg) {
  const graph = router.buildGraph(data.lines);
  if (cfg.busExpress != null) applyBusCaps(graph, cfg.busExpress, cfg.busLocal);

  const walkFn = (a, b) => {
    const distM = router.haversineKm(a, b) * 1000;
    return Promise.resolve({ dist: distM, min: distM / cfg.walkMperMin });
  };
  const opts = cfg.metro != null ? { metroSpeedKmh: cfg.metro } : {};

  const errors = [];
  let routed = 0;
  for (const s of samples) {
    const t = s.resp && s.resp.route && s.resp.route.transits ? s.resp.route.transits[0] : null;
    if (!t || t.duration == null) continue;
    const gt = Number(t.duration) / 60;
    let r = null;
    try { r = await router.findOptimalRoute(graph, s.origin, s.dest, opts, walkFn); } catch (e) {}
    if (!r || r.totalMin == null) continue;
    routed++;
    const local = r.totalMin;
    errors.push({ gt, local, abs: local - gt, rel: Math.abs(local - gt) / gt });
  }

  console.log('\n===== ' + name + '（N=' + errors.length + '，找到路线 ' + routed + '/' + samples.length + '） =====');
  if (!errors.length) return;
  const rels = errors.map((e) => e.rel);
  const absMin = errors.map((e) => Math.abs(e.abs));
  console.log('MAPE（平均绝对百分比误差）: ' + (mean(rels) * 100).toFixed(2) + ' %');
  console.log('中位相对误差              : ' + (median(rels) * 100).toFixed(2) + ' %');
  console.log('平均绝对误差              : ' + mean(absMin).toFixed(2) + ' min');
  console.log('中位绝对误差              : ' + median(absMin).toFixed(2) + ' min');
  console.log('RMSE                      : ' + Math.sqrt(mean(errors.map((e) => e.abs * e.abs))).toFixed(2) + ' min');
  console.log('平均偏差（本地-高德）     : ' + mean(errors.map((e) => e.abs)).toFixed(2) + ' min（正=高估，负=低估）');
  console.log('高德均值/中位             : ' + mean(errors.map((e) => e.gt)).toFixed(1) + ' / ' + median(errors.map((e) => e.gt)).toFixed(1) + ' min');
  console.log('本地均值/中位             : ' + mean(errors.map((e) => e.local)).toFixed(1) + ' / ' + median(errors.map((e) => e.local)).toFixed(1) + ' min');
  const buckets = [0.05, 0.1, 0.15, 0.2, 0.3, 0.5, Infinity];
  const labels = ['≤5%', '≤10%', '≤15%', '≤20%', '≤30%', '≤50%', '>50%'];
  let prev = 0;
  let dist = [];
  for (let i = 0; i < buckets.length; i++) { const c = rels.filter((r) => r <= buckets[i]).length; dist.push(c - prev); prev = c; }
  console.log('相对误差分布: ' + labels.map((lb, i) => lb + ' ' + (100 * dist[i] / errors.length).toFixed(0) + '%').join('  '));
}

async function main() {
  let rawRecords = 0;
  for (const l of data.lines) rawRecords += (l.stops || []).length;
  const t0 = Date.now();
  const graph = router.buildGraph(data.lines);
  console.log('===== 站点数 =====');
  console.log('线路数                  : ' + data.count);
  console.log('站-线记录（去重前）     : ' + rawRecords);
  console.log('物理站（去重后，融合前）: ' + graph.physById.size);
  console.log('逻辑站（融合后）        : ' + graph.logicalById.size);
  console.log('建图耗时                : ' + (Date.now() - t0) + ' ms');
  console.log('样本总数                : ' + samples.length);

  // ① 当前默认参数（生产）
  await runConfig('① 当前默认参数', { walkMperMin: 75 });

  // ② calibrate.js 锚点法校准值（地铁 35.4 / 公交长段 21.1 / 步行 64.7）
  await runConfig('② 校准参数（锚点法）', { walkMperMin: 64.7, metro: 35.4, busExpress: 21.1, busLocal: 16 });
}

main().catch((e) => { console.error(e); process.exit(1); });
