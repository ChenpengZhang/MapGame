/**
 * core/dom.js —— DOM 小工具（最底层，不依赖任何其它模块）
 *
 * 【分层说明】
 *   只封装"和业务无关的 DOM 操作"：取元素、改文字、显隐、加载提示、错误提示。
 *   凡是带业务含义的界面（路线面板、结果弹窗、菜单）都不在这里，
 *   它们在 ui/ 层；这里保证 ui/ 与 game/ 不必重复写样板代码。
 *
 * 【统一显隐】
 *   全项目用同一个隐藏类 `.hidden`（定义在 index.html 的样式里），
 *   所有显隐都走 hide() / show() / toggleHidden()，不要直接写 classList。
 */

/** 按 id 取元素（最常用的简写；取不到返回 null） */
export const $ = (id) => document.getElementById(id);

/** 隐藏元素：隐藏类是 index.html 里定义的 .hidden */
export function hide(id) {
  const el = typeof id === 'string' ? $(id) : id;
  if (el) el.classList.add('hidden');
}

/** 显示元素 */
export function show(id) {
  const el = typeof id === 'string' ? $(id) : id;
  if (el) el.classList.remove('hidden');
}

/** 按条件显隐元素 */
export function toggleHidden(id, hidden) {
  if (hidden) hide(id);
  else show(id);
}

/** 设置元素文本 */
export function setText(id, text) {
  const el = $(id);
  if (el) el.textContent = text;
}

// ============ 全局提示（状态栏 / 错误 / 加载 / 中央气泡） ============

/** 底部状态栏文字：告诉玩家"现在该干什么" */
export function setStatus(text) {
  setText('status', text);
}

/** 启动失败等致命错误的红条提示 */
export function showError(html) {
  const el = $('error');
  if (!el) return;
  el.innerHTML = html;
  el.classList.remove('hidden');
}

/** 显示全屏加载遮罩（数据加载、最优路线计算时用） */
export function showLoading(text) {
  setText('loading-text', text || '正在计算最优路线…');
  show('loading-overlay');
}

export function hideLoading() {
  hide('loading-overlay');
}

/** 地图中央的短提示气泡（例如"请关闭全图显示后继续"），1.6 秒后自动消失 */
export function showCenterToast(text) {
  const el = $('center-toast');
  if (!el) return;
  const inner = el.querySelector('.center-toast-inner');
  if (inner) inner.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(el.__timer);
  el.__timer = setTimeout(() => el.classList.add('hidden'), 1600);
}

// ============ 脚本加载 ============

/**
 * 动态插入 <script> 并等它加载完（用于按需加载高德 JS API 或 Leaflet）。
 * 失败时 reject，由调用方决定怎么提示。
 */
export function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('地图脚本加载失败（请检查网络）'));
    document.head.appendChild(s);
  });
}
