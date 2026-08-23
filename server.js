'use strict';

// 极简静态文件服务器：运行 `node server.js` 后访问 http://localhost:8080
// （高德 JS API 需要域名白名单，必须用 http://localhost:8080 访问，不能直接双击 index.html）

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
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
  .listen(PORT, () => {
    console.log('✅ 已启动：http://localhost:' + PORT);
    console.log('   请在高德控制台把该 Key 的域名白名单加上 http://localhost:' + PORT);
  });
