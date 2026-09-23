# 城市公共交通制霸（从A到B）

一个「规划最快公交/地铁路线」的单机游戏。看看你有多接近最快时间。

<p align="center">
  <img src="screenshots/cover.png" width="70%">
</p>

灵感来源于作者不喜欢用导航的时光。

当前支持模式：**故事模式· 自由模式 · 无尽爬塔模式**

当前支持城市：**北京 广州 上海 深圳**
---

## 最新已知Bug
- 公交车上下行站点不一致被忽略 + 公交车左行问题（涉及算法+前端ui大量重构）（已修复）
- 广州公交包含佛山东莞区域，并会造成图结构不连通（已修复，现在每次指定起终点前会检查图连通性）
- 未完工的线路允许玩家乘坐（已修复）
- 部分完整线路显示冗余北段中段等信息
- 公交站上下行ui重名（已修复）
- 按城市边界裁切误伤机场大巴（对说的就是你大兴机场）（已修复）

---

## 特性

- **本地寻路**：不依赖任何网络，`shared/router.js` 在「逻辑站 × 线路」状态空间上做 Dijkstra，支持一些有意思的畸变待你探索。
- **故事模式**：6 个带剧情（Galgame 对话框 + 教学泡泡）的关卡，逐关解锁。
- **自由模式**：随机起终点，可勾选情景。
- **无尽模式（爬塔）**：随机起终点，每层要求「比最优慢 ≤ 固定百分比」，从 100% 逐层收紧到 1%；4 个畸变按钮分别记录成绩，支持中途退出续玩。
- **本地步行估算**：步行一律用直线距离 / 75 m/min。
- **成本模型**：地铁 35 km/h；公交按线路平均站间距动态给巡航速度（城区密站慢、郊区大站快）。
- **零依赖**：shapefile 解析器（`lib/shp.js`）已经写好。

---

## 快速开始

### 方式一：直接下载 Release（推荐，免安装）

只想玩、不想装任何东西？直接去本仓库的 **[Releases](https://github.com/ChenpengZhang/MapGame/releases)** 页面：

1. 按你的系统下载对应的压缩包：
   - **Windows** → `MapGame-win-x64.zip`
   - **macOS（M 系列芯片）** → `MapGame-darwin-arm64.tar.gz`
   - **macOS（Intel 芯片）** → `MapGame-darwin-x64.tar.gz`
   - **Linux** → `MapGame-linux-x64.tar.gz`
2. 解压后双击 **`Start-Game.bat`**（Windows）/ **`Start-Game.command`**（macOS）/ **`Start-Game.sh`**（Linux）
3. 程序会自动打开默认浏览器进入游戏，无需安装 Node.js。

> **Windows 提示**：exe 未做代码签名，首次运行若出现「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」即可。

### 方式二：源码运行（开发者）

#### 1. 前提
- Node.js 18+（已验证 v24，脚本零依赖）。

#### 2. 启动（免 Key，默认即可玩）
```bash
node server.js
```
浏览器打开 **http://localhost:8080/**（会自动打开）。也支持 **http://localhost:8080/mapgame/**，用于验证线上子路径。

前端文件在 `frontend/`，通过服务器映射后 URL 仍是 `js/`、`fonts/`、`shared/`、`data/`，不用在地址中加 `frontend/`。

地图默认用 **Leaflet + OpenStreetMap**（免费、免 Key、开箱即用），无需任何配置。

> 若 `data/beijing-transit.json` 不存在，会回退到 `data/sample.json`（6 条演示线路）。

### （可选）配置高德 Key，切换高德底图
想用高德底图的话，在游戏内「设置 → 高德地图 Key」填入即可：

1. [高德开放平台](https://lbs.amap.com/) →「控制台 → 应用管理 → 创建新应用」→「添加 Key」（设置页里有直达教程链接）
2. 服务平台选 **Web端(JS API)**
3. 把 **Key（jsApiKey）** 和 **安全密钥（securityJsCode）** 填进设置页，点「保存 Key」
4. 在 Key 的「设置」里把**域名白名单**加上 `http://localhost:8080`（否则地图报 `INVALID_USER_DOMAIN`）。Release 版同样用这个端口。

> Key 只保存在**浏览器本地缓存（localStorage）**里，不会以任何形式上传。
> 填 Key 保存后刷新 → 用高德底图；把 Key 清空再保存 → 回到免 Key 的 OSM 地图。

---

## 网页发布（/mapgame/）

在仓库根目录执行：

```bash
npm run build:web
```

将生成的 **`dist/mapgame/` 整个目录**部署到网站的 `/mapgame/`，例如 `/var/www/zcpenguin/mapgame/`。
产物包含页面、前端 JS、字体、共享寻路器和游戏交通数据，不包含后端、数据库配置、原始数据或测试。
不要只上传 `frontend/`，否则会缺少 `shared/router.js` 和交通数据；也不要将整个仓库当作网站根目录。
Nginx API 代理和静态目录示例见 [`backend/deploy/nginx.conf.example`](backend/deploy/nginx.conf.example)。

本地 `npm start` 和 Release 启动脚本保持不变。`npm run test:paths` 检查根路径、`/mapgame/`、资源引用和发行包资源是否完整。

---

## 数据生成（CPTOND-2025）

全量数据来自开源数据集 **CPTOND-2025**（[figshare](https://figshare.com/articles/dataset/CPTOND-2025/29377427)，WGS-84）。

```bash
node scripts/cptond-convert.js
```
生成 `data/beijing-transit.json`（约 2213 条线路、5.7 万站记录、18.9MB，含 WGS-84→GCJ-02 转换、双向合并、逐站距离、路径抽稀、幽灵站剔除等）。

全项目只维护这一份 **GCJ-02** 数据：高德底图和OSM只涉及一个简单坐标变换。内存也只需一份（约 87MB）。

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
├── frontend/              # 前端源码（浏览器 ES modules）
│   ├── index.html         # 游戏页面、菜单与弹窗
│   ├── favicon.svg
│   ├── fonts/             # 本地字体
│   └── js/                # app.js + core/data/map/game/ui 分层
├── backend/               # Node.js / PostgreSQL 后端（DDD）
│   ├── src/               # domain/application/infrastructure/http
│   ├── migrations/        # 数据库迁移
│   └── .env.example       # 配置模板，真实 .env 不入 Git
├── shared/router.js       # 浏览器与后端共用的寻路和基础计时函数
├── data/                  # 四城交通数据、sample.json、原始数据（原始数据不入 Git）
├── lib/shp.js             # 数据转换工具使用的 SHP/DBF 解析器
├── scripts/               # 构建/发布/数据管线/校准脚本 + 资源映射
│   ├── assets.js          # 源码文件到公开 URL 的统一映射
│   ├── dev.js             # 一键起前后端
│   ├── build-web.js       # 生成 dist/mapgame/ 静态发布目录
│   ├── build-release.js   # 便携 Node + 游戏资源的桌面发行包
│   ├── cptond-convert.js  # 交通数据转换
│   ├── calibrate*.js      # 数据采样与计时模型校准
│   └── benchmark.js       # 模型对照
├── server.js              # 本地静态服务器
├── test/                  # 前端流程、数据、寻路与路径回归测试
├── screenshots/           # README 配图
├── .github/workflows/     # Release 自动打包
└── docs/                  # 架构、技术方案与数据管线文档
```

---

## 测试

```bash
node test/test-router.js            # 寻路回归测试（故宫→国贸 正常/禁用地铁）
node test/test-integrity.js         # 数据完整性：逻辑站 id 唯一、物理站线路映射无缺失
node test/test-optimal-invariant.js # 不变式：系统最优 ≤ 玩家可达方案（防「最优比玩家慢」）
node test/test-app-smoke.mjs        # 前端冒烟测试（模块图 + 主流程，Node 桩环境，无需浏览器）
node --check shared/router.js
npm run test:paths               # 根路径、/mapgame/、静态产物与发行包资源
```

真实浏览器流程测试使用 `npm run test:e2e`，默认验证 `/mapgame/`。可用 `E2E_BASE_PATH=/` 切换为根路径，
用 `E2E_BROWSER=chrome` 选择已安装的 Chrome（默认 Edge）；需先 `npm ci` 安装 Playwright。

### 成本模型校准（可选，需高德「Web服务」key）

用高德真实路径规划反推本地成本模型参数，并做端到端误差评估：

```bash
$env:AMAP_WEB_KEY="你的Web服务key"    # 仅存环境变量，不进代码/仓库
node scripts/calibrate-collect.js 100 # 采 100 对随机起终点 → data/calibrate-samples.json
node scripts/calibrate.js             # 锚点法校准（含 train/test 稳定性检查）
node scripts/benchmark.js             # 端到端：本地模型 vs 高德真实耗时
```

> 校准结论：地铁巡航速度 35 km/h 基本准确；公交长段实测约 21 km/h、步行约 65 m/min 偏低。
> 等车/换乘/停站无法从高德 transit 数据辨识（其 duration 不含独立等车信号），保持原值。

---

## 无 Key 上手（开箱即玩）

**默认就是免 Key 的**：地图用 Leaflet + OpenStreetMap 瓦片（免费、无需注册），寻路、步行、剧情、爬塔全部是本地逻辑，没有任何外部依赖。

两个地图后端共用同一份 **GCJ-02 数据**，全程无偏移、路由一致：

- **未配置 Key** → `frontend/js/amap-polyfill.js` 用 Leaflet 模拟高德 API，底图为 OSM；坐标换算（GCJ-02→WGS-84）全部在该兼容层的渲染边界完成，app.js 无感知；
- **设置里填了高德 Key** → 加载真实高德 JS API，底图为高德，直接用 GCJ-02，零换算、零改动。

但：推荐使用高德地图底图游玩。响应更自然，国内细节更完整，没有地图合规问题。

## 免责叠甲
此游戏纯属虚构，限于数据质量和代码复杂度，规划的路线可能存在很多严重不符合现实的情况，请勿将其作为现实世界参考。

一切实际交通规划请以权威国内在线地图为准。

然而，若有任何建议欢迎友好交流！

## 后续计划更新（无顺序）
- 北京加入公交间隔信息
- 加入更多城市
- 更多游戏模式
- 玩家注册和登录、已验证游玩记录保存（已实现）
- 关卡自定义模式和上传，删除，管理
- 交通数据进一步压缩加快加载速度
- 加入排位和每日挑战模式

## 后端开发

账户认证、每日挑战、服务端爬塔存档和排行榜 API 位于 [`backend/`](backend/README.md)，采用 DDD 分层的 Node.js / PostgreSQL 单体服务。
部署路径为 `/mapgame/api/`；数据库和 SMTP 凭据通过环境变量配置，不提交 Git。
主页已接入登录、注册、邮箱验证、密码找回和最近 50 条游玩记录。无需登录也能玩，游客数据仅留在浏览器；登录后，故事、随机与爬塔由服务器发题，完成后验证路线并入库，游客旧层数不会导入。

本地完整启动（Node.js 22.13+，推荐 24）：
```sh
cd backend
npm ci
cp .env.example .env # 首次配置；已有 .env 不要覆盖
# 填入本机 PostgreSQL 连接和随机认证密钥
cd ..
npm run dev
```
访问 `http://localhost:8080/mapgame/`；开发服务器将 API 转发至本机 3001 端口。`PUBLIC_ORIGIN` 应与浏览器地址一致。仅体验游客玩法仍可运行 `npm start`。

启动后自动创建缺失的数据库、执行增量迁移，已有数据保留。开发邮件写入 `backend/.mail-preview/`；正式注册和密码找回需配置 SMTP。详情见后端 README。

结算仅提交服务器关卡 ID、幂等请求 ID 和分段路线。乘车与步行换乘由服务器按物理站连续性逐段验证和重算；路线耗时、层数、通过状态与答题用时均不信任客户端。上传失败可保留当前页面重试。答题用时包含网络延迟，不能据此证明真人手速或阻止自动解题。无尽排行榜已接入页面，显示前 20 名及榜外登录玩家的本人名次。
