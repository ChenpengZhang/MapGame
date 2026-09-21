/**
 * core/config.js —— 全局常量与可调参数（最底层，不依赖任何其它模块）
 *
 * 【分层说明】
 *   本文件属于 core（基础层）。core 只放"与具体业务无关的东西"：
 *   常量、全局状态容器、DOM 小工具、事件总线、localStorage 封装。
 *   core 不允许依赖 data / map / game / ui 任何一层。
 *
 * 【想调数值就改这里】
 *   速度、停站、换乘、等车、缩放阈值、配色、合并距离、步行上限……
 *   游戏手感相关的数字全部集中在本文件，避免散落在逻辑里。
 *
 * 注意：js/router.js 里有一份功能等价的成本参数（DEFAULT_PARAMS），
 *       它是寻路器自己的默认值，两者需保持一致（改动时请同步）。
 */

// ============ 地图与数据源 ============

/**
 * 数据文件版本号：重跑数据管线（cptond-convert.js）更新数据后，把这里 +1，
 * 浏览器缓存才会失效并重新下载（URL 带 ?v=N，版本号一变就是全新资源）。
 */
export const DATA_VERSION = 5;

// 注：地图初始中心、数据文件路径、城市列表都按城市区分，见 data/cities.js。

// ============ 站点渲染阈值 ============

export const METRO_MIN_ZOOM = 13;   // 地铁站：放大到更近才显示（站点少，仍可较早出现）
export const BUS_MIN_ZOOM = 15;     // 公交站：放大到该等级才显示（视野渲染 + 抽稀，避免低缩放卡顿）
export const MAX_BUS_RENDER = 8000; // 公交站低缩放时的渲染上限：视野内超过则空间抽稀，避免整城 2.8 万点卡顿

// ============ 配色 ============

/** 线路配色池（按线路 id 哈希取色，同一线路颜色稳定） */
export const LINE_PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6',
  '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324', '#800000', '#aaffc3',
  '#808000', '#000075', '#008080', '#ffd8b1', '#00ffff', '#ff00ff', '#e6beff',
  '#ffe119', '#a9a9a9', '#d2f53c',
];

export const WALK_COLOR = '#6c5ce7';    // 步行（虚线）
export const ROUTE_COLOR = '#111111';   // 已规划乘车段（深色主线）
export const ROUTE_CASING = '#ffffff';  // 已规划乘车段白色描边
export const OPTIMAL_COLOR = '#00b894'; // 最优路线（青绿色）
export const OPTIMAL_CASING = '#ffffff';

// ============ 时间估计模型：距离 / 巡航速度 + 停站时间（后续接入 §8 校准） ============

export const METRO_SPEED_KMH = 35;   // 地铁巡航速度（平均）
export const METRO_DWELL_MIN = 0.6;  // 地铁每站停站时间（分钟）
export const BUS_DWELL_MIN = 0.4;    // 公交每站停站时间（分钟）

// 公交车段行驶模型：0 → 缓慢加速 → 最高巡航速度 → 匀速（路程 = ∫v dt）
// 公交巡航速度按线路平均站间距动态区分：城区密站慢车 → 郊区大站/快车
export const BUS_VMAX_KMH = 36.45;         // 快车/郊区大站最高速度（快车侧再降 10%）
export const BUS_VMAX_LOCAL_KMH = 16;      // 城区密站慢车最高速度
export const BUS_SPACING_LOCAL_KM = 0.5;   // 平均站间距 ≤ 此值 → 慢车
export const BUS_SPACING_EXPRESS_KM = 2.0; // 平均站间距 ≥ 此值 → 快车
export const BUS_ACCEL_MPS2 = 0.3;         // 公交加速度 m/s²（缓慢加速）

// 换乘惩罚（按前后线路模式区分）
export const BUS_BUS_TRANSFER_MIN = 0;     // 公交↔公交：不算时间
export const METRO_METRO_TRANSFER_MIN = 3; // 地铁↔地铁：站内换乘步行
export const BUS_METRO_TRANSFER_MIN = 5;   // 公交↔地铁：下/上地铁

// 等车时间（发车间隔/2 的粗略估计，无时刻表数据，后续可校准）
export const METRO_WAIT_MIN = 2.5;
export const BUS_WAIT_MIN = 5;

// ============ 站点合并与步行规则 ============

/** 同名站点合并距离（公交↔地铁换乘，曾为 500 太激进） */
export const MERGE_DISTANCE_M = 300;

/** 起终点步行上限：不允许超过 1.5km（超过则禁止该站点作为起终点） */
export const MAX_WALK_M = 1500;

/** 步行换乘上限（米）：换乘时两站相距超过合并距离（MERGE_DISTANCE_M）但不超过此值，
 *  可步行前往并按步行速度计时。仅当设置里开启「步行换乘」时生效。 */
export const WALK_TRANSFER_MAX_M = 1500;

/** 步行速度（米/分钟）：步行一律用直线距离 / 该速度估计 */
export const WALK_SPEED_M_PER_MIN = 75;

/** 换乘步行虚线的绘制阈值（米）：两段乘车段端点距离小于此值就不画 */
export const TRANSFER_WALK_MIN_M = 40;
