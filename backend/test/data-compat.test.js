import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Transit } from '../src/infrastructure/transit.js';
import { DATA_VERSION, RULES_VERSION } from '../src/domain/rules.js';

// 数据文件只升级格式（图完全相同）时，用旧文件生成的题目仍然有效：换上当前版本标记、照常校验；
// 与当前数据无关的哈希仍按“数据已更新”拒绝。
test('format-only data upgrades keep puzzles generated from the old file valid', async () => {
  const transit = new Transit();
  const file = JSON.parse(await readFile(new URL('../../data/shuanghe-transit.json', import.meta.url)));
  assert.ok(Array.isArray(file.compatibleHashes) && file.compatibleHashes.length, '迁移脚本记录了旧文件哈希');
  const fresh = await transit.generate('shuanghe', 'normal');
  const oldHash = file.compatibleHashes[0];
  assert.ok((await transit.compatibleHashes('shuanghe')).includes(oldHash));

  const legacy = { ...fresh, dataHash: oldHash, dataVersion: DATA_VERSION - 1 };
  const current = await transit.current(legacy);
  assert.equal(current.dataHash, fresh.dataHash, '旧题目换上当前数据哈希');
  assert.equal(current.dataVersion, DATA_VERSION);
  assert.deepEqual([current.origin, current.destination, current.optimalDurationMs], [fresh.origin, fresh.destination, fresh.optimalDurationMs]);

  const stranger = { ...fresh, dataHash: createHash('sha256').update('other data').digest('hex'), dataVersion: DATA_VERSION - 1 };
  assert.equal(await transit.current(stranger), stranger, '无关的旧数据不做处理');
  await assert.rejects(transit.evaluate(stranger, [], 'free'), { code: 'PUZZLE_VERSION_UNAVAILABLE' });
  await assert.rejects(transit.evaluate({ ...legacy, rulesVersion: RULES_VERSION + 1 }, [], 'free'), { code: 'PUZZLE_VERSION_UNAVAILABLE' });
});
