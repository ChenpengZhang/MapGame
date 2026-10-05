import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { settle,threshold,beijingDate } from '../src/domain/rules.js';
import { configFromEnv } from '../src/config.js';
import { startBody,submissionBody } from '../src/http/app.js';

test('tower thresholds match existing game; server derives pass and elapsed time',() => {
  assert.equal(threshold(1),1); assert.ok(Math.abs(threshold(12)-0.01)<1e-9); assert.equal(threshold(100),0.01);
  const stage = { status: 'active',started_at: new Date('2026-09-22T00:00:00Z'),optimal_duration_ms: 10000,stage_no: 1 };
  assert.deepEqual(settle(stage,20000,new Date('2026-09-22T00:00:03Z'),'tower'),{ durationMs:20000,elapsedMs:3000,passed:true });
  assert.equal(settle(stage,20001,new Date('2026-09-22T00:00:03Z'),'tower').passed,false);
  assert.throws(()=>settle(stage,1,new Date('2026-09-21T00:00:00Z'),'tower'));
  assert.throws(()=>settle({ ...stage,status:'passed' },1,new Date(),'tower'));
});
test('story levels without a time limit pass after a valid route is completed',() => {
  const stage = {
    status: 'active', started_at: new Date('2026-09-22T00:00:00Z'),
    optimal_duration_ms: 10000, stage_no: 1, puzzle: { limitMs: null },
  };
  assert.equal(settle(stage, 999999, new Date('2026-09-22T00:00:03Z'), 'story').passed, true);
});
test('strict command boundary rejects injected score, clocks, layer, owner, rules and oversized paths',()=> {
  const valid = { stageId:randomUUID(),requestId:randomUUID(),route:[{lineId:'L',fromStopId:'A',toStopId:'B'}] };
  for (const key of ['durationMs','elapsedMs','elapsed_ms','totalElapsedMs','total_elapsed_ms','startedAt','started_at','finishedAt','submittedAt','serverTime','clientTime','userId','stageNo','puzzle','cleared_layers']) {
    assert.equal(submissionBody.safeParse({...valid,[key]:1}).success,false);
  }
  const start={mode:'tower',city:'beijing',scenario:'normal'};
  for(const key of ['startedAt','started_at','elapsedMs','totalElapsedMs','finishedAt','serverTime','clientTime']) {
    assert.equal(startBody.safeParse({...start,[key]:1}).success,false);
  }
  assert.equal(submissionBody.safeParse({...valid,route:Array(201).fill(valid.route[0])}).success,false);
  assert.equal(submissionBody.safeParse(valid).success,true);
  assert.equal(submissionBody.safeParse({...valid,route:[{type:'walk',fromStopId:'A',toStopId:'B'}]}).success,true);
});
test('daily date uses Shanghai midnight',()=> {
  assert.equal(beijingDate(new Date('2026-09-21T15:59:59Z')),'2026-09-21');
  assert.equal(beijingDate(new Date('2026-09-21T16:00:00Z')),'2026-09-22');
});
test('production cannot accidentally use preview mail or HTTP; config errors omit secrets',()=> {
  const base = { DATABASE_URL:'postgresql://user:secret@localhost/mapgame',BETTER_AUTH_SECRET:'x'.repeat(40),PUBLIC_ORIGIN:'http://localhost:3001' };
  assert.equal(configFromEnv(base).MAIL_TRANSPORT,'preview');
  assert.throws(()=>configFromEnv({...base,NODE_ENV:'production'}));
  try { configFromEnv({...base,DATABASE_URL:'PRIVATE_SECRET'}); } catch(error) { assert.ok(!error.message.includes('PRIVATE_SECRET')); }
});

test('daily answer is only public after the challenge closes', async () => {
  const { GameService } = await import('../src/application/game-service.js');
  const daily = {
    opens_at: new Date('2026-10-03T16:00:00Z'), closes_at: new Date('2026-10-04T16:00:00Z'),
    puzzle: { city: 'beijing', scenario: 'normal', origin: [116.4, 39.9], destination: [116.5, 39.95], optimalDurationMs: 1800000, dataHash: 'x' },
  };
  let now = new Date('2026-10-04T12:00:00Z');
  const repository = { daily: async (date) => (date === '2026-10-04' ? daily : null), now: async () => now };
  const game = new GameService(repository, null);
  await assert.rejects(game.dailyAnswer('2026-10-04'), { code: 'DAILY_NOT_CLOSED' });
  await assert.rejects(game.dailyAnswer('2026-10-01'), { code: 'DAILY_NOT_FOUND' });
  now = new Date('2026-10-04T16:00:01Z');
  const answer = await game.dailyAnswer('2026-10-04');
  assert.deepEqual(answer, {
    date: '2026-10-04', city: 'beijing', scenario: 'normal',
    origin: [116.4, 39.9], destination: [116.5, 39.95], optimalDurationMs: 1800000,
  });
  assert.equal('dataHash' in answer, false, '只公开起终点与情景');
});
