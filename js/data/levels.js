/**
 * data/levels.js —— 关卡剧本与模式内容（纯数据，不含任何逻辑）
 *
 * 【分层说明】
 *   这里只声明"游戏里有哪些内容"：故事模式 6 关的起终点/时限/剧情台词/成败文案，
 *   教学通用文案，以及无尽模式的 4 种畸变定义。
 *   改动剧情文案、增删关卡只需改本文件，不用碰任何逻辑代码。
 *
 * 坐标均为 GCJ-02 近似值（与数据源同坐标系）。
 *
 * 字段说明（故事模式关卡）：
 *   id            关卡标识（'tower' / 'random' 为模式专用，不出现在本列表）
 *   series        关卡序号（界面显示用）
 *   title         关卡名
 *   timeLimitMin  时限（分钟），超过即失败
 *   origin/dest   { name, lng, lat }
 *   goalText      目标描述（同时作为第一句教学提示）
 *   scenario      关卡自带情景（noMetro / busSpeedFactor / walkSpeedFactor），可选
 *   scenarioHint  剧情结束后右下角弹出的情景提示（无则不弹）
 *   story         剧情行：type = 'player' 我 / 'narration' 旁白 / 'action' 舞台指示 / 'phone' 手机提示
 *   success/fail  结算文案
 */

// ============ 故事模式关卡 ============
export const LEVELS = [
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

/** 教学环节通用的后三句（第一句是每关的 goalText）——桌面（鼠标）版 */
export const TUTORIAL_COMMON = [
  '放大地图并点按任何一个公交/地铁站以开始规划路线。',
  '点击沿途站点以实现抵达/换乘。',
  '点击终点以结束路线。',
];

/** 教学通用文案——手机（触摸）版：点一下高亮、再点一下确定 */
export const TUTORIAL_COMMON_TOUCH = [
  '放大地图，点按任何一个公交/地铁站。',
  '点一下站点只会高亮它，再次点击同一站才确定。',
  '换乘同理：点一下沿途站高亮，再点一下确定。',
  '点击终点图钉以结束路线。',
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
