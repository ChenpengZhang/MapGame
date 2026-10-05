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
 *   storyOnly 仅供故事模式教学关使用的小城市，不出现在左上角城市选择里
 *   pinyin    按音节空格分隔的拼音，用于城市菜单按首字母排序、分组和搜索（支持全拼与首字母缩写）
 */
export const CITIES = [
  { id: 'beijing',   name: '北京', center: [116.397, 39.909], sample: 'data/sample.json', pinyin: 'bei jing' },
  { id: 'guangzhou', name: '广州', center: [113.264, 23.129], sample: null, pinyin: 'guang zhou' },
  { id: 'shenzhen',  name: '深圳', center: [114.058, 22.543], sample: null, pinyin: 'shen zhen' },
  { id: 'shanghai',  name: '上海', center: [121.474, 31.230], sample: null, pinyin: 'shang hai' },
  { id: 'wenshan', name: '文山州', center: [105.05664, 24.05421], sample: null, pinyin: 'wen shan zhou', storyOnly: true },
  { id: 'shuanghe', name: '双河', center: [82.0789, 44.899], sample: null, pinyin: 'shuang he', storyOnly: true },
  { id: 'kokdala', name: '可克达拉', center: [81.0, 43.93], sample: null, pinyin: 'ke ke da la', storyOnly: true },
  { id: 'datong', name: '大同', center: [113.3, 40.08], sample: null, pinyin: 'da tong' },
  { id: 'chengdu', name: '成都', center: [104.066, 30.572], sample: null, pinyin: 'cheng du' },
  { id: 'chongqing', name: '重庆', center: [106.551, 29.563], sample: null, pinyin: 'chong qing' },
  { id: 'hangzhou', name: '杭州', center: [120.155, 30.274], sample: null, pinyin: 'hang zhou' },
  { id: 'wuhan', name: '武汉', center: [114.305, 30.593], sample: null, pinyin: 'wu han' },
  { id: 'nanjing', name: '南京', center: [118.796, 32.059], sample: null, pinyin: 'nan jing' },
  { id: 'tianjin', name: '天津', center: [117.201, 39.084], sample: null, pinyin: 'tian jin' },
  { id: 'qingdao', name: '青岛', center: [120.383, 36.067], sample: null, pinyin: 'qing dao' },
  { id: 'kunming', name: '昆明', center: [102.833, 24.880], sample: null, pinyin: 'kun ming' },
  { id: 'xiamen', name: '厦门', center: [118.089, 24.479], sample: null, pinyin: 'xia men' },
  { id: 'jinan', name: '济南', center: [117.000, 36.651], sample: null, pinyin: 'ji nan' },
  { id: 'zhengzhou', name: '郑州', center: [113.625, 34.747], sample: null, pinyin: 'zheng zhou' },
  { id: 'changchun', name: '长春', center: [125.324, 43.817], sample: null, pinyin: 'chang chun' },
];

/** 按 id 取城市对象 */
export function cityById(id) {
  return CITIES.find((c) => c.id === id) || null;
}

/** 默认城市（未选择时用第一个） */
export const DEFAULT_CITY_ID = CITIES[0].id;
