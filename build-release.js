'use strict';

// 发布打包脚本：把游戏 + 便携 Node 运行时打包成"解压即玩"的压缩包
//
// 用法：
//   node build-release.js                    # 打包当前平台
//   node build-release.js --target win-x64    # 显式指定平台
//   node build-release.js --all               # 打包所有平台（需本机能下载各平台 Node 包）
//
// 输出：release/MapGame-<平台>-<架构>.zip （Windows）或 .tar.gz（macOS/Linux）
//
// 说明：
//   - 原理：下载 Node 官方便携包，把 node 二进制 + 项目文件 + 启动脚本组装后压缩。
//     玩家解压后双击启动脚本即可（server.js 会自动打开浏览器）。
//   - Windows 用 .zip（系统 bsdtar 打）；macOS/Linux 用 .tar.gz（保留可执行位）。
//     注意：在 Windows 上打 macOS/Linux 的 tar 会丢可执行位（bsdtar 不支持 --chmod），
//     所以三平台完整打包建议用 GitHub Actions 在各自原生环境跑（见 .github/workflows/release.yml）。
//   - 零依赖：只用 Node 内置模块 + 系统 tar。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// 固定 Node 版本（LTS），避免下载到会变动的 latest
const NODE_VERSION = 'v24.19.0';
const DIST_ROOT = 'https://nodejs.org/dist/' + NODE_VERSION + '/';

// 各平台的 Node 便携包信息
const TARGETS = {
  'win-x64':     { archive: 'node-' + NODE_VERSION + '-win-x64.zip',      bin: 'node.exe',              ext: '.zip' },
  'darwin-arm64':{ archive: 'node-' + NODE_VERSION + '-darwin-arm64.tar.gz', bin: 'bin/node',           ext: '.tar.gz' },
  'darwin-x64':  { archive: 'node-' + NODE_VERSION + '-darwin-x64.tar.gz',   bin: 'bin/node',           ext: '.tar.gz' },
  'linux-x64':   { archive: 'node-' + NODE_VERSION + '-linux-x64.tar.xz',    bin: 'bin/node',           ext: '.tar.gz' },
};

// 运行时需要的文件/目录（相对项目根）。
// 开发/构建产物一律不进包：data/cptond（11GB 原始 shapefile）、build-release.js、
// cptond-convert.js、fetch-data.js、inspect-shp.js、test-router.js、diag-walk.html、
// config.json、docs/、.gitignore 等。
const INCLUDE = [
  'server.js',
  'index.html',
  'js',                         // app.js / router.js / amap-polyfill.js
  'fonts',                      // ChillRoundF 字体（SIL OFL，本地打包）
  'data/beijing-transit.json',  // 全量数据（GCJ-02）
  'data/sample.json',           // 演示兜底
  'README.md',
];

// 各平台的启动脚本（用英文名，避免 zip 打包中文文件名编码乱码）
const LAUNCHERS = {
  'win-x64': {
    name: 'Start-Game.bat',
    content: '@echo off\r\ncd /d "%~dp0"\r\nnode.exe server.js\r\n',
  },
  'darwin-arm64': {
    name: 'Start-Game.command',
    content: '#!/bin/bash\ncd "$(dirname "$0")"\n./node server.js\n',
  },
  'darwin-x64': {
    name: 'Start-Game.command',
    content: '#!/bin/bash\ncd "$(dirname "$0")"\n./node server.js\n',
  },
  'linux-x64': {
    name: 'Start-Game.sh',
    content: '#!/bin/bash\ncd "$(dirname "$0")"\n./node server.js\n',
  },
};

const ROOT = __dirname;
const RELEASE_DIR = path.join(ROOT, 'release');
const CACHE_DIR = path.join(RELEASE_DIR, '.cache');

function currentPlatformTarget() {
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const map = { win32: 'win-' + arch, darwin: 'darwin-' + arch, linux: 'linux-' + arch };
  return map[process.platform] || null;
}

function sh(cmd) {
  console.log('  > ' + cmd);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT });
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('下载失败 ' + url + ' HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
}

function extract(archive, destDir) {
  const ext = path.extname(archive);
  fs.mkdirSync(destDir, { recursive: true });
  // 系统 tar 支持 zip / tar.gz / tar.xz
  sh(`tar -xf "${archive}" -C "${destDir}"`);
}

function copyProject(dest) {
  for (const item of INCLUDE) {
    const src = path.join(ROOT, item);
    const dst = path.join(dest, item);
    if (!fs.existsSync(src)) continue;
    // 确保父目录存在（cpSync 不会自动建多级父目录）
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
  }
}

function writeLauncher(dest, target) {
  const launcher = LAUNCHERS[target];
  if (!launcher) return;
  const p = path.join(dest, launcher.name);
  fs.writeFileSync(p, launcher.content);
  // Unix 启动脚本需要可执行位
  if (target !== 'win-x64') fs.chmodSync(p, 0o755);
}

function packageAs(dir, target, ext) {
  const name = 'MapGame-' + target + ext;
  const out = path.join(RELEASE_DIR, name);
  if (fs.existsSync(out)) fs.rmSync(out);
  if (ext === '.zip') {
    // Windows：bsdtar -a 根据扩展名打 zip
    sh(`tar -a -cf "${out}" -C "${dir}" .`);
  } else {
    // macOS/Linux：tar.gz（在原生平台打，保留可执行位）
    sh(`tar -czf "${out}" -C "${dir}" .`);
  }
  return out;
}

async function buildOne(target) {
  const info = TARGETS[target];
  console.log('\n===== 打包 ' + target + ' =====');
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  const archivePath = path.join(CACHE_DIR, info.archive);
  const url = DIST_ROOT + info.archive;
  if (!fs.existsSync(archivePath)) {
    console.log('  ↓ 下载 ' + url);
    await download(url, archivePath);
  } else {
    console.log('  ✓ 已缓存 ' + info.archive);
  }

  const extractDir = path.join(CACHE_DIR, target);
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  extract(archivePath, extractDir);

  // 找到解压后的顶层目录（node-vXX-.../）
  const entries = fs.readdirSync(extractDir).filter((n) => n !== '.' && n !== '..');
  const nodeDir = path.join(extractDir, entries[0]);

  const stageDir = path.join(RELEASE_DIR, 'MapGame-' + target);
  if (fs.existsSync(stageDir)) fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // 复制 node 二进制到包根目录
  const binSrc = path.join(nodeDir, info.bin);
  const binName = path.basename(info.bin); // node.exe 或 node
  fs.copyFileSync(binSrc, path.join(stageDir, binName));
  // Linux/macOS 的 node 二进制必须可执行（尤其跨平台打包时，复制可能丢可执行位）
  if (binName !== 'node.exe') fs.chmodSync(path.join(stageDir, binName), 0o755);

  copyProject(stageDir);
  writeLauncher(stageDir, target);

  const out = packageAs(stageDir, target, info.ext);
  const mb = (fs.statSync(out).size / 1024 / 1024).toFixed(1);
  console.log('  ✅ 产出 ' + path.relative(ROOT, out) + '（' + mb + ' MB）');

  // 清理中间目录（保留 .cache 供下次复用）
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
}

(async function main() {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });

  const args = process.argv.slice(2);
  let targets;
  const ti = args.indexOf('--target');
  if (ti >= 0 && args[ti + 1]) {
    const t = args[ti + 1];
    if (!TARGETS[t]) { console.error('未知目标：' + t + '（可用：' + Object.keys(TARGETS).join(', ') + '）'); process.exit(1); }
    targets = [t];
  } else if (args.includes('--all')) {
    targets = Object.keys(TARGETS);
  } else {
    const cur = currentPlatformTarget();
    if (!cur) { console.error('未知平台：' + process.platform); process.exit(1); }
    targets = [cur];
  }

  for (const t of targets) {
    await buildOne(t);
  }
  console.log('\n完成。产物在 release/ 目录。');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
