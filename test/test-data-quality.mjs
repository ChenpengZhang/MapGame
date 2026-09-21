// 数据质量回归测试：校验 cptond-convert.js 产出四城 transit.json 的关键不变量。
// 覆盖本次修复的数据管线 bug，防止回归：
//   1) 公交拆上下行（每条公交是单向线 oneWay=true，上下行同名不同 id）
//   2) 地铁分支拆分 + 分叉贯通（广州3号线北延段通到海傍、上海10/11/5号线拆支线、首都机场线不误拆）
//   3) 剔除未完工线路（status 2/3：二期/北延段/中段等，不误杀本体）
//   4) 城市边界裁剪 + 跨市碎片清理（佛/莞/平湖/燕郊等 ≤2 站碎片丢弃）
//   5) 机场边界容差（大兴机场不被误裁）
//   6) 图连通性（主分量占绝大多数、地铁全在主分量、无逻辑站碰撞）
//
// 用法：node test/test-data-quality.mjs

'use strict';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const R = require('../js/router.js');

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CITIES = ['beijing', 'shanghai', 'shenzhen', 'guangzhou'];
const CROSS_CITY_RE = /(^佛|^莞|平湖|嘉善|泰兴|昆山|太仓|花桥|吴江|启东|海门|燕郊|涿州|廊坊|三河|香河|固安|大厂|惠州|凤岗|珠海|清远|肇庆|江门)/;

const data = {};
for (const id of CITIES) data[id] = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', id + '-transit.json'), 'utf8'));

let pass = 0, fail = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  \u2713 ' + name);
    pass++;
  } catch (e) {
    console.error('  \u2717 ' + name + '\n      ' + (e && e.message));
    fail++;
  }
}
const isLoopName = (n) => /内环|外环/.test(n || '') && !/区间/.test(n || '');

console.log('\n=== 数据质量回归测试（四城 transit.json）===\n');

// ============ 1. 基础结构 ============
check('每条线路都有 id/name/mode/oneWay/path/stops（≥2 站）', () => {
  for (const id of CITIES) {
    for (const line of data[id].lines) {
      assert.ok(line.id, id + ' ' + line.name + ' 缺 id');
      assert.ok(line.name, id + ' 有线路缺 name');
      assert.ok(line.mode === 'metro' || line.mode === 'bus', id + ' ' + line.name + ' mode 非法');
      assert.equal(typeof line.oneWay, 'boolean', id + ' ' + line.name + ' 缺 oneWay');
      assert.ok(Array.isArray(line.stops) && line.stops.length >= 2, id + ' ' + line.name + ' 站数应≥2，实际 ' + (line.stops || []).length);
      assert.ok(Array.isArray(line.path) && line.path.length >= 2, id + ' ' + line.name + ' path 应≥2 点');
      for (const s of line.stops) {
        assert.ok(s.id && s.name, id + ' ' + line.name + ' 有站点缺 id/name');
        assert.ok(Number.isFinite(s.lng) && Number.isFinite(s.lat), id + ' ' + line.name + ':' + s.name + ' 坐标非法');
      }
    }
  }
});

check('线路 id 全局唯一（上下行不能用同一 id）', () => {
  for (const id of CITIES) {
    const ids = new Set();
    for (const line of data[id].lines) {
      assert.ok(!ids.has(line.id), id + ' 重复线路 id ' + line.id + '（' + line.name + '）');
      ids.add(line.id);
    }
  }
});

// ============ 2. oneWay 语义（拆上下行） ============
check('公交全部单向（oneWay=true）；地铁除环线外双向（oneWay=false）', () => {
  for (const id of CITIES) {
    for (const line of data[id].lines) {
      if (line.mode === 'bus') {
        assert.equal(line.oneWay, true, id + ' 公交 ' + line.name + ' 应为 oneWay=true');
      } else {
        assert.equal(line.oneWay, isLoopName(line.name), id + ' 地铁 ' + line.name + ' oneWay 应=' + isLoopName(line.name));
      }
    }
  }
});

check('同一条公交的上下行同名、不同 id', () => {
  for (const id of CITIES) {
    const byName = new Map();
    for (const line of data[id].lines) if (line.mode === 'bus') {
      if (!byName.has(line.name)) byName.set(line.name, []);
      byName.get(line.name).push(line);
    }
    for (const [name, ls] of byName) {
      // 上下行拆成两条；环线/单方向 1 条；个别有「短交路」变体可能 3 条（如顺64路），不纠结条数
      assert.ok(ls.length >= 1, id + ' ' + name + ' 应至少 1 条');
      if (ls.length >= 2) {
        const ids = new Set(ls.map((l) => l.id));
        assert.equal(ids.size, ls.length, id + ' ' + name + ' 同名各方向 id 应互不相同');
      }
    }
  }
});

// ============ 3. 地铁分支拆分 + 分叉贯通 ============
check('广州3号线拆成两条且都通到海傍（主线 + 北延段贯通）', () => {
  const gz = data.guangzhou.lines.filter((l) => l.name === '地铁3号线' || l.name.startsWith('地铁3号线（'));
  assert.equal(gz.length, 2, '广州3号线应有两条，实际 ' + gz.length);
  const north = gz.find((l) => l.name.includes('机场北'));
  assert.ok(north, '应有北延段');
  assert.equal(north.stops[north.stops.length - 1].name, '海傍', '北延段应贯通到海傍（不是止于体育西路）');
  assert.ok(north.stops.some((s) => s.name === '体育西路'), '北延段应经过体育西路（与主线换乘）');
  assert.ok(north.stops.some((s) => s.name.includes('机场北')), '北延段应含机场北');
});

check('上海10/11/5号线各拆出支线（航中路/嘉定北/闵行开发区）', () => {
  const names = data.shanghai.lines.map((l) => l.name);
  assert.ok(names.includes('地铁10号线') && names.includes('地铁10号线（航中路—基隆路）'), '10号线应有航中路支线');
  assert.ok(names.includes('地铁11号线') && names.some((n) => n.includes('嘉定北')), '11号线应有嘉定北支线');
  assert.ok(names.includes('地铁5号线') && names.some((n) => n.includes('闵行开发区')), '5号线应有闵行开发区支线');
});

check('北京首都机场线不误拆（站点集合相同的两个方向合并为一条）', () => {
  const cap = data.beijing.lines.filter((l) => l.name === '首都机场线');
  assert.equal(cap.length, 1, '首都机场线应只有一条（不能被当成分叉误拆），实际 ' + cap.length);
});

check('深圳2号线是贯通单线（2号线+8号线），不误拆', () => {
  const l2 = data.shenzhen.lines.filter((l) => l.name === '地铁2号线');
  assert.equal(l2.length, 1, '深圳2号线应只有一条，实际 ' + l2.length);
  assert.ok(l2[0].stops.some((s) => s.name === '小梅沙') && l2[0].stops.some((s) => s.name === '赤湾'), '2号线应贯通小梅沙—赤湾');
});

// ============ 4. 剔除未完工线路（status 2/3） ============
check('未开通线路被剔除、本体保留（广州12/10号线、13号线二期 vs 13号线本体）', () => {
  const gzNames = data.guangzhou.lines.map((l) => l.name);
  assert.ok(!gzNames.some((n) => n.includes('地铁12号线')), '广州12号线（整线未开通）应被剔除');
  assert.ok(!gzNames.some((n) => n === '地铁10号线'), '广州10号线（未开通）应被剔除');
  assert.ok(!gzNames.some((n) => n.includes('13号线二期')), '13号线二期（未开通）应被剔除');
  assert.ok(!gzNames.some((n) => n.includes('18号线南延段') || n.includes('18号线北延段') || n.includes('18号线后通段')), '18号线延段应被剔除');
  assert.ok(gzNames.includes('地铁13号线'), '13号线本体应保留');
  assert.ok(gzNames.includes('地铁18号线'), '18号线本体应保留');
  assert.ok(gzNames.includes('地铁8号线'), '8号线本体应保留');
  assert.ok(gzNames.includes('地铁22号线'), '22号线本体应保留');
});

check('北京3号线本体保留、一期东段（在建）剔除；燕房线本体保留、支线剔除', () => {
  const bjNames = data.beijing.lines.map((l) => l.name);
  assert.ok(bjNames.includes('地铁3号线'), '北京3号线本体应保留');
  assert.ok(!bjNames.some((n) => n.includes('3号线一期东段')), '3号线一期东段（在建）应剔除');
  assert.ok(bjNames.includes('地铁燕房线'), '燕房线本体应保留');
  assert.ok(!bjNames.some((n) => n.includes('燕房线支线')), '燕房线支线（在建）应剔除');
});

// ============ 5. 跨市碎片清理 ============
check('跨市公交（佛/莞/平湖/燕郊…）无 ≤2 站碎片', () => {
  for (const id of CITIES) {
    for (const line of data[id].lines) {
      if (line.mode === 'bus' && CROSS_CITY_RE.test(line.name)) {
        assert.ok(line.stops.length > 2, id + ' 跨市线 ' + line.name + ' 裁剪后应 >2 站或整条剔除，实际 ' + line.stops.length);
      }
    }
  }
});

// ============ 6. 机场边界容差 ============
check('北京大兴机场大巴首都机场线两端完整（含大兴机场）', () => {
  const dx = data.beijing.lines.filter((l) => l.name === '大兴机场大巴首都机场线');
  assert.equal(dx.length, 2, '应有上下行两条，实际 ' + dx.length);
  for (const l of dx) {
    assert.ok(l.stops.some((s) => s.name === '大兴机场'), '应含大兴机场站（不能因边界被裁掉）');
    assert.ok(l.stops.some((s) => s.name.includes('首都机场T3')), '应含首都机场T3');
    assert.ok(l.stops.length >= 5, '站数应完整，实际 ' + l.stops.length);
  }
});

// ============ 7. 连通性 + 无逻辑站碰撞 ============
check('连通性：主分量占绝大多数、地铁全在主分量、无逻辑站碰撞', () => {
  for (const id of CITIES) {
    const g = R.buildGraph(data[id].lines);

    // 无逻辑站碰撞（物理站的 lineIds 必须全部包含在逻辑站的 lineIds 里）
    let bad = 0, total = 0;
    for (const [physId, logId] of g.physToLogical) {
      total++;
      const p = g.physById.get(physId), log = g.logicalById.get(logId);
      if (!p || !log) continue;
      for (const lid of p.lineIds) if (!log.lineIds.includes(lid)) { bad++; break; }
    }
    assert.equal(bad, 0, id + ' 有 ' + bad + ' 个逻辑站线路缺失');

    // union-find 连通分量
    const uf = new Map();
    const find = (x) => { let r = x; while (uf.get(r) !== r) r = uf.get(r); while (uf.get(x) !== x) { const nx = uf.get(x); uf.set(x, r); x = nx; } return r; };
    const union = (a, b) => { const ra = find(a), rb = find(b); if (ra !== rb) uf.set(ra, rb); };
    for (const [lid, log] of g.logicalById) uf.set(lid, lid);
    for (const [lid, line] of g.lineById) {
      const logs = new Set();
      for (const st of line.stops) { const lg = g.physToLogical.get(String(st.id)); if (lg) logs.add(lg); }
      const arr = [...logs];
      for (let i = 1; i < arr.length; i++) union(arr[0], arr[i]);
    }
    const comps = new Map();
    for (const lid of uf.keys()) { const r = find(lid); comps.set(r, (comps.get(r) || 0) + 1); }
    const sizes = [...comps.values()].sort((a, b) => b - a);
    const totalLog = [...comps.values()].reduce((a, b) => a + b, 0);
    const main = sizes[0];
    assert.ok(main / totalLog > 0.99, id + ' 主分量占比应>99%，实际 ' + (main / totalLog * 100).toFixed(2) + '%');

    // 地铁全在主分量
    const mainRoot = [...comps.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for (const [lid, line] of g.lineById) {
      if (line.mode !== 'metro') continue;
      const st0 = line.stops[0];
      if (!st0) continue;
      const lg = g.physToLogical.get(String(st0.id));
      if (!lg) continue;
      assert.equal(find(lg), mainRoot, id + ' 地铁 ' + line.name + ' 不应落在孤岛');
    }
  }
});

// ============ 汇总 ============
console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail === 0 ? 0 : 1);
