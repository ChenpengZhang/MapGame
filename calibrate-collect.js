'use strict';

// 校准数据采集：随机采样 N 对起终点，调高德公交路径规划 API，存原始 JSON。
//
// 用法：
//   AMAP_WEB_KEY=你的web服务key node calibrate-collect.js [N] [输出文件]
//   （Windows PowerShell: $env:AMAP_WEB_KEY="..."; node calibrate-collect.js）
//
// 说明：
//   - key 只从环境变量读，绝不写进任何文件/代码。
//   - 采样逻辑与游戏一致：随机站点 + 偏移 300~1500m，保证起终点 3~30km。
//   - 输出 data/calibrate-samples.json：{ city, generated_at, samples:[{origin,dest,resp}] }
//   - 断点续采：输出文件已存在则跳过已采的（按 origin,dest 去重），重跑只补缺。

const fs = require('fs');
const path = require('path');

const KEY = process.env.AMAP_WEB_KEY;
if (!KEY) {
  console.error('❌ 请先设置环境变量 AMAP_WEB_KEY（高德「Web服务」类型的 key）');
  process.exit(1);
}

const N = parseInt(process.argv[2], 10) || 100;
const OUT = path.join(__dirname, process.argv[3] || 'data/calibrate-samples.json');
const CITY = '010'; // 北京 citycode

// ---------- 采样工具（与游戏 randomPoint 一致） ----------
const RANDOM_OFFSET_MIN_M = 300;
const RANDOM_OFFSET_MAX_M = 1500;

const data = require('./data/beijing-transit.json');

// 全部物理站点（合并去重后的点）——简化：直接取所有 line.stops 的坐标去重
function buildPointPool() {
  const seen = new Set();
  const pts = [];
  for (const line of data.lines) {
    for (const s of line.stops || []) {
      const key = s.lng.toFixed(5) + ',' + s.lat.toFixed(5);
      if (seen.has(key)) continue;
      seen.add(key);
      pts.push({ lng: Number(s.lng), lat: Number(s.lat) });
    }
  }
  return pts;
}

function haversineKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b[1] - a[1]);
  const dLng = rad(b[0] - a[0]);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[1])) * Math.cos(rad(b[1])) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

function randomPoint(pool) {
  const stop = pool[Math.floor(Math.random() * pool.length)];
  const angle = Math.random() * 2 * Math.PI;
  const dist = RANDOM_OFFSET_MIN_M + Math.random() * (RANDOM_OFFSET_MAX_M - RANDOM_OFFSET_MIN_M);
  const dLat = (dist * Math.cos(angle)) / 111000;
  const dLng = (dist * Math.sin(angle)) / 85000;
  return [Number((stop.lng + dLng).toFixed(6)), Number((stop.lat + dLat).toFixed(6))];
}

function samplePair(pool) {
  for (let i = 0; i < 100; i++) {
    const o = randomPoint(pool);
    const d = randomPoint(pool);
    const km = haversineKm(o, d);
    if (km >= 3 && km <= 30) return { origin: o, dest: d };
  }
  return { origin: randomPoint(pool), dest: randomPoint(pool) };
}

// ---------- 高德调用 ----------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function amapTransit(origin, dest) {
  const url = `https://restapi.amap.com/v3/direction/transit/integrated` +
    `?origin=${origin[0]},${origin[1]}&destination=${dest[0]},${dest[1]}` +
    `&city=${CITY}&key=${KEY}`;
  const res = await fetch(url);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error('非 JSON 响应: ' + text.slice(0, 200)); }
  return json;
}

async function main() {
  const pool = buildPointPool();
  console.log('站点池：' + pool.length + ' 个物理点');

  // 读已有样本做断点续采
  let samples = [];
  const seen = new Set();
  if (fs.existsSync(OUT)) {
    samples = JSON.parse(fs.readFileSync(OUT, 'utf8')).samples || [];
    for (const s of samples) seen.add(s.origin.join(',') + '|' + s.dest.join(','));
    console.log('已有 ' + samples.length + ' 条，续采补齐到 ' + N);
  }

  let ok = 0, fail = 0;
  while (samples.length < N) {
    const { origin, dest } = samplePair(pool);
    const key = origin.join(',') + '|' + dest.join(',');
    if (seen.has(key)) continue;
    seen.add(key);

    let resp = null;
    for (let attempt = 0; attempt < 3 && !resp; attempt++) {
      try {
        resp = await amapTransit(origin, dest);
      } catch (e) {
        console.error('  调用异常（重试）:', e.message);
        await sleep(1500);
      }
    }

    if (resp && resp.status === '1' && resp.route && resp.route.transits && resp.route.transits.length) {
      samples.push({ origin, dest, resp });
      ok++;
    } else {
      fail++;
      const msg = resp ? (resp.info || resp.infocode) : '无响应';
      console.log(`  ✗ 无公交方案 (${msg})，跳过`);
    }

    // 控制 QPS（个人 key 约 2~3 QPS，这里取 600ms ≈ 1.6 QPS）
    await sleep(600);
  }

  fs.writeFileSync(OUT, JSON.stringify({
    city: '北京',
    generated_at: new Date().toISOString(),
    samples,
  }, null, 2));

  console.log(`\n完成：成功 ${ok} 条，失败 ${fail} 条，总计 ${samples.length} 条`);
  console.log('已写入 ' + OUT);
}

main().catch((e) => { console.error(e); process.exit(1); });
