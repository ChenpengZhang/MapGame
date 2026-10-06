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
import { decodeTransitData } from '../core/router-api.js';

/**
 * 加载当前城市的线路数据（支持下载进度回调与字节数回调，用于进度条和动态文案）。
 * @param {(fraction:number)=>void} [onProgress] 下载进度回调，fraction ∈ [0,1]；
 *        仅在全量数据下载时触发，sample 兜底不报进度。
 * @param {(bytes:number)=>void} [onSize] 拿到响应头后回调一次实际传输的字节数（Content-Length，压缩后）。
 *        拿不到时不回调——调用方应自行降级为"不显示大小"的通用文案；读本地缓存时也不回调。
 * @returns {Promise<{data: object, source: string}>} data 为 { city, count, lines }；
 *          source 是给状态栏显示的来源说明。
 */
export async function loadTransitData(onProgress, onSize, cityId = state.currentCityId) {
  const city = cityById(cityId);
  if (!city) throw new Error('未知城市：' + cityId);
  const full = 'data/' + city.id + '-transit.json?v=' + DATA_VERSION;
  let data;
  let source;
  try {
    // 数据文件是 format 2（站点去重、路径差分、预计算的站点合并），解码成统一的内存结构
    data = decodeTransitData(await fetchJsonWithProgress(full, onProgress, onSize));
    source = city.name + '全量';
  } catch (e) {
    if (city.sample) {
      state.transitDataHash=null;
      data = decodeTransitData(await fetch(city.sample + '?v=' + DATA_VERSION).then((r) => r.json()));
      source = 'sample.json（演示数据）';
    } else {
      throw e; // 无兜底数据的城市：加载失败直接抛出
    }
  }
  return { data, source };
}

// 城市数据本地缓存（Cache Storage）：浏览器 HTTP 缓存对 10MB 级的大文件不可靠（实测刷新后会整份重下），
// 这里按 URL（含 ?v=数据版本）自己存一份，刷新/再次进入直接读本地；数据版本一变，旧版本整批删除。
const DATA_CACHE = 'mg-transit-data';

async function openDataCache() {
  try { return typeof caches !== 'undefined' ? await caches.open(DATA_CACHE) : null; }
  catch { return null; } // 非安全上下文、隐私模式等不可用时直接走网络
}

/** 该城市当前版本的数据是否已在本地缓存（用于加载提示：读本地 vs 下载） */
export async function hasCachedTransitData(cityId) {
  const city = cityById(cityId);
  const cache = city && await openDataCache();
  if (!cache) return false;
  return !!(await cache.match('data/' + city.id + '-transit.json?v=' + DATA_VERSION).catch(() => null));
}

/** 删除某城市当前版本的本地缓存（与服务器数据指纹不一致时，下次加载改为重新下载） */
export async function dropCachedTransitData(cityId) {
  const city = cityById(cityId);
  const cache = city && await openDataCache();
  if (cache) await cache.delete('data/' + city.id + '-transit.json?v=' + DATA_VERSION).catch(() => {});
}

/** 删除不是当前数据版本的缓存条目 */
async function pruneOldVersions(cache) {
  for (const request of await cache.keys()) {
    if (new URL(request.url).searchParams.get('v') !== String(DATA_VERSION)) await cache.delete(request);
  }
}

/**
 * 读取城市数据：先查本地缓存，没有再下载（流式读取并报告进度），下载完存入缓存。
 * 进度按解压后的字节数计算：服务器用 X-Uncompressed-Length 告知原始大小；
 * onSize 报告的是实际传输大小（Content-Length，压缩后），用于「约 X MB」文案。
 */
async function fetchJsonWithProgress(url, onProgress, onSize) {
  const cache = await openDataCache();
  const cached = cache ? await cache.match(url).catch(() => null) : null;
  if (cached) {
    try {
      const bytes = new Uint8Array(await cached.arrayBuffer());
      const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
      await rememberHash(bytes);
      return data;
    } catch {
      await cache.delete(url).catch(() => {}); // 缓存损坏：删掉重新下载
    }
  }

  const r = await fetch(url);
  if (!r.ok) throw new Error('not found');
  const encoded = !!r.headers.get('Content-Encoding');
  const transfer = Number(r.headers.get('Content-Length')) || 0;
  const total = Number(r.headers.get('X-Uncompressed-Length')) || (encoded ? 0 : transfer);
  if (transfer && onSize) onSize(transfer);
  let bytes;
  // 无法计算进度或环境不支持流式读取（如 Node 桩）→ 一次读完
  if (!total || !r.body || !r.body.getReader) {
    if (!r.arrayBuffer) return r.json(); // Node test response stubs.
    bytes = new Uint8Array(await r.arrayBuffer());
  } else {
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
    bytes = new Uint8Array(received);
    let off = 0;
    for (const c of chunks) { bytes.set(c, off); off += c.length; }
  }
  await rememberHash(bytes);
  const data = JSON.parse(new TextDecoder('utf-8').decode(bytes));
  if (cache) {
    cache.put(url, new Response(bytes, { headers: { 'Content-Type': 'application/json' } }))
      .then(() => pruneOldVersions(cache))
      .catch(() => {}); // 空间不足等：只是下次还要重新下载
  }
  return data;
}

async function rememberHash(bytes) {
  state.transitDataHash=null;
  if(typeof crypto !== 'undefined' && crypto.subtle) {
    const digest=await crypto.subtle.digest('SHA-256',bytes);
    state.transitDataHash=Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('');
  }
}
