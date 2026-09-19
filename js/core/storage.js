/**
 * core/storage.js —— localStorage 读写封装（最底层）
 *
 * 【为什么单独一层】
 *   localStorage 在隐私模式/禁用 Cookie 时会直接抛异常。
 *   重构前每个调用点都写了 try/catch（散落各处、很难看），
 *   这里统一兜住，上层代码可以放心调用，不用关心存储是否可用。
 *
 * 【本项目用到的 localStorage key（集中登记，避免互相覆盖）】
 *   mg_amap_key              高德 jsApiKey（只存本地，不上传）
 *   mg_amap_security         高德 securityJsCode
 *   mg_story_unlocked        故事模式已解锁关卡数
 *   mg_tower_state           爬塔纪录 { best, progress }
 *   amapWalkCache_v4         高德步行结果缓存（当前未启用，见 map/walk.js 末尾）
 */

/** 读字符串；不可用或不存在时返回 fallback */
export function readText(key, fallback = '') {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : v;
  } catch (e) {
    return fallback;
  }
}

/** 写字符串；不可用时静默失败 */
export function writeText(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    /* localStorage 不可用（隐私模式等）则忽略 */
  }
}

/** 删除 key */
export function removeKey(key) {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    /* 忽略 */
  }
}

/** 读 JSON；解析失败或不存在时返回 null */
export function readJSON(key) {
  const raw = readText(key, '');
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (e) {
    return null; // 忽略损坏的缓存
  }
}

/** 写 JSON */
export function writeJSON(key, value) {
  try {
    writeText(key, JSON.stringify(value));
  } catch (e) {
    /* 循环引用等异常忽略 */
  }
}

// ============ 高德 Key（只存浏览器本地，绝不进代码/仓库） ============

const KEY_AMAP_KEY = 'mg_amap_key';
const KEY_AMAP_SECURITY = 'mg_amap_security';

export function loadAmapKey() {
  return readText(KEY_AMAP_KEY, '');
}

export function loadAmapSecurity() {
  return readText(KEY_AMAP_SECURITY, '');
}

export function saveAmapKey(key) {
  writeText(KEY_AMAP_KEY, String(key || '').trim());
}

export function saveAmapSecurity(code) {
  writeText(KEY_AMAP_SECURITY, String(code || '').trim());
}

// ============ 步行换乘开关 ============

const KEY_WALK_TRANSFER = 'mg_walk_transfer';

export function loadWalkTransfer() {
  return readText(KEY_WALK_TRANSFER, '') === '1';
}

export function saveWalkTransfer(on) {
  writeText(KEY_WALK_TRANSFER, on ? '1' : '0');
}
