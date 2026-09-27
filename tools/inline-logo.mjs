#!/usr/bin/env node
/**
 * inline-logo.mjs — 把应用图标内联进界面 HTML（顶栏 logo + 标签页 favicon）。
 *
 * 为什么要内联：单文件版 dist/PDScope.html 双击即用，**不能引外部资源**，
 * 否则换个目录打开就没有图标了。所以图标以 PNG data URI 直接写死在 `src/ui/index.html`。
 *
 * 为什么要有这个脚本：图标真源是 `assets/icon.png`，经
 *   `make-icon.py` → `make-tauri-icons.py`
 * 派发出 `src-tauri/icons/*`（打包用）。网页这一份是同一套图的**副本**，
 * 手工同步必然有一天会忘 —— 于是把它做成一条命令。
 *
 * 用法：
 *   node tools/inline-logo.mjs           # 重新内联（改完图标后跑这个）
 *   node tools/inline-logo.mjs --check   # 只校验是否已同步，不同步则非 0 退出
 *
 * 完整流程图（改图标时按顺序跑）：
 *   npm run icon  →  npm run icon:tauri  →  npm run icon:web  →  npm run build
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HTML = resolve(ROOT, 'src/ui/index.html');

/* 尺寸说明：
 *   logo    29px 显示 ⇒ 128px 源图有 4x 余量，够 2x/3x 屏
 *   favicon 浏览器标签页就 32px，给大图纯属浪费体积
 */
const SOURCES = [
  { name: 'topbar logo', file: 'src-tauri/icons/128x128.png', pattern: /(<img class="logo"[^>]*src=")data:image\/png;base64,[^"]*(")/ },
  { name: 'favicon', file: 'src-tauri/icons/32x32.png', pattern: /(<link rel="icon" href=")data:image\/png;base64,[^"]*(")/ },
];

const check = process.argv.includes('--check');

let src = readFileSync(HTML, 'utf8');
let stale = 0;

for (const s of SOURCES) {
  const abs = resolve(ROOT, s.file);
  if (!existsSync(abs)) {
    console.error(`  ✘ ${s.name}：找不到源图 ${s.file}`);
    console.error('    先跑 npm run icon && npm run icon:tauri 生成图标');
    process.exit(1);
  }
  const uri = 'data:image/png;base64,' + readFileSync(abs).toString('base64');
  const next = src.replace(s.pattern, (_m, a, b) => a + uri + b);
  if (next === src) {
    if (!s.pattern.test(src)) {
      console.error(`  ✘ ${s.name}：index.html 里没找到可替换的位置，选择器要跟着改`);
      process.exit(1);
    }
    console.log(`  · ${s.name} 已是最新（${(uri.length / 1024).toFixed(1)} KB）`);
  } else {
    stale++;
    src = next;
    console.log(check
      ? `  ✘ ${s.name} 与 ${s.file} 不一致（应为 ${(uri.length / 1024).toFixed(1)} KB）`
      : `  ✔ ${s.name} → ${s.file}（${(uri.length / 1024).toFixed(1)} KB）`);
  }
}

if (check) {
  if (stale) {
    console.error(`\n  有 ${stale} 处图标与源图不一致，跑 npm run icon:web 同步。`);
    process.exit(1);
  }
  console.log('\n  图标与源图一致。');
} else if (stale) {
  writeFileSync(HTML, src);
  console.log(`\n  src/ui/index.html 已更新。别忘了 npm run build 重建 dist。`);
} else {
  console.log('\n  无需改动。');
}
