import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { traceBody } from '../src/http/app.js';
import { GameService } from '../src/application/game-service.js';
import { Repository } from '../src/infrastructure/repository.js';
import { migrate } from '../src/infrastructure/migrate.js';
import { authOptions } from '../src/infrastructure/auth.js';
import { DATA_VERSION, RULES_VERSION } from '../src/domain/rules.js';

const url = process.env.TEST_DATABASE_URL;
const sample = (over = {}) => ({
  id: randomUUID(), anonId: randomUUID(), mode: 'free', city: 'beijing', scenario: { noMetro: true },
  origin: [116.3, 39.9], destination: [116.4, 39.95], outcome: 'finished', durationMs: 42000,
  events: [{ t: 1200, e: 'preview', stop: 'BV1@116.3,39.9', n: '西直门', first: 1 }, { t: 3000, e: 'start', stop: 'BV1@116.3,39.9', n: '西直门', line: null }, { t: 9000, e: 'finish' }],
  route: [{ k: 'start', stop: 'BV1@116.3,39.9', n: '西直门' }], summary: { stops: 1, rides: 0, walks: 0, playerMin: 31.5 },
  client: { w: 1440, h: 900, touch: false, map: 'osm', walkTransfer: false, v: '137' },
  ...over,
});

test('trace body accepts small flat events and rejects nested, oversized or unknown data', () => {
  assert.doesNotThrow(() => traceBody.parse(sample()));
  assert.throws(() => traceBody.parse(sample({ events: [{ t: 1, e: 'x', nested: { a: 1 } }] })), '事件不能嵌套对象');
  assert.throws(() => traceBody.parse(sample({ events: Array.from({ length: 2001 }, (_, i) => ({ t: i, e: 'x' })) })), '单局最多 2000 条');
  assert.throws(() => traceBody.parse(sample({ events: [{ t: 1, e: 'x'.repeat(201) }] })), '字段值限长');
  assert.throws(() => traceBody.parse({ ...sample(), password: 'x' }), '不接受未知字段');
  assert.throws(() => traceBody.parse(sample({ city: 'atlantis' })), '城市必须有效');
});

test('traces link to a run only when it belongs to the signed-in player', async () => {
  const saved = [];
  const owned = new Set(['run-mine']);
  const repository = { insertTrace: async (t) => saved.push(t), ownedRound: async (userId, runId) => (owned.has(runId) && userId === 'u1' ? { id: runId } : null) };
  const game = new GameService(repository, null);
  await game.recordTrace(null, sample({ runId: 'run-mine', roundId: 'r1' }));
  await game.recordTrace('u1', sample({ runId: 'run-mine', roundId: 'r1' }));
  await game.recordTrace('u1', sample({ runId: 'run-other', roundId: 'r2' }));
  assert.deepEqual(saved.map((t) => [t.userId, t.runId, t.roundId]), [[null, null, null], ['u1', 'run-mine', 'r1'], ['u1', null, null]]);
});

test('PostgreSQL: traces are stored, updated by the same browser only, and kept anonymous when the user is deleted', { skip: !url }, async (t) => {
  assert.match(new URL(url).pathname.slice(1), /_test$/, 'TEST_DATABASE_URL must target a *_test database');
  const pool = new pg.Pool({ connectionString: url, max: 3 });
  const userId = randomUUID();
  t.after(async () => { await pool.query('DELETE FROM "user" WHERE id=$1', [userId]); await pool.end(); });
  await migrate(pool, authOptions({ PUBLIC_ORIGIN: 'http://localhost:3001', NODE_ENV: 'test', BETTER_AUTH_SECRET: 'test-only-secret-'.repeat(4) }, pool, async () => {}));
  await pool.query('INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$1,$2,true,clock_timestamp(),clock_timestamp())', [userId, `${userId}@example.test`]);
  const repository = new Repository(pool);
  const puzzle = { city: 'beijing', scenario: 'normal', origin: [116.3, 39.9], destination: [116.4, 39.95], dataVersion: DATA_VERSION, rulesVersion: RULES_VERSION, dataHash: 'trace-fixture', optimalDurationMs: 600000 };
  const run = await repository.createRun(userId, 'free', puzzle, null);
  const round = await repository.createStage(run.id, 1, puzzle);
  const game = new GameService(repository, null);

  // 中途切后台先按“放弃”上报，之后完成用同一 id 覆盖
  const trace = sample({ runId: run.id, roundId: round.id, outcome: 'abandoned' });
  await game.recordTrace(userId, trace);
  await game.recordTrace(userId, { ...trace, outcome: 'finished', events: [...trace.events, { t: 12000, e: 'finish' }] });
  let row = (await pool.query('SELECT * FROM play_traces WHERE id=$1', [trace.id])).rows[0];
  assert.equal(row.outcome, 'finished');
  assert.equal(row.events.length, 4);
  assert.equal(row.user_id, userId);
  assert.equal(row.round_id, round.id, '关联到自己的这一关');
  // 别的浏览器（不同匿名 id）拿同一个 id 不能改写
  await game.recordTrace(null, { ...trace, anonId: randomUUID(), outcome: 'abandoned', events: [] });
  row = (await pool.query('SELECT outcome,events FROM play_traces WHERE id=$1', [trace.id])).rows[0];
  assert.equal(row.outcome, 'finished');
  assert.equal(row.events.length, 4);
  // 删除账号：记录保留，但不再关联用户
  await pool.query('DELETE FROM "user" WHERE id=$1', [userId]);
  row = (await pool.query('SELECT user_id,anon_id FROM play_traces WHERE id=$1', [trace.id])).rows[0];
  assert.equal(row.user_id, null);
  assert.equal(row.anon_id, trace.anonId);
});
