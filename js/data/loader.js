/**
 * data/loader.js —— 交通数据加载（只负责"把 JSON 拿回来"，不做索引、不碰界面）
 *
 * 加载策略（与重构前一致）：
 *   1) 先请求全量数据 data/beijing-transit.json（约 19MB，GCJ-02）；
 *   2) 失败（404 / 网络错误 / 解析失败）则回退到 data/sample.json（6 条演示线路），
 *      保证源码 clone 下来没跑过数据管线也能玩。
 *
 * 建索引、建寻路图、渲染首屏这些后续步骤由 app.js 依次调用（见 app.js 的 loadGameData）。
 */

import { DATA_FULL, DATA_SAMPLE } from '../core/config.js';

/**
 * 加载线路数据。
 * @returns {Promise<{data: object, source: string}>} data 为 { city, count, lines }；
 *          source 是给状态栏显示的来源说明。
 */
export async function loadTransitData() {
  let data;
  let source;
  try {
    const r = await fetch(DATA_FULL);
    if (!r.ok) throw new Error('not found');
    data = await r.json();
    source = 'beijing-transit.json（全量）';
  } catch (e) {
    data = await fetch(DATA_SAMPLE).then((r) => r.json());
    source = 'sample.json（演示数据）';
  }
  return { data, source };
}
