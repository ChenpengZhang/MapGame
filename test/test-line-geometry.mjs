// 线路走向修补：只有站点连线的线路，从同名线路借用真实走向（真实数据：北京 快速直达专线196路）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { repairBarePaths, hasBarePath } from '../frontend/js/data/line-geometry.js';
const transitFormat = createRequire(import.meta.url)('../shared/transit-format.js');

const dist = (a, b) => {
  const t = Math.PI / 180, dLat = (b[1] - a[1]) * t, dLng = (b[0] - a[0]) * t;
  const x = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * t) * Math.cos(b[1] * t) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(x));
};
const maxJump = (path) => Math.max(...path.slice(1).map((p, i) => dist(path[i], p)));

const data = transitFormat.decode(JSON.parse(readFileSync(new URL('../data/beijing-transit.json', import.meta.url))));
const line = data.lines.find((l) => l.id === 'L_f79f586d3121');
assert.ok(hasBarePath(line), '196路这一班次原始数据只有站点坐标');
assert.ok(maxJump(line.path) > 15000, '原始走向里有一段十几公里的直线');
const healthy = data.lines.filter((l) => !hasBarePath(l)).slice(0, 50).map((l) => l.path);

const repaired = repairBarePaths(data.lines);
assert.ok(repaired >= 10, '北京有十余条线路被修补');
assert.ok(line.path.length > 100, '借到了同名线路的真实走向');
assert.ok(maxJump(line.path) < 2000, '不再有跨越多站的长直线');
assert.deepEqual(line.path[0], [line.stops[0].lng, line.stops[0].lat], '起点仍是首站');
assert.deepEqual(line.path.at(-1), [line.stops.at(-1).lng, line.stops.at(-1).lat], '终点仍是末站');
assert.deepEqual(data.lines.filter((l) => !hasBarePath(l)).slice(0, 50).map((l) => l.path), healthy, '有真实走向的线路不受影响');

console.log('\n=== 线路走向修补：通过 ===\n');
