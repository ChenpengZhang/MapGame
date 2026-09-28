/**
 * ui/story.js —— 剧情对话框（Galgame 风格）
 *
 * 【回调驱动，不认识"关卡"】
 *   本模块不知道"剧情放完该干什么"——那是玩法流程的事。
 *   所以 playStory 接收一个 onDone 回调（由 game/session.js 传入）。
 *   这样 ui/ 不必 import game/，依赖方向保持单向。
 *
 * 【地图锁】
 *   剧情播放期间锁地图（storyActive，同时禁止站点点击与滚轮缩放）。
 */

import { show, hide, $ } from '../core/dom.js';
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
  setNudgeListener(true);
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
    setNudgeListener(false);
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
  const label = $('story-next-label');
  if (label) label.textContent = _storyIndex >= _storyLines.length - 1 ? '开始' : '继续';
}

/**
 * 剧情期间点到按钮以外的任何地方（多半是想直接点地图），就让“继续”按钮抖动发光吸引注意。
 * 用捕获阶段监听，地图被锁时也能收到。
 */
function onStrayPointer(event) {
  const btn = $('story-next-btn');
  if (!btn || (event.target && btn.contains?.(event.target))) return;
  btn.classList.remove('nudge');
  void btn.offsetWidth; // 重启动画
  btn.classList.add('nudge');
}

let _nudgeOn = false;
function setNudgeListener(on) {
  if (typeof document === 'undefined' || !document.addEventListener || !document.removeEventListener || on === _nudgeOn) return;
  _nudgeOn = on;
  if (on) document.addEventListener('pointerdown', onStrayPointer, true);
  else document.removeEventListener('pointerdown', onStrayPointer, true);
}

/** 点击“继续”按钮：下一句 */
export function storyNext() {
  _storyIndex++;
  renderStoryLine();
}

/** 收起剧情对话框（切关卡、回菜单时调用，并把回调丢掉避免误触发）。 */
export function hideStory() {
  setNudgeListener(false);
  hide('story-dialog');
  _storyOnDone = null;
}
