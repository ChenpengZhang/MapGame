'use strict';

// ============ 常量 ============
const MAP_CENTER = [116.397, 39.909]; // GCJ-02，与高德一致；OSM 后端由 amap-polyfill.js 在渲染边界统一换算
const DATA_FULL = 'data/beijing-transit.json'; // 唯一数据源：GCJ-02（路由/关卡/交互全部用同一坐标系，两端结果一致）
const DATA_SAMPLE = 'data/sample.json';

function isLeafletBackend() {
  return !!(window.AMap && AMap.__backend === 'leaflet');
}

// 起终点（由关卡设定）
let ORIGIN = null;
let DEST = null;
let ORIGIN_NAME = '';
let DEST_NAME = '';
let currentLevel = null;
// 情景模式（关卡或自由模式可加载）：noMetro 禁用地铁 / busSpeedFactor 公交速度系数 / walkSpeedFactor 步行速度系数
let scenario = { noMetro: false, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 };
let gameMode = 'standard';    // 游戏模式：'standard' 固定关卡 / 'random' 纯随机
let storyUnlocked = 1;        // 故事模式已解锁关卡数（1 = 仅第 1 关）
let storyActive = false;      // 剧情/教学进行中，禁止地图操作
let mapLocked = false;        // 剧情期间锁定地图拖拽/缩放
let showAllStops = false;     // 规划中"全图显示站点"开关（开启时不能继续规划）
let endpointMarkers = [];     // 起终点图钉

// 无尽模式（爬塔）
let towerActive = false;      // 是否处于爬塔中
let towerLayer = 1;           // 当前层
let towerScenarioKey = 'normal'; // 当前畸变 key
let towerLastPass = false;    // 上一层是否通过
const towerBest = { normal: 0, noMetro: 0, busBoost: 0, rain: 0 };      // 各畸变最高层
const towerProgress = { normal: 0, noMetro: 0, busBoost: 0, rain: 0 };  // 各畸变当前进行到第几层（0 = 无进度）

// 无尽模式可选的畸变（普通也是其一；成绩分别记录）
const TOWER_SCENARIOS = {
  normal:   { label: '普通模式', scenario: { noMetro: false, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 } },
  noMetro:  { label: '地铁瘫痪（禁用地铁）', scenario: { noMetro: true, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 } },
  busBoost: { label: '一路畅通（公交加速20%）', scenario: { noMetro: false, busSpeedFactor: 1.2, walkSpeedFactor: 1.0 } },
  rain:     { label: '大雨滂沱（公交/步行减缓50%）', scenario: { noMetro: false, busSpeedFactor: 0.5, walkSpeedFactor: 0.5 } },
};

// 爬塔难度：第 1 层要求 ≤100%（2 倍最优以内），线性收紧到第 12 层 ≤1%，之后保持 1%
function towerThreshold(layer) {
  if (layer <= 1) return 1.0;
  const t = 1.0 - (layer - 1) * (1.0 - 0.01) / 11;
  return Math.max(0.01, t);
}

// 关卡列表（坐标为 GCJ-02 近似值）
// story 行 type：'player' 我 / 'narration' 旁白 / 'action' 舞台指示 / 'phone' 手机提示
// scenarioHint：剧情结束后在右下角弹出的情景提示（无则不弹）
// scenario：关卡自带的情景模式（noMetro / busSpeedFactor / walkSpeedFactor）
const LEVELS = [
  {
    id: 'school', series: 1, title: '漫漫上学路',
    timeLimitMin: 80,
    origin: { name: '望京南湖东园', lng: 116.478, lat: 40.003 },
    dest: { name: '北京中学（东坝南校区）', lng: 116.5555, lat: 39.9665 },
    goalText: '请规划路线以确保自己在80分钟内到校。',
    story: [
      { type: 'narration', text: '今天，是我在北京中学上高中的第一天。' },
      { type: 'narration', text: '然而我其实在前一天都没有看我们学校该怎么走。' },
      { type: 'action', text: '（掏出手机）' },
      { type: 'player', text: '什么？？？' },
      { type: 'player', text: '我信号呢？' },
      { type: 'narration', text: '我低头看了一下我的手表——6：40' },
      { type: 'narration', text: '我记得学校要求我们8：00必须到校。' },
      { type: 'player', text: '坏了。' },
      { type: 'player', text: '这下有麻烦了。' },
    ],
    success: '恭喜！你准时到达了学校——下次不要当P人了，即便你是Peking的。',
    fail: '抱歉——你迟到了，再试试看这回能变得更快么？',
  },
  {
    id: 'yizhuang', series: 2, title: '汽车不可到达之地',
    timeLimitMin: 80,
    origin: { name: '亦庄', lng: 116.50, lat: 39.80 },
    dest: { name: '王府井', lng: 116.41, lat: 39.91 },
    goalText: '请规划路线以确保自己在80分钟内赶到王府井。',
    story: [
      { type: 'player', text: '下班！！！' },
      { type: 'player', text: '听说王府井的“愉悦”又开了新店，这不得下班看看？' },
      { type: 'player', text: '启动！' },
      { type: 'player', text: '趁着天色还早，早点到地方开始逛街吧。' },
    ],
    success: '成功！祝你在“愉悦”玩得愉悦。',
    fail: '晚点到就晚点到嘛，没关系的，但你能做的更好吗？',
  },
  {
    id: 'airport', series: 3, title: '机场到机场',
    timeLimitMin: 200,
    origin: { name: '首都机场T2航站楼', lng: 116.591, lat: 40.080 },
    dest: { name: '大兴机场航站楼', lng: 116.41, lat: 39.51 },
    goalText: '请规划路线以确保自己在200分钟内赶到大兴机场。',
    story: [
      { type: 'player', text: '转机，如此简单。' },
      { type: 'player', text: '去找找机场大巴就好了。' },
    ],
    success: '好险赶上了，来了北京才知道大兴机场都快修到河北去了。',
    fail: '你看着天上远去的飞机，或许这次改签就是你的命运。再来一次，我肯定不会买转机只给4小时的机票。',
  },
  {
    id: 'metrodown', series: 4, title: '瘫痪的地铁',
    timeLimitMin: 250,
    origin: { name: '大兴', lng: 116.34, lat: 39.72 },
    dest: { name: '昌平十三陵', lng: 116.22, lat: 40.25 },
    goalText: '请仅使用公交规划出最快的到达路线。',
    scenario: { noMetro: true },
    scenarioHint: '地铁已被禁用。请仅使用公交规划出最快的到达路线。',
    story: [
      { type: 'phone', text: '【北京市交通委】紧急通知：本月11-13日由于地铁司机师傅放假，全市地铁暂停服务，给您带来的不便敬请谅解。' },
      { type: 'player', text: '什么玩意？地铁司机师傅放假？？？' },
      { type: 'player', text: '这种东西不应该是轮班的么？' },
      { type: 'player', text: '话说这游戏的作者，你就算编也编个好的理由吧......' },
      { type: 'player', text: '但总之确实是地铁用不了了，想想出路吧，今天下午还要赶到昌平......' },
      { type: 'player', text: '或许我应该看看快速公交？' },
    ],
    success: '恭喜！看来昌平不止地铁昌平线。',
    fail: '尽量避免小站公交，再试一次吧。',
  },
  {
    id: 'smooth', series: 5, title: '一路畅通',
    timeLimitMin: 100,
    origin: { name: '海淀中关村', lng: 116.31, lat: 39.98 },
    dest: { name: '房山', lng: 116.13, lat: 39.75 },
    goalText: '请规划路线以确保自己在100分钟内赶到房山。',
    scenario: { busSpeedFactor: 1.2 },
    scenarioHint: '过年地面交通畅通，公交车已被加速20%。请多多利用。',
    story: [
      { type: 'player', text: '过年的北京是真的爽啊......' },
      { type: 'player', text: '到处都没有人。' },
      { type: 'player', text: '我看下怎么去拜访我外甥的姑姑的三姨的远房表哥的连过门的弟弟的孙女。' },
    ],
    success: '公交很爽，快速公交更爽。',
    fail: '过年的北京，如此好的机会没有把握住啊，再试试看呢？',
  },
  {
    id: 'rain', series: 6, title: '大雨滂沱',
    timeLimitMin: 140,
    origin: { name: '安定门', lng: 116.40, lat: 39.95 },
    dest: { name: '门头沟新桥大街', lng: 116.10, lat: 39.94 },
    goalText: '请规划路线以确保自己在140分钟内回到家。',
    scenario: { busSpeedFactor: 0.5, walkSpeedFactor: 0.5 },
    scenarioHint: '大雨天气，公交、步行已被减缓50%。',
    story: [
      { type: 'player', text: '刚吃完晚饭就下起了瓢泼大雨。' },
      { type: 'player', text: '这就是6月的北京。' },
      { type: 'player', text: '我只能望洋兴叹。' },
      { type: 'player', text: '想个办法冲回家吧。' },
    ],
    success: '恭喜！准时到达——更重要的是没被淋成落汤鸡。',
    fail: '下雨还在外面待到这么晚......难不成你就是肖申克的救赎？',
  },
];

// 教学环节通用的后三句（第一句是每关的 goalText）
const TUTORIAL_COMMON = [
  '放大地图并点按任何一个公交/地铁站以开始规划路线。',
  '点击沿途站点以实现抵达/换乘。',
  '点击终点以结束路线。',
];

const METRO_MIN_ZOOM = 13; // 地铁站：放大到更近才显示（站点少，仍可较早出现）
const BUS_MIN_ZOOM = 15;   // 公交站：放大到该等级才显示（视野渲染 + 抽稀，避免低缩放卡顿）
const MAX_BUS_RENDER = 8000; // 公交站低缩放时的渲染上限：视野内超过则空间抽稀，避免整城 2.8 万点卡顿

const LINE_PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#42d4f4', '#f032e6',
  '#bfef45', '#fabed4', '#469990', '#dcbeff', '#9A6324', '#800000', '#aaffc3',
  '#808000', '#000075', '#008080', '#ffd8b1', '#00ffff', '#ff00ff', '#e6beff',
  '#ffe119', '#a9a9a9', '#d2f53c',
];

const WALK_COLOR = '#6c5ce7';   // 步行（虚线）
const ROUTE_COLOR = '#111111';  // 已规划乘车段（深色主线）
const ROUTE_CASING = '#ffffff'; // 已规划乘车段白色描边
const OPTIMAL_COLOR = '#00b894'; // 最优路线（青绿色）
const OPTIMAL_CASING = '#ffffff';

// 时间估计模型：距离 / 巡航速度 + 停站时间（后续接入 §8 校准）
const METRO_SPEED_KMH = 35;   // 地铁巡航速度（平均）
const METRO_DWELL_MIN = 0.6;  // 地铁每站停站时间（分钟）
const BUS_DWELL_MIN = 0.4;    // 公交每站停站时间（分钟）
// 公交车段行驶模型：0 → 缓慢加速 → 最高巡航速度 → 匀速（路程 = ∫v dt）
// 公交巡航速度按线路平均站间距动态区分：城区密站慢车 → 郊区大站/快车
const BUS_VMAX_KMH = 36.45;          // 快车/郊区大站最高速度（快车侧再降 10%）
const BUS_VMAX_LOCAL_KMH = 16;       // 城区密站慢车最高速度
const BUS_SPACING_LOCAL_KM = 0.5;    // 平均站间距 ≤ 此值 → 慢车
const BUS_SPACING_EXPRESS_KM = 2.0;  // 平均站间距 ≥ 此值 → 快车
const BUS_ACCEL_MPS2 = 0.3;   // 公交加速度 m/s²（缓慢加速）

// 换乘惩罚（按前后线路模式区分）
const BUS_BUS_TRANSFER_MIN = 0;      // 公交↔公交：不算时间
const METRO_METRO_TRANSFER_MIN = 3;  // 地铁↔地铁：站内换乘步行
const BUS_METRO_TRANSFER_MIN = 5;    // 公交↔地铁：下/上地铁

// 等车时间（发车间隔/2 的粗略估计，无时刻表数据，后续可校准）
const METRO_WAIT_MIN = 2.5;
const BUS_WAIT_MIN = 5;

const MERGE_DISTANCE_M = 300; // 同名站点合并距离（公交↔地铁换乘，曾为 500 太激进）

// ============ 状态 ============
let map = null;
let metroMarks = null;
let busMarks = null;
let candidateMarks = null;    // 沿途可换乘站点层
let candidateOverlays = [];   // 沿途线路（浅色，候选网络）
let routeOverlayGroups = [];  // 已提交路线按步骤分组（支持撤回）
let linesMap = new Map();
let physStops = [];            // 物理点（渲染用）：{id,name,lng,lat,mode,logicalId}
let logicalStops = [];         // 逻辑站（路由用）：{id,name,lng,lat,mode,line_ids,stopByLine}
let logicalById = new Map();   // 逻辑站 id -> 逻辑站
let physToLogical = new Map(); // 物理 stop_id -> 逻辑站 id
let physById = new Map();      // 物理 stop_id -> 物理点
let logicalPhysMap = new Map();// 逻辑站 id -> [物理 stop_id]
let activeOverlays = [];      // 悬浮高亮
let metroBase = [];
let walking = null;
let routerGraph = null;        // 本地寻路图（TransitRouter.buildGraph）
let optimalResult = null;      // 最优路线结果
let optimalOverlays = [];      // 最优路线覆盖物

// 路线链
let routeStops = [];          // [S1, S2, ...]
let routeRides = [];          // [line1, line2, ...]（S[i]→S[i+1] 乘 rides[i]）
let walkToFirstMin = 0;       // 起点→首站步行分钟
let walkToDestMin = 0;        // 末站→终点步行分钟
let finished = false;

const $ = (id) => document.getElementById(id);

// ============ 启动 ============
// 高德 Key 只存本地缓存（localStorage），不进代码/仓库，避免泄露
function loadAmapKey() { try { return localStorage.getItem('mg_amap_key') || ''; } catch (e) { return ''; } }
function loadAmapSecurity() { try { return localStorage.getItem('mg_amap_security') || ''; } catch (e) { return ''; } }

(async function bootstrap() {
  showLoading('正在加载地图…');
  try {
    const amapKey = loadAmapKey();
    if (amapKey) {
      // 配置了高德 Key → 用高德底图（真实高德脚本会覆盖 amap-polyfill.js 里的兼容层）
      window._AMapSecurityConfig = { securityJsCode: loadAmapSecurity() || '' };
      await loadScript('https://webapi.amap.com/maps?v=2.0&key=' + encodeURIComponent(amapKey));
    } else {
      // 未配置 Key → 免 Key 的 Leaflet + OSM（amap-polyfill.js 提供 AMap 兼容层）
      await loadScript('https://unpkg.com/leaflet@1.9.4/dist/leaflet.js');
    }
    $('city-label').textContent = '北京';
    initMap();
  } catch (e) {
    hideLoading();
    showError('初始化失败：' + (e && e.message ? e.message : e));
  }
})();

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('地图脚本加载失败（请检查网络）'));
    document.head.appendChild(s);
  });
}

// ============ 地图初始化 ============
function initMap() {
  map = new AMap.Map('map', { center: MAP_CENTER, zoom: 11, viewMode: '2D', scrollWheel: false });
  setupZoomInertia();
  loadWalkCache();
  setStatus('选择关卡开始游戏');
  loadData();
}

// 缩放惯性：接管滚轮，用"速度 + 指数衰减"实现带惯性的平滑缩放
let zoomSpeed = 0.5; // 设置里的"缩放速度"滑块（0-1，默认 0.5）

function setupZoomInertia() {
  const el = document.getElementById('map');
  if (!el || !map) return;
  let velocity = 0;        // 缩放速度（zoom/步）
  let running = false;
  let lastStep = 0;
  const STEP_MS = 33;      // 约 30fps：比 60fps 少一半重绘，海量点缩放不卡
  const DECAY = 0.80;      // 每步衰减系数（惯性，越小惯性越弱）
  const EPS = 0.0004;      // 停止阈值
  const SPEED_SCALE = 1.3; // 缩放速度整体调快 30%
  function gain() { return (0.004 + zoomSpeed * 0.096) * SPEED_SCALE; } // 单格速度增量：0→慢，1→快
  function maxV() { return (0.03 + zoomSpeed * 0.11) * SPEED_SCALE; }   // 连续滚动速度上限

  function applyZoom(z) {
    z = Math.min(19, Math.max(3, z));
    try { map.setZoomAndCenter(z, map.getCenter(), true); }
    catch (e) { map.setZoom(z); }
  }
  function tick(now) {
    if (Math.abs(velocity) < EPS) { running = false; return; }
    if (now - lastStep < STEP_MS) { requestAnimationFrame(tick); return; }
    lastStep = now;
    applyZoom(map.getZoom() + velocity);
    velocity *= DECAY;
    if (Math.abs(velocity) < EPS) { running = false; return; }
    requestAnimationFrame(tick);
  }
  function onWheel(e) {
    if (e.ctrlKey || e.metaKey) return; // 保留 Ctrl/⌘+滚轮给浏览器
    if (storyActive) return; // 剧情/教学期间禁止缩放
    e.preventDefault();
    e.stopPropagation();
    let d = e.deltaY;
    if (e.deltaMode === 1) d *= 33;                       // 行模式
    else if (e.deltaMode === 2) d *= (window.innerHeight || 800); // 页模式
    const dir = d > 0 ? -1 : 1;                            // 向下滚=缩小
    const inc = gain() * Math.min(1.5, Math.abs(d) / 100); // 连续滚动累积加速
    velocity += dir * inc;
    const cap = maxV();
    velocity = Math.max(-cap, Math.min(cap, velocity));
    if (!running) { running = true; requestAnimationFrame(tick); }
  }
  el.addEventListener('wheel', onWheel, { passive: false });
}

function drawEndpoints() {
  for (const m of endpointMarkers) m.setMap(null);
  endpointMarkers = [];
  if (!ORIGIN || !DEST) return;
  const o = new AMap.Marker({
    position: ORIGIN, content: '<div class="pin origin flash">起</div>',
    offset: new AMap.Pixel(-12, -12), zIndex: 400,
  });
  o.setMap(map);
  endpointMarkers.push(o);
  const d = new AMap.Marker({
    position: DEST, content: '<div class="pin dest flash">终</div>',
    offset: new AMap.Pixel(-12, -12), zIndex: 400,
  });
  d.setMap(map);
  endpointMarkers.push(d);
  d.on('click', () => finishRoute());
  // 视野适配起终点
  const sw = [Math.min(ORIGIN[0], DEST[0]), Math.min(ORIGIN[1], DEST[1])];
  const ne = [Math.max(ORIGIN[0], DEST[0]), Math.max(ORIGIN[1], DEST[1])];
  map.setBounds(new AMap.Bounds(sw, ne), false, [60, 60, 60, 60]);
}

// ============ 数据加载与索引 ============
async function loadData() {
  let data, source;
  try {
    const r = await fetch(DATA_FULL);
    if (!r.ok) throw new Error('not found');
    data = await r.json();
    source = 'beijing-transit.json（全量）';
  } catch (e) {
    data = await fetch(DATA_SAMPLE).then((r) => r.json());
    source = 'sample.json（演示数据）';
  }

  buildIndex(data);
  routerGraph = TransitRouter.buildGraph(data.lines); // 本地寻路图（供最优路线计算）
  renderMetroContext();
  renderStops();
  setStatus(`已加载 ${linesMap.size} 条线路 / ${physStops.length} 个站点 · ${source} · 选择关卡开始游戏`);
  hideLoading(); // 数据渲染完成，收起启动加载弹窗
}

function buildIndex(data) {
  linesMap = new Map();
  const physMap = new Map(); // stop_id -> 物理点（含 line_ids）

  for (const line of data.lines || []) {
    const id = String(line.id);
    line.color = colorForLine(id);
    line.busVmaxKmh = busVmaxForLine(line); // 公交线路巡航速度（城区慢/郊区快）
    // 地铁环线（内环/外环）首尾相邻，补上闭环距离，供"走站少的那边"
    line.isLoop = /内环|外环/.test(line.name || '');
    if (line.isLoop && line.stops.length >= 2) {
      const a = line.stops[0], b = line.stops[line.stops.length - 1];
      line.wrapDistKm = TransitRouter.haversineKm([a.lng, a.lat], [b.lng, b.lat]);
    }
    linesMap.set(id, line);

    for (const st of line.stops || []) {
      const sid = String(st.id != null ? st.id : st.name + ',' + st.lng + ',' + st.lat);
      let p = physMap.get(sid);
      if (!p) {
        p = {
          id: sid,
          name: String(st.name || '').trim(),
          lng: Number(st.lng),
          lat: Number(st.lat),
          mode: line.mode === 'metro' ? 'metro' : 'bus',
          line_ids: new Set(),
        };
        physMap.set(sid, p);
      }
      p.line_ids.add(id);
      if (line.mode === 'metro') p.mode = 'metro';
    }
  }

  const physList = Array.from(physMap.values());

  // 逻辑站合并：距离 < MERGE_DISTANCE_M 且名字匹配（完全相同 或 一者包含另一者）
  // 用空间网格 + 并查集，支持"地铁苹果园站"↔"苹果园"这类近名换乘
  const CELL = 0.01;
  const grid = new Map();
  for (const p of physList) {
    const k = Math.floor(p.lng / CELL) + ':' + Math.floor(p.lat / CELL);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(p);
  }

  const uf = new Map();
  const rootLines = new Map(); // root -> 该簇内所有线路集合（防止传递合并同一线路的两个站）
  for (const p of physList) {
    uf.set(p.id, p.id);
    rootLines.set(p.id, new Set(p.line_ids));
  }
  const findRoot = (x) => { let r = x; while (uf.get(r) !== r) r = uf.get(r); while (uf.get(x) !== x) { const nx = uf.get(x); uf.set(x, r); x = nx; } return r; };
  const union = (a, b) => {
    const ra = findRoot(a), rb = findRoot(b);
    if (ra === rb) return;
    const la = rootLines.get(ra), lb = rootLines.get(rb);
    for (const lid of la) if (lb.has(lid)) return; // 同一线路的两个站不合并（含传递）
    uf.set(ra, rb);
    for (const lid of la) lb.add(lid);
    rootLines.delete(ra);
  };

  for (const p of physList) {
    const gi = Math.floor(p.lng / CELL), gj = Math.floor(p.lat / CELL);
    for (let di = -1; di <= 1; di++) {
      for (let dj = -1; dj <= 1; dj++) {
        const cell = grid.get((gi + di) + ':' + (gj + dj));
        if (!cell) continue;
        for (const q of cell) {
          if (q.id === p.id) continue;
          if (distM(p, q) < MERGE_DISTANCE_M && (namesMatch(p.name, q.name) || airportTerminalMatch(p.name, q.name)) && !sharesLine(p, q)) union(p.id, q.id);
        }
      }
    }
  }

  const groups = new Map();
  for (const p of physList) {
    const r = findRoot(p.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(p);
  }

  const logicalList = [];
  const p2l = new Map(); // 物理 stop_id -> 逻辑站 id
  const l2p = new Map(); // 逻辑站 id -> [物理 stop_id]

  for (const clusterPhys of groups.values()) {
    clusterPhys.sort((a, b) => (a.id < b.id ? -1 : 1));
    let rep = null;
    for (const p of clusterPhys) if (p.mode === 'metro') { rep = p; break; }
    if (!rep) rep = clusterPhys[0];
    let name = clusterPhys[0].name;
    for (const p of clusterPhys) if (p.name.length < name.length) name = p.name;

    const line_ids = new Set();
    const stopByLine = {};
    const physIds = [];
    for (const p of clusterPhys) {
      for (const lid of p.line_ids) { line_ids.add(lid); stopByLine[lid] = p.id; }
      physIds.push(p.id);
    }

    const id = 'S_' + name + '@' + rep.lng.toFixed(4) + ',' + rep.lat.toFixed(4);
    logicalList.push({
      id, name, lng: rep.lng, lat: rep.lat, mode: rep.mode,
      line_ids: Array.from(line_ids), stopByLine,
    });
    l2p.set(id, physIds);
    for (const pid of physIds) p2l.set(pid, id);
  }

  logicalStops = logicalList;
  logicalById = new Map(logicalList.map((s) => [s.id, s]));
  physToLogical = p2l;
  logicalPhysMap = l2p;
  physById = new Map(physList.map((p) => [p.id, p]));
  physStops = physList.map((p) => ({
    id: p.id, name: p.name, lng: p.lng, lat: p.lat,
    mode: p.mode, logicalId: p2l.get(p.id),
  }));
}

function distM(a, b) {
  const R = 6371000;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
}

// 站名匹配：完全相同，或一者包含另一者（如"苹果园"⊂"地铁苹果园站"），短名需≥2字避免误配
function namesMatch(a, b) {
  a = String(a || '').trim();
  b = String(b || '').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  if (shorter.length < 2) return false;
  const longer = a.length <= b.length ? b : a;
  return longer.includes(shorter);
}

// 机场航站楼特殊匹配：T2/T3/大兴机场的站名不统一（如"T2航站楼"vs"2号航站楼"、"大兴机场"vs"航站楼"），
// 归一化到同一航站楼 key 后视为同名。距离是否过近仍由 MERGE_DISTANCE_M 判断。
function airportTerminalKey(name) {
  name = String(name || '').trim();
  if (!name) return null;
  if (name.includes('大兴机场') || /^航站楼/.test(name)) return 'daxing';
  const isCapital = name.includes('首都机场') || /^T[23]/.test(name) || /^\d号航/.test(name);
  if (!isCapital) return null;
  if (/2/.test(name) && !/3/.test(name)) return 't2';
  if (/3/.test(name) && !/2/.test(name)) return 't3';
  return null;
}
function airportTerminalMatch(a, b) {
  const ka = airportTerminalKey(a), kb = airportTerminalKey(b);
  return ka != null && kb != null && ka === kb;
}

// 是否共享线路：同一条线路上的两个不同站不能合并（否则破坏线路拓扑，乘车边会断）
function sharesLine(a, b) {
  const sa = a.line_ids;
  const sb = b.line_ids;
  for (const lid of sa) if (sb.has(lid)) return true;
  return false;
}

function resolveStop(d) {
  if (!d) return null;
  const lid = d.logicalId || physToLogical.get(d.id);
  return logicalById.get(lid) || null;
}

function colorForLine(id) {
  let h = 0;
  const s = String(id);
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return LINE_PALETTE[h % LINE_PALETTE.length];
}

// 公交线路巡航速度：按平均站间距区分城区慢车/郊区快车
function busVmaxForLine(line) {
  const ds = (line.stops || []).map((s) => s.d).filter((x) => typeof x === 'number' && x > 0);
  if (!ds.length) return BUS_VMAX_KMH; // 无距离数据，按快车
  const avg = ds.reduce((a, b) => a + b, 0) / ds.length;
  const t = Math.max(0, Math.min(1, (avg - BUS_SPACING_LOCAL_KM) / (BUS_SPACING_EXPRESS_KM - BUS_SPACING_LOCAL_KM)));
  return BUS_VMAX_LOCAL_KMH + t * (BUS_VMAX_KMH - BUS_VMAX_LOCAL_KMH);
}

// ============ 非线性动画（淡入/淡出，不拖沓） ============
const ANIM_FADE_IN_MS = 220;
const ANIM_FADE_OUT_MS = 180;
const TRANSFER_WALK_MIN_M = 40; // 换乘步行虚线的绘制阈值（米）
const MAX_WALK_M = 1500;        // 起终点步行上限：不允许超过 1.5km
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

// 把覆盖物透明度从 from 过渡到 to（非线性缓动）；重复调用会取消上一次动画
function tweenAlpha(o, setFn, from, to, duration, onDone) {
  if (o.__tween) { o.__tween.cancel(); o.__tween = null; }
  const t0 = performance.now();
  let raf = 0, ended = false;
  const anim = { cancel() { if (raf) { cancelAnimationFrame(raf); raf = 0; } ended = true; } };
  o.__tween = anim;
  function frame(now) {
    if (ended) return;
    const t = Math.min(1, (now - t0) / duration);
    setFn(from + (to - from) * easeOutCubic(t));
    if (t < 1) raf = requestAnimationFrame(frame);
    else { o.__tween = null; if (onDone) onDone(); }
  }
  raf = requestAnimationFrame(frame);
}

// 返回 {set(alpha), get()}，alpha∈[0,1]；无法淡化的类型返回 null
function overlayAlpha(o) {
  if (!o) return null;
  if (o instanceof AMap.Polyline) {
    return { set: (a) => o.setOptions({ strokeOpacity: a }), get: () => o.getOptions().strokeOpacity };
  }
  if (o instanceof AMap.Circle) {
    const sb = o.__strokeBase != null ? o.__strokeBase : 1;
    const fb = o.__fillBase != null ? o.__fillBase : 0.25;
    return { set: (a) => o.setOptions({ strokeOpacity: a * sb, fillOpacity: a * fb }), get: () => sb };
  }
  if (o instanceof AMap.MassMarks) {
    const base = o.__baseOpacity != null ? o.__baseOpacity : 0.9;
    const c = o.__canvas;
    if (c && c.style) return { set: (a) => { c.style.opacity = a; }, get: () => base };
    return { set: (a) => { try { o.setOptions({ opacity: a }); } catch (e) {} }, get: () => base };
  }
  return null;
}

function fadeInOverlay(o, duration) {
  if (!o) return;
  const info = overlayAlpha(o);
  if (!info) return;
  const to = Math.min(1, Math.max(0, info.get()));
  info.set(0);
  tweenAlpha(o, info.set, 0, to, duration || ANIM_FADE_IN_MS);
}

function fadeOutOverlay(o, duration, onRemoved) {
  if (!o) { if (onRemoved) onRemoved(); return; }
  const info = overlayAlpha(o);
  if (!info) { try { o.setMap(null); } catch (e) {} if (onRemoved) onRemoved(); return; }
  const from = Math.min(1, Math.max(0, info.get()));
  tweenAlpha(o, info.set, from, 0, duration || ANIM_FADE_OUT_MS, () => {
    try { o.setMap(null); } catch (e) {}
    if (onRemoved) onRemoved();
  });
}

// MassMarks 渲染到一个 <canvas>；setMap 后捕获它，供透明度动画使用
function captureMassMarksCanvas(mm, container, before, tries) {
  if (!mm || mm.__canvas || !container) return;
  if (window.AMap && AMap.__backend === 'leaflet') return; // Leaflet 海量点无 canvas，淡化走 setOptions
  tries = tries || 0;
  if (tries > 20) return; // 空数据等极端情况没有 canvas，放弃
  const after = container.querySelectorAll('canvas');
  for (const c of after) if (!before.has(c)) { mm.__canvas = c; return; }
  requestAnimationFrame(() => captureMassMarksCanvas(mm, container, before, tries + 1));
}
function setMassMarksMap(mm, targetMap) {
  const container = (map && map.getContainer) ? map.getContainer() : document.getElementById('map');
  const before = container ? new Set(container.querySelectorAll('canvas')) : new Set();
  mm.setMap(targetMap);
  if (targetMap && container) {
    // 先同步找一次（高德 setMap 通常同步挂载 canvas），再异步兜底
    const after = container.querySelectorAll('canvas');
    for (const c of after) if (!before.has(c)) { mm.__canvas = c; return; }
    captureMassMarksCanvas(mm, container, before, 0);
  }
}

// ============ 通用渲染 ============
let _icons = null;
function getIcons() {
  if (!_icons) _icons = { metroIcon: circleIcon('#e74c3c', 10), busIcon: circleIcon('#3498db', 7) };
  return _icons;
}

function makeMassMarks(data) {
  const { metroIcon, busIcon } = getIcons();
  const mm = new AMap.MassMarks(data, {
    opacity: 0.9,
    zIndex: 110,
    style: [
      { url: metroIcon, size: new AMap.Size(10, 10), anchor: new AMap.Pixel(5, 5) },
      { url: busIcon, size: new AMap.Size(7, 7), anchor: new AMap.Pixel(3.5, 3.5) },
    ],
  });
  mm.__baseOpacity = 0.9;
  return mm;
}

function stopToData(p) {
  return {
    lnglat: [p.lng, p.lat],
    style: p.mode === 'metro' ? 0 : 1,
    id: p.id,
    name: p.name,
    mode: p.mode,
    logicalId: p.logicalId,
  };
}

function renderMetroContext() {
  if (scenario.noMetro) return;
  for (const line of linesMap.values()) {
    if (line.mode !== 'metro') continue;
    if (!line.path || line.path.length < 2) continue;
    const poly = new AMap.Polyline({
      path: line.path, strokeColor: '#e7b7b1', strokeWeight: 2,
      strokeOpacity: 0.55, lineJoin: 'round', zIndex: 50,
    });
    poly.setMap(map);
    fadeInOverlay(poly, 260);
    metroBase.push(poly);
  }
}

function renderStops() {
  // 基础站点层改为"按视野渲染"：初始空数据，显示时再按当前视野填充，
  // 避免 2.8 万公交站常驻渲染导致缩放/平移卡顿。
  metroMarks = makeMassMarks([]);
  busMarks = makeMassMarks([]);

  for (const m of [metroMarks, busMarks]) {
    m.setMap(map);
    m.hide();
    m.on('mouseover', onStopMouseOver);
    m.on('mouseout', onStopMouseOut);
    m.on('click', onStopClick);
  }

  metroMarksShown = false;
  busMarksShown = false;
  updateStopsByZoom();
  // 缩放过程中实时显隐（zoomchange 每次缩放级别变化都触发），缩放结束后刷新视野数据
  map.on('zoomchange', updateStopsByZoom);
  map.on('zoomend', () => { updateStopsByZoom(); scheduleRefreshStops(); });
  map.on('moveend', scheduleRefreshStops);
}

let metroMarksShown = false;
let busMarksShown = false;

// 视野内站点（外扩 35% 边距，避免边缘站点在平移时忽隐忽现）
function viewportStops(mode) {
  if (!map) return [];
  let list = physStops;
  const b = (map.getBounds && map.getBounds()) || null;
  if (b) {
    const sw = b.getSouthWest(), ne = b.getNorthEast();
    const padLng = (ne.getLng() - sw.getLng()) * 0.35;
    const padLat = (ne.getLat() - sw.getLat()) * 0.35;
    const minLng = sw.getLng() - padLng, maxLng = ne.getLng() + padLng;
    const minLat = sw.getLat() - padLat, maxLat = ne.getLat() + padLat;
    list = physStops.filter((p) => p.lng >= minLng && p.lng <= maxLng && p.lat >= minLat && p.lat <= maxLat);
  }
  if (mode) list = list.filter((p) => p.mode === mode);
  if (mode === 'bus' && list.length > MAX_BUS_RENDER) list = thinStopsSpatially(list, MAX_BUS_RENDER);
  return list;
}

// 空间抽稀：网格越来越大，直到点数降到 maxCount 以内（每格保留一个代表点，分布均匀）
function thinStopsSpatially(stops, maxCount) {
  if (stops.length <= maxCount) return stops;
  let cell = 0.001; // 约 100m 起步
  let out = stops;
  for (let iter = 0; iter < 24 && out.length > maxCount; iter++) {
    const seen = new Set();
    out = [];
    for (const p of stops) {
      const k = Math.floor(p.lng / cell) + ':' + Math.floor(p.lat / cell);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(p);
    }
    cell *= 1.4;
  }
  return out.length <= maxCount ? out : out.slice(0, maxCount);
}

// 更新站点层数据为当前视野内的站点（首次 setData 会创建 canvas，顺带捕获供淡入淡出使用）
function setStopData(mm, data) {
  if (!mm) return;
  const container = (map && map.getContainer) ? map.getContainer() : document.getElementById('map');
  const before = container ? new Set(container.querySelectorAll('canvas')) : null;
  mm.setData(data);
  if (container && (!mm.__canvas || !mm.__canvas.isConnected)) {
    mm.__canvas = null;
    captureMassMarksCanvas(mm, container, before, 0);
  }
}

function refreshStopData(mm) {
  if (!mm) return;
  const mode = mm === metroMarks ? 'metro' : 'bus';
  setStopData(mm, viewportStops(mode).map(stopToData));
}

function refreshVisibleStops() {
  if (metroMarksShown) refreshStopData(metroMarks);
  if (busMarksShown) refreshStopData(busMarks);
}

// 防抖：平移/缩放结束后 80ms 再刷新视野内站点，避免连续重绘
let refreshTimer = null;
function scheduleRefreshStops() {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    refreshVisibleStops();
  }, 80);
}

function updateStopsByZoom() {
  if (!map) return;
  // 浏览态或"全图显示"开启时，按缩放显示基础站点；否则（规划中）隐藏
  const showBase = routeStops.length === 0 || showAllStops;
  const z = map.getZoom();
  setStopsVisible(metroMarks, showBase && !scenario.noMetro && z >= METRO_MIN_ZOOM, () => metroMarksShown, (v) => { metroMarksShown = v; });
  setStopsVisible(busMarks, showBase && z >= BUS_MIN_ZOOM, () => busMarksShown, (v) => { busMarksShown = v; }); // 公交站按缩放等级显隐
}

// 站点层显隐：状态变化时才淡入/淡出，避免每次缩放重复触发
function setStopsVisible(mm, show, getShown, setShown) {
  if (!mm) return;
  if (getShown() === show) return;
  setShown(show);
  if (show) {
    refreshStopData(mm); // 显示前按当前视野填充数据（视野渲染）
    mm.show();
    fadeInOverlay(mm);
  } else {
    // 隐藏用 hide() 而非 setMap(null)，这样后续 show() 还能恢复
    const info = overlayAlpha(mm);
    if (!info) { mm.hide(); return; }
    tweenAlpha(mm, info.set, info.get(), 0, ANIM_FADE_OUT_MS, () => mm.hide());
  }
}

// 开始规划时淡出基础站点层（候选站点层接管显示）
function hideBaseStops() {
  setStopsVisible(metroMarks, false, () => metroMarksShown, (v) => { metroMarksShown = v; });
  setStopsVisible(busMarks, false, () => busMarksShown, (v) => { busMarksShown = v; });
}

// 规划中"全图显示站点"开关
function toggleShowAllStops() {
  showAllStops = !showAllStops;
  const btn = $('show-all-btn');
  if (btn) btn.textContent = showAllStops ? '关闭全图显示' : '显示全图站点';
  updateStopsByZoom();
  setStatus(showAllStops ? '全图显示中——点击站点不会继续规划' : '继续点击沿途站点换乘，或点击「终」完成');
}

function showCenterToast(text) {
  const el = $('center-toast');
  if (!el) return;
  el.querySelector('.center-toast-inner').textContent = text;
  el.classList.remove('hidden');
  clearTimeout(el.__timer);
  el.__timer = setTimeout(() => el.classList.add('hidden'), 1600);
}

function circleIcon(color, radius) {
  const size = radius * 2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath();
  ctx.arc(radius, radius, radius, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();
  return c.toDataURL();
}

// ============ 悬浮交互（仅未规划时）============
let hoverTimer = null;

function onStopMouseOver(e) {
  if (storyActive) return; // 剧情/教学期间禁止交互
  const d = resolveStop(e && e.data);
  if (!d) return;
  // 防抖：快速划过密集站点时只处理最后停留的那个，避免反复创建/销毁大量折线
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    renderHighlight(d);
  }, 45);
}

function onStopMouseOut() {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  clearHighlight();
}

function renderHighlight(d) {
  clearHighlight();

  const shown = [];
  for (const id of d.line_ids || []) {
    const line = linesMap.get(id);
    if (!line || !line.path || line.path.length < 2) continue;
    const isMetro = line.mode === 'metro';
    const poly = new AMap.Polyline({
      path: line.path, strokeColor: line.color, strokeWeight: isMetro ? 5 : 3,
      strokeOpacity: 0.95, lineJoin: 'round', zIndex: isMetro ? 210 : 200,
      interactive: false, // OSM：高亮线不拦截鼠标，否则悬浮点点位会闪烁
    });
    poly.setMap(map);
    activeOverlays.push(poly);
    shown.push(line);
  }

  const ring = new AMap.Circle({
    center: [d.lng, d.lat], radius: 150, strokeColor: '#ffffff', strokeWeight: 2,
    fillColor: '#e74c3c', fillOpacity: 0.25, zIndex: 300,
    interactive: false, // OSM：高亮圈不拦截鼠标
  });
  ring.setMap(map);
  activeOverlays.push(ring);

  showInfoCard(d, shown);
}

function clearHighlight() {
  const overlays = activeOverlays;
  activeOverlays = [];
  for (const o of overlays) o.setMap(null); // 悬浮层即时销毁，不做淡出（密集区反复建线会卡）
  $('infocard').classList.add('hidden');
}

function showInfoCard(d, lines) {
  $('info-stop').textContent = d.name + (d.mode === 'metro' ? '（地铁）' : '（公交）');
  const box = $('info-lines');
  box.innerHTML = '';
  for (const l of lines) {
    const tag = document.createElement('span');
    tag.className = 'line-tag';
    tag.style.backgroundColor = l.color || (l.mode === 'metro' ? '#e74c3c' : '#f39c12');
    tag.textContent = l.name;
    box.appendChild(tag);
  }
  $('info-walk').textContent = '';
  $('infocard').classList.remove('hidden');
}

// ============ 路线规划 ============
function onStopClick(e) {
  if (storyActive) return; // 剧情/教学期间禁止开始规划
  if (showAllStops) { showCenterToast('请关闭全图显示后继续'); return; }
  const phys = e && e.data;
  const logical = resolveStop(phys);
  if (!phys || !logical || routeStops.length) return;
  // 起点步行上限：不允许超过 1.5km
  if (TransitRouter.haversineKm(ORIGIN, phys.lnglat) * 1000 > MAX_WALK_M) {
    showCenterToast('距离起点步行超过 1.5km，请选择更近的站点');
    return;
  }
  startRoute({ logical, point: phys.lnglat });
}

function startRoute(d) {
  resetRoute();
  routeOverlayGroups = [[]]; // 第一组：首站标记 + 首段步行
  routeStops = [d];
  updateLegend(); // 开始规划后隐藏图例
  addStopMarker(1, d.point);

  hideBaseStops();

  drawWalkLeg(ORIGIN, d.point).then((w) => {
    walkToFirstMin = w.min;
    renderRoutePanel();
  });

  showCandidateNetwork(d.logical);
  renderRoutePanel();
  $('btn-group').classList.remove('hidden');
  updateButtons();
  setStatus('已选择 ' + d.logical.name + '，点击沿途站点换乘，点击「终」完成');
}

function onCandidateStopClick(phys) {
  if (showAllStops) { showCenterToast('请关闭全图显示后继续'); return; }
  const logical = resolveStop(phys);
  if (!logical) return;
  if (!routeStops.length || finished) return;
  const prev = routeStops[routeStops.length - 1];
  if (String(logical.id) === String(prev.logical.id)) return;
  if (routeStops.some((s) => String(s.logical.id) === String(logical.id))) return;

  const shared = sharedLines(prev.logical, logical);
  if (!shared.length) return;

  const line = shared[0]; // 站数更少优先（同站数时地铁优先）
  // 到达点 = 该线路上的物理站坐标（乘车段终点，也是下一步步行的起点）
  const physStop = findStopInLine(line, logical);
  const point = physStop ? [physStop.lng, physStop.lat] : (phys.lnglat || [logical.lng, logical.lat]);
  const cur = { logical, point };
  routeOverlayGroups.push([]); // 新组：本步站点标记 + 乘车段（供撤回）
  routeRides.push(line);
  routeStops.push(cur);
  addStopMarker(routeStops.length, cur.point);
  drawRideSegment(line, prev.logical, cur.logical);
  // 换乘步行虚线：换乘发生在 prev.logical（上一步终点=本步起点）。
  // 连接「上一条线在 prev 的下车点」↔「本条线在 prev 的上车点」，两者相距较远才画。
  if (routeRides.length >= 2) {
    const prevLine = routeRides[routeRides.length - 2];
    drawTransferWalk(rideEndpoint(prevLine, prev.logical), rideEndpoint(line, prev.logical));
  }
  showCandidateNetwork(cur.logical);
  renderRoutePanel();
  setStatus('继续点击沿途站点换乘，或点击「终」完成');
}

function finishRoute() {
  if (finished) return;
  // 未选择任何站点：直接从起点步行到终点
  if (!routeStops.length) {
    if (TransitRouter.haversineKm(ORIGIN, DEST) * 1000 > MAX_WALK_M) {
      showCenterToast('起点到终点超过 1.5km，无法直接步行到达，请先选站点');
      return;
    }
    routeOverlayGroups.push([]);
    const g = routeOverlayGroups[routeOverlayGroups.length - 1];
    drawWalkLeg(ORIGIN, DEST, g).then((w) => {
      if (routeOverlayGroups[routeOverlayGroups.length - 1] !== g) return;
      walkToFirstMin = w.min;
      walkToDestMin = 0;
      finished = true;
      clearCandidate();
      updateButtons();
      renderRoutePanel();
      computeOptimal();
    });
    return;
  }
  // 终点步行上限：不允许超过 1.5km
  const last = routeStops[routeStops.length - 1];
  if (TransitRouter.haversineKm(last.point, DEST) * 1000 > MAX_WALK_M) {
    showCenterToast('距离终点步行超过 1.5km，请先换乘到更近的站点');
    return;
  }
  routeOverlayGroups.push([]); // 终点步行组
  const g = routeOverlayGroups[routeOverlayGroups.length - 1];
  drawWalkLeg(last.point, DEST, g).then((w) => {
    if (routeOverlayGroups[routeOverlayGroups.length - 1] !== g) return; // 已被撤回
    walkToDestMin = w.min;
    finished = true;
    clearCandidate();   // 到达后隐藏候选站点/线路
    updateButtons();    // 完成后切换为"重新开始"
    renderRoutePanel();
    computeOptimal();
  });
}

function resetRoute() {
  routeStops = [];
  routeRides = [];
  finished = false;
  walkToFirstMin = 0;
  walkToDestMin = 0;
  for (const g of routeOverlayGroups) clearGroupOverlays(g);
  routeOverlayGroups = [];
  clearCandidate();
  clearOptimal();
  showAllStops = false;
  const sab = $('show-all-btn');
  if (sab) sab.textContent = '显示全图站点';
  updateButtons();
  updateLegend(); // 重新开始后恢复图例
  $('route-panel').classList.add('hidden');
  $('btn-group').classList.add('hidden');
  $('result-overlay').classList.add('hidden');
  $('result-toggle-btn').classList.add('hidden');
  updateStopsByZoom();
}

// ============ 最优路线（本地寻路 + 高德步行） ============
function computeOptimal() {
  if (!routerGraph) return;
  showLoading('正在计算最优路线…');
  TransitRouter.findOptimalRoute(routerGraph, ORIGIN, DEST, { allowMetro: !scenario.noMetro, busSpeedFactor: scenario.busSpeedFactor }, routerWalkFn)
    .then((result) => {
      hideLoading();
      if (!result) { setStatus('未找到可行路线'); return; }
      optimalResult = result;
      drawOptimalRoute(result);
      drawOptimalTransfers(result);
      renderRoutePanel();
      if (towerActive) showTowerResult();
      else showResultOverlay();
      setStatus('规划完成 · 已对比最优路线');
    })
    .catch((e) => {
      hideLoading();
      console.error(e);
      setStatus('最优路线计算失败');
    });
}

function drawOptimalRoute(result) {
  clearOptimalOverlays();
  activeWalk(ORIGIN, [result.board.lng, result.board.lat]).then((r) => { if (r.path) drawOptimalWalk(r.path); });
  let prevAlight = null;
  for (const leg of result.legs) {
    if (leg.type !== 'ride') continue;
    const line = linesMap.get(leg.lineId);
    const from = logicalById.get(leg.fromLogicalId);
    const to = logicalById.get(leg.toLogicalId);
    if (!line || !from || !to) continue;
    const sub = lineSegmentPath(line, from, to);
    if (sub && sub.length >= 2) {
      drawOptimalRide(sub);
      // 换乘步行虚线：上一乘车段下车点 ↔ 本乘车段上车点
      if (prevAlight) drawOptimalTransferWalk(prevAlight, sub[0]);
      prevAlight = sub[sub.length - 1];
    }
  }
  activeWalk([result.alight.lng, result.alight.lat], DEST).then((r) => { if (r.path) drawOptimalWalk(r.path); });
}

function drawOptimalWalk(path) {
  const poly = new AMap.Polyline({
    path, strokeColor: OPTIMAL_COLOR, strokeWeight: 4, strokeOpacity: 0.9,
    strokeStyle: 'dashed', dashArray: [10, 8], lineJoin: 'round', zIndex: 382,
  });
  poly.setMap(map);
  tagRouteOverlay(poly, 'optimal', 382);
  fadeInOverlay(poly);
  optimalOverlays.push(poly);
}

function drawOptimalRide(path) {
  const casing = new AMap.Polyline({ path, strokeColor: OPTIMAL_CASING, strokeWeight: 11, strokeOpacity: 0.9, lineJoin: 'round', zIndex: 384 });
  casing.setMap(map);
  tagRouteOverlay(casing, 'optimal', 384);
  fadeInOverlay(casing);
  optimalOverlays.push(casing);
  const main = new AMap.Polyline({ path, strokeColor: OPTIMAL_COLOR, strokeWeight: 7, strokeOpacity: 0.95, lineJoin: 'round', zIndex: 385 });
  main.setMap(map);
  tagRouteOverlay(main, 'optimal', 385);
  fadeInOverlay(main);
  optimalOverlays.push(main);
}

// 标记最优路线的换乘点（橙色"换"图钉）
function drawOptimalTransfers(result) {
  for (const leg of result.legs) {
    if (leg.type !== 'transfer') continue;
    const log = logicalById.get(leg.logicalId);
    if (!log) continue;
    const m = new AMap.Marker({
      position: [log.lng, log.lat],
      content: '<div class="pin transfer">换</div>',
      offset: new AMap.Pixel(-12, -12),
      zIndex: 430,
    });
    m.setMap(map);
    optimalOverlays.push(m);
  }
}

function clearOptimalOverlays() {
  const overlays = optimalOverlays;
  optimalOverlays = [];
  for (const o of overlays) fadeOutOverlay(o);
}

function clearOptimal() {
  clearOptimalOverlays();
  optimalResult = null;
}

function scoreFor(gapRatio) {
  if (gapRatio <= 0.05) return { label: '完美', stars: '⭐⭐⭐', color: '#27ae60' };
  if (gapRatio <= 0.15) return { label: '优秀', stars: '⭐⭐', color: '#2980b9' };
  if (gapRatio <= 0.30) return { label: '良好', stars: '⭐', color: '#f39c12' };
  return { label: '还有差距', stars: '', color: '#c0392b' };
}

// 撤回上一步：仅规划中可用（完成后由"重新开始"重置）
function undoRoute() {
  if (finished) return; // 完成后不可撤回
  if (!routeStops.length) return;
  if (routeStops.length > 1) {
    const g = routeOverlayGroups.pop();
    clearGroupOverlays(g);
    routeRides.pop();
    routeStops.pop();
    const prev = routeStops[routeStops.length - 1];
    showCandidateNetwork(prev.logical);
    renderRoutePanel();
    setStatus('已撤回一步，可继续选择');
    return;
  }
  resetRoute();
}

// ---- 候选网络（当前站可换乘的线路 + 沿途站点）----
function showCandidateNetwork(stop) {
  clearCandidate();
  const lines = allowedLines(stop.line_ids);

  for (const line of lines) {
    if (!line.path || line.path.length < 2) continue;
    const poly = new AMap.Polyline({
      path: line.path, strokeColor: line.color,
      strokeWeight: line.mode === 'metro' ? 4 : 2.5, strokeOpacity: 0.7,
      lineJoin: 'round', zIndex: 180,
    });
    poly.setMap(map);
    fadeInOverlay(poly);
    candidateOverlays.push(poly);
  }

  // 沿途站点 = 只显示候选线路上真实经过的物理站（不显示合并进来的公交/地铁"小弟"）。
  // 例如地铁线过菜户营，只显示红色的地铁点；除非真有从当前站出发的公交线也过菜户营。
  // 仍按"换乘枢纽优先 + 就近优先"排序并设上限，避免海量点拖慢地图。
  const lineIdSet = new Set(lines.map((l) => String(l.id)));
  const curPt = { lng: stop.lng, lat: stop.lat };
  const onLogicals = [];
  for (const ls of logicalStops) {
    const ids = [];
    for (const lid of ls.line_ids) {
      if (!lineIdSet.has(lid)) continue;
      const pid = ls.stopByLine[lid];
      if (pid) ids.push(pid);
    }
    if (ids.length) onLogicals.push({ ls, ids: Array.from(new Set(ids)) });
  }
  onLogicals.sort((a, b) => {
    const ha = a.ls.line_ids.length >= 2 ? 0 : 1; // 多线换乘枢纽优先
    const hb = b.ls.line_ids.length >= 2 ? 0 : 1;
    if (ha !== hb) return ha - hb;
    return distM({ lng: a.ls.lng, lat: a.ls.lat }, curPt) - distM({ lng: b.ls.lng, lat: b.ls.lat }, curPt);
  });
  const MAX_CANDIDATE_POINTS = 3000;
  const points = [];
  for (const { ids } of onLogicals) {
    for (const pid of ids) {
      const p = physById.get(pid);
      if (p) points.push(p);
    }
    if (points.length >= MAX_CANDIDATE_POINTS) break;
  }
  candidateMarks = makeMassMarks(points.map(stopToData));
  setMassMarksMap(candidateMarks, map);
  fadeInOverlay(candidateMarks);
  candidateMarks.on('click', (e) => {
    const dd = e && e.data;
    if (dd) onCandidateStopClick(dd);
  });
  candidateMarks.on('mouseover', onStopMouseOver);
  candidateMarks.on('mouseout', onStopMouseOut);
}

function clearCandidate() {
  const polylines = candidateOverlays;
  candidateOverlays = [];
  for (const o of polylines) fadeOutOverlay(o);
  const mm = candidateMarks;
  candidateMarks = null;
  if (mm) fadeOutOverlay(mm);
}

// ---- 路线绘制 ----
function currentGroup() {
  if (!routeOverlayGroups.length) routeOverlayGroups.push([]);
  return routeOverlayGroups[routeOverlayGroups.length - 1];
}
function clearGroupOverlays(g) {
  for (const o of g) fadeOutOverlay(o);
}

function addStopMarker(index, lnglat) {
  const m = new AMap.Marker({
    position: lnglat,
    content: '<div class="pin route">' + index + '</div>',
    offset: new AMap.Pixel(-12, -12), zIndex: 420,
  });
  m.setMap(map);
  currentGroup().push(m);
}

// 路线悬停置顶：鼠标移到某条路线（玩家/最优）时，把整条路线提到最前
const FRONT_Z = 3000;

function allRouteOverlays() {
  const arr = [];
  for (const g of routeOverlayGroups) for (const o of g) arr.push(o);
  for (const o of optimalOverlays) arr.push(o);
  return arr;
}

function tagRouteOverlay(overlay, group, baseZ) {
  overlay._group = group;
  overlay._baseZ = baseZ;
  overlay.on('mouseover', () => {
    for (const o of allRouteOverlays()) {
      if (o._group === group) o.setOptions({ zIndex: FRONT_Z });
      else o.setOptions({ zIndex: o._baseZ });
    }
  });
  overlay.on('mouseout', () => {
    for (const o of allRouteOverlays()) o.setOptions({ zIndex: o._baseZ });
  });
}

function drawRideSegment(line, fromStop, toStop) {
  const sub = lineSegmentPath(line, fromStop, toStop);
  if (!sub || sub.length < 2) return;
  const casing = new AMap.Polyline({
    path: sub, strokeColor: ROUTE_CASING, strokeWeight: 11,
    strokeOpacity: 1, lineJoin: 'round', zIndex: 395,
  });
  casing.setMap(map);
  tagRouteOverlay(casing, 'player', 395);
  fadeInOverlay(casing);
  currentGroup().push(casing);
  const main = new AMap.Polyline({
    path: sub, strokeColor: ROUTE_COLOR, strokeWeight: 6,
    strokeOpacity: 1, lineJoin: 'round', zIndex: 396,
  });
  main.setMap(map);
  tagRouteOverlay(main, 'player', 396);
  fadeInOverlay(main);
  currentGroup().push(main);
}

// 换乘步行：换乘站上，上一乘车段的下车点 ↔ 下一乘车段的上车点（物理站可能相距较远）。
// 距离超过阈值时画一段虚线表示步行；不计时（时间仍走原来的换乘惩罚）。
function rideEndpoint(line, logicalStop) {
  const st = findStopInLine(line, logicalStop);
  if (!st || !line.path || line.path.length < 2) return null;
  const i = nearestPathIndex(line.path, [st.lng, st.lat]);
  return line.path[i];
}

function drawTransferWalk(p1, p2) {
  if (!p1 || !p2) return;
  if (TransitRouter.haversineKm(p1, p2) * 1000 < TRANSFER_WALK_MIN_M) return;
  const poly = new AMap.Polyline({
    path: [p1, p2], strokeColor: WALK_COLOR, strokeWeight: 3, strokeOpacity: 0.9,
    strokeStyle: 'dashed', dashArray: [6, 6], lineJoin: 'round', zIndex: 388,
  });
  poly.setMap(map);
  tagRouteOverlay(poly, 'player', 388);
  fadeInOverlay(poly);
  currentGroup().push(poly);
}

function drawOptimalTransferWalk(p1, p2) {
  if (!p1 || !p2) return;
  if (TransitRouter.haversineKm(p1, p2) * 1000 < TRANSFER_WALK_MIN_M) return;
  const poly = new AMap.Polyline({
    path: [p1, p2], strokeColor: OPTIMAL_COLOR, strokeWeight: 3, strokeOpacity: 0.9,
    strokeStyle: 'dashed', dashArray: [6, 6], lineJoin: 'round', zIndex: 383,
  });
  poly.setMap(map);
  tagRouteOverlay(poly, 'optimal', 383);
  fadeInOverlay(poly);
  optimalOverlays.push(poly);
}

function lineSegmentPath(line, stopA, stopB) {
  const a = findStopInLine(line, stopA);
  const b = findStopInLine(line, stopB);
  if (!a || !b || !line.path || line.path.length < 2) return null;
  const ia = nearestPathIndex(line.path, [a.lng, a.lat]);
  const ib = nearestPathIndex(line.path, [b.lng, b.lat]);
  const i0 = Math.min(ia, ib), i1 = Math.max(ia, ib);

  let sub;
  // 环线：闭合路径上有两条弧，选较短的那条（走站少的那边）
  if (line.isLoop && (line.path.length - i1) + i0 < i1 - i0) {
    sub = line.path.slice(i1).concat(line.path.slice(0, i0 + 1));
  } else {
    sub = line.path.slice(i0, i1 + 1);
  }
  // 让折线从 stopA 走向 stopB：若首端更靠近 stopB 则反转
  const startNearB = TransitRouter.haversineKm(sub[0], [b.lng, b.lat]) < TransitRouter.haversineKm(sub[0], [a.lng, a.lat]);
  if (startNearB) sub = sub.slice().reverse();
  return sub;
}

function nearestPathIndex(path, pt) {
  let best = 0, bd = Infinity;
  for (let i = 0; i < path.length; i++) {
    const dx = path[i][0] - pt[0], dy = path[i][1] - pt[1];
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function findStopInLine(line, logicalStop) {
  const sid = logicalStop && logicalStop.stopByLine ? logicalStop.stopByLine[String(line.id)] : null;
  if (sid) {
    const s = (line.stops || []).find((x) => String(x.id) === String(sid));
    if (s) return s;
  }
  return (line.stops || []).find((s) => String(s.id) === String(logicalStop && logicalStop.id));
}

// 按设置返回可用线路（禁用地铁时过滤地铁线）
function allowedLines(lineIds) {
  return (lineIds || []).map((id) => linesMap.get(id)).filter((l) => l && (!scenario.noMetro || l.mode !== 'metro'));
}

function sharedLines(s1, s2) {
  const set1 = new Set(s1.line_ids || []);
  const shared = [];
  for (const id of s2.line_ids || []) {
    if (!set1.has(id)) continue;
    const line = linesMap.get(id);
    if (!line) continue;
    if (scenario.noMetro && line.mode === 'metro') continue;
    shared.push(line);
  }
  // 站数更少优先：避免地铁环线绕远、公交坐慢车；站数相同时地铁优先
  shared.sort((a, b) => {
    const stA = rideStats(a, s1, s2);
    const stB = rideStats(b, s1, s2);
    const segA = stA ? stA.segments : Infinity;
    const segB = stB ? stB.segments : Infinity;
    if (segA !== segB) return segA - segB;
    return (a.mode === 'metro' ? 0 : 1) - (b.mode === 'metro' ? 0 : 1);
  });
  return shared;
}

// ---- 步行（高德 Walking 插件 → 虚线；起终点缓存，同一请求只调一次 API）----
const WALK_CACHE_KEY = 'amapWalkCache_v4';
const walkCache = new Map();     // key -> {path, dist, min, ts}
const walkInFlight = new Map();  // key -> Promise（并发去重）

function loadWalkCache() {
  try {
    // 迁移：清除旧版本缓存（含错误分钟数的脏数据）
    try { localStorage.removeItem('amapWalkCache_v1'); } catch (e) {}
    try { localStorage.removeItem('amapWalkCache_v2'); } catch (e) {}
    try { localStorage.removeItem('amapWalkCache_v3'); } catch (e) {}
    const raw = localStorage.getItem(WALK_CACHE_KEY);
    if (raw) {
      for (const [k, v] of Object.entries(JSON.parse(raw))) walkCache.set(k, v);
    }
  } catch (e) { /* 忽略损坏缓存 */ }
}

function saveWalkCache() {
  try {
    let obj = {};
    for (const [k, v] of walkCache) obj[k] = v;
    let s = JSON.stringify(obj);
    // 超限时按最旧优先删除
    while (s.length > 3.5 * 1024 * 1024 && walkCache.size > 0) {
      let oldestK = null, oldestTs = Infinity;
      for (const [k, v] of walkCache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestK = k; }
      }
      if (oldestK == null) break;
      walkCache.delete(oldestK);
      obj = {};
      for (const [k, v] of walkCache) obj[k] = v;
      s = JSON.stringify(obj);
    }
    localStorage.setItem(WALK_CACHE_KEY, s);
  } catch (e) { /* localStorage 不可用则忽略 */ }
}

function pointStr(pt) {
  return pt[0].toFixed(6) + ',' + pt[1].toFixed(6);
}
// 双向复用：A→B 与 B→A 共享同一缓存（路径按 key 顺序存储，方向按需翻转）
function walkKey(a, b) {
  const p1 = pointStr(a), p2 = pointStr(b);
  return p1 < p2 ? p1 + '|' + p2 : p2 + '|' + p1;
}

function ensureWalking(cb) {
  if (walking) { cb(walking); return; }
  AMap.plugin('AMap.Walking', () => {
    walking = new AMap.Walking({}); // 不绑定 map，自己画虚线
    cb(walking);
  });
}

function drawWalkPolyline(path, g) {
  const poly = new AMap.Polyline({
    path, strokeColor: WALK_COLOR, strokeWeight: 4, strokeOpacity: 0.95,
    strokeStyle: 'dashed', dashArray: [12, 8], lineJoin: 'round', zIndex: 190,
  });
  poly.setMap(map);
  tagRouteOverlay(poly, 'player', 190);
  fadeInOverlay(poly);
  (g || currentGroup()).push(poly);
}

// 步行距离/时间：直接用步行路径折线长度算（不依赖高德字段名/单位，稳定可靠）
function pathLengthMeters(path) {
  if (!path || path.length < 2) return 0;
  let total = 0;
  for (let i = 1; i < path.length; i++) {
    total += TransitRouter.haversineKm(path[i - 1], path[i]) * 1000;
  }
  return total;
}

function drawWalkLeg(from, to, g) {
  g = g || currentGroup();
  return activeWalk(from, to).then((r) => {
    drawWalkPolyline(r.path || [from, to], g);
    return { dist: r.dist, min: r.min };
  });
}

// 取步行结果（复用缓存/并发去重/方向归一化），不画线；供玩家路线与寻路器共用
function getWalkResult(from, to) {
  const key = walkKey(from, to);
  const keyFirst = key.split('|')[0];
  const reverse = pointStr(from) !== keyFirst;
  const orient = (path) => (path ? (reverse ? path.slice().reverse() : path) : null);

  const cached = walkCache.get(key);
  if (cached) return Promise.resolve({ dist: cached.dist, min: cached.min, path: orient(cached.path) });

  let p = walkInFlight.get(key);
  if (!p) {
    p = new Promise((resolve) => {
      ensureWalking((wk) => {
        wk.search(from, to, (status, result) => {
          let c = null;
          if (status === 'complete' && result.routes && result.routes[0]) {
            const r = result.routes[0];
            let path = collectWalkPath(r);
            if (reverse && path.length) path.reverse(); // 归一化：按 key 顺序存储
            let dist = pathLengthMeters(path);
            if (!(dist > 0)) dist = TransitRouter.haversineKm(from, to) * 1000; // 折线为空→直线距离兜底
            c = { path: path.length >= 2 ? path : null, dist, min: dist / 75, ts: Date.now() };
            console.log('[walk]', pointStr(from), '→', pointStr(to), '| 距离', Math.round(dist) + 'm', '| 时间', (dist / 75).toFixed(1) + 'min', '| 折线点数', path.length);
            walkCache.set(key, c);
            saveWalkCache(); // 失败结果不缓存
          }
          walkInFlight.delete(key);
          if (c) {
            resolve({ dist: c.dist, min: c.min, path: c.path });
          } else {
            // 高德步行失败：直线距离兜底（不缓存，下次重试）
            const straight = TransitRouter.haversineKm(from, to) * 1000;
            resolve({ dist: straight, min: straight / 75, path: null });
          }
        });
      });
    });
    walkInFlight.set(key, p);
  }
  return p.then((c) => ({ dist: c.dist, min: c.min, path: orient(c.path) }));
}

// ============ 步行策略（统一用直线距离估计，不依赖高德）============
// 直线步行：球面直线距离
function straightLineWalk(from, to) {
  const distM = TransitRouter.haversineKm(from, to) * 1000;
  // 步行速度受情景影响（如大雨减缓 50% → walkSpeedFactor 0.5）
  const speed = 75 * scenario.walkSpeedFactor;
  return Promise.resolve({ dist: distM, min: distM / speed, path: [from, to] });
}
// 直角（曼哈顿）步行：|Δx| + |Δy|（备用策略）
function manhattanWalk(from, to) {
  const dx = Math.abs(from[0] - to[0]) * 85000; // 经度米（北京纬度近似）
  const dy = Math.abs(from[1] - to[1]) * 111000;
  const distM = dx + dy;
  return Promise.resolve({ dist: distM, min: distM / 75, path: [from, to] });
}
// 当前模式使用的步行策略：一律直线距离估计（含故事模式，不再调高德）
function activeWalk(from, to) {
  return straightLineWalk(from, to);
}
// 供寻路器使用的步行函数（返回 {dist(米), min(分钟)}）
function routerWalkFn(a, b) {
  return activeWalk(a, b).then((r) => ({ dist: r.dist, min: r.min }));
}

function collectWalkPath(route) {
  const pts = [];
  for (const step of route.steps || []) {
    for (const p of step.path || []) {
      const lng = typeof p.lng === 'number' ? p.lng : (p.getLng ? p.getLng() : p[0]);
      const lat = typeof p.lat === 'number' ? p.lat : (p.getLat ? p.getLat() : p[1]);
      if (typeof lng === 'number' && typeof lat === 'number') pts.push([lng, lat]);
    }
  }
  return pts;
}

// ---- 时间估计 ----
function findStopIndexInLine(line, logicalStop) {
  const sid = logicalStop && logicalStop.stopByLine ? logicalStop.stopByLine[String(line.id)] : null;
  if (sid) {
    const i = (line.stops || []).findIndex((x) => String(x.id) === String(sid));
    if (i >= 0) return i;
  }
  return (line.stops || []).findIndex((s) => String(s.id) === String(logicalStop && logicalStop.id));
}

// 公交车段行驶分钟（梯形加速：0→缓加速→线路巡航速度→匀速，路程=∫v dt）
function busSegmentMinutes(distMeters, vmaxKmh) {
  // 公交速度受情景影响（如加速 20% / 减缓 50%）
  const vmax = (vmaxKmh || BUS_VMAX_KMH) * scenario.busSpeedFactor / 3.6;
  const tAccel = vmax / BUS_ACCEL_MPS2;
  const dAccel = 0.5 * BUS_ACCEL_MPS2 * tAccel * tAccel;
  if (distMeters < dAccel) return Math.sqrt((2 * distMeters) / BUS_ACCEL_MPS2) / 60;
  return (tAccel + (distMeters - dAccel) / vmax) / 60;
}

// 单段（两相邻站之间）行驶分钟，不含停站
function segmentRideMinutes(line, distMeters) {
  if (line.mode === 'metro') return (distMeters / 1000 / METRO_SPEED_KMH) * 60;
  return busSegmentMinutes(distMeters, line.busVmaxKmh);
}

function rideStats(line, from, to) {
  const ia = findStopIndexInLine(line, from);
  const ib = findStopIndexInLine(line, to);
  if (ia < 0 || ib < 0) return null;
  if (ia === ib) return { distanceKm: 0, segments: 0, hasDist: false, rideMin: 0 };
  const lo = Math.min(ia, ib), hi = Math.max(ia, ib);
  const N = line.stops.length;

  function rangeStats(a, b) {
    let dist = 0, hasDist = false, rideMin = 0;
    for (let i = a; i < b; i++) {
      const d = line.stops[i].d;
      if (typeof d === 'number' && d > 0) {
        dist += d;
        hasDist = true;
        rideMin += segmentRideMinutes(line, d * 1000);
      }
    }
    return { dist, hasDist, rideMin, segs: b - a };
  }

  // 方向1：线性 lo→hi
  const d1 = rangeStats(lo, hi);
  // 方向2：绕环（仅环线）
  let d2 = null;
  if (line.isLoop && line.wrapDistKm > 0) {
    const seg1 = rangeStats(hi, N - 1);
    const seg2 = rangeStats(0, lo);
    d2 = {
      dist: seg1.dist + line.wrapDistKm + seg2.dist,
      hasDist: true,
      rideMin: seg1.rideMin + segmentRideMinutes(line, line.wrapDistKm * 1000) + seg2.rideMin,
      segs: seg1.segs + 1 + seg2.segs,
    };
  }

  const best = (d2 && d2.rideMin < d1.rideMin) ? d2 : d1;
  return { distanceKm: best.dist, segments: best.segs, hasDist: best.hasDist, rideMin: best.rideMin };
}

function estimateRideMinutes(line, from, to) {
  const st = rideStats(line, from, to);
  if (!st || !st.hasDist) {
    // 兜底：无距离数据时退回"站数 × 每站时长"
    const n = st ? st.segments : 1;
    return n * (line.mode === 'metro' ? 2.5 : 2.0);
  }
  const dwell = line.mode === 'metro' ? METRO_DWELL_MIN : BUS_DWELL_MIN;
  return st.rideMin + st.segments * dwell;
}

function waitMin(line) {
  return line.mode === 'metro' ? METRO_WAIT_MIN : BUS_WAIT_MIN;
}

function transferPenaltyMin(lineA, lineB) {
  const m1 = lineA.mode, m2 = lineB.mode;
  if (m1 !== m2) return BUS_METRO_TRANSFER_MIN; // 公交↔地铁：下/上地铁
  return m1 === 'metro' ? METRO_METRO_TRANSFER_MIN : BUS_BUS_TRANSFER_MIN;
}

function computeTotalMinutes() {
  let total = walkToFirstMin;
  for (let i = 0; i < routeRides.length; i++) {
    total += waitMin(routeRides[i]); // 等车
    total += estimateRideMinutes(routeRides[i], routeStops[i].logical, routeStops[i + 1].logical);
    if (i > 0) total += transferPenaltyMin(routeRides[i - 1], routeRides[i]); // 换乘
  }
  if (finished) total += walkToDestMin;
  return total;
}

function fmtDist(km) {
  if (km == null || !(km > 0)) return '';
  if (km >= 1) return km.toFixed(1) + 'km';
  return Math.round(km * 1000) + 'm';
}
function walkRowHTML(fromName, toName, distKm, timeMin) {
  const d = (distKm != null && distKm > 0) ? '<span class="rp-km">' + fmtDist(distKm) + '</span>' : '';
  return '<div class="rp-row"><span class="rp-desc">🚶 <span class="rp-station">' + fromName + '</span> → <span class="rp-station">' + toName + '</span></span>' +
    '<span class="rp-metrics">' + d + '<span class="rp-time">' + timeMin.toFixed(0) + '分</span></span></div>';
}
function lineRowHTML(lineName, waitMin) {
  return '<div class="rp-row"><span class="rp-desc">🚌 <span class="rp-pill">' + lineName + '</span></span>' +
    '<span class="rp-metrics"><span class="rp-time">' + waitMin.toFixed(0) + '分</span></span></div>';
}
function rideRowHTML(fromName, toName, stops, distKm, rideMin) {
  let m = '';
  if (stops != null) m += '<span class="rp-stops">' + stops + '站</span>';
  if (distKm != null && distKm > 0) m += '<span class="rp-km">' + fmtDist(distKm) + '</span>';
  m += '<span class="rp-time">' + rideMin.toFixed(0) + '分</span>';
  return '<div class="rp-row"><span class="rp-desc"><span class="rp-station">' + fromName + '</span> → <span class="rp-station">' + toName + '</span></span>' +
    '<span class="rp-metrics">' + m + '</span></div>';
}
function transferRowHTML(label, penaltyMin) {
  const t = penaltyMin > 0 ? ('+' + penaltyMin.toFixed(0) + '分') : '0分';
  return '<div class="rp-row"><span class="rp-desc">　↪ <span class="rp-pill">' + label + '</span></span>' +
    '<span class="rp-metrics"><span class="rp-time">' + t + '</span></span></div>';
}

function renderRoutePanel() {
  const panel = $('route-panel');
  const rows = [];
  rows.push('<div class="rp-title">路线规划</div>');

  if (!routeStops.length) {
    // 纯步行路线（未选任何站点直接点终点）
    if (finished) {
      rows.push(walkRowHTML(ORIGIN_NAME, DEST_NAME, TransitRouter.haversineKm(ORIGIN, DEST), walkToFirstMin));
    } else {
      rows.push('<div class="rp-desc" style="color:#888;">…（点击站点开始规划，或点击「终」图钉直接步行到终点）</div>');
    }
    rows.push('<div class="rp-total">总耗时约 ' + computeTotalMinutes().toFixed(0) + ' 分钟</div>');
    appendOptimalComparison(rows);
    panel.innerHTML = rows.join('');
    panel.classList.remove('hidden');
    return;
  }

  // 步行到首站
  rows.push(walkRowHTML(ORIGIN_NAME, routeStops[0].logical.name, TransitRouter.haversineKm(ORIGIN, routeStops[0].point), walkToFirstMin));

  for (let i = 0; i < routeRides.length; i++) {
    const line = routeRides[i];
    const from = routeStops[i].logical, to = routeStops[i + 1].logical;
    rows.push(lineRowHTML(line.name, waitMin(line)));
    const st = rideStats(line, from, to);
    rows.push(rideRowHTML(from.name, to.name, st ? st.segments : null, st && st.hasDist ? st.distanceKm : null, estimateRideMinutes(line, from, to)));
    if (i < routeRides.length - 1) {
      const tp = transferPenaltyMin(line, routeRides[i + 1]);
      rows.push(transferRowHTML(tp > 0 ? '换乘' : '同站换乘', tp));
    }
  }
  if (finished) {
    const last = routeStops[routeStops.length - 1];
    rows.push(walkRowHTML(last.logical.name, DEST_NAME, TransitRouter.haversineKm(last.point, DEST), walkToDestMin));
  } else {
    rows.push('<div class="rp-desc" style="color:#888;">…（继续选站，或点击「终」图钉完成）</div>');
  }
  rows.push('<div class="rp-total">总耗时约 ' + computeTotalMinutes().toFixed(0) + ' 分钟</div>');

  appendOptimalComparison(rows);

  panel.innerHTML = rows.join('');
  panel.classList.remove('hidden');
}

function appendOptimalComparison(rows) {
  if (!optimalResult) return;
  rows.push('<hr style="border:none;border-top:1px dashed #ccc;margin:6px 0;">');
  rows.push('<div class="rp-title" style="color:#00897b;">🏆 最优路线（系统）</div>');
  rows.push(walkRowHTML(ORIGIN_NAME, optimalResult.board.name, TransitRouter.haversineKm(ORIGIN, [optimalResult.board.lng, optimalResult.board.lat]), optimalResult.walkToMin));
  for (const leg of optimalResult.legs) {
    if (leg.type === 'transfer') {
      const la = linesMap.get(leg.fromLineId);
      const lb = linesMap.get(leg.toLineId);
      const tp = (la && lb) ? transferPenaltyMin(la, lb) : 0;
      rows.push(transferRowHTML(tp > 0 ? '换乘' : '同站换乘', tp));
    } else {
      rows.push(lineRowHTML(leg.lineName, leg.waitMin));
      rows.push(rideRowHTML(leg.fromName, leg.toName, leg.stops, leg.distanceKm, leg.rideMin));
    }
  }
  rows.push(walkRowHTML(optimalResult.alight.name, DEST_NAME, TransitRouter.haversineKm([optimalResult.alight.lng, optimalResult.alight.lat], DEST), optimalResult.walkFromMin));
  rows.push('<div class="rp-total" style="color:#00897b;">最优总耗时约 ' + optimalResult.totalMin.toFixed(0) + ' 分钟</div>');

  const playerTotal = computeTotalMinutes();
  const gap = playerTotal - optimalResult.totalMin;
  const gapRatio = optimalResult.totalMin > 0 ? gap / optimalResult.totalMin : 0;
  const s = scoreFor(gapRatio);
  const gapTxt = gapRatio > 0.001
    ? ('比最优慢 ' + (gapRatio * 100).toFixed(0) + '%（+' + gap.toFixed(0) + ' 分钟）')
    : '与最优持平！';
  rows.push('<div style="color:' + s.color + ';font-weight:700;">评分：' + s.label + ' ' + s.stars + ' · ' + gapTxt + '</div>');
}

// ============ 工具 ============
function setStatus(text) {
  $('status').textContent = text;
}

function showError(html) {
  const el = $('error');
  el.innerHTML = html;
  el.classList.remove('hidden');
}

function showLoading(text) {
  $('loading-text').textContent = text || '正在计算最优路线…';
  $('loading-overlay').classList.remove('hidden');
}

function hideLoading() {
  $('loading-overlay').classList.add('hidden');
}

// 按完成状态切换按钮：规划中=上一步+取消；完成后隐藏（由结果弹窗接管）
function updateButtons() {
  // 爬塔时显示"从第1层重来"，其它模式隐藏
  const trb = $('tower-restart-btn');
  if (trb) trb.classList.toggle('hidden', !towerActive);
  if (finished) {
    $('btn-group').classList.add('hidden');
  } else {
    $('btn-group').classList.remove('hidden');
    $('undo-btn').classList.remove('hidden');
    $('reset-btn').textContent = '取消';
  }
}

// 图例只在"浏览/选起始站"的初始阶段显示；开始规划后隐藏
function updateLegend() {
  const legend = $('legend');
  if (routeStops.length > 0) legend.classList.add('hidden');
  else legend.classList.remove('hidden');
}

// ============ 主菜单 / 故事模式 / 设置 ============
// 开发者调试模式：true 时直接解锁所有关卡（仅代码内开关，无 UI；自由模式已不设锁）
const DEV_DEBUG_MODE = true;

function loadStoryProgress() {
  try {
    const v = parseInt(localStorage.getItem('mg_story_unlocked'), 10);
    if (v > 0) storyUnlocked = v;
  } catch (e) { /* 忽略 */ }
  if (DEV_DEBUG_MODE) storyUnlocked = LEVELS.length + 1; // 调试模式：全部解锁
}
function saveStoryProgress() {
  try { localStorage.setItem('mg_story_unlocked', String(storyUnlocked)); } catch (e) { /* 忽略 */ }
}

function buildStoryLevels() {
  const list = $('story-level-list');
  list.innerHTML = '';
  LEVELS.forEach((lv, i) => {
    const unlocked = i < storyUnlocked;
    const card = document.createElement('div');
    card.className = 'story-level' + (unlocked ? ' unlocked' : ' locked');
    card.innerHTML =
      '<div class="slv-num">' + (unlocked ? String(lv.series) : '🔒') + '</div>' +
      '<div class="slv-title">' + lv.title + '</div>';
    if (unlocked) card.addEventListener('click', () => startLevel(lv));
    list.appendChild(card);
  });
}

function showMenu() {
  resetRoute();
  hideStoryAndTutorial();
  setMapLocked(false);
  // 爬塔中途退出：保存当前层与最佳纪录
  if (towerActive) {
    if (towerLayer > towerBest[towerScenarioKey]) towerBest[towerScenarioKey] = towerLayer;
    towerProgress[towerScenarioKey] = towerLayer;
    saveTowerState();
  }
  towerActive = false;
  $('tower-hud').classList.add('hidden');
  $('city-label').textContent = '北京';
  setStatus('选择游戏模式');
  $('main-menu').classList.remove('hidden');
  $('story-menu').classList.add('hidden');
  $('tower-menu').classList.add('hidden');
  $('free-menu').classList.add('hidden');
  $('settings-panel').classList.add('hidden');
  $('result-overlay').classList.add('hidden');
  $('result-toggle-btn').classList.add('hidden');
  // 自由模式始终开放
  const free = $('free-btn');
  if (free) {
    free.classList.remove('locked');
    free.textContent = '🆓 自由模式';
  }
}

function openStoryMenu() {
  buildStoryLevels();
  $('main-menu').classList.add('hidden');
  $('story-menu').classList.remove('hidden');
  setStatus('选择关卡');
}

function hideStoryAndTutorial() {
  $('story-dialog').classList.add('hidden');
  $('tutorial-bubble').classList.add('hidden');
}

function setMapLocked(locked) {
  mapLocked = locked;
  storyActive = locked;
  if (map) {
    try { map.setStatus({ dragEnable: !locked, zoomEnable: !locked, doubleClickZoom: !locked }); } catch (e) { /* 忽略 */ }
  }
}

function beginGameplay(level) {
  setMapLocked(false);
  setStatus((level && level.goalText) || '点击站点开始规划');
}

function startLevel(level, opts) {
  opts = opts || {};
  currentLevel = level;
  gameMode = level.mode || 'standard'; // 固定关卡=standard；随机=random
  ORIGIN = [level.origin.lng, level.origin.lat];
  DEST = [level.dest.lng, level.dest.lat];
  ORIGIN_NAME = level.origin.name;
  DEST_NAME = level.dest.name;
  // 应用情景：优先 opts.scenario（自由模式勾选），其次 level.scenario（关卡自带），否则默认
  scenario = Object.assign({ noMetro: false, busSpeedFactor: 1.0, walkSpeedFactor: 1.0 }, level.scenario, opts.scenario);
  towerActive = (level.id === 'tower');
  if (!towerActive) $('tower-hud').classList.add('hidden');
  $('city-label').textContent = '北京 · ' + level.title;
  $('main-menu').classList.add('hidden');
  $('story-menu').classList.add('hidden');
  $('tower-menu').classList.add('hidden');
  $('settings-panel').classList.add('hidden');
  $('free-menu').classList.add('hidden');
  hideStoryAndTutorial();
  resetRoute();
  applyScenario();
  drawEndpoints();
  if (opts.skipStory || !level.story || !level.story.length) {
    beginGameplay(level);
  } else {
    playStory(level);
  }
}

// ---- 剧情（Galgame 对话框）----
let _storyLines = [];
let _storyIndex = 0;
let _storyOnDone = null;

function playStory(level) {
  setMapLocked(true);
  _storyLines = level.story || [];
  _storyIndex = 0;
  _storyOnDone = () => {
    $('story-dialog').classList.add('hidden');
    // 第一关：完整教学；情景关卡：弹出情景提示；其余：直接进入玩法
    if (level && level.series === 1) playHint([level.goalText || ''].concat(TUTORIAL_COMMON));
    else if (level && level.scenarioHint) playHint([level.scenarioHint]);
    else beginGameplay(level);
  };
  $('story-dialog').classList.remove('hidden');
  renderStoryLine();
}

function renderStoryLine() {
  const line = _storyLines[_storyIndex];
  if (!line) { if (_storyOnDone) _storyOnDone(); return; }
  const speaker = $('story-speaker');
  const text = $('story-text');
  if (line.type === 'player') {
    speaker.textContent = '我';
    speaker.className = 'story-speaker player';
  } else if (line.type === 'phone') {
    speaker.textContent = '手机提示';
    speaker.className = 'story-speaker phone';
  } else if (line.type === 'action') {
    speaker.textContent = '';
    speaker.className = 'story-speaker action';
  } else {
    speaker.textContent = '';
    speaker.className = 'story-speaker narration';
  }
  text.textContent = line.text;
}

function storyNext() {
  _storyIndex++;
  renderStoryLine();
}

// ---- 教学（右下角聊天泡泡）----
let _tutorialLines = [];
let _tutorialIndex = 0;

function playHint(lines) {
  setMapLocked(false); // 提示泡泡出现时，地图可正常操作
  _tutorialLines = lines || [];
  _tutorialIndex = 0;
  $('tutorial-bubble').classList.remove('hidden');
  renderTutorialLine();
}

function renderTutorialLine() {
  const line = _tutorialLines[_tutorialIndex];
  if (!line) {
    $('tutorial-bubble').classList.add('hidden');
    beginGameplay(currentLevel);
    return;
  }
  $('tutorial-text').textContent = line;
}

function tutorialNext() {
  _tutorialIndex++;
  renderTutorialLine();
}

// ============ 纯随机模式（直线步行，零高德调用）============
// 随机偏移范围：离采样站点的距离（米）
const RANDOM_OFFSET_MIN_M = 300;
const RANDOM_OFFSET_MAX_M = 1500; // 上限 1.5km，保证起终点步行不超过 1.5km

// 随机点：采样一个真实站点 + 随机偏移。
// 按站点密度加权：城区站点密集→城区概率高；偏远郊区站点稀疏→很少出现；且点永不远离站点（步行可控）。
function randomPoint() {
  if (!physStops.length) return [116.4, 39.9];
  const stop = physStops[Math.floor(Math.random() * physStops.length)];
  const angle = Math.random() * 2 * Math.PI;
  const dist = RANDOM_OFFSET_MIN_M + Math.random() * (RANDOM_OFFSET_MAX_M - RANDOM_OFFSET_MIN_M);
  const dLat = (dist * Math.cos(angle)) / 111000; // 1° 纬度 ≈ 111km
  const dLng = (dist * Math.sin(angle)) / 85000;  // 1° 经度 ≈ 85km（北京纬度）
  return [stop.lng + dLng, stop.lat + dLat];
}

async function randomLevel(scenario) {
  // 数据未加载完时等待，避免 randomPoint 拿到空数据（此前会导致两点重合→无限递归，需点两次）
  if (!physStops.length) {
    setStatus('数据加载中，请稍候…');
    for (let i = 0; i < 75 && !physStops.length; i++) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!physStops.length) { setStatus('数据加载失败，请刷新重试'); return; }
  }
  // 迭代重抽（带次数上限），保证两点拉开距离、且不会栈溢出
  let o = randomPoint();
  let d = randomPoint();
  for (let i = 0; i < 50 && TransitRouter.haversineKm(o, d) < 3; i++) {
    d = randomPoint();
  }
  const level = {
    id: 'random',
    mode: 'random',
    title: '自由模式',
    goalText: '规划一条从随机起点到随机终点的最快路线。',
    origin: { name: '随机起点', lng: o[0], lat: o[1] },
    dest: { name: '随机终点', lng: d[0], lat: d[1] },
  };
  startLevel(level, { skipStory: true, scenario: scenario || {} });
}

// 自由模式：二级页面选择情景
function openFreeMenu() {
  $('main-menu').classList.add('hidden');
  $('free-menu').classList.remove('hidden');
  setStatus('勾选情景后开始自由模式');
}

function startFreeGame() {
  const sc = {
    noMetro: $('free-no-metro').checked,
    busSpeedFactor: 1.0,
    walkSpeedFactor: 1.0,
  };
  if ($('free-bus-boost').checked) sc.busSpeedFactor *= 1.2;
  if ($('free-rain').checked) { sc.busSpeedFactor *= 0.5; sc.walkSpeedFactor *= 0.5; }
  $('free-menu').classList.add('hidden');
  randomLevel(sc);
}

// ============ 无尽模式（爬塔） ============
function loadTowerState() {
  try {
    const v = JSON.parse(localStorage.getItem('mg_tower_state') || '{}');
    const b = v.best || {}, p = v.progress || {};
    for (const k of Object.keys(towerBest)) {
      const bn = parseInt(b[k], 10); if (bn > 0) towerBest[k] = bn;
      const pn = parseInt(p[k], 10); if (pn > 0) towerProgress[k] = pn;
    }
  } catch (e) { /* 忽略 */ }
}
function saveTowerState() {
  try { localStorage.setItem('mg_tower_state', JSON.stringify({ best: towerBest, progress: towerProgress })); } catch (e) { /* 忽略 */ }
}

function openTowerMenu() {
  updateTowerMenuBest();
  $('main-menu').classList.add('hidden');
  $('tower-menu').classList.remove('hidden');
  setStatus('选择畸变开始爬塔');
}

function updateTowerMenuBest() {
  const map = { normal: 'tower-normal', noMetro: 'tower-no-metro', busBoost: 'tower-bus-boost', rain: 'tower-rain' };
  for (const [key, elId] of Object.entries(map)) {
    const el = $(elId);
    if (!el) continue;
    const best = towerBest[key] || 0;
    const prog = towerProgress[key] || 0;
    let txt = best > 0 ? ('最佳 第 ' + best + ' 层') : '暂无纪录';
    if (prog > 0) txt += '　·　进行中 第 ' + prog + ' 层';
    el.querySelector('.tower-best').textContent = txt;
  }
}

function startTower(key) {
  towerScenarioKey = key;
  // 有进度则从该层继续，否则从第 1 层
  towerLayer = towerProgress[key] > 0 ? towerProgress[key] : 1;
  towerLastPass = false;
  towerActive = true;
  $('tower-menu').classList.add('hidden');
  startTowerRound();
}

function resetTowerFromLayer1() {
  towerLayer = 1;
  towerProgress[towerScenarioKey] = 0;
  towerLastPass = false;
  saveTowerState();
  resetRoute();
  startTowerRound();
}

function startTowerRound() {
  let o = randomPoint(), d = randomPoint();
  for (let i = 0; i < 50 && TransitRouter.haversineKm(o, d) < 3; i++) d = randomPoint();
  const cfg = TOWER_SCENARIOS[towerScenarioKey];
  const thr = towerThreshold(towerLayer);
  const level = {
    id: 'tower',
    mode: 'random',
    title: '无尽模式 · ' + cfg.label,
    goalText: '第 ' + towerLayer + ' 层 · 要求比最优慢 ≤ ' + Math.round(thr * 100) + '%',
    origin: { name: '随机起点', lng: o[0], lat: o[1] },
    dest: { name: '随机终点', lng: d[0], lat: d[1] },
  };
  $('tower-hud').classList.remove('hidden');
  $('tower-layer-label').textContent = '第 ' + towerLayer + ' 层';
  $('tower-threshold-label').textContent = '要求比最优慢 ≤ ' + Math.round(thr * 100) + '%';
  startLevel(level, { skipStory: true, scenario: cfg.scenario });
}

function showTowerResult() {
  const playerTotal = computeTotalMinutes();
  const optTotal = optimalResult ? optimalResult.totalMin : 0;
  const gapRatio = optTotal > 0 ? (playerTotal - optTotal) / optTotal : 0;
  const thr = towerThreshold(towerLayer);
  const pass = gapRatio <= thr;
  towerLastPass = pass;

  let detail = '你的用时 ' + playerTotal.toFixed(0) + ' 分钟';
  if (optTotal > 0) detail += '　·　最快 ' + optTotal.toFixed(0) + ' 分钟';
  detail += '　·　比最优慢 ' + Math.round(gapRatio * 100) + '%（要求 ≤ ' + Math.round(thr * 100) + '%）';
  $('result-times').textContent = detail;

  if (pass) {
    $('result-title').textContent = '🗼 第 ' + towerLayer + ' 层通过！';
    $('result-message').textContent = '下一层要求更严苛：比最优慢 ≤ ' + Math.round(towerThreshold(towerLayer + 1) * 100) + '%';
    $('result-restart').textContent = '下一层';
    // 通过后进度推进到下一层（退出时保存）
    towerProgress[towerScenarioKey] = towerLayer + 1;
    saveTowerState();
  } else {
    if (towerLayer > towerBest[towerScenarioKey]) {
      towerBest[towerScenarioKey] = towerLayer;
    }
    towerProgress[towerScenarioKey] = 0; // 失败后清空进度（重新挑战从第 1 层）
    saveTowerState();
    $('result-title').textContent = '💀 止步第 ' + towerLayer + ' 层';
    $('result-message').textContent = '最高纪录：第 ' + towerBest[towerScenarioKey] + ' 层';
    $('result-restart').textContent = '重新挑战';
  }
  $('result-next').classList.add('hidden');
  $('result-viewmap').classList.remove('hidden');
  $('result-tower-reset').classList.remove('hidden');
  $('result-overlay').classList.remove('hidden');
  $('result-toggle-btn').classList.add('hidden');
}

function applyScenario() {
  const old = metroBase;
  metroBase = [];
  for (const p of old) fadeOutOverlay(p);
  if (!scenario.noMetro) renderMetroContext();
  updateStopsByZoom();
}

// ============ 关卡完成结果弹窗 ============
function showResultOverlay() {
  const playerTotal = computeTotalMinutes();
  const optTotal = optimalResult ? optimalResult.totalMin : 0;
  const limit = currentLevel ? currentLevel.timeLimitMin : null;
  const win = limit == null || playerTotal <= limit;

  $('result-title').textContent = win ? '🎉 恭喜！' : '🥲 抱歉…';
  $('result-message').textContent = win
    ? ((currentLevel && currentLevel.success) || '恭喜！你完成了任务！')
    : ((currentLevel && currentLevel.fail) || '抱歉——再试试更快一点的路线？');

  let detail = '你的用时 ' + playerTotal.toFixed(0) + ' 分钟';
  if (optTotal > 0) detail += '　·　最快 ' + optTotal.toFixed(0) + ' 分钟';
  if (limit != null) detail += '　·　时限 ' + limit + ' 分钟';
  $('result-times').textContent = detail;

  const idx = LEVELS.indexOf(currentLevel);
  const hasNext = idx >= 0 && idx + 1 < LEVELS.length;
  // 通关才解锁下一关；失败时隐藏"下一关"
  if (win && idx >= 0) {
    if (storyUnlocked < idx + 2) { storyUnlocked = idx + 2; saveStoryProgress(); }
  }
  $('result-next').textContent = hasNext ? '下一关' : '通关·回菜单';
  $('result-next').classList.toggle('hidden', !win);
  $('result-tower-reset').classList.add('hidden');
  $('result-overlay').classList.remove('hidden');
  $('result-toggle-btn').classList.add('hidden');
}

function hideResultOverlay() {
  $('result-overlay').classList.add('hidden');
  $('result-toggle-btn').classList.remove('hidden');
}

function nextLevel() {
  const idx = LEVELS.indexOf(currentLevel);
  if (idx >= 0 && idx + 1 < LEVELS.length) {
    startLevel(LEVELS[idx + 1]);
  } else {
    // 通关全部 → 解锁自由模式
    if (storyUnlocked < LEVELS.length + 1) { storyUnlocked = LEVELS.length + 1; saveStoryProgress(); }
    showMenu();
  }
}

function restartLevel() {
  resetRoute();
  if (towerActive) {
    // 爬塔：通过 → 下一层；未通过 → 重新挑战（回到第 1 层）
    towerLayer = towerLastPass ? towerLayer + 1 : 1;
    startTowerRound();
  } else {
    beginGameplay(currentLevel);
  }
}

$('undo-btn').addEventListener('click', undoRoute);
$('show-all-btn').addEventListener('click', toggleShowAllStops);
$('tower-restart-btn').addEventListener('click', resetTowerFromLayer1);
$('reset-btn').addEventListener('click', resetRoute);
$('menu-btn').addEventListener('click', showMenu);
$('story-btn').addEventListener('click', openStoryMenu);
$('tower-btn').addEventListener('click', openTowerMenu);
$('tower-normal').addEventListener('click', () => startTower('normal'));
$('tower-no-metro').addEventListener('click', () => startTower('noMetro'));
$('tower-bus-boost').addEventListener('click', () => startTower('busBoost'));
$('tower-rain').addEventListener('click', () => startTower('rain'));
$('tower-back-btn').addEventListener('click', showMenu);
$('free-btn').addEventListener('click', openFreeMenu);
$('free-start-btn').addEventListener('click', startFreeGame);
$('free-back-btn').addEventListener('click', showMenu);
$('online-btn').addEventListener('click', () => setStatus('排位模式尚未开放，敬请期待'));
$('story-back-btn').addEventListener('click', showMenu);
$('settings-btn').addEventListener('click', () => {
  $('amap-key-input').value = loadAmapKey();
  $('amap-sec-input').value = loadAmapSecurity();
  $('settings-panel').classList.remove('hidden');
});
$('amap-save-btn').addEventListener('click', () => {
  try { localStorage.setItem('mg_amap_key', ($('amap-key-input').value || '').trim()); } catch (e) {}
  try { localStorage.setItem('mg_amap_security', ($('amap-sec-input').value || '').trim()); } catch (e) {}
  showLoading('正在切换地图，请稍候…');
  location.reload();
});
$('settings-close').addEventListener('click', () => $('settings-panel').classList.add('hidden'));
$('zoom-speed-slider').addEventListener('input', (e) => { zoomSpeed = parseFloat(e.target.value) || 0.5; });
$('story-dialog').addEventListener('click', storyNext);
$('tutorial-next').addEventListener('click', tutorialNext);
$('result-next').addEventListener('click', nextLevel);
$('result-restart').addEventListener('click', restartLevel);
$('result-tower-reset').addEventListener('click', resetTowerFromLayer1);
$('result-viewmap').addEventListener('click', hideResultOverlay);
$('result-toggle-btn').addEventListener('click', () => { $('result-toggle-btn').classList.add('hidden'); $('result-overlay').classList.remove('hidden'); });
loadStoryProgress();
loadTowerState();
buildStoryLevels();
