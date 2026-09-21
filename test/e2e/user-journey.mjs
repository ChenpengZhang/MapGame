// test/e2e/user-journey.mjs —— Playwright 真实浏览器 E2E
//
// 用真实浏览器走一遍完整用户流程：启动本地 server → 打开页面 → 主菜单 →
// 故事模式 → 第 1 关 → 过剧情 → 过教学 → 设置 → 退出回主菜单。
//
// 运行前需要：
//   1) npm install（安装 playwright）
//   2) 有可用浏览器：默认用系统 Edge（channel:'msedge'，Windows 自带，无需下载）。
//      无 Edge 时改成 chromium 并 `npx playwright install chromium`。
//   3) 地图底图走免 Key 的 OSM/Leaflet 后端，需要能访问 unpkg.com 与 tile 服务器（联网）。
//
// 用法：node test/e2e/user-journey.mjs

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';

const PORT = Number(process.env.PORT) || 8080;
const BASE = `http://localhost:${PORT}`;
const CHANNEL = process.env.E2E_BROWSER || 'msedge'; // msedge / chrome / chromium

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForServer(base) {
  for (let i = 0; i < 150; i++) {
    try {
      const r = await fetch(base);
      if (r.ok) return;
    } catch { /* 还没起 */ }
    await wait(200);
  }
  throw new Error('本地 server 启动超时：请先 node server.js 或检查端口');
}

let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); console.log('  \u2713 ' + name); pass++; }
  catch (e) { console.error('  \u2717 ' + name + '\n      ' + (e && e.message)); fail++; }
}

console.log('\n=== Playwright 真实浏览器 E2E（完整用户流程）===\n');

// 1. 启动本地 server（测试完杀掉）
const server = spawn('node', ['server.js'], {
  stdio: 'ignore',
  env: { ...process.env, NO_OPEN: '1' },
});
await waitForServer(BASE);

const browser = await chromium.launch({ channel: CHANNEL, headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  await step('打开页面 → 主菜单显示（数据懒加载，地图底图异步）', async () => {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#main-menu:not(.hidden)', { timeout: 30000 });
    assert.ok(await page.isVisible('#story-btn'), '故事模式按钮可见');
    assert.ok(await page.isVisible('#tower-btn'), '无尽模式按钮可见');
    assert.ok(await page.isVisible('#free-btn'), '随机模式按钮可见');
    assert.ok(await page.isVisible('#settings-btn'), '设置按钮可见');
  });

  await step('点「故事模式」→ 选关菜单显示', async () => {
    await page.click('#story-btn');
    await page.waitForSelector('#story-menu:not(.hidden)');
  });

  await step('点第 1 关 → 剧情对话框弹出、地图锁定', async () => {
    await page.click('#story-level-list .story-level.unlocked');
    await page.waitForSelector('#story-dialog:not(.hidden)');
    assert.ok(await page.isVisible('#story-dialog'), '剧情对话框可见');
  });

  await step('连点剧情对话框逐句跳过 → 对话框收起', async () => {
    for (let i = 0; i < 40; i++) {
      if (!(await page.isVisible('#story-dialog'))) break;
      await page.click('#story-dialog');
      await wait(30);
    }
    assert.ok(!(await page.isVisible('#story-dialog')), '剧情已放完');
  });

  await step('连点「下一步」跳过教学 → 状态栏显示关卡目标', async () => {
    for (let i = 0; i < 10; i++) {
      if (!(await page.isVisible('#tutorial-next'))) break;
      await page.click('#tutorial-next');
      await wait(30);
    }
    assert.ok(!(await page.isVisible('#tutorial-next')), '教学已放完');
    const status = await page.textContent('#status');
    assert.ok(status && status.includes('80分钟内到校'), '状态栏已显示第 1 关目标：' + status);
  });

  await step('点「设置」→ 设置面板打开 → 关闭返回', async () => {
    await page.click('#settings-btn');
    await page.waitForSelector('#settings-panel:not(.hidden)');
    assert.ok(await page.isVisible('#amap-key-input'), '高德 Key 输入框可见');
    await page.click('#settings-close');
    assert.ok(!(await page.isVisible('#settings-panel')), '设置面板已关闭');
  });

  await step('点「🏠」返回主界面 → 主菜单回来', async () => {
    await page.click('#menu-btn');
    await page.waitForSelector('#main-menu:not(.hidden)');
    assert.ok(await page.isVisible('#main-menu'), '主菜单已显示');
  });

} finally {
  await browser.close();
  server.kill();
}

console.log('\n=== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ===\n');
process.exit(fail === 0 ? 0 : 1);
