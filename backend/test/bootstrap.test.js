import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID,randomInt } from 'node:crypto';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { bootstrapDatabase,ensureDatabase,quoteIdentifier } from '../src/infrastructure/bootstrap-database.js';

test('CREATE DATABASE identifiers are quoted, bounded and cannot inject SQL',()=> {
  assert.equal(quoteIdentifier('db"; DROP DATABASE other; --'),'"db""; DROP DATABASE other; --"');
  for (const name of ['', 'bad\0name','a'.repeat(64),'中'.repeat(22)]) assert.throws(()=>quoteIdentifier(name));
  assert.equal(quoteIdentifier('mapgame'),'"mapgame"');
});

test('PostgreSQL bootstrap: missing DB, concurrent migrations, existing data and actual API startup',{
  skip:!process.env.TEST_DATABASE_URL,
},async t=> {
  const base = new URL(process.env.TEST_DATABASE_URL);
  assert.match(decodeURIComponent(base.pathname),/_test$/);
  const name = `mg_bootstrap_${randomUUID().replaceAll('-','').slice(0,16)}_test`;
  const maintenance = new URL(base); maintenance.pathname='/postgres';
  const target = new URL(base); target.pathname=`/${name}`;
  const admin = new pg.Client({connectionString:maintenance.href});
  await admin.connect();
  const pools=[];
  let child;
  t.after(async()=> {
    if(child && child.exitCode === null) {
      const stopped=new Promise(resolve=>child.once('exit',resolve));
      child.kill('SIGTERM'); await stopped;
    }
    await Promise.all(pools.map(p=>p.end()));
    // Only drop the randomly named DB created by this test; never the supplied database.
    await admin.query(`DROP DATABASE IF EXISTS ${quoteIdentifier(name)}`);
    await admin.end();
  });
  const config={DATABASE_URL:target.href,PUBLIC_ORIGIN:'http://localhost:3001',
    NODE_ENV:'test',BETTER_AUTH_SECRET:randomUUID()+randomUUID()};
  const created=await Promise.all([ensureDatabase(config),ensureDatabase(config)]);
  assert.deepEqual(created.map(result=>result.created).sort(),[false,true]);
  const [one,two]=await Promise.all([
    bootstrapDatabase({...config,DATABASE_ADMIN_URL:maintenance.href},async()=>{}).then(p=>{pools.push(p);return p;}),
    bootstrapDatabase(config,async()=>{}).then(p=>{pools.push(p);return p;}),
  ]);
  assert.equal((await one.query('SELECT count(*)::int AS n FROM mapgame_migrations')).rows[0].n,5);
  await one.query('CREATE TABLE bootstrap_marker(value text NOT NULL)');
  await one.query("INSERT INTO bootstrap_marker VALUES('preserved')");
  assert.equal((await ensureDatabase({...config,DATABASE_ADMIN_URL:'postgresql://invalid:invalid@localhost:1/postgres'})).created,false);
  const three=await bootstrapDatabase(config,async()=>{}); pools.push(three);
  assert.equal((await three.query('SELECT value FROM bootstrap_marker')).rows[0].value,'preserved');
  assert.equal((await two.query('SELECT count(*)::int AS n FROM "user"')).rows[0].n,0);

  const port=randomInt(20000,40000);
  child=spawn(process.execPath,['src/main.js'],{
    cwd:new URL('../',import.meta.url),
    env:{...process.env,...config,PORT:String(port),HOST:'127.0.0.1',MAIL_TRANSPORT:'preview',DATABASE_ADMIN_URL:''},
    stdio:['ignore','pipe','pipe'],
  });
  await new Promise((resolve,reject)=> {
    const timeout=setTimeout(()=>reject(new Error('API startup timeout')),10000);
    child.once('error',error=>{clearTimeout(timeout);reject(error);});
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error(`API startup exited ${code}`));});
    child.stdout.once('data',()=>{clearTimeout(timeout);resolve();});
  });
  const response=await fetch(`http://127.0.0.1:${port}/mapgame/api/health`);
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{ok:true});
  assert.equal((await three.query('SELECT value FROM bootstrap_marker')).rows[0].value,'preserved');
});
