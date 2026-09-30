/**
 * data/levels.js —— 关卡剧本与模式内容（纯数据，不含任何逻辑）
 *
 * 【分层说明】
 *   这里只声明"游戏里有哪些内容"：跨城市共用的故事关卡及新手教学，
 *   教学通用文案，以及无尽模式的 4 种畸变定义。
 *   改动剧情文案、增删关卡只需改本文件，不用碰任何逻辑代码。
 *
 * 坐标均为 GCJ-02 近似值（与数据源同坐标系）。
 *
 * 字段说明（故事模式关卡）：
 *   id            关卡标识（'tower' / 'random' 为模式专用，不出现在本列表）
 *   cityId        本关使用的城市数据，与玩家在主页选择的城市无关
 *   series        关卡序号（界面显示用）
 *   title         关卡名
 *   timeLimitMin  时限（分钟），可选；不填写则只要求完成路线
 *   origin/dest   { name, lng, lat }
 *   goalText      目标描述
 *   showWalkRanges 是否显示起终点 1.5km 步行范围圈（默认显示）
 *   mapTutorial   绑定地图坐标的分步提示（可选）；transfer 子项用于换乘教学（见第二关）
 *   hideShowAllStops 隐藏“显示全图站点”按钮（新手第一关不引入这个功能）
 *   mapTutorial.notes  钉在起/终点步行范围红圈底端的说明；highlights 高亮的站点与说明；flashHud 出发前闪烁时间 HUD；
 *                      anchors 把某一步的提示固定到指定坐标
 *   scenario      关卡自带情景（noMetro / busSpeedFactor / walkSpeedFactor），可选
 *   story         剧情行：type = 'player' 我 / 'narration' 旁白 / 'action' 舞台指示 / 'phone' 手机提示
 *   success/fail  结算文案
 */

// ============ 故事模式关卡 ============
export const LEVELS = [{
  id: 'guided_intro', cityId: 'shuanghe', series: 1, title: '新手教程',
  color: '#19b7c9',
  origin: { name: '迎宾桥附近', lng: 82.0628, lat: 44.8597 },
  dest: { name: '火车站附近', lng: 82.111, lat: 44.905 },
  scenario: { noMetro: false, busSpeedFactor: 1, walkSpeedFactor: 1 },
  story: [{ type: 'welcome', title: '欢迎来到 RouteGuesser', text: '乘上公交，换乘地铁，探索城市。\n规划从起点到终点的路线，尽可能快地抵达。' }],
  success: '教程完成！你已经亲手规划了一条路线。选站、乘车和换乘的操作在其他模式中也一样，可以去无尽模式的普通难度继续探索！',
  mapTutorial: {
    panel: true, panelOnly: true, mapPractice: true, waitForBusStops: true,
  },
}];

// ============ 无尽模式（爬塔）可选的畸变 ============
// 普通也是其一；四种畸变的成绩分别记录（见 state.towerBest / towerProgress）
// label 是标题（进游戏后左上角关卡描述用），sub 是二级说明（菜单卡片上的小字）。
export const TOWER_SCENARIOS = {
  normal:   { label: '普通', sub: '无特殊效果', scenario: { noMetro: false, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 } },
  noMetro:  { label: '地铁瘫痪', sub: '禁用地铁', scenario: { noMetro: true, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 } },
  busBoost: { label: '一路畅通', sub: '公交加速20%', scenario: { noMetro: false, busSpeedFactor: 1.2, walkSpeedFactor: 1.0 } },
  rain:     { label: '大雨滂沱', sub: '公交/步行减缓50%', scenario: { noMetro: false, busSpeedFactor: 0.5, walkSpeedFactor: 0.5 } },
};

/** 爬塔畸变的展示顺序（菜单与纪录表按此顺序） */
export const TOWER_KEYS = ['normal', 'noMetro', 'busBoost', 'rain'];
