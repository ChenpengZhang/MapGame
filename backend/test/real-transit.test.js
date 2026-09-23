import test from 'node:test';
import assert from 'node:assert/strict';
import router from '../../shared/router.js';
import { Transit } from '../src/infrastructure/transit.js';
import { SCENARIOS } from '../src/domain/rules.js';

test('real Beijing data: router answers replay under the same authoritative cost model',async()=> {
  const transit = new Transit();
  const {graph,hash} = await transit.load('beijing');
  for (const scenario of Object.keys(SCENARIOS)) {
    const options = SCENARIOS[scenario];
    const origin = [116.397,39.908], destination = [116.46,39.91];
    const result = await router.findOptimalRoute(graph,origin,destination,options,async(a,b)=>({min:router.haversineKm(a,b)*1000/(75*options.walkSpeedFactor)}));
    assert.ok(result);
    const route = result.legs.filter(l=>l.type==='ride').map(l=>({lineId:l.lineId,
      fromStopId:graph.logicalById.get(l.fromLogicalId).stopByLine[l.lineId],
      toStopId:graph.logicalById.get(l.toLogicalId).stopByLine[l.lineId]}));
    const duration = await transit.evaluate({city:'beijing',scenario,origin,destination,dataHash:hash,dataVersion:6,rulesVersion:1},route);
    assert.ok(Math.abs(duration-Math.round(result.totalMin*60000)) <= 1,`${scenario}: ${duration} vs ${result.totalMin*60000}`);
  }
});
