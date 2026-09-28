import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Transit } from '../src/infrastructure/transit.js';
import { unlockedStoryCount } from '../src/application/game-service.js';
import { startBody } from '../src/http/app.js';
import { LEVELS } from '../../frontend/js/data/levels.js';

test('shared story exposes the Wenshan one-line and Shuanghe transfer tutorials', async () => {
  assert.equal(unlockedStoryCount([]), 1, '新玩家只解锁第一关');
  assert.equal(unlockedStoryCount(['wenshan_intro']), 2, '通过第一关后才推进解锁序号');
  assert.deepEqual(LEVELS.map(({ id, cityId }) => [id, cityId]), [['wenshan_intro', 'wenshan'], ['shuanghe_transfer', 'shuanghe'], ['kokdala_walk_range', 'kokdala'], ['datong_brt', 'datong']]);
  assert.equal(startBody.safeParse({ mode: 'story', levelId: 'shuanghe_transfer' }).success, true);
  assert.equal(startBody.safeParse({ mode: 'story', levelId: 'wenshan_intro' }).success, true);
  assert.equal(startBody.safeParse({ mode: 'story', levelId: 'school' }).success, false);

  const archive = JSON.parse(await readFile(new URL('../../data/story-archive/beijing-levels.json', import.meta.url)));
  assert.equal(archive.levels.length, 6);

  const puzzle = await new Transit().story('wenshan_intro');
  assert.equal(puzzle.city, 'wenshan');
  assert.equal(puzzle.storyId, 'wenshan_intro');
  assert.ok(puzzle.optimalDurationMs > 0);
  assert.equal(puzzle.limitMs, null, '第一关不设时间限制');

  const timed = await new Transit().story('kokdala_walk_range');
  assert.equal(timed.city, 'kokdala');
  assert.equal(timed.limitMs, 32 * 60000, '第三关限时 32 分钟');
  assert.ok(timed.optimalDurationMs < timed.limitMs, '最优路线必须能在时限内完成');

  const brt = await new Transit().story('datong_brt');
  assert.equal(brt.city, 'datong');
  assert.ok(brt.optimalDurationMs < brt.limitMs, '第四关最优（快速公交）必须在时限内');

  const transfer = await new Transit().story('shuanghe_transfer');
  assert.equal(transfer.city, 'shuanghe');
  assert.ok(transfer.optimalDurationMs > 0);
});
