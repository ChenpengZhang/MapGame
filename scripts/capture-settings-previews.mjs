// 设置页预览图：用真实浏览器截取“公交站显示级别”与 OSM 底图示例，存到 design/settings-previews-src/（原图）。
// 字号、地铁底图、步行换乘、高德示例是手动截取的，不由本脚本生成，原图同样放在该目录。
// 截完后运行 python3 scripts/compress-settings-previews.py，裁切压缩成 frontend/assets/settings/*.webp 才会上线。
// 用法：先启动开发服务器（PORT=8090 NO_OPEN=1 node server.js），再运行
//   node scripts/capture-settings-previews.mjs [http://localhost:8090]
// 使用本机 Chrome（Playwright 的 channel: 'chrome'），底图为免 Key 的 OSM，需要联网加载瓦片。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8090';
const OUT = new URL('../design/settings-previews-src/', import.meta.url);
mkdirSync(OUT, { recursive: true });

// 北京市中心的固定场景：起点在西单附近，终点在东边，保证每次截图内容一致
const LEVEL = {
  id: 'random', mode: 'random', cityId: 'beijing', title: '示例',
  origin: { name: '起点', lng: 116.3745, lat: 39.9075 },
  dest: { name: '终点', lng: 116.4605, lat: 39.9330 },
};
const VIEWPORT = { width: 1280, height: 800 };
const CLIP = { width: 360, height: 200 }; // 与设置页预览框同比例

// 公交站显示级别：截图中心放在公交站密集的东单一带；起点放到远处，避免红色步行圈盖住画面
const BUS_CENTER = [116.4172, 39.9135];
const FAR_LEVEL = { ...LEVEL, origin: { name: '起点', lng: 116.2300, lat: 39.9900 }, dest: { name: '终点', lng: 116.2900, lat: 40.0300 } };

async function openGame(browser, settings, level = LEVEL) {
  const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 2 });
  await page.addInitScript((s) => {
    localStorage.setItem('mg_settings', JSON.stringify(s));
    localStorage.setItem('mg_city_id', 'beijing');
  }, { zoomSpeed: 0.5, busMinZoom: 15, metroBase: true, fontScale: 'normal', ...settings });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__MG?.state?.map);
  await page.evaluate(async (level) => {
    window.__MG.startLevel(level, { skipStory: true });
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    for (let i = 0; i < 100 && !(window.__MG.state.loadedCityId === 'beijing' && window.__MG.state.routerGraph); i++) await wait(200);
    await wait(800);
  }, level);
  return page;
}

async function settle(page, ms = 2500) {
  await page.waitForLoadState('networkidle').catch(() => {});
  await page.waitForTimeout(ms);
}

async function captureBusZoom(browser, zoom) {
  const page = await openGame(browser, { busMinZoom: zoom }, FAR_LEVEL);
  // 正好缩放到该级别：这一级刚开始显示公交站
  await page.evaluate(([z, c]) => {
    const S = window.__MG.state;
    S.map.setZoomAndCenter(z, new AMap.LngLat(c[0], c[1]), true);
  }, [zoom, BUS_CENTER]);
  await settle(page, 3500);
  await page.screenshot({
    path: new URL(`bus-zoom-${zoom}.jpg`, OUT).pathname, type: 'jpeg', quality: 80,
    clip: { x: (VIEWPORT.width - CLIP.width) / 2, y: (VIEWPORT.height - CLIP.height) / 2, ...CLIP },
  });
  await page.close();
}

// 底图对比：OSM 截取与高德示例图（amap-sample.jpg，手动截取的建国门一带）相同的位置与比例尺
async function captureOsmSample(browser) {
  const page = await browser.newPage({ viewport: { width: 810, height: 584 }, deviceScaleFactor: 2 });
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__MG?.state?.map);
  // 只留地图：隐藏菜单与游戏界面
  await page.addStyleTag({ content: '#app > :not(#map) { display: none !important; }' });
  await page.evaluate(() => window.__MG.state.map.setZoomAndCenter(16, new AMap.LngLat(116.4304, 39.9091), true));
  await settle(page, 3500);
  await page.screenshot({ path: new URL('osm-sample.jpg', OUT).pathname, type: 'jpeg', quality: 84, scale: 'css' });
  await page.close();
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // 字号预览（font-*.jpg）改为手动截取的整局画面，这里不再生成，避免覆盖
  for (const zoom of [13, 14, 15, 16]) await captureBusZoom(browser, zoom);
  await captureOsmSample(browser);
  console.log('已生成设置页预览图：', OUT.pathname);
} finally {
  await browser.close();
}
