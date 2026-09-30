// 自定义关卡组：关卡视图（HUD / 剧情 / 情景）与共享计分规则
import assert from 'node:assert/strict';
import { installAllStubs } from './stubs.mjs';

installAllStubs();
const { customLevelView, customScenario } = await import('../frontend/js/game/custom-play.js');
const { customLevelScore, customLimitMs, describeTimeLimit } = await import('../frontend/js/data/custom-maps.js');

const map = {
  code: 'ABCDEFGH', title: '测试组',
  levels: [
    { city: 'beijing', origin: [116.4, 39.9], dest: [116.5, 39.95], scenario: 'normal', timeLimit: null },
    { city: 'shuanghe', origin: [82.06, 44.86], dest: [82.11, 44.9], scenario: 'blind', timeLimit: { type: 'ratio', value: 1.5 },
      originName: '迎宾桥', destName: '火车站', title: '换乘', text: '先坐 3路' },
  ],
};

const first = customLevelView(map, 0, 0);
assert.equal(first.id, 'custom', '自定义关卡 id 固定为 custom（登录玩家不被当成故事关跳转）');
assert.equal(first.cityId, 'beijing');
assert.equal(first.hudText, '第 1/2 关 · 累计 0 分');
assert.equal(first.story, null, '没有标题/提示文字就不弹剧情框');
assert.equal(first.origin.name, '起点');

const second = customLevelView(map, 1, 5000);
assert.equal(second.hudText, '第 2/2 关 · 累计 5000 分 · ≤ 最速 150% · 盲棋');
assert.deepEqual(second.story, [{ type: 'narration', text: '换乘\n先坐 3路' }]);
assert.equal(second.origin.name, '迎宾桥');
assert.equal(second.title, '测试组 · 第 2/2 关');
assert.equal(customScenario('blind').blindMap, true, '盲棋情景带上无底图标志');
assert.equal(customScenario('unknown').noMetro, false, '未知情景回落为普通');

assert.equal(describeTimeLimit({ type: 'minutes', value: 45 }), '≤ 45 分钟');
assert.equal(customLevelScore(900000, 600000, customLimitMs({ type: 'ratio', value: 1.5 }, 600000)), 3333);
assert.equal(customLevelScore(900001, 600000, customLimitMs({ type: 'ratio', value: 1.5 }, 600000)), 0);

console.log('\n=== 自定义关卡组：通过 ===\n');
