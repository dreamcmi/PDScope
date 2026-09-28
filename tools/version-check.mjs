#!/usr/bin/env node
/**
 * version-check.mjs — 版本号一致性检查
 *
 * 为什么需要它：这个仓库的版本号散落在 5 个文件里，而它们各自被不同的东西读走：
 *
 *   package.json              npm 元数据
 *   src-tauri/tauri.conf.json  安装包名（PDScope_0.2.0_x64-setup.exe）、.app 的 CFBundleVersion
 *   src-tauri/Cargo.toml       可执行文件自身的版本
 *   src-tauri/Cargo.lock       锁文件里的根包（漏改会让 cargo 认为它和 Cargo.toml 不一致）
 *   src/ui/app.js              界面「关于」里显示的版本
 *
 * 只改其中一处不会报错，只会悄悄装出来一个「文件名 0.3.0、关于里写 0.2.0」的包，
 * 而且这种不一致往往是发给别人之后才发现的。所以放在自检链最前面统一核对。
 *
 * 用法：node tools/version-check.mjs
 */
import { readFileSync } from 'node:fs';

const rows = [];                                  // [文件, 位置, 版本]

const add = (file, what, ver) => rows.push({ file, what, ver });
const read = (p) => readFileSync(p, 'utf8');

// ── package.json（基准） ─────────────────────────────────────────
const pkg = JSON.parse(read('package.json'));
add('package.json', 'version', pkg.version);

// ── src-tauri/tauri.conf.json ────────────────────────────────────
const conf = JSON.parse(read('src-tauri/tauri.conf.json'));
add('src-tauri/tauri.conf.json', 'version', conf.version);

// ── src-tauri/Cargo.toml ─────────────────────────────────────────
// 只认 [package] 段里的 version —— [dependencies] 里每个 crate 也有 version=，
// 从头扫全文会扫到 tauri-build 的版本上去。
const cargo = read('src-tauri/Cargo.toml');
const pkgSec = cargo.slice(Math.max(0, cargo.indexOf('[package]')));
const mCargo = /^\s*version\s*=\s*"([^"]+)"/m.exec(pkgSec);
add('src-tauri/Cargo.toml', '[package] version', mCargo ? mCargo[1] : null);

// ── src-tauri/Cargo.lock ─────────────────────────────────────────
// ⚠ Windows 上这个文件是 CRLF 换行，正则里必须写 `\r?\n`，
//   只写 `\n` 会静默匹配不到（表现为「读不到版本」而不是报错）。
const mLock = /\[\[package\]\]\r?\nname = "pdscope"\r?\nversion = "([^"]+)"/.exec(read('src-tauri/Cargo.lock'));
add('src-tauri/Cargo.lock', '[[package]] pdscope', mLock ? mLock[1] : null);

// ── src/ui/app.js ────────────────────────────────────────────────
const mApp = /\bversion:\s*'([^']+)'/.exec(read('src/ui/app.js'));
add('src/ui/app.js', 'PDScope.version', mApp ? mApp[1] : null);

// ── README.md（只提示，不拦） ────────────────────────────────────
// 文档里会写安装包产物名（PDScope_0.2.0_x64-setup.exe），最容易忘记跟着改。
const readmeVers = [...new Set(
  [...read('README.md').matchAll(/PDScope_(\d+\.\d+\.\d+)/g)].map((m) => m[1]),
)];
if (readmeVers.length) add('README.md', '安装包产物名', readmeVers.join('、'));

// ── 比对 ─────────────────────────────────────────────────────────
const target = pkg.version;
const width = Math.max(...rows.map((r) => r.file.length));
let bad = 0;

console.log(`版本基准（package.json）：${target}\n`);
for (const r of rows) {
  const ok = r.ver === target;
  if (r.ver === null) {
    bad++;
    console.log(`  ✗ ${r.file.padEnd(width)}  ${r.what}`);
    console.log('      （读不到）这一项没写，或格式变了导致脚本没找到它');
    continue;
  }
  // README 里可能列多个平台名（x64 / arm64 各一个），逐个查
  const vers = String(r.ver).split('、');
  const allOk = vers.every((v) => v === target);
  if (!allOk) bad++;
  console.log(`  ${allOk ? '✓' : '✗'} ${r.file.padEnd(width)}  ${r.what.padEnd(20)} ${r.ver}`);
}

if (bad) {
  console.log(`\n${bad} 处不一致。改版本号要五处一起改，见本文件顶部注释。`);
  process.exit(1);
}
console.log('\n版本号一致。');
