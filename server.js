'use strict';

// 极简静态文件服务器：运行 `node server.js` 后访问 http://localhost:8080
// （高德 JS API 需要域名白名单，必须用 http://localhost:8080 访问，不能直接双击 index.html）
// 打包发布时，双击启动脚本即可：node server.js 会自动打开默认浏览器。

const http = require('http');
const fs = require('fs');
const path = require('path');
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

http
  .createServer((req, res) => {
    let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/') urlPath = '/index.html';

    const filePath = path.normalize(path.join(ROOT, urlPath));
    if (!filePath.startsWith(ROOT + path.sep)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    fs.readFile(filePath, (err, buf) => {
      if (err) {
        res.writeHead(404);
        return res.end('Not Found: ' + urlPath);
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
      res.end(buf);
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
