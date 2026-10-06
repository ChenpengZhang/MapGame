'use strict';

// 大文件预压缩：城市交通数据 5–37MB，运行时现压既慢又阻塞（北京 gzip-9 同步要 3 秒多）。
// 每个大文件只压一次，brotli-11（北京 37MB → 4MB）+ gzip-9 兜底，结果存到 .cache/compressed/（不进仓库），
// 文件名带原文件的 大小+修改时间，数据一更新自动重压、旧文件启动时清理。
// 压缩在 libuv 线程池里异步进行，一次只压一个文件，不阻塞服务器、也不占满线程池。
//
// server.js 在请求到大文件时按需排队；部署后也可以一次性预热全部：
//   node scripts/precompress.js          # 压缩所有尚未压缩的大文件（约十几分钟，只需一次）

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const CACHE_DIR = path.join(ROOT, '.cache', 'compressed');
const MIN_BYTES = 512 * 1024; // 只预压大文件（交通数据）；小文件运行时现压足够快
const EXTS = new Set(['.json', '.js', '.css', '.html', '.svg']);

const queue = [];       // 待压缩的绝对路径
const queued = new Set();
let running = false;

function eligible(absPath, size) {
  return size >= MIN_BYTES && EXTS.has(path.extname(absPath).toLowerCase());
}

function variantBase(absPath, stat) {
  const rel = path.relative(ROOT, absPath).split(path.sep).join('__');
  return path.join(CACHE_DIR, `${rel}.${stat.size}-${Math.floor(stat.mtimeMs)}`);
}

/** 已压好的版本路径（encoding: 'br' | 'gzip'），没有则返回 null */
function readyVariant(absPath, stat, encoding) {
  const file = variantBase(absPath, stat) + (encoding === 'br' ? '.br' : '.gz');
  return fs.existsSync(file) ? file : null;
}

function compress(fn, buf, options) {
  return new Promise((resolve, reject) => fn(buf, options, (err, out) => (err ? reject(err) : resolve(out))));
}

async function writeAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.promises.writeFile(tmp, data);
  await fs.promises.rename(tmp, file);
}

async function compressFile(absPath) {
  const stat = await fs.promises.stat(absPath);
  if (!eligible(absPath, stat.size)) return;
  const base = variantBase(absPath, stat);
  const wantBr = !fs.existsSync(base + '.br');
  const wantGz = !fs.existsSync(base + '.gz');
  if (!wantBr && !wantGz) return;
  await fs.promises.mkdir(CACHE_DIR, { recursive: true });
  const buf = await fs.promises.readFile(absPath);
  const t0 = Date.now();
  if (wantGz) await writeAtomic(base + '.gz', await compress(zlib.gzip, buf, { level: 9 }));
  if (wantBr) {
    await writeAtomic(base + '.br', await compress(zlib.brotliCompress, buf, {
      params: {
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_QUALITY]: 11,
        [zlib.constants.BROTLI_PARAM_LGWIN]: 24,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: buf.length,
      },
    }));
  }
  console.log(`[precompress] ${path.relative(ROOT, absPath)} ${(buf.length / 1e6).toFixed(1)}MB → br ${(fs.statSync(base + '.br').size / 1e6).toFixed(1)}MB（${Math.round((Date.now() - t0) / 1000)}s）`);
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (queue.length) {
      const file = queue.shift();
      try { await compressFile(file); }
      catch (err) { console.error('[precompress] 失败', file, err.message); }
      finally { queued.delete(file); }
    }
  } finally {
    running = false;
  }
}

/** 排队压缩一个大文件（重复调用无副作用）；返回是否需要压缩 */
function schedule(absPath, stat) {
  if (!eligible(absPath, stat.size) || queued.has(absPath)) return false;
  const base = variantBase(absPath, stat);
  if (fs.existsSync(base + '.br') && fs.existsSync(base + '.gz')) return false;
  queued.add(absPath);
  queue.push(absPath);
  void drain();
  return true;
}

/** 删除不再对应当前文件版本的压缩结果（数据更新后的旧文件） */
function pruneStale(absPaths) {
  if (!fs.existsSync(CACHE_DIR)) return;
  const keep = new Set();
  for (const file of absPaths) {
    try {
      const stat = fs.statSync(file);
      if (eligible(file, stat.size)) keep.add(path.basename(variantBase(file, stat)));
    } catch { /* 文件不存在就不保留 */ }
  }
  for (const name of fs.readdirSync(CACHE_DIR)) {
    const base = name.replace(/\.(br|gz)$/, '');
    if (!keep.has(base)) fs.rmSync(path.join(CACHE_DIR, name), { force: true });
  }
}

module.exports = { readyVariant, schedule, pruneStale, eligible };

// 命令行：一次性压缩全部公开资源里的大文件（小的先压，常用的小城市先可用）
if (require.main === module) {
  const assets = require('./assets').publicAssets(ROOT);
  const files = [...new Set(assets.values())].map((rel) => path.join(ROOT, rel))
    .filter((file) => fs.existsSync(file) && fs.statSync(file).isFile())
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  pruneStale(files);
  let n = 0;
  for (const file of files) if (schedule(file, fs.statSync(file))) n++;
  console.log(n ? `[precompress] 需要压缩 ${n} 个文件…` : '[precompress] 全部已是最新');
}
