/**
 * data/loader.js —— 交通数据加载（只负责"把 JSON 拿回来"，不做索引、不碰界面）
 *
 * 加载策略（与重构前一致）：
 *   1) 先请求全量数据 data/beijing-transit.json（GCJ-02，约 19MB，文件名见 config.js）；
 *   2) 失败（404 / 网络错误 / 解析失败）则回退到 data/sample.json（6 条演示线路），
 *      保证源码 clone 下来没跑过数据管线也能玩。
 *
 * 建索引、建寻路图、渲染首屏这些后续步骤由 game/data-ready.js 的 ensureGameDataReady
 * 在"玩家进入某个模式"时按需触发（懒加载，幂等），不再在 app.js 首屏时加载。
 */

import { DATA_VERSION } from '../core/config.js';
import { state } from '../core/state.js';
import { cityById } from './cities.js';

/**
 * 加载当前城市的线路数据（支持下载进度回调与字节数回调，用于进度条和动态文案）。
 * @param {(fraction:number)=>void} [onProgress] 下载进度回调，fraction ∈ [0,1]；
 *        仅在全量数据下载时触发，sample 兜底不报进度。
 * @param {(bytes:number)=>void} [onSize] 拿到响应头后回调一次真实字节数（Content-Length）。
 *        注意：传输层 gzip/brotli 会让浏览器剥掉 Content-Length，此时不会回调——
 *        调用方应自行降级为"不显示大小"的通用文案。
 * @returns {Promise<{data: object, source: string}>} data 为 { city, count, lines }；
 *          source 是给状态栏显示的来源说明。
 */
export async function loadTransitData(onProgress, onSize) {
  const city = cityById(state.currentCityId) || cityById('beijing');
  const full = 'data/' + city.id + '-transit.json?v=' + DATA_VERSION;
  let data;
  let source;
  try {
    data = await fetchJsonWithProgress(full, onProgress, onSize);
    source = city.name + '全量';
  } catch (e) {
    if (city.sample) {
      state.transitDataHash=null;
      data = await fetch(city.sample + '?v=' + DATA_VERSION).then((r) => r.json());
      source = 'sample.json（演示数据）';
    } else {
      throw e; // 无兜底数据的城市：加载失败直接抛出
    }
  }
  return { data, source };
}

/**
 * 流式读取 fetch 响应并按 Content-Length 报告下载进度。
 * 拿不到 Content-Length 时（chunked 传输 / gzip 被剥头）不报进度，但仍正常返回 JSON。
 */
async function fetchJsonWithProgress(url, onProgress, onSize) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('not found');
  const total = Number(r.headers.get('Content-Length')) || 0;
  if (total && onSize) onSize(total);
  // 无 Content-Length 或环境不支持流式读取（如 Node 桩）→ 直接 r.json()
  if (!total || !r.body || !r.body.getReader) {
    if(!r.arrayBuffer)return r.json(); // Node test response stubs.
    const bytes=new Uint8Array(await r.arrayBuffer());
    await rememberHash(bytes);
    return JSON.parse(new TextDecoder('utf-8').decode(bytes));
  }

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
  await rememberHash(merged);
  return JSON.parse(new TextDecoder('utf-8').decode(merged));
}

async function rememberHash(bytes) {
  state.transitDataHash=null;
  if(typeof crypto !== 'undefined' && crypto.subtle) {
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    state.transitDataHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  }
}
