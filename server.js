'use strict';

// 极简静态文件服务器：运行 `node server.js` 后访问 http://localhost:8080
// （高德 JS API 需要域名白名单，必须用 http://localhost:8080 访问，不能直接双击 index.html）
// 打包发布时，双击启动脚本即可：node server.js 会自动打开默认浏览器。

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { exec } = require('child_process');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;

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
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', // ChillRoundF 字体，Chrome 需要正确的 font MIME 才加载 @font-face
  '.woff': 'font/woff',
};

// 适合 gzip 的文本类型（二进制/已压缩格式跳过，避免徒劳且可能变大）
const GZIP_EXTS = new Set(['.html', '.js', '.css', '.json', '.svg']);
// 内存缓存 gzip 结果：本地开发反复刷新时避免每次都重压 19MB 数据（key = 文件路径 + mtime）
const gzipCache = new Map();

// 缓存策略：
//   - 带 ?v=N 的资源（数据文件 beijing-transit.json?v=1、app.js?v=5 等）→ 一年强缓存：
//     版本号一变 URL 就变，浏览器自动拿新文件，不会用旧缓存；
//   - HTML 入口 → no-store：保证每次刷新都拿到最新的版本号引用（app.js?v=N、数据?v=N）；
//   - 其余无版本号的 JS 模块/CSS 等 → no-store：开发期改了就立刻生效，量小无所谓。
function cacheControlFor(url) {
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
    let urlPath = decodeURIComponent(rawUrl.split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

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
        const headers = { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': cacheControlFor(rawUrl) };

        // gzip：仅文本类型 + 客户端支持时启用（浏览器都带 Accept-Encoding: gzip）
        const accept = String(req.headers['accept-encoding'] || '');
        if (GZIP_EXTS.has(ext) && /\bgzip\b/.test(accept) && buf.length > 1024) {
          const ck = filePath + ':' + stat.mtimeMs + ':' + stat.size;
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
