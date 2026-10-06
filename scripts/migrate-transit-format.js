'use strict';

// 把 data/<城市>-transit.json 转成 format 2（见 shared/transit-format.js），或在站点合并规则改动后重新生成。
// 用法：
//   node scripts/migrate-transit-format.js            # 处理全部城市
//   node scripts/migrate-transit-format.js beijing    # 只处理指定城市
// 合并结果总是用当前 shared/router.js 现场重算（不复用文件里旧的 logical），然后写回同一文件。
//
// compatibleHashes：若新文件建出的图与原文件完全相同（只是文件格式/编码变了），记下原文件的哈希。
// 服务器据此把用原文件生成的题目、进行中的存档和无尽排行视为同一版本数据，格式升级不会作废它们
// （见 backend/src/infrastructure/transit.js）。图有任何不同就不写，旧对局照常按“数据已更新”处理。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const router = require('../shared/router.js');
const format = require('../shared/transit-format.js');

const DATA = path.join(__dirname, '..', 'data');

/** 建图结果的指纹：物理站、逻辑站（含线路与各线停靠站台）及二者映射 */
function graphFingerprint(graph) {
  const h = crypto.createHash('sha256');
  for (const p of graph.physList) h.update(`${p.id}|${p.name}|${p.lng},${p.lat}|${p.mode}|${[...p.lineIds].join(',')}\n`);
  for (const [id, l] of graph.logicalById) h.update(`${id}|${l.name}|${l.lng},${l.lat}|${l.lineIds.join(',')}|${JSON.stringify(l.stopByLine)}\n`);
  for (const [p, l] of graph.physToLogical) h.update(`${p}>${l}\n`);
  return h.digest('hex');
}

function migrate(file) {
  const raw = fs.readFileSync(file);
  const input = JSON.parse(raw);
  const data = format.decode(input); // 旧格式原样返回；format 2 解码回旧结构
  const graph = router.buildGraph(data.lines); // 不传预计算结果：按当前规则重算合并
  const encoded = format.encode(data, graph, router.MERGE_RULES_VERSION);

  // 新文件解码 + 预计算合并建出的图，必须与原文件建出的图逐字节一致，才承认原文件哈希
  const check = format.decode(JSON.parse(JSON.stringify(encoded)));
  const same = graphFingerprint(router.buildGraph(check.lines, { logical: check.logical, mergeRules: check.mergeRules }))
    === graphFingerprint(graph);
  if (same) {
    const previous = Array.isArray(input.compatibleHashes) ? input.compatibleHashes : [];
    const inputHash = crypto.createHash('sha256').update(raw).digest('hex');
    encoded.compatibleHashes = [...new Set([inputHash, ...previous])].slice(0, 8);
  }
  const out = JSON.stringify(encoded);
  fs.writeFileSync(file, out);
  return { before: raw.length, after: Buffer.byteLength(out), compatible: same };
}

module.exports = { migrate, graphFingerprint };

if (require.main === module) {
  const only = process.argv.slice(2);
  const files = fs.readdirSync(DATA)
    .filter((f) => f.endsWith('-transit.json'))
    .filter((f) => !only.length || only.includes(f.replace('-transit.json', '')));
  for (const f of files) {
    const { before, after, compatible } = migrate(path.join(DATA, f));
    console.log(`${f.padEnd(26)} ${(before / 1e6).toFixed(1)}MB → ${(after / 1e6).toFixed(1)}MB${compatible ? '（图不变，记录原文件哈希）' : '（图有变化）'}`);
  }
}
