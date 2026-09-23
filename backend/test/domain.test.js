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
