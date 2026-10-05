import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { customLevelScore, customLimitMs, MAX_LEVEL_SCORE } from '../../frontend/js/data/custom-maps.js';
import { customMapBody, startBody } from '../src/http/app.js';
import { Transit } from '../src/infrastructure/transit.js';
import { authOptions } from '../src/infrastructure/auth.js';
import { migrate } from '../src/infrastructure/migrate.js';
import { Repository } from '../src/infrastructure/repository.js';
import { GameService } from '../src/application/game-service.js';
import { DATA_VERSION, RULES_VERSION } from '../src/domain/rules.js';

// 双河新手教程的起终点：约 6km，需要 3路 → 2路 换乘一次
const SHUANGHE = { city: 'shuanghe', origin: [82.0628, 44.8597], dest: [82.111, 44.905], scenario: 'normal', timeLimit: null };

test('custom scoring: proportional to optimal, capped at 5000, zero when over the limit', () => {
  assert.equal(customLevelScore(600000, 600000), MAX_LEVEL_SCORE);
  assert.equal(customLevelScore(1200000, 600000), 2500);
  assert.equal(customLevelScore(300000, 600000), MAX_LEVEL_SCORE, '比最优还快（步行换乘）也不超过满分');
  assert.equal(customLevelScore(900001, 600000, 900000), 0, '超时 0 分');
  assert.equal(customLimitMs(null, 600000), null);
  assert.equal(customLimitMs({ type: 'minutes', value: 20 }, 600000), 1200000);
  assert.equal(customLimitMs({ type: 'ratio', value: 1.5 }, 600000), 900000);
});

test('custom map body rejects server-computed fields, bad cities and oversize groups', () => {
  const body = { title: '测试', visibility: 'public', levels: [SHUANGHE] };
  assert.equal(customMapBody.safeParse(body).success, true);
  for (const extra of [{ optimalDurationMs: 1 }, { limitMs: 1 }, { dataHash: 'x' }]) {
    assert.equal(customMapBody.safeParse({ ...body, levels: [{ ...SHUANGHE, ...extra }] }).success, false);
  }
  assert.equal(customMapBody.safeParse({ ...body, levels: [{ ...SHUANGHE, city: 'paris' }] }).success, false);
  assert.equal(customMapBody.safeParse({ ...body, levels: Array(11).fill(SHUANGHE) }).success, false);
  assert.equal(customMapBody.safeParse({ ...body, levels: [{ ...SHUANGHE, timeLimit: { type: 'ratio', value: 1 } }] }).success, false);
  assert.equal(startBody.safeParse({ mode: 'custom', map: 'ABCDEFGH' }).success, true);
  assert.equal(startBody.safeParse({ mode: 'custom', map: 'abc' }).success, false);
});

test('transit builds a custom round on real data and rejects too-close levels', async () => {
  const transit = new Transit();
  const puzzle = await transit.custom({ ...SHUANGHE, timeLimit: { type: 'ratio', value: 2 } }, { levelIndex: 0, levelCount: 1 });
  assert.equal(puzzle.city, 'shuanghe');
  assert.ok(puzzle.optimalDurationMs > 0);
  assert.equal(puzzle.limitMs, Math.ceil(puzzle.optimalDurationMs * 2));
  assert.equal(puzzle.levelCount, 1);
  await assert.rejects(transit.custom({ ...SHUANGHE, dest: [82.063, 44.8605] }), { code: 'LEVEL_TOO_CLOSE' });
});

const url = process.env.TEST_DATABASE_URL;
test('transit caches custom optimal durations per city/scenario/endpoints/data hash', async () => {
  const transit = new Transit();
  const first = await transit.custom(SHUANGHE);
  assert.equal(transit.customOptimal.size, 1);
  // 缓存命中时不再跑寻路：把缓存值改掉，第二次取到的就是改过的值
  const [key] = transit.customOptimal.keys();
  transit.customOptimal.set(key, first.optimalDurationMs + 1);
  assert.equal((await transit.custom(SHUANGHE)).optimalDurationMs, first.optimalDurationMs + 1);
  // 改了情景就是另一关，重新计算
  await transit.custom({ ...SHUANGHE, scenario: 'rain' });
  assert.equal(transit.customOptimal.size, 2);
});

test('PostgreSQL: custom map lifecycle, scored rounds, leaderboard and versioning', { skip: !url }, async (t) => {
  assert.match(new URL(url).pathname.slice(1), /_test$/, 'TEST_DATABASE_URL must target a *_test database');
  const pool = new pg.Pool({ connectionString: url, max: 5 });
  const users = [randomUUID(), randomUUID()];
  t.after(async () => {
    await pool.query('DELETE FROM "user" WHERE id=ANY($1::text[])', [users]);
    await pool.end();
  });
  const config = { PUBLIC_ORIGIN: 'http://localhost:3001', NODE_ENV: 'test', BETTER_AUTH_SECRET: 'test-only-secret-'.repeat(4) };
  await migrate(pool, authOptions(config, pool, async () => {}));
  for (const [i, id] of users.entries()) {
    await pool.query(
      'INSERT INTO "user"(id,name,email,"emailVerified","createdAt","updatedAt") VALUES($1,$2,$3,true,clock_timestamp(),clock_timestamp())',
      [id, `玩家${i + 1}`, `${id}@example.test`],
    );
  }

  // 假的交通层：最优 10 分钟；路线的 lineId 决定用时，便于构造不同得分
  const transit = {
    custom: async (level, meta = {}) => ({
      city: level.city, scenario: level.scenario, options: {}, origin: level.origin, destination: level.dest,
      dataVersion: DATA_VERSION, rulesVersion: RULES_VERSION, dataHash: 'custom-fixture',
      optimalDurationMs: 600000, limitMs: level.timeLimit ? 900000 : null, ...meta,
    }),
    evaluate: async (_puzzle, route) => ({ fast: 600000, slow: 1200000, late: 1000000 })[route[0].lineId],
  };
  const game = new GameService(new Repository(pool), transit);
  const [owner, player] = users;
  const levels = [SHUANGHE, { ...SHUANGHE, timeLimit: { type: 'minutes', value: 15 } }];

  const map = await game.createCustomMap(owner, { title: '双河两关', description: '', visibility: 'public', levels });
  assert.match(map.code, /^[A-HJ-NP-Z2-9]{8}$/);
  assert.equal(map.isOwner, true);
  assert.equal((await game.getCustomMap(map.code, player)).isOwner, false);
  assert.ok((await game.listCustomMaps({ q: '双河两关' })).some((row) => row.code === map.code), '公开关卡组出现在广场');
  assert.equal((await game.myCustomMaps(owner))[0].code, map.code);
  await assert.rejects(game.updateCustomMap(player, map.code, { ...map, levels }), { code: 'NOT_MAP_OWNER' });

  const play = async (userId, lines) => {
    let { run, stage } = await game.start(userId, { mode: 'custom', map: map.code, restart: true });
    let last;
    for (const [i, lineId] of lines.entries()) {
      if (i > 0) stage = await game.next(userId, run.id);
      assert.equal(stage.stageNo, i + 1);
      assert.equal(stage.puzzle.levelIndex, i);
      last = await game.submit(userId, run.id, {
        stageId: stage.id, requestId: randomUUID(), route: [{ lineId, fromStopId: 'A', toStopId: 'B' }],
      }, new Date(Date.now() + 1000));
    }
    return { run, last };
  };

  // 第 1 关最优（5000），第 2 关超时（15 分钟时限，用了 1000000ms ≈ 16.7 分钟）→ 0 分但仍进入结算
  const first = await play(player, ['fast', 'late']);
  assert.equal(first.last.score, 0);
  assert.equal(first.last.passed, false);
  assert.equal(first.last.total_score, 5000);
  assert.equal(first.last.rounds_done, 2);
  assert.equal(first.last.level_count, 2);
  await assert.rejects(game.next(player, first.run.id), { code: 'RUN_NOT_ACTIVE' }, '整组结束后不能再开下一关');

  const second = await play(owner, ['slow', 'fast']); // 2500 + 5000
  assert.equal(second.last.total_score, 7500);

  let board = await game.leaderboard({ mode: 'custom', map: map.code }, player);
  assert.deepEqual(board.leaders.map((row) => [row.name, row.total_score]), [['玩家1', 7500], ['玩家2', 5000]]);
  assert.equal(board.leaders[1].is_me, true);

  // 只改标题不换版本；改关卡内容则升版本，旧成绩不再计入排行
  const renamed = await game.updateCustomMap(owner, map.code, { title: '改名', description: '', visibility: 'unlisted', levels });
  assert.equal(renamed.version, 1);
  assert.ok(!(await game.listCustomMaps({ q: '改名' })).some((row) => row.code === map.code), '仅链接的关卡组不出现在广场');
  const changed = await game.updateCustomMap(owner, map.code, { title: '改名', description: '', visibility: 'unlisted', levels: [SHUANGHE] });
  assert.equal(changed.version, 2);
  board = await game.leaderboard({ mode: 'custom', map: map.code }, player);
  assert.equal(board.leaders.length, 0);

  // 进行中的旧版本对局在关卡组更新后不能继续
  const { run } = await game.start(player, { mode: 'custom', map: map.code });
  await game.deleteCustomMap(owner, map.code);
  await assert.rejects(game.getCustomMap(map.code), { code: 'MAP_NOT_FOUND' });
  const status = (await pool.query('SELECT status FROM game_runs WHERE id=$1', [run.id])).rows[0].status;
  assert.equal(status, 'abandoned', '删除关卡组时作废进行中的对局');
});
