'use strict';
const fs = require('node:fs');
const path = require('node:path');

// Browser URL -> repository file. Dev server and static publishing share this manifest.
// Keep data pipelines, credentials, backend and test files out of the public tree.
function publicAssets(root) {
  const assets = new Map([
    ['/index.html', 'frontend/index.html'],
    ['/favicon.svg', 'frontend/favicon.svg'],
    ['/shared/router.js', 'shared/router.js'],
  ]);
  function collect(directory, publicDirectory, allowed) {
    for (const entry of fs.readdirSync(path.join(root,directory),{ withFileTypes:true })) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      const relative = `${directory}/${entry.name}`;
      const url = `${publicDirectory}/${entry.name}`;
      if (entry.isDirectory()) collect(relative,url,allowed);
      else if (entry.isFile() && allowed.has(path.extname(entry.name))) assets.set(url,relative);
    }
  }
  collect('frontend/css','/css',new Set(['.css']));
  collect('frontend/js','/js',new Set(['.js']));
  collect('frontend/fonts','/fonts',new Set(['.css','.woff2','.woff','.txt']));
  for (const name of ['sample','beijing-transit','guangzhou-transit','shanghai-transit','shenzhen-transit']) {
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
