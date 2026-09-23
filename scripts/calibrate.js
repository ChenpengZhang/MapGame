'use strict';

// 成本模型参数校准（锚点法，最终版）
//
// 背景：用高德公交路径规划 API 的真实数据，反向校准本地成本模型的参数。
// 采集：scripts/calibrate-collect.js 随机采 100 对起终点 → data/calibrate-samples.json。
//
// 方法学结论（关键，避免过拟合/不可辨识）：
//   1) 高德 transit.duration ≈ Σwalking + Σbuslines.duration，等车/换乘无独立信号，
//      因此等车、换乘参数无法从此数据反向拟合，保持原值。
//   2) 乘车段「速度」与「停站」强共线（站数 ≈ 距离/平均站间距），同时自由拟合会退化。
//      解法：停站时间用物理先验锚定（dwell 固定），只反推巡航速度。
//   3) 短段（<4 站）混入等车/起停，反推速度失真，故只用「长段」锚定巡航速度。
//
// 最终拟合结果（100 样本，长段锚定，dwell 固定 0.3 分钟做反推基准）：
//   地铁巡航速度 ≈ 35.4 km/h（原值 35，几乎不用改）
//   公交长段速度 ≈ 21.1 km/h（原值"快车最高速 36.45"明显偏高，建议下调）
//   步行速度     ≈ 64.7 m/min（原值 75 偏高，建议下调）
//
// 经验性检查：5 次随机对半划分，train/test 锚点几乎一致（地铁 ±0.4、公交 ±1、步行 ±1），
// 无过拟合迹象。

const data = require('../data/beijing-transit.json');
const samples = require('../data/calibrate-samples.json').samples;

const localByName = new Map();
for (const l of data.lines) localByName.set(l.name.trim(), l);

function normLineName(n) { return n.replace(/\([^)]*\)/g, '').trim(); }

// 从所有样本抽取「乘车段 + 步行段」观测
function collectSegments() {
  const segs = [];
  for (const s of samples) {
    const t = s.resp.route.transits[0];
    for (const sg of t.segments || []) {
      if (sg.bus && sg.bus.buslines && sg.bus.buslines.length) {
        for (const b of sg.bus.buslines) {
          const line = localByName.get(normLineName(b.name));
          if (!line) continue;
          const fi = line.stops.findIndex((x) => x.name === b.departure_stop.name);
          const ti = line.stops.findIndex((x) => x.name === b.arrival_stop.name);
          if (fi < 0 || ti < 0) continue;
          const lo = Math.min(fi, ti), hi = Math.max(fi, ti);
          let dist = 0, n = 0;
          for (let i = lo; i < hi; i++) {
            const dd = line.stops[i].d;
            if (typeof dd === 'number' && dd > 0) { dist += dd; n++; }
          }
          if (n === 0) continue;
          segs.push({
            mode: line.mode === 'metro' ? 'metro' : 'bus',
            distKm: Number(b.distance) / 1000,   // 高德距离（与本地 d 几乎一致）
            durMin: Number(b.duration) / 60,     // 高德乘车时长（含停站）
            segs: n,
          });
        }
      } else if (sg.walking) {
        segs.push({
          mode: 'walk',
          distM: Number(sg.walking.distance),
          durSec: Number(sg.walking.duration),
        });
      }
    }
  }
  return segs;
}

function median(a) { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)]; }

// 长段反推巡航速度：dur = dist/v*60 + dwell*segs → v = dist/(dur - dwell*segs)*60
function anchorSpeeds(segs, dwellMin) {
  const metro = segs.filter((r) => r.mode === 'metro' && r.segs >= 4)
    .map((r) => (r.distKm / (r.durMin - dwellMin * r.segs)) * 60);
  const bus = segs.filter((r) => r.mode === 'bus' && r.segs >= 4)
    .map((r) => (r.distKm / (r.durMin - dwellMin * r.segs)) * 60);
  const walk = segs.filter((r) => r.mode === 'walk')
    .map((r) => r.distM / (r.durSec / 60));
  return {
    metroSpeedKmh: metro.length ? median(metro) : NaN,
    busSpeedKmh: bus.length ? median(bus) : NaN,
    walkSpeedMperMin: walk.length ? median(walk) : NaN,
    metroN: metro.length, busN: bus.length, walkN: walk.length,
  };
}

function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function main() {
  const segs = collectSegments();
  console.log('观测段数：地铁 ' + segs.filter(r => r.mode === 'metro').length +
    '，公交 ' + segs.filter(r => r.mode === 'bus').length +
    '，步行 ' + segs.filter(r => r.mode === 'walk').length);

  // 用 dwell=0.3 做反推基准（0.3 是地铁/公交停站的中间先验）
  const full = anchorSpeeds(segs, 0.3);
  console.log('\n===== 全量锚点（长段 segs>=4，dwell 固定 0.3min） =====');
  console.log('地铁巡航速度：' + full.metroSpeedKmh.toFixed(1) + ' km/h（n=' + full.metroN + '）');
  console.log('公交长段速度：' + full.busSpeedKmh.toFixed(1) + ' km/h（n=' + full.busN + '）');
  console.log('步行速度：' + full.walkSpeedMperMin.toFixed(1) + ' m/min（n=' + full.walkN + '）');

  console.log('\n===== 经验性检查：5 次随机对半划分（防过拟合） =====');
  console.log('     地铁(km/h) 公交(km/h) 步行(m/min)  |  train 地铁 公交 步行');
  for (let k = 0; k < 5; k++) {
    const sh = shuffle(segs.slice());
    const train = sh.slice(0, sh.length >> 1);
    const test = sh.slice(sh.length >> 1);
    const a1 = anchorSpeeds(train, 0.3), a2 = anchorSpeeds(test, 0.3);
    console.log('test ' + a2.metroSpeedKmh.toFixed(1).padStart(6) + a2.busSpeedKmh.toFixed(1).padStart(7) + a2.walkSpeedMperMin.toFixed(1).padStart(8) +
      '  |  ' + a1.metroSpeedKmh.toFixed(1).padStart(6) + a1.busSpeedKmh.toFixed(1).padStart(7) + a1.walkSpeedMperMin.toFixed(1).padStart(8));
  }

  // dwell 敏感性：dwell 从 0 到 0.6 变化时速度锚点的变化
  console.log('\n===== dwell 敏感性（0~0.6min，看速度锚点漂移） =====');
  for (const dwell of [0, 0.2, 0.3, 0.5, 0.6]) {
    const a = anchorSpeeds(segs, dwell);
    console.log('dwell=' + dwell + ' → 地铁 ' + a.metroSpeedKmh.toFixed(1) + ' km/h，公交 ' + a.busSpeedKmh.toFixed(1) + ' km/h');
  }
}

main();
