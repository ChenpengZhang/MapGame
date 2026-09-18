/**
 * core/state.js —— 跨模块共享的运行时状态（整个应用唯一可变状态容器）
 *
 * 【为什么要集中放】
 *   拆分前所有状态都是 app.js 里的模块级 let 变量，任何一行代码都能改，
 *   出了 bug 很难知道"是谁把它改坏的"。现在规则很简单：
 *     - 需要被两个以上模块读写的状态 → 放在这里（state.xxx）；
 *     - 只被某一个模块内部用的状态（例如站点图层自己的显隐标记）
 *       → 留在那个模块内部，不要加到这里。
 *   这样"谁能改状态"的范围是可枚举的，排查问题从"翻 2000 行"变成"看一个文件"。
 *
 * 【命名约定】
 *   此处属性名沿用重构前的变量名（ORIGIN / routeStops…），
 *   以便与原代码逐行对照，降低迁移出错概率。
 */

export const state = {
  // ---------- 地图实例 ----------
  map: null,

  // ---------- 数据索引（由 data/index-builder.js 构建，只读使用） ----------
  linesMap: new Map(),          // 线路 id -> 线路对象
  physStops: [],                // 物理点（渲染用）：{id,name,lng,lat,mode,logicalId}
  logicalStops: [],             // 逻辑站（路由用）：{id,name,lng,lat,mode,line_ids,stopByLine}
  logicalById: new Map(),       // 逻辑站 id -> 逻辑站
  physToLogical: new Map(),     // 物理 stop_id -> 逻辑站 id
  physById: new Map(),          // 物理 stop_id -> 物理点
  logicalPhysMap: new Map(),    // 逻辑站 id -> [物理 stop_id]（当前未参与计算，保留备用）

  // ---------- 寻路图 ----------
  routerGraph: null,            // 本地寻路图（router-api.buildGraph 的结果）

  // ---------- 关卡与情景 ----------
  ORIGIN: null,                 // 起点 [lng, lat]（由关卡设定）
  DEST: null,                   // 终点 [lng, lat]
  ORIGIN_NAME: '',              // 起点名称（面板显示用）
  DEST_NAME: '',                // 终点名称
  currentLevel: null,           // 当前关卡对象
  gameMode: 'standard',         // 游戏模式：'standard' 固定关卡 / 'random' 纯随机
  scenario: { noMetro: false, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 },
  // 情景模式（关卡或自由模式可加载）：noMetro 禁用地铁 / busSpeedFactor 公交速度系数 / walkSpeedFactor 步行速度系数

  storyUnlocked: 1,             // 故事模式已解锁关卡数（1 = 仅第 1 关）
  storyActive: false,           // 剧情/教学进行中，禁止地图操作
  mapLocked: false,             // 剧情期间锁定地图拖拽/缩放
  showAllStops: false,          // 规划中"全图显示站点"开关（开启时不能继续规划）

  // ---------- 无尽模式（爬塔） ----------
  towerActive: false,           // 是否处于爬塔中
  towerLayer: 1,                // 当前层
  towerScenarioKey: 'normal',   // 当前畸变 key
  towerLastPass: false,         // 上一层是否通过
  towerBest: { normal: 0, noMetro: 0, busBoost: 0, rain: 0 },     // 各畸变最高层
  towerProgress: { normal: 0, noMetro: 0, busBoost: 0, rain: 0 }, // 各畸变当前进行到第几层（0 = 无进度）

  // ---------- 玩家路线链 ----------
  routeStops: [],               // [S1, S2, ...]：{logical, point}
  routeRides: [],               // [line1, line2, ...]（S[i]→S[i+1] 乘 rides[i]）
  walkToFirstMin: 0,            // 起点→首站步行分钟
  walkToDestMin: 0,             // 末站→终点步行分钟
  finished: false,              // 玩家是否已点击终点完成规划

  // ---------- 地图覆盖物句柄 ----------
  endpointMarkers: [],          // 起终点图钉
  activeOverlays: [],           // 悬浮高亮（线路 + 高亮圈）
  metroBase: [],                // 地铁底图（灰色地铁线）
  candidateMarks: null,         // 候选站点层（MassMarks）
  candidateOverlays: [],        // 候选线路（浅色，候选网络）
  routeOverlayGroups: [],       // 已提交路线按步骤分组（支持撤回）
  optimalResult: null,          // 最优路线结果（router 返回）
  optimalOverlays: [],          // 最优路线覆盖物
};
