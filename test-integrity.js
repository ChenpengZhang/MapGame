'use strict';

// 验证：逻辑站 ID 是否发生碰撞（不同簇生成同一个 id，后者覆盖前者）
const R = require('./js/router.js');
const data = require('./data/beijing-transit.json');
const g = R.buildGraph(data.lines);

// 找出所有「映射到同一逻辑站 id、但该逻辑站的 stopByLine 不包含其线路」的情况
const guilty = new Map(); // logId -> Set(缺失的线路)
for (const [physId, logId] of g.physToLogical) {
  const p = g.physById.get(physId);
  const log = g.logicalById.get(logId);
  if (!p || !log) continue;
  for (const lid of p.lineIds) {
    if (!log.lineIds.includes(lid)) {
      if (!guilty.has(logId)) guilty.set(logId, new Set());
      guilty.get(logId).add(lid);
    }
  }
}

console.log('受影响逻辑站数：' + guilty.size);
let shown = 0;
for (const [logId, lines] of guilty) {
  if (shown++ >= 8) break;
  const log = g.logicalById.get(logId);
  const missing = [...lines].map((lid) => (g.lineById.get(lid) || {}).name || lid);
  console.log('\n逻辑站 ' + logId);
  console.log('  站名=' + log.name + '  代表点=' + log.lng + ',' + log.lat);
  console.log('  该逻辑站已含线路数=' + log.lineIds.length + '，但下列物理站所属线路缺失：' + missing.join(' / '));
  // 打印映射到该 id 的所有物理站
  let cnt = 0;
  for (const [pid, lid2] of g.physToLogical) {
    if (lid2 !== logId) continue;
    if (cnt++ >= 6) { console.log('    …'); break; }
    const p = g.physById.get(pid);
    console.log('    物理站 ' + p.name + ' @' + p.lng + ',' + p.lat + '  线路=' +
      [...p.lineIds].map((x) => (g.lineById.get(x) || {}).name).join(','));
  }
}

// 统计：有多少物理站因为 id 碰撞而"线路缺失"
let badPhys = 0, totalPhys = 0;
for (const [physId, logId] of g.physToLogical) {
  totalPhys++;
  const p = g.physById.get(physId);
  const log = g.logicalById.get(logId);
  if (!p || !log) continue;
  for (const lid of p.lineIds) if (!log.lineIds.includes(lid)) { badPhys++; break; }
}
console.log('\n===== 汇总 =====');
console.log('物理站总数 ' + totalPhys + '，其中线路映射缺失的 ' + badPhys +
  '（' + (badPhys / totalPhys * 100).toFixed(2) + '%）');
