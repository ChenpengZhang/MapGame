'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Browser URL -> repository file. Dev server and static publishing share this manifest.
// Keep data pipelines, credentials, backend and test files out of the public tree.
function publicAssets(root) {
  const assets = new Map([
    ['/index.html', 'frontend/index.html'],
    ['/shared/router.js', 'shared/router.js'],
    ['/shared/rivers.js', 'shared/rivers.js'],
  ]);
  function collect(directory, publicDirectory, allowed) {
    if (!fs.existsSync(path.join(root,directory))) return; // 可选目录（如精简包里没有的边界数据）
    for (const entry of fs.readdirSync(path.join(root,directory),{ withFileTypes:true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = `${directory}/${entry.name}`;
      const url = `${publicDirectory}/${entry.name}`;
      if (entry.isDirectory()) collect(relative,url,allowed);
      else if (entry.isFile() && allowed.has(path.extname(entry.name))) assets.set(url,relative);
    }
  }
  collect('frontend/css','/css',new Set(['.css']));
  collect('frontend/assets','/assets',new Set(['.svg','.png','.jpg','.jpeg','.webp']));
  collect('frontend/js','/js',new Set(['.js']));
  collect('frontend/fonts','/fonts',new Set(['.css','.woff2','.woff','.ttf','.txt']));
  // 城市行政边界（DataV GeoJSON）：无尽模式“盲棋”用来画城市轮廓
  collect('data/boundaries','/data/boundaries',new Set(['.json']));
  // 江河中心线（武汉、重庆等）：禁止步行过江，见 shared/rivers.js
  collect('data/rivers','/data/rivers',new Set(['.json']));
  for (const name of ['sample','beijing-transit','guangzhou-transit','shanghai-transit','shenzhen-transit','wenshan-transit','shuanghe-transit','kokdala-transit','datong-transit','chengdu-transit','chongqing-transit','hangzhou-transit','wuhan-transit','nanjing-transit','tianjin-transit','qingdao-transit','kunming-transit','xiamen-transit','jinan-transit','zhengzhou-transit','changchun-transit']) {
    const relative = `data/${name}.json`;
    if (fs.existsSync(path.join(root,relative))) assets.set(`/${relative}`,relative);
  }
  return assets;
}
function copyPublicAssets(root,destination) {
  for (const [url,relative] of publicAssets(root)) {
    const target = path.join(destination,url.slice(1));
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(path.join(root,relative),target);
  }
}
module.exports = { publicAssets,copyPublicAssets };
