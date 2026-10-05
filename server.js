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
const GZIP_EXTS = new Set(['.html', '.js', '.css', '.json', '.svg']);
// 内存缓存 gzip 结果：本地开发反复刷新时避免每次都重压 19MB 数据（key = 文件路径 + mtime）
const gzipCache = new Map();

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
  // 本地/便携服务器上的代码始终取最新版本。Safari 对 immutable ES modules
  // 的复用尤其激进，开发时即使 HTML 更新也可能继续拼出旧模块图。
  if (/\.(?:html|js|css)$/.test(relative || '')) return 'no-store';
  const q = (url || '').indexOf('?');
  if (q >= 0) {
    const query = url.slice(q + 1);
    if (/(^|&)v=/.test(query)) return 'public, max-age=31536000, immutable';
  }
  return 'no-store';
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
      fs.readFile(filePath, (err, buf) => {
        if (err) {
          res.writeHead(404);
          return res.end('Not Found: ' + urlPath);
        }
        const ext = path.extname(filePath).toLowerCase();
        const isFrontendModule = ext === '.js' && relative.startsWith('frontend/js/');
        if (isFrontendModule) buf = Buffer.from(versionLocalModuleImports(buf.toString('utf8')));
        const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControlFor(rawUrl, relative) };

        // gzip：仅文本类型 + 客户端支持时启用（浏览器都带 Accept-Encoding: gzip）
        const accept = String(req.headers['accept-encoding'] || '');
        if (GZIP_EXTS.has(ext) && /\bgzip\b/.test(accept) && buf.length > 1024) {
          // 模块导入会随 index.html 版本号改写；v44→v45 字节数不变，
          // 仅按长度缓存 gzip 会把旧的子模块引用发给新版入口，造成两份 state。
          const moduleHash = isFrontendModule ? crypto.createHash('sha256').update(buf).digest('hex') : '';
          const ck = filePath + ':' + stat.mtimeMs + ':' + stat.size + ':' + moduleHash;
          let gz = gzipCache.get(ck);
          if (!gz) {
            gz = zlib.gzipSync(buf, { level: 9 });
            if (gzipCache.size > 64) gzipCache.clear(); // 简单防膨胀：超过 64 项清空重建
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
