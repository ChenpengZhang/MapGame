import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Transit } from '../src/infrastructure/transit.js';
import transitFormat from '../../shared/transit-format.js';
import { DATA_VERSION, RULES_VERSION } from '../src/domain/rules.js';

// 武汉：从汉阳的晴川码头步行到对岸武昌的中华路码头（直线约 1km，在 1.5km 步行上限内）要过长江，必须拒绝
test('server rejects walking across the Yangtze in Wuhan', async () => {
  const transit = new Transit();
  const { hash, graph } = await transit.load('wuhan');
  assert.ok(graph.rivers, '武汉加载了江河数据');
  const data = transitFormat.decode(JSON.parse(await readFile(new URL('../../data/wuhan-transit.json', import.meta.url))));
  const line = data.lines.find((l) => l.stops.some((s, i) => s.name === '中华路码头' && i + 1 < l.stops.length));
  const i = line.stops.findIndex((s) => s.name === '中华路码头');
  const from = line.stops[i], to = line.stops[i + 1];
  const puzzle = {
    city: 'wuhan', scenario: 'normal', options: null, dataHash: hash, dataVersion: DATA_VERSION, rulesVersion: RULES_VERSION,
    origin: [114.285685, 30.555169], // 晴川码头（汉阳岸）
    destination: [to.lng, to.lat],
  };
  const route = [{ lineId: line.id, fromStopId: from.id, toStopId: to.id }];
  await assert.rejects(transit.evaluate(puzzle, route, 'tower'), { code: 'RIVER_CROSSING' });
  // 同一岸起步则正常计时
  const sameBank = { ...puzzle, origin: [from.lng + 0.001, from.lat] };
  assert.ok((await transit.evaluate(sameBank, route, 'tower')) > 0);
});
