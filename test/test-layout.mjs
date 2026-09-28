import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import assets from '../scripts/assets.js';
import release from '../scripts/build-release.js';

const root = fileURLToPath(new URL('../',import.meta.url));
function verifyReferences(directory) {
  const manifest = assets.publicAssets(directory);
  const requireResource = (reference,base) => {
    if (/^(https?:|data:|#)/.test(reference) || reference.startsWith('//')) return;
    const url = new URL(reference,`http://localhost/mapgame${base}`);
    assert.ok(url.pathname.startsWith('/mapgame/'),`Escapes deployment prefix: ${reference}`);
    if(url.pathname.endsWith('/'))url.pathname+='index.html';
    assert.ok(manifest.has(url.pathname.slice('/mapgame'.length)),`Missing ${reference} referenced by ${base}`);
  };
  for (const [url,file] of manifest) {
    assert.ok(fs.statSync(path.join(directory,file)).isFile(),file);
    if (!/\.(html|js|css)$/.test(file)) continue;
    const content = fs.readFileSync(path.join(directory,file),'utf8');
    const pattern = file.endsWith('.html') ? /(?:src|href)="([^"]+)"/g
      : file.endsWith('.css') ? /url\(['"]?([^)'"\s]+)['"]?\)/g
      : /\b(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g;
    for (const match of content.matchAll(pattern)) requireResource(match[1],url);
  }
  return manifest;
}
async function serve(directory,registerCleanup) {
  const port=randomInt(20000,40000);
  const child=spawn(process.execPath,['server.js','--no-open'],{cwd:directory,env:{...process.env,PORT:String(port),NO_OPEN:'1'},stdio:['ignore','pipe','pipe']});
  registerCleanup(async()=> {
    if(child.exitCode===null) { const stopped=new Promise(resolve=>child.once('exit',resolve));child.kill();await stopped; }
  });
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Server startup timed out')),5000);
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Server exited ${code}`));});
    child.once('error',reject);
    child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});
  });
  return `http://127.0.0.1:${port}`;
}

test('frontend source and shared assets resolve at the /mapgame/ prefix',()=> {
  const manifest=verifyReferences(root);
  assert.equal(manifest.get('/shared/router.js'),'shared/router.js');
  assert.ok(![...manifest.values()].some(file=>/backend|\.env|cptond|calibrate|package\.json/.test(file)));
});

test('web artifact and portable release preserve paths without backend files',async t=> {
  const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'mapgame-layout-'));
  const cleanup=[()=>fs.rmSync(temporary,{recursive:true,force:true})];
  t.after(async()=> { for(const close of cleanup.reverse()) await close(); });
  const web=path.join(temporary,'web');
  assets.copyPublicAssets(root,web);
  for(const [url,file] of assets.publicAssets(root)) {
    assert.ok(fs.readFileSync(path.join(web,url)).equals(fs.readFileSync(path.join(root,file))),url);
  }
  const stage=path.join(temporary,'release');
  release.copyProject(stage);
  release.writeLauncher(stage,'linux-x64');
  verifyReferences(stage);
  assert.ok(fs.existsSync(path.join(stage,'Start-Game.sh')));
  assert.ok(!fs.existsSync(path.join(stage,'backend')));
  const base=await serve(stage,close=>cleanup.push(close));
  for(const prefix of ['', '/mapgame']) {
    const response=await fetch(`${base}${prefix}/`);
    assert.equal(response.status,200);
    assert.match(await response.text(),/src="shared\/router.js/);
    for(const resource of ['js/app.js','shared/router.js','fonts/ChillRoundF/ChillRoundF.css','fonts/RobotoCondensed/RobotoCondensed-Variable.ttf','data/sample.json','data/wenshan-transit.json','assets/map.svg']) {
      const asset=await fetch(`${base}${prefix}/${resource}`);
      assert.equal(asset.status,200,resource); await asset.arrayBuffer();
    }
  }
  // 缓存回归：代码即使带版本号也不永久缓存；交通数据仍按版本长期缓存。
  // 同时只改 HTML 的入口版本（例如 v48→v49），JS 文件 mtime/大小不变，
  // 同一个运行中的服务器必须重新压缩新版 import，不能复用旧 gzip 内容。
  const htmlPath=path.join(stage,'frontend/index.html');
  const originalHtml=fs.readFileSync(htmlPath,'utf8');
  const entryVersion=originalHtml.match(/js\/app\.js\?v=(\d+)/)?.[1];
  assert.ok(entryVersion,'entry cache version exists');
  const nextVersion=String(Number(entryVersion)+1);
  assert.equal(nextVersion.length,entryVersion.length,'test keeps version string length unchanged');
  const appBefore=await fetch(`${base}/js/app.js?v=${entryVersion}`,{headers:{'accept-encoding':'gzip'}});
  assert.equal(appBefore.headers.get('content-encoding'),'gzip');
  assert.equal(appBefore.headers.get('cache-control'),'no-store');
  assert.match(await appBefore.text(),new RegExp(`state\\.js\\?v=${entryVersion}`));
  const transit=await fetch(`${base}/data/wenshan-transit.json?v=7`);
  assert.match(transit.headers.get('cache-control') || '',/immutable/);
  fs.writeFileSync(htmlPath,originalHtml.replace(`js/app.js?v=${entryVersion}`,`js/app.js?v=${nextVersion}`));
  const appAfter=await fetch(`${base}/js/app.js?v=${nextVersion}`,{headers:{'accept-encoding':'gzip'}});
  assert.equal(appAfter.headers.get('content-encoding'),'gzip');
  assert.match(await appAfter.text(),new RegExp(`state\\.js\\?v=${nextVersion}`));
  const redirect=await fetch(`${base}/mapgame`,{redirect:'manual'});
  assert.equal(redirect.status,308);assert.equal(redirect.headers.get('location'),'/mapgame/');
  for(const resource of ['backend/.env','backend/src/main.js','frontend/package.json','data/calibrate-samples.json','lib/shp.js']) {
    const response=await fetch(`${base}/mapgame/${resource}`);
    assert.ok([403,404].includes(response.status),resource);
  }
});
