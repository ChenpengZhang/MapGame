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
export const LEVELS = [
  {
    id: 'wenshan_intro', cityId: 'wenshan', series: 1, title: '第一站：一条公交线',
    color: '#19b7c9',
    // 起终点分别与电信局、南达站相距约 300m，让首末段步行有明确意义。
    origin: { name: '电信局附近', lng: 105.05664, lat: 24.051514 },
    dest: { name: '南达附近', lng: 105.053636, lat: 24.081111 },
    goalText: '乘坐广南13路抵达终点',
    showWalkRanges: false,
    hideShowAllStops: true,
    mapTutorial: {
      // 标注锚在电信局站的真实坐标，地图平移或缩放时不会漂离站点。
      position: [105.05664, 24.054212],
      waitForBusStops: true,
      beforeReveal: '放大地图显示公交站',
      initial: '点击红色点行走到公交站',
      confirm: '再次点击确认',
      selectLine: '点击线路名称或标线选择线路',
      rideStop: '点击站点乘车到目的地附近',
      finish: '点击终点行走到目的地',
    },
    story: [
      { type: 'narration', text: '请规划合理的路线从起点到终点。' },
    ],
    success: '成功到达南达！你已经学会了选站和乘车，下一关学习换乘。',
    fail: '再试一次：放大地图，选择广南13路沿途的站点，最后点击终点。',
  },
  {
    // 双河全城只有 2路、3路两条公交，两线在博州妇幼保健院等站交叉：
    // 起点只在 3路旁、终点只在 2路旁，必须换乘一次（最优即 3路 → 博州妇幼保健院 → 2路）。
    id: 'shuanghe_transfer', cityId: 'shuanghe', series: 2, title: '第二站：换乘',
    color: '#e4572e',
    origin: { name: '迎宾桥附近', lng: 82.0628, lat: 44.8597 },
    dest: { name: '火车站附近', lng: 82.111, lat: 44.905 },
    goalText: '在换乘站换乘到达终点',
    showWalkRanges: false,
    mapTutorial: {
      // 前半段与第一关相同：锚在迎宾桥，放大地图后引导走到站、确认、选线路
      position: [82.06, 44.8597],
      waitForBusStops: true,
      beforeReveal: '放大地图显示公交站',
      initial: '点击红色点行走到公交站',
      confirm: '再次点击确认',
      selectLine: '点击线路名称或标线选择线路',
      rideStop: '点击站点乘车到目的地附近',
      finish: '点击终点行走到目的地',
      transfer: {
        stopName: '博州妇幼保健院',
        position: [82.0789, 44.899],
        // 到站后的提示放到换乘站与终点之间约一半处（2路 东方嘉苑南门站旁），不压住换乘站
        arrivedPosition: [82.0966, 44.898],
        reach: '乘坐公交抵达换乘站',
        wrongLine: '这条线路到不了换乘站，换一条线路试试',
        previewMap: '换乘站的所有线路图也会在地图中显示',
        previewCard: '换乘站的可换乘信息会展示在预览中',
        arrived: '点击你要换乘的线路抵达终点',
      },
    },
    story: [
      { type: 'narration', text: '这次没有一条线能直接到达终点，需要在途中换乘。' },
    ],
    success: '换乘成功！对于临近的站点，你也可以实现步行换乘——记得在设置中开启这个选项。',
    fail: '再试一次：先乘 3路 到换乘站，再换乘 2路 前往终点。',
  },
  {
    // 可克达拉只有 4 条公交。起点最近的紫金名门（约 190m）只有 68路，要绕一大圈（约 46 分钟）；
    // 多走约 470m 到可克达拉市人民医院乘 63路 直达只要约 26 分钟。限时 32 分钟正好卡住“就近上车”。
    id: 'kokdala_walk_range', cityId: 'kokdala', series: 3, title: '第三站：赶时间',
    color: '#8e5bd8',
    timeLimitMin: 32,
    origin: { name: '紫金名门附近', lng: 81.01101, lat: 43.93415 },
    dest: { name: '文旅小镇附近', lng: 80.982212, lat: 43.925133 },
    mapTutorial: {
      position: [81.01101, 43.93415],
      initial: '点击红圈内的站点出发',
      confirm: '再次点击确认',
      selectLine: '点击线路名称或标线选择线路',
      rideStop: '点击站点乘车到目的地附近',
      finish: '点击终点行走到目的地',
      flashHud: true,
      notes: [
        { at: 'origin', text: '此红圈标示了从起点开始可以步行的范围' },
        { at: 'dest', text: '此红圈标示了从哪里开始可以步行到终点' },
      ],
      highlights: [
        { stopName: '紫金名门', position: [81.011812, 43.932553], text: '最近站可能不是最快的路径', side: 'right' },
        { stopName: '可克达拉市人民医院', position: [81.00531, 43.93244], text: '更远的站提供了更多的线路选择', side: 'left' },
      ],
    },
    story: [
      { type: 'narration', text: '最近的步行站并不一定是最优解。' },
      { type: 'narration', text: '这一关具有时间限制，请在规定的时间内赶到终点。' },
    ],
    success: '准时到达！离得最近的站不一定最快，出发前先比较步行范围内的各个站点。',
    fail: '超时了。最近的紫金名门只有绕远的 68路，试试走到红圈里的其他站点。',
  },
  {
    // 大同：快速公交607线与普通 32路 都从公交六公司开往金牛装饰城，走同一条通道。
    // 607 线这段只停 7 站（约 42 分钟），32路 要停 21 站（约 68 分钟）；其它线路组合最快约 45 分钟。
    // 限时 50 分钟：只要不固执地选 32路 就能通过。直接点击目标站时 sharedLines 按站数少优先，会自动选中 607 线。
    id: 'datong_brt', cityId: 'datong', series: 4, title: '第四站：快车与慢车',
    color: '#2f9e44',
    timeLimitMin: 50,
    origin: { name: '同地景园附近', lng: 113.228899, lat: 39.997647 },
    dest: { name: '装饰城附近', lng: 113.286489, lat: 40.061362 },
    mapTutorial: {
      position: [113.228899, 39.997647],
      initial: '点击起点附近的站点出发',
      confirm: '再次点击确认',
      selectLine: '也可以不选线路：直接点击目标站，系统会自动选最快的一条',
      rideStop: '点击站点乘车到目的地附近',
      finish: '点击终点行走到目的地',
      anchors: { selectLine: [113.284489, 40.063362] },
      highlights: [
        { stopName: '金牛装饰城', position: [113.284489, 40.063362], text: '目标站 · 金牛装饰城', phase: 'afterStart' },
      ],
    },
    story: [
      { type: 'narration', text: '同一条路上常常既有快车也有慢车。' },
      { type: 'narration', text: '这一关同样有时间限制：选对线路，才能按时赶到。' },
    ],
    success: '按时到达！快速公交站距大、停站少，同一段路比普通公交快得多。直接点击站点时，系统会替你挑最快的线路。',
    fail: '超时了。32路和快速公交607线走同一条路，但32路要多停十几站。试试不选线路，直接点击金牛装饰城。',
  },
];

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
