'use strict';

// 极简静态文件服务器：运行 `node server.js` 后访问 http://localhost:8080
// （高德 JS API 需要域名白名单，必须用 http://localhost:8080 访问，不能直接双击 index.html）
// 打包发布时，双击启动脚本即可：node server.js 会自动打开默认浏览器。

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 8080;
const API_PORT = Number(process.env.MAPGAME_API_PORT) || 3001;
const ROOT = __dirname;
const assets = require('./scripts/assets').publicAssets(ROOT);
const precompress = require('./scripts/precompress');
// 启动时清掉数据更新后已过期的预压缩文件（.cache/compressed/）
try { precompress.pruneStale([...new Set(assets.values())].map((rel) => path.join(ROOT, rel))); } catch { /* 忽略 */ }

// 自动打开浏览器（跨平台）；设置环境变量 NO_OPEN=1 可禁用
function openBrowser(url) {
  if (process.env.NO_OPEN === '1' || process.argv.includes('--no-open')) return;
  const cmd = process.platform === 'win32'
    ? `start "" "${url}"`
    : process.platform === 'darwin'
      ? `open "${url}"`
      : `xdg-open "${url}"`;
  exec(cmd, (err) => { if (err) { /* 无图形环境时忽略 */ } });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', // ChillRoundF 字体，Chrome 需要正确的 font MIME 才加载 @font-face
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
};

// 适合 gzip 的文本类型（二进制/已压缩格式跳过，避免徒劳且可能变大）
const GZIP_EXTS = new Set(['.html', '.js', '.css', '.json', '.svg', '.ttf']); // ttf 未压缩，gzip 后约小 40%
// 内存缓存小文件的 gzip 结果（key = 文件路径 + mtime + 大小 + 模块内容哈希）；按插入顺序淘汰最旧的
const gzipCache = new Map();
const GZIP_CACHE_MAX = 256;
// 大文件（交通数据）在预压缩完成前的临时 gzip：异步压缩、同一文件并发请求共用一次结果
const bigGzip = new Map(); // key -> Promise<Buffer>

/** 浏览器直接访问本机（便携版玩家、本地开发）：不必为省流量去做耗时的预压缩 */
function isLocalDirect(req) {
  const ip = String(req.socket.remoteAddress || '');
  return !req.headers['x-forwarded-for'] && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
}

function acceptedEncoding(req) {
  const accept = String(req.headers['accept-encoding'] || '');
  if (/\bbr\b/.test(accept)) return 'br';
  if (/\bgzip\b/.test(accept)) return 'gzip';
  return null;
}

/**
 * 大文件（≥512KB 的交通数据等）：优先发预压缩好的 brotli-11 / gzip-9；
 * 还没压好时先异步 gzip-6 应付，并在后台排队预压缩（只压一次，存到磁盘）。
 * X-Uncompressed-Length 告诉前端解压后的字节数，用于下载进度条。
 */
function sendLargeFile(req, res, filePath, stat, headers) {
  headers['Vary'] = 'Accept-Encoding';
  headers['X-Uncompressed-Length'] = String(stat.size);
  const encoding = acceptedEncoding(req);
  const ready = encoding && (precompress.readyVariant(filePath, stat, encoding)
    || (encoding === 'br' && precompress.readyVariant(filePath, stat, 'gzip')));
  if (ready) {
    headers['Content-Encoding'] = ready.endsWith('.br') ? 'br' : 'gzip';
    headers['Content-Length'] = String(fs.statSync(ready).size);
    res.writeHead(200, headers);
    return fs.createReadStream(ready).pipe(res);
  }
  if (!isLocalDirect(req)) precompress.schedule(filePath, stat);
  if (!encoding) {
    headers['Content-Length'] = String(stat.size);
    res.writeHead(200, headers);
    return fs.createReadStream(filePath).pipe(res);
  }
  const key = filePath + ':' + stat.mtimeMs + ':' + stat.size;
  if (!bigGzip.has(key)) {
    const pending = fs.promises.readFile(filePath)
      .then((buf) => new Promise((resolve, reject) => zlib.gzip(buf, { level: 6 }, (err, out) => (err ? reject(err) : resolve(out)))));
    bigGzip.set(key, pending);
    // 预压缩完成后磁盘版本会接手，内存里的临时结果几分钟后释放
    pending.then(() => setTimeout(() => bigGzip.delete(key), 10 * 60 * 1000).unref(), () => bigGzip.delete(key));
  }
  bigGzip.get(key).then((gz) => {
    headers['Content-Encoding'] = 'gzip';
    headers['Content-Length'] = String(gz.length);
    res.writeHead(200, headers);
    res.end(gz);
  }, () => { res.writeHead(500); res.end('Compression failed'); });
}

// ES module 的查询参数不会从 app.js 自动传递给 import 的子模块。
// 本地服务器也要像 build-web.js 一样给整棵依赖树加版本号，否则 Safari
// 可能沿用旧的裸模块 URL，出现“新入口 + 旧子模块”的混用。
function versionLocalModuleImports(source) {
  const htmlPath = path.join(ROOT, 'frontend/index.html');
  let html = '';
  try { html = fs.readFileSync(htmlPath, 'utf8'); } catch (e) { return source; }
  const version = (html.match(/js\/app\.js\?v=([^"']+)/) || [])[1];
  if (!version) return source;
  return source
    .replace(/(\bfrom\s*['"])(\.{1,2}\/[^'"]+\.js)(['"])/g, `$1$2?v=${version}$3`)
    .replace(/(\bimport\s*['"])(\.{1,2}\/[^'"]+\.js)(['"])/g, `$1$2?v=${version}$3`)
    .replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+\.js)(['"]\s*\))/g, `$1$2?v=${version}$3`);
}

// 缓存策略：
//   - 带 ?v=N 的资源（数据文件 beijing-transit.json?v=1、app.js?v=5 等）→ 一年强缓存：
//     版本号一变 URL 就变，浏览器自动拿新文件，不会用旧缓存；
//   - HTML 入口 → no-store：保证每次刷新都拿到最新的版本号引用（app.js?v=N、数据?v=N）；
//   - 其余无版本号的 JS 模块/CSS 等 → no-store：开发期改了就立刻生效，量小无所谓。
function cacheControlFor(url, relative) {
  // 代码（html/js/css）与无版本号的资源（字体等）：no-cache = 可以缓存，但每次使用前向服务器确认（带 ETag）。
  // 没变时只回 304、不传内容；变了立即拿到新版本。不用 immutable：Safari 对 immutable ES modules
  // 的复用尤其激进，开发时即使 HTML 更新也可能继续拼出旧模块图。
  if (/\.(?:html|js|css)$/.test(relative || '')) return 'no-cache';
  const q = (url || '').indexOf('?');
  if (q >= 0) {
    const query = url.slice(q + 1);
    if (/(^|&)v=/.test(query)) return 'public, max-age=31536000, immutable';
  }
  return 'no-cache';
}

/** index.html 里 app.js 的版本号：前端模块的 import 会按它改写，所以也是模块内容的一部分 */
function appVersion() {
  try { return (fs.readFileSync(path.join(ROOT, 'frontend/index.html'), 'utf8').match(/js\/app\.js\?v=([^"']+)/) || [])[1] || ''; }
  catch { return ''; }
}

http
  .createServer((req, res) => {
    const rawUrl = req.url || '/';
    // Same-origin local development proxy; the upstream is fixed to loopback.
    if (rawUrl.startsWith('/mapgame/api/')) {
      const upstream = http.request({hostname:'127.0.0.1',port:API_PORT,path:rawUrl,method:req.method,
        headers:{...req.headers,'x-forwarded-for':req.socket.remoteAddress,'x-real-ip':req.socket.remoteAddress,'x-forwarded-proto':'http'}}, response=>{
        res.writeHead(response.statusCode,response.headers);response.pipe(res);
      });
      upstream.setTimeout(35000,()=>upstream.destroy());
      upstream.on('error',()=>{if(!res.headersSent){res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({error:'SERVICE_UNAVAILABLE'}));}else res.destroy();});
      req.on('aborted',()=>upstream.destroy());
      req.pipe(upstream);return;
    }
    let urlPath;
    try { urlPath = decodeURIComponent(rawUrl.split('?')[0]); }
    catch { res.writeHead(400); return res.end('Bad Request'); }
    if (urlPath === '/mapgame') {
      res.writeHead(308, { Location: '/mapgame/' });
      return res.end();
    }
    if (urlPath.startsWith('/mapgame/')) urlPath = urlPath.slice('/mapgame'.length);
    if (urlPath === '/') urlPath = '/index.html';

    // 屏蔽敏感目录/文件（.git / node_modules / .env*）：防止整仓库 clone 后这些被直接访问
    const segs = urlPath.split('/');
    if (segs.some((s) => s === '.git' || s === 'node_modules' || s.startsWith('.env'))) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    const normalized = path.posix.normalize(urlPath);
    const relative = assets.get(normalized);
    if (!relative) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    const filePath = path.join(ROOT,relative);

    fs.stat(filePath, (statErr, stat) => {
      if (statErr) {
        res.writeHead(404);
        return res.end('Not Found: ' + urlPath);
      }
      const extName = path.extname(filePath).toLowerCase();
      const cacheControl = cacheControlFor(rawUrl, relative);
      // ETag：文件大小 + 修改时间（前端模块再加 app 版本号）。浏览器带 If-None-Match 来确认时，没变就回 304
      const moduleVersion = extName === '.js' && relative.startsWith('frontend/js/') ? '-' + appVersion() : '';
      const etag = `W/"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}${moduleVersion}"`;
      if (req.headers['if-none-match'] === etag) {
        res.writeHead(304, { ETag: etag, 'Cache-Control': cacheControl, Vary: 'Accept-Encoding' });
        return res.end();
      }
      if (!relative.startsWith('frontend/js/') && precompress.eligible(filePath, stat.size)) {
        return sendLargeFile(req, res, filePath, stat, {
          'Content-Type': MIME[extName] || 'application/octet-stream', 'Cache-Control': cacheControl, ETag: etag,
        });
      }
      fs.readFile(filePath, (err, buf) => {
        if (err) {
          res.writeHead(404);
          return res.end('Not Found: ' + urlPath);
        }
        const ext = path.extname(filePath).toLowerCase();
        const isFrontendModule = ext === '.js' && relative.startsWith('frontend/js/');
        if (isFrontendModule) buf = Buffer.from(versionLocalModuleImports(buf.toString('utf8')));
        const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControl, ETag: etag };

        // gzip：仅文本类型 + 客户端支持时启用（浏览器都带 Accept-Encoding: gzip）
        const accept = String(req.headers['accept-encoding'] || '');
        if (GZIP_EXTS.has(ext) && /\bgzip\b/.test(accept) && buf.length > 1024) {
          // 模块导入会随 index.html 版本号改写；v44→v45 字节数不变，
          // 仅按长度缓存 gzip 会把旧的子模块引用发给新版入口，造成两份 state。
          const moduleHash = isFrontendModule ? crypto.createHash('sha256').update(buf).digest('hex') : '';
          const ck = filePath + ':' + stat.mtimeMs + ':' + stat.size + ':' + moduleHash;
          let gz = gzipCache.get(ck);
          if (!gz) {
            gz = zlib.gzipSync(buf, { level: 9 }); // 小文件，同步压缩只需几毫秒
            if (gzipCache.size >= GZIP_CACHE_MAX) gzipCache.delete(gzipCache.keys().next().value);
            gzipCache.set(ck, gz);
          }
          headers['Content-Encoding'] = 'gzip';
          headers['Vary'] = 'Accept-Encoding';
          res.writeHead(200, headers);
          res.end(gz);
          return;
        }

        res.writeHead(200, headers);
        res.end(buf);
      });
    });
  })
  .on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error('❌ 端口 ' + PORT + ' 已被占用。请关闭占用该端口的程序后重试，或用 PORT=其他端口 启动。');
      process.exit(1);
    }
    throw err;
  })
  .listen(PORT, () => {
    console.log('✅ 已启动：http://localhost:' + PORT);
    console.log('   按 Ctrl+C 退出');
    openBrowser('http://localhost:' + PORT);
  });
