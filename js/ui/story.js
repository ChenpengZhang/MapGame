/**
 * ui/story.js —— 剧情对话框（Galgame 风格）与教学气泡
 *
 * 【两种 UI】
 *   剧情对话框：#story-dialog，一次一句，点任意位置下一句（speaker 按 type 换样式）；
 *   教学气泡：  #tutorial-bubble，右下角聊天泡泡，点"下一步"逐条显示。
 *
 * 【回调驱动，不认识"关卡"】
 *   本模块不知道"剧情放完该干什么"——那是玩法流程的事。
 *   所以 playStory / playHint 都接收一个 onDone 回调（由 game/session.js 传入：
 *   放完剧情 → 播放教学 → 交还操作权）。
 *   这样 ui/ 不必 import game/，依赖方向保持单向。
 *
 * 【地图锁】
 *   剧情播放期间锁地图（storyActive，同时禁止站点点击与滚轮缩放），
 *   教学气泡出现时解锁——因为教学要求玩家照着提示操作。
 */

import { show, hide, setText, $ } from '../core/dom.js';
import { setMapLocked } from '../map/map-init.js';

// ---------- 剧情 ----------
let _storyLines = [];
let _storyIndex = 0;
let _storyOnDone = null;

/**
 * 播放一段剧情。
 * @param {object} level 关卡对象（读 level.story）
 * @param {Function} onDone 剧情放完后的回调
 */
export function playStory(level, onDone) {
  setMapLocked(true);
  _storyLines = level.story || [];
  _storyIndex = 0;
  _storyOnDone = onDone || null;
  show('story-dialog');
  renderStoryLine();
}

/** 渲染当前这句；放完则收起对话框并回调 */
function renderStoryLine() {
  const line = _storyLines[_storyIndex];
  if (!line) {
    hide('story-dialog');
    const cb = _storyOnDone;
    _storyOnDone = null;
    if (cb) cb();
    return;
  }
  const speaker = $('story-speaker');
  const text = $('story-text');
  if (speaker) {
    if (line.type === 'player') {
      speaker.textContent = '我';
      speaker.className = 'story-speaker player';
    } else if (line.type === 'phone') {
      speaker.textContent = '手机提示';
      speaker.className = 'story-speaker phone';
    } else if (line.type === 'action') {
      speaker.textContent = '';
      speaker.className = 'story-speaker action';
    } else {
      speaker.textContent = '';
      speaker.className = 'story-speaker narration';
    }
  }
  if (text) text.textContent = line.text;
}

/** 点击对话框：下一句 */
export function storyNext() {
  _storyIndex++;
  renderStoryLine();
}

// ---------- 教学气泡 ----------
let _tutorialLines = [];
let _tutorialIndex = 0;
let _tutorialOnDone = null;

/**
 * 播放提示气泡。
 * @param {string[]} lines 逐条显示的文案
 * @param {Function} onDone 全部看完后的回调
 */
export function playHint(lines, onDone) {
  setMapLocked(false); // 提示泡泡出现时，地图可正常操作
  _tutorialLines = lines || [];
  _tutorialIndex = 0;
  _tutorialOnDone = onDone || null;
  show('tutorial-bubble');
  renderTutorialLine();
}

/** 渲染当前这条；看完则收起气泡并回调 */
function renderTutorialLine() {
  const line = _tutorialLines[_tutorialIndex];
  if (!line) {
    hide('tutorial-bubble');
    const cb = _tutorialOnDone;
    _tutorialOnDone = null;
    if (cb) cb();
    return;
  }
  setText('tutorial-text', line);
}

/** 点"下一步"：下一条 */
export function tutorialNext() {
  _tutorialIndex++;
  renderTutorialLine();
}

/** 收起剧情对话框与教学气泡（切关卡、回菜单时调用，并把回调丢掉避免误触发） */
export function hideStoryAndTutorial() {
  hide('story-dialog');
  hide('tutorial-bubble');
  _storyOnDone = null;
  _tutorialOnDone = null;
}
