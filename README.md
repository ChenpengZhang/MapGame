# 城市公共交通制霸（从A到B）

一个「规划最快公交/地铁路线」的单机游戏，本地用 Dijkstra 计算最优路线，玩家规划路线后与最优对比打分。

当前支持：**故事模式（6 关）· 自由模式 · 无尽爬塔模式 · 排位模式（占位）**。

---

## 特性

- **本地寻路**：不依赖任何网络，`js/router.js` 在「逻辑站 × 线路」状态空间上做 Dijkstra，支持情景模式（禁用地铁 / 公交加速 / 公交步行减速）。
- **故事模式**：6 个带剧情（Galgame 对话框 + 教学泡泡）的关卡，逐关解锁。
- **自由模式**：随机起终点，可勾选情景。
- **无尽模式（爬塔）**：随机起终点，每层要求「比最优慢 ≤ 固定百分比」，从 100% 逐层收紧到 1%；4 个畸变按钮分别记录成绩，支持中途退出续玩。
- **本地步行估算**：步行一律用直线距离 / 75 m/min（不再调高德步行接口）。
- **成本模型**：地铁 35 km/h；公交按线路平均站间距动态给巡航速度（城区密站慢、郊区大站快）。
- **零依赖**：shapefile 解析器（`lib/shp.js`）自己写，无需 `npm install`。

---

## 快速开始

### 1. 前提
- Node.js 18+（已验证 v24，脚本零依赖）。

### 2. 启动（免 Key，默认即可玩）
```bash
node server.js
```
浏览器打开 **http://localhost:8080**

地图默认用 **Leaflet + OpenStreetMap**（免费、免 Key、开箱即用），无需任何配置。

> 若 `data/beijing-transit.json` 不存在，会回退到 `data/sample.json`（6 条演示线路）。

### 3.（可选）配置高德 Key，切换高德底图
想用高德底图的话，在游戏内「设置 → 高德地图 Key」填入即可：

1. [高德开放平台](https://lbs.amap.com/) →「控制台 → 应用管理 → 创建新应用」→「添加 Key」（设置页里有直达教程链接）
2. 服务平台选 **Web端(JS API)**
3. 把 **Key（jsApiKey）** 和 **安全密钥（securityJsCode）** 填进设置页，点「保存 Key」
4. 在 Key 的「设置」里把**域名白名单**加上 `http://localhost:8080`（否则地图报 `INVALID_USER_DOMAIN`）

> Key 只保存在**浏览器本地缓存（localStorage）**里，绝不写入代码或仓库，可以放心把项目传到 GitHub。
> 填 Key 保存后刷新 → 用高德底图；把 Key 清空再保存 → 回到免 Key 的 OSM 地图。

---

## 数据生成（CPTOND-2025，零 API 配额）

全量数据来自开源数据集 **CPTOND-2025**（[figshare](https://figshare.com/articles/dataset/CPTOND-2025/29377427)，WGS-84）。

```bash
node cptond-convert.js
```
生成 `data/beijing-transit.json`（约 2213 条线路、5.7 万站记录、18.9MB，含 WGS-84→GCJ-02 转换、双向合并、逐站距离、路径抽稀、幽灵站剔除等）。

全项目只维护这一份 **GCJ-02** 数据：高德底图直接用；OSM 后端在 `js/amap-polyfill.js` 的渲染边界统一 GCJ-02→WGS-84（标准迭代逆变换，误差 <1 米），所以两套底图下**路由、关卡坐标、交互完全一致**，内存也只需一份（约 87MB）。

> 数据处理的完整细节、踩过的坑、迁移到新城市的清单见 **`docs/数据管线与城市迁移指南.md`**。

---

## 数据格式（beijing-transit.json）

```jsonc
{
  "city": "北京",
  "count": 2213,
  "lines": [
    {
      "id": "L_xxx", "name": "地铁2号线外环", "mode": "metro",
      "front": "西直门", "terminal": "积水潭",
      "stops": [ { "id": "BV…@lng,lat", "name": "西直门", "lng": 116.35, "lat": 39.94, "seq": 1, "d": 1.2 } ],
      "path": [ [116.35, 39.94], … ]   // GCJ-02 轨迹（高德直接用；OSM 在渲染边界换算回 WGS-84）
    }
  ]
}
```
- `d`：该站到下一站的公里数（末站为 `null`）。
- 站点 `id` 是 `原始id@lng,lat` 复合键，避免 CPTOND 里「临时站」复用同一 id 的问题。

---

## 目录结构

```
MapGame/
├── server.js              # 本地静态服务器（node server.js）
├── index.html             # 主界面 + 各菜单/弹窗
├── js/app.js              # UI、渲染、关卡、剧情、爬塔、情景
├── js/router.js           # 本地寻路器（Dijkstra，Node/浏览器通用）
├── js/amap-polyfill.js    # Leaflet+OSM 免 Key 地图后端（模拟高德 API）
├── cptond-convert.js      # CPTOND → beijing-transit.json（主数据管线）
├── test-router.js         # 寻路器 Node 回归测试（node test-router.js）
├── lib/shp.js             # 最小 shapefile 读取器（零依赖）
├── data/
│   ├── sample.json         # 演示数据（开箱即用）
│   ├── beijing-transit.json        # 全量数据（GCJ-02，唯一数据源）
│   └── cptond/             # CPTOND 原始 shapefile（含北京/其它城市地铁）
└── docs/
    ├── 技术方案.md        # 早期竞品调研 + 可行性 + 架构
    └── 数据管线与城市迁移指南.md  # 数据管线 + 踩坑记录 + 新城市迁移清单
```

---

## 测试

```bash
node test-router.js        # 寻路回归测试（故宫→国贸 正常/禁用地铁）
node --check js/app.js     # 语法检查
node --check js/router.js
```

---

## 无 Key 上手（开箱即玩）

**默认就是免 Key 的**：地图用 Leaflet + OpenStreetMap 瓦片（免费、无需注册），寻路、步行、剧情、爬塔全部是本地逻辑，没有任何外部依赖。

两个地图后端共用同一份 **GCJ-02 数据**，全程无偏移、路由一致：

- **未配置 Key** → `js/amap-polyfill.js` 用 Leaflet 模拟高德 API，底图为 OSM；坐标换算（GCJ-02→WGS-84）全部在该兼容层的渲染边界完成，app.js 无感知；
- **设置里填了高德 Key** → 加载真实高德 JS API，底图为高德，直接用 GCJ-02，零换算、零改动。

因为路由、关卡坐标、站点交互都只用这一份 GCJ-02 数据，两套底图下的最优路线、点位、玩法**完全一致**（OSM 偏移由渲染边界换算到 <1 米），内存也只需加载一份（约 87MB）。
