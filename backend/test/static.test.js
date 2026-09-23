import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { get } from 'node:http';

test('local static server never publishes backend files or environment secrets',async t=> {
  const port = randomInt(20000,40000);
  const child = spawn(process.execPath,['server.js','--no-open'],{
    cwd:new URL('../../',import.meta.url),env:{...process.env,PORT:String(port),NO_OPEN:'1'},stdio:['ignore','pipe','pipe'],
  });
  t.after(()=>{child.kill();});
  await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Static server startup timeout')),5000);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`Static server exited ${code}`));});
    child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});
  });
  const request = path=>new Promise((resolve,reject)=>get({host:'127.0.0.1',port,path},res=>{
    res.resume();res.on('end',()=>resolve(res.statusCode));
  }).on('error',reject));
  assert.equal(await request('/'),200);
  assert.equal(await request('/shared/router.js'),200);
  for (const path of ['/backend/package.json','/backend/src/config.js','/package.json','/js/../backend/package.json']) {
    assert.equal(await request(path),404);
  }
  assert.equal(await request('/backend/.env'),403);
  assert.equal(await request('/.git/config'),403);
  assert.equal(await request('/%ZZ'),400);
});
