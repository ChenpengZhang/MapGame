'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { copyPublicAssets } = require('./assets');
const destination = path.join(__dirname,'..','dist','mapgame');
// This directory is generated exclusively by this script. Rebuild without stale assets.
fs.rmSync(destination,{recursive:true,force:true});
copyPublicAssets(path.join(__dirname,'..'),destination);

// index.html 的入口版本同时应用到整棵 ES module 依赖树。
// 浏览器不会把 app.js?v=N 的查询参数自动传给它 import 的子模块；若静态服务器缓存
// /js/game/route.js 等裸 URL，就会出现“新入口 + 旧模块”。构建时统一改写可彻底避免混用。
const html = fs.readFileSync(path.join(destination,'index.html'),'utf8');
const version = (html.match(/js\/app\.js\?v=([^"']+)/) || [])[1];
if (!version) throw new Error('Missing app.js cache version in frontend/index.html');

function versionModuleImports(directory) {
  for (const entry of fs.readdirSync(directory,{withFileTypes:true})) {
    const file = path.join(directory,entry.name);
    if (entry.isDirectory()) versionModuleImports(file);
    else if (entry.isFile() && entry.name.endsWith('.js')) {
      let source = fs.readFileSync(file,'utf8');
      source = source
        .replace(/(\bfrom\s*['"])(\.{1,2}\/[^'"]+\.js)(['"])/g, `$1$2?v=${version}$3`)
        .replace(/(\bimport\s*['"])(\.{1,2}\/[^'"]+\.js)(['"])/g, `$1$2?v=${version}$3`)
        .replace(/(\bimport\s*\(\s*['"])(\.{1,2}\/[^'"]+\.js)(['"]\s*\))/g, `$1$2?v=${version}$3`);
      fs.writeFileSync(file,source);
    }
  }
}
versionModuleImports(path.join(destination,'js'));

console.log(`Static site built: dist/mapgame/ (deploy at /mapgame/, module cache v${version})`);
