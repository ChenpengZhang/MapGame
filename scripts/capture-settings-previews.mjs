// 设置页预览图：用真实浏览器截取“字号”和“公交站显示级别”的效果图，存到 frontend/assets/settings/。
// 用法：先启动开发服务器（PORT=8090 NO_OPEN=1 node server.js），再运行
//   node scripts/capture-settings-previews.mjs [http://localhost:8090]
// 使用本机 Chrome（Playwright 的 channel: 'chrome'），底图为免 Key 的 OSM，需要联网加载瓦片。
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const BASE = process.argv[2] || 'http://localhost:8090';
const OUT = new URL('../frontend/assets/settings/', import.meta.url);
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

async function captureFont(browser, scale) {
  const page = await openGame(browser, { fontScale: scale });
  // 确认离起点最近的站，让左上角出现路线规划与站牌
  await page.evaluate(async () => {
    const v = [...document.scripts].map((s) => s.src).find((s) => s.includes('app.js')).split('?')[1];
    const R = await import('/js/game/route.js?' + v);
    const { stopToData } = await import('/js/map/stop-marks.js?' + v);
    const { haversineKm } = await import('/js/core/router-api.js?' + v);
    const S = window.__MG.state;
    const stop = S.physStops.slice().sort((a, b) => haversineKm(S.ORIGIN, [a.lng, a.lat]) - haversineKm(S.ORIGIN, [b.lng, b.lat]))[0];
    R.onStopClick({ data: stopToData(stop) });
    R.onStopClick({ data: stopToData(stop) });
  });
  await settle(page);
  const box = await page.locator('#left-col').boundingBox();
  await page.screenshot({
    path: new URL(`font-${scale}.jpg`, OUT).pathname, type: 'jpeg', quality: 82,
    clip: { x: Math.max(0, box.x - 6), y: Math.max(0, box.y - 6), ...CLIP },
  });
  await page.close();
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
  for (const scale of ['normal', 'lg', 'xl']) await captureFont(browser, scale);
  for (const zoom of [13, 14, 15, 16]) await captureBusZoom(browser, zoom);
  await captureOsmSample(browser);
  console.log('已生成设置页预览图：', OUT.pathname);
} finally {
  await browser.close();
}
