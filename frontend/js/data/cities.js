/**
 * data/cities.js —— 城市清单（纯数据，不含逻辑）
 *
 * 【用途】主页「选择城市」菜单、数据加载、地图初始中心；故事模式由关卡自选城市。
 * 【加新城市】1) 用 scripts/cptond-convert.js 转出 data/<id>-transit.json；2) 在这里加一行。
 *
 * 字段说明：
 *   id        城市标识（同时是数据文件名 data/<id>-transit.json 的前缀）
 *   name      中文名（顶栏标题、菜单显示）
 *   center    地图初始中心 [lng, lat]（GCJ-02，与数据源同坐标系）
 *   sample    演示兜底数据文件（只有北京有 sample.json，其余城市无兜底）
 */
export const CITIES = [
  { id: 'beijing',   name: '北京', center: [116.397, 39.909], sample: 'data/sample.json' },
  { id: 'guangzhou', name: '广州', center: [113.264, 23.129], sample: null },
  { id: 'shenzhen',  name: '深圳', center: [114.058, 22.543], sample: null },
  { id: 'shanghai',  name: '上海', center: [121.474, 31.230], sample: null },
  { id: 'wenshan', name: '文山州', center: [105.05664, 24.05421], sample: null },
  { id: 'shuanghe', name: '双河', center: [82.0789, 44.899], sample: null },
  { id: 'kokdala', name: '可克达拉', center: [81.0, 43.93], sample: null },
  { id: 'datong', name: '大同', center: [113.3, 40.08], sample: null },
];

/** 按 id 取城市对象 */
export function cityById(id) {
  return CITIES.find((c) => c.id === id) || null;
}

/** 默认城市（未选择时用第一个） */
export const DEFAULT_CITY_ID = CITIES[0].id;
