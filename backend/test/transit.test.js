import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../../shared/router.js';
import { Transit } from '../src/infrastructure/transit.js';
const stop = (id,lng,d=1) => ({ id,name:id,lng,lat:30,d });
const lines = [
  {id:'bus',name:'bus',mode:'bus',oneWay:true,stops:[stop('A',120),stop('B',120.01),stop('C',120.02)]},
  {id:'metro',name:'metro',mode:'metro',stops:[stop('C',120.02),stop('D',120.03)]},
];
const transit = new Transit();
transit.cache.set('beijing',Promise.resolve({graph:router.buildGraph(lines),hash:'test'}));
const puzzle = {city:'beijing',scenario:'normal',origin:[120,30],destination:[120.02,30],dataHash:'test',dataVersion:6,rulesVersion:1};
const ride = (lineId,fromStopId,toStopId) => ({lineId,fromStopId,toStopId});
test('recomputes finite duration and rejects reversed one-way edges, teleport, forged stop and forbidden metro',async()=> {
  const time = await transit.evaluate(puzzle,[ride('bus','A','C')]);
  assert.ok(time > 5*60000);
  await assert.rejects(transit.evaluate({...puzzle,origin:puzzle.destination,destination:puzzle.origin},[ride('bus','C','A')]),/WRONG_DIRECTION/);
  await assert.rejects(transit.evaluate(puzzle,[ride('bus','fake','C')]),/INVALID_STOPS/);
  await assert.rejects(transit.evaluate(puzzle,[ride('bus','A','B'),ride('metro','C','D')]),/DISCONNECTED/);
  await assert.rejects(transit.evaluate({...puzzle,scenario:'noMetro'},[ride('metro','C','D')]),/LINE_NOT_ALLOWED/);
  await assert.rejects(transit.evaluate({...puzzle,origin:[0,0]},[ride('bus','A','C')]),/START_TOO_FAR/);
  await assert.rejects(transit.evaluate({...puzzle,dataHash:'forged'},[ride('bus','A','C')]),/VERSION/);
});
test('same physical-route score uses existing router cost primitives, including rain and transfers',async()=> {
  const leg = [ride('bus','A','C'),ride('metro','C','D')];
  const normal = await transit.evaluate({...puzzle,destination:[120.03,30]},leg);
  const rain = await transit.evaluate({...puzzle,destination:[120.03,30],scenario:'rain'},leg);
  assert.ok(rain > normal);
});
test('tower walk transfers are replayed from physical stop to physical stop',async()=> {
  const route=[ride('bus','A','B'),{type:'walk',fromStopId:'B',toStopId:'C'},ride('metro','C','D')];
  const duration=await transit.evaluate({...puzzle,destination:[120.03,30]},route,'tower');
  assert.ok(Number.isFinite(duration) && duration>0);
  await assert.rejects(transit.evaluate({...puzzle,destination:[120.03,30]},route,'free'),/WALK_TRANSFER_NOT_ALLOWED/);
  await assert.rejects(transit.evaluate({...puzzle,destination:[120.03,30]},[
    ride('bus','A','B'),{type:'walk',fromStopId:'A',toStopId:'C'},ride('metro','C','D'),
  ],'tower'),/DISCONNECTED_ROUTE/);
});
