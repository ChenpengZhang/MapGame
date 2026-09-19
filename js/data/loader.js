/**
 * data/loader.js —— 交通数据加载（只负责"把 JSON 拿回来"，不做索引、不碰界面）
 *
 * 加载策略（与重构前一致）：
 *   1) 先请求全量数据 data/beijing-transit.json（约 19MB，GCJ-02）；
 *   2) 失败（404 / 网络错误 / 解析失败）则回退到 data/sample.json（6 条演示线路），
 *      保证源码 clone 下来没跑过数据管线也能玩。
 *
 * 建索引、建寻路图、渲染首屏这些后续步骤由 game/data-ready.js 的 ensureGameDataReady
 * 在"玩家进入某个模式"时按需触发（懒加载，幂等），不再在 app.js 首屏时加载。
 */

import { DATA_FULL, DATA_SAMPLE } from '../core/config.js';

/**
 * 加载线路数据（支持下载进度回调，用于进度条）。
 * @param {(fraction:number)=>void} [onProgress] 下载进度回调，fraction ∈ [0,1]；
 *        仅在全量数据（beijing-transit.json）下载时触发，sample 兜底不报进度。
 * @returns {Promise<{data: object, source: string}>} data 为 { city, count, lines }；
 *          source 是给状态栏显示的来源说明。
 */
export async function loadTransitData(onProgress) {
  let data;
  let source;
  try {
    data = await fetchJsonWithProgress(DATA_FULL, onProgress);
    source = 'beijing-transit.json（全量）';
  } catch (e) {
    data = await fetch(DATA_SAMPLE).then((r) => r.json());
    source = 'sample.json（演示数据）';
  }
  return { data, source };
}

/**
 * 流式读取 fetch 响应并按 Content-Length 报告下载进度。
 * 拿不到 Content-Length 时（chunked 传输）不报进度，但仍正常返回 JSON。
 */
async function fetchJsonWithProgress(url, onProgress) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('not found');
  const total = Number(r.headers.get('Content-Length')) || 0;
  // 无 Content-Length 或环境不支持流式读取（如 Node 桩）→ 直接 r.json()
  if (!total || !r.body || !r.body.getReader) return r.json();

  const reader = r.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (onProgress) onProgress(Math.min(1, received / total));
  }

  // 合并分块 → 文本 → 解析
  let size = 0;
  for (const c of chunks) size += c.length;
  const merged = new Uint8Array(size);
  let off = 0;
  for (const c of chunks) { merged.set(c, off); off += c.length; }
  return JSON.parse(new TextDecoder('utf-8').decode(merged));
}
