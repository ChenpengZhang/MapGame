import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { createAuth, authOptions } from '../src/infrastructure/auth.js';
import { migrate } from '../src/infrastructure/migrate.js';
import { Repository } from '../src/infrastructure/repository.js';
import { GameService } from '../src/application/game-service.js';
import { createApp } from '../src/http/app.js';
import { RULES_VERSION } from '../src/domain/rules.js';

const url = process.env.TEST_DATABASE_URL;
test('PostgreSQL: authentication, reset, authoritative settlement, concurrency and ownership', { skip: !url },async t => {
  // This suite creates data. Explicitly restrict it to a dedicated test database.
  const database = new URL(url).pathname.slice(1);
  assert.match(database,/_test$/,'TEST_DATABASE_URL must target a database ending in _test');
  const pool = new pg.Pool({connectionString:url,max:10});
  let server, userId, challengerUserId;
  const rankingUserIds=[];
  t.after(async()=> {
    if (server) await new Promise(resolve=>server.close(resolve));
    if(rankingUserIds.length)await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])',[rankingUserIds]);
    if (challengerUserId) await pool.query('DELETE FROM \"user\" WHERE id=$1',[challengerUserId]);
    if (userId) await pool.query('DELETE FROM \"user\" WHERE id=$1',[userId]);
    await pool.end();
  });
  const mail = [];
  const config = { PUBLIC_ORIGIN:'http://localhost:3001',NODE_ENV:'test',BETTER_AUTH_SECRET:'test-only-secret-'.repeat(4) };
  const sendMail = async message=>{mail.push(message);};
  const options = authOptions(config,pool,sendMail);
  await migrate(pool,options);
  await migrate(pool,options); // Repeat migrations must be harmless.
  const auth = createAuth(config,pool,sendMail);
  const repository = new Repository(pool);
  const puzzle = { city:'beijing',scenario:'normal',origin:[120,30],destination:[120.04,30],
    dataVersion:6,rulesVersion:RULES_VERSION,dataHash:'integration-fixture',optimalDurationMs:10000 };
  const transit = {
    generate:async(city,scenario,options)=>({...puzzle,city,scenario,options}),
    story:async levelId=>({...puzzle,storyId:levelId,limitMs:20000}),
    evaluate:async(_puzzle,route)=>route[0].lineId === 'slow' ? 999999 : 15000,
    load:async()=>({hash:puzzle.dataHash}),
  };
  const game = new GameService(repository,transit);
  server = createApp({auth,game,repository,config}).listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  const base = `http://127.0.0.1:${server.address().port}/mapgame/api`;
  async function request(path,body,cookie='',origin=config.PUBLIC_ORIGIN) {
    return fetch(`${base}${path}`,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',origin,cookie},body:body===undefined?undefined:JSON.stringify(body),redirect:'manual'});
  }
  const email = `integration-${randomUUID()}@example.com`;
  const password = 'Testing-password-1234';
  const displayName = `测试-${randomUUID()}`;
  let response = await request('/auth/sign-up/email',{email,password,name:displayName});
  assert.equal(response.status,200,await response.clone().text());
  userId = (await response.json()).user.id;
  assert.equal(mail.length,1);
  assert.equal(mail[0].kind,'email-verification');
  assert.match(mail[0].otp,/^\d{6}$/);
  response = await request('/auth/sign-in/email',{email,password});
  assert.equal(response.status,403);
  assert.equal(mail.at(-1).kind,'email-verification');
  response = await request('/auth/email-otp/verify-email',{email,otp:mail.at(-1).otp});
  assert.equal(response.status,200,await response.text());
  response = await request('/auth/sign-in/email',{email,password});
  assert.equal(response.status,200,await response.clone().text());
  const cookie = response.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
  assert.ok(cookie.includes('mapgame'));
  assert.match(response.headers.get('set-cookie'),/HttpOnly/i);
  assert.match(response.headers.get('set-cookie'),/Path=\/mapgame/i);
  const user = (await response.json()).user;
  assert.equal((await request('/runs',{mode:'tower',city:'beijing',scenario:'normal'})).status,401);
  assert.equal((await request('/runs',{mode:'tower',city:'beijing',scenario:'normal'},cookie,'https://evil.example')).status,403);
  const start = {mode:'tower',city:'beijing',scenario:'normal'};
  const starts = await Promise.all([request('/runs',start,cookie),request('/runs',start,cookie)]);
  const [a,b] = await Promise.all(starts.map(r=>r.json()));
  assert.equal(a.run.id,b.run.id);
  assert.equal(a.stage.startedAt,b.stage.startedAt);
  assert.equal(a.stage.puzzle.optimalDurationMs,undefined);
  const command = {stageId:a.stage.id,requestId:randomUUID(),route:[{lineId:'valid',fromStopId:'A',toStopId:'B'}]};
  response = await request(`/runs/${a.run.id}/submit`,{...command,durationMs:1,stageNo:999999},cookie);
  assert.equal(response.status,400);
  const results = await Promise.all([request(`/runs/${a.run.id}/submit`,command,cookie),request(`/runs/${a.run.id}/submit`,command,cookie)]);
  const [s1,s2] = await Promise.all(results.map(r=>r.json()));
  assert.equal(s1.id,s2.id); assert.equal(Number(s1.duration_ms),15000); assert.ok(Number(s1.elapsed_ms)>=0);
  assert.equal(Number(s1.total_elapsed_ms),Number(s1.elapsed_ms));
  assert.deepEqual(await repository.one('SELECT cleared_layers,total_elapsed_ms FROM tower_run_stats WHERE run_id=$1',[a.run.id]),
    {cleared_layers:1,total_elapsed_ms:String(s1.elapsed_ms)});
  const resumed=await (await request('/runs',start,cookie)).json();
  assert.equal(Number(resumed.run.total_elapsed_ms),Number(s1.elapsed_ms));
  assert.equal((await request(`/runs/${a.run.id}/submit`,{...command,requestId:randomUUID()},cookie)).status,409);
  const nexts = await Promise.all([request(`/runs/${a.run.id}/next`,{},cookie),request(`/runs/${a.run.id}/next`,{},cookie)]);
  const [n1,n2] = await Promise.all(nexts.map(r=>r.json()));
  assert.equal(n1.id,n2.id); assert.equal(n1.stageNo,2);
  const serverNow = await repository.now();
  await assert.rejects(game.submit('another-user',a.run.id,{...command,stageId:n1.id},serverNow),/RUN_NOT_FOUND/);
  await assert.rejects(game.submit(user.id,a.run.id,{...command,stageId:n1.id},serverNow),/IDEMPOTENCY_CONFLICT/);
  const failure = await game.submit(user.id,a.run.id,{...command,stageId:n1.id,requestId:randomUUID(),route:[{lineId:'slow',fromStopId:'A',toStopId:'B'}]},serverNow);
  assert.equal(failure.passed,false);
  await assert.rejects(game.next(user.id,a.run.id),/RUN_NOT_ACTIVE/);
  await pool.query('UPDATE tower_run_stats SET total_elapsed_ms=15000 WHERE run_id=$1',[a.run.id]);
  const board = await game.leaderboard({mode:'tower',city:'beijing',scenario:'normal'},user.id);
  assert.ok(board.leaders.some(row=>row.name===displayName && row.cleared_layers===1 && Number(row.total_elapsed_ms)===15000));
  assert.equal(board.leaders.find(row=>row.name===displayName).is_me,true);
  assert.equal(board.player,null);
  const challengerName = `快玩家-${randomUUID()}`;
  response = await request('/auth/sign-up/email',{
    email:`challenger-${randomUUID()}@example.com`,password,name:challengerName,
  });
  assert.equal(response.status,200,await response.clone().text());
  challengerUserId = (await response.json()).user.id;
  const challengerRun = await repository.createRun(challengerUserId,'tower',puzzle,null);
  await pool.query("UPDATE game_runs SET status='completed',finished_at=clock_timestamp() WHERE id=$1",[challengerRun.id]);
  await pool.query('UPDATE tower_run_stats SET cleared_layers=1,total_elapsed_ms=14000,achieved_at=clock_timestamp() WHERE run_id=$1',[challengerRun.id]);
  const tiedLayerBoard = await game.leaderboard({mode:'tower',city:'beijing',scenario:'normal'},user.id);
  const challengerRow = tiedLayerBoard.leaders.find(row=>row.name===challengerName);
  const playerRow = tiedLayerBoard.leaders.find(row=>row.name===displayName);
  assert.equal(Number(challengerRow.rank),1);
  assert.equal(Number(playerRow.rank),2);
  assert.ok(tiedLayerBoard.leaders.indexOf(challengerRow)<tiedLayerBoard.leaders.indexOf(playerRow));
  for(let index=1;index<=19;index++){
    const id=randomUUID();rankingUserIds.push(id);
    await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,clock_timestamp(),clock_timestamp())',
      [id,`榜单玩家-${index}`,`rank-${randomUUID()}@example.com`]);
    const run=await repository.createRun(id,'tower',puzzle,null);
    await pool.query("UPDATE game_runs SET status='completed',finished_at=clock_timestamp() WHERE id=$1",[run.id]);
    await pool.query('UPDATE tower_run_stats SET cleared_layers=1,total_elapsed_ms=$2,achieved_at=clock_timestamp() WHERE run_id=$1',[run.id,14000+index]);
  }
  const outsideTop20=await game.leaderboard({mode:'tower',city:'beijing',scenario:'normal'},user.id);
  assert.equal(outsideTop20.leaders.length,20);
  assert.equal(outsideTop20.player.name,displayName);
  assert.equal(Number(outsideTop20.player.rank),21);
  assert.ok(!outsideTop20.leaders.some(row=>row.name===displayName));
  await pool.query('UPDATE tower_run_stats SET invalidated_at=clock_timestamp() WHERE run_id=$1',[a.run.id]);
  assert.ok(!(await game.leaderboard({mode:'tower',city:'beijing',scenario:'normal'})).leaders.some(row=>row.name===displayName));
  const daily = await game.start(user.id,{mode:'daily'});
  await game.submit(user.id,daily.run.id,{...command,stageId:daily.stage.id,requestId:randomUUID()},await repository.now());
  const dailyDate = (await game.dailyInfo()).date;
  assert.ok((await game.leaderboard({mode:'daily',date:dailyDate})).leaders.some(row=>Number(row.duration_ms)===15000));
  const expired = await game.start(user.id,{mode:'daily'});
  await assert.rejects(game.submit(user.id,expired.run.id,{...command,stageId:expired.stage.id,requestId:randomUUID()},new Date(Date.now()+86400000)),/DAILY_CLOSED/);
  const freeBody={mode:'free',city:'beijing',options:{noMetro:false,busBoost:true,rain:true}};
  assert.equal((await request('/runs',{...freeBody,options:{...freeBody.options,busSpeedFactor:999}},cookie)).status,400);
  const freeResponse=await request('/runs',freeBody,cookie);
  assert.equal(freeResponse.status,200,await freeResponse.clone().text());
  const free=await freeResponse.json();
  assert.equal(free.stage.puzzle.options.busSpeedFactor,0.6);
  await game.submit(user.id,free.run.id,{...command,stageId:free.stage.id,requestId:randomUUID()},await repository.now());
  const story=await game.start(user.id,{mode:'story',levelId:'school'});
  const storyResult=await game.submit(user.id,story.run.id,{...command,stageId:story.stage.id,requestId:randomUUID()},await repository.now());
  assert.equal(storyResult.passed,true);
  const history=await (await request('/history',undefined,cookie)).json();
  assert.ok(history.some(row=>row.run_id===free.run.id && row.mode==='free'));
  assert.ok(history.some(row=>row.run_id===story.run.id && row.story_id==='school'));
  assert.deepEqual(await game.history('another-user'),[]);
  assert.equal((await request('/history')).status,401);
  assert.equal((await request('/runs',{mode:'story',levelId:'injected'},cookie)).status,400);
  response = await request('/auth/email-otp/request-password-reset',{email});
  assert.equal(response.status,200,await response.text());
  const reset = mail.findLast(m=>m.kind==='forget-password');
  assert.match(reset.otp,/^\d{6}$/);
  response = await request('/auth/email-otp/check-verification-otp',{email,type:'forget-password',otp:reset.otp});
  assert.equal(response.status,200,await response.text());
  response = await request('/auth/email-otp/reset-password',{email,otp:reset.otp,password:'A-new-password-12345'});
  assert.equal(response.status,200,await response.text());
  assert.equal((await request('/me',undefined,cookie)).status,401);
  assert.equal((await request('/auth/email-otp/reset-password',{email,otp:reset.otp,password:'Another-password-12345'})).status,400);
  response = await request('/auth/sign-in/email',{email,password:'A-new-password-12345'});
  assert.equal(response.status,200,await response.text());
});
