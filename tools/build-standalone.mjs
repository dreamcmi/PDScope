#!/usr/bin/env node
/**
 * build-standalone.mjs — 把整个前端打包成「单文件 HTML」
 *
 * 产出 dist/PDScope.html：内联全部 CSS + 全部 JS（ES Module 已被拍平成一段普通脚本）。
 * 双击即可运行，不依赖 Node / 不依赖网络，macOS / Windows / Linux 通吃。
 *
 * 用法：node tools/build-standalone.mjs
 */
import { existsSync, rmSync } from 'node:fs';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const UI = join(ROOT, 'src', 'ui');
const ENTRY = join(UI, 'app.js');
const OUT = join(ROOT, 'dist', 'PDScope.html');

/* ── 1. 收集模块依赖（后序遍历） ─────────────────────────── */
const IMPORT_RE = /^[ \t]*import\s+(?:[\s\S]*?)\s*from\s*['"]([^'"]+)['"]\s*;?[ \t]*$/gm;
const BARE_IMPORT_RE = /^[ \t]*import\s+['"][^'"]+['"]\s*;?[ \t]*$/gm;

async function collect(file, seen = new Map(), order = []) {
  const abs = resolve(file);
  if (seen.has(abs)) return order;
  seen.set(abs, true);
  const src = await readFile(abs, 'utf8');
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;               // 跳过裸模块名（node 内置等）
    await collect(resolve(dirname(abs), spec), seen, order);
  }
  order.push(abs);
  return order;
}

/* ── 2. 剥离 import / export，得到可拼接的裸代码 ─────────── */
function stripModuleSyntax(src, name) {
  let out = src.replace(IMPORT_RE, '').replace(BARE_IMPORT_RE, '');
  // export { a, b };  /  export { a as b };
  out = out.replace(/^[ \t]*export\s*\{[^}]*\}\s*;?[ \t]*$/gm, '');
  // export default → 交给 default 本身（本项目未使用，出现即报错）
  if (/^[ \t]*export\s+default\b/m.test(out)) {
    throw new Error(`[${name}] 使用了 export default，打包器暂不支持`);
  }
  // export const/let/var/class/function/async function
  out = out.replace(/^([ \t]*)export\s+(async\s+function|function|class|const|let|var)\b/gm, '$1$2');
  return out;
}

/** 抓顶层声明名，用于检测跨模块重名 */
function topLevelNames(src) {
  const names = new Set();
  const re = /^(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of src.matchAll(re)) names.add(m[1]);
  return names;
}

/* ── 3. 主流程 ─────────────────────────────────────────── */
const order = await collect(ENTRY);

const chunks = [];
const owners = new Map();       // 名字 -> [模块...]
let totalBytes = 0;

for (const abs of order) {
  const rel = abs.slice(ROOT.length + 1).replace(/\\/g, '/');
  const raw = await readFile(abs, 'utf8');
  const code = stripModuleSyntax(raw, rel);
  totalBytes += code.length;

  for (const n of topLevelNames(code)) {
    if (!owners.has(n)) owners.set(n, []);
    owners.get(n).push(rel);
  }
  chunks.push(`/* ══════ ${rel} ══════ */\n${code.trim()}\n`);
}

// 重名检测
const collisions = [...owners.entries()].filter(([, v]) => v.length > 1);
if (collisions.length) {
  console.warn('\n⚠ 检测到跨模块顶层重名（打包后可能互相覆盖）：');
  for (const [n, v] of collisions) console.warn(`   ${n}  ←  ${v.join(' , ')}`);
  console.warn('');
}

const bundle = `(function(){\n"use strict";\n${chunks.join('\n')}\n})();`;

/* ── 4. 组装 HTML ──────────────────────────────────────── */
let html = await readFile(join(UI, 'index.html'), 'utf8');
const css = await readFile(join(UI, 'styles.css'), 'utf8');

if (!/<link[^>]+href="\.\/styles\.css"/.test(html)) throw new Error('index.html 里找不到 styles.css 引用');
if (!/<script[^>]+src="\.\/app\.js"/.test(html)) throw new Error('index.html 里找不到 app.js 引用');

// 注意：replace 的「替换串」里 $$ / $& / $1 有特殊含义，必须用函数形式防止被吃掉
html = html.replace(/[ \t]*<link[^>]+href="\.\/styles\.css"[^>]*>\s*/, () => `<style>\n${css}\n</style>\n`);
html = html.replace(/[ \t]*<script[^>]+src="\.\/app\.js"[^>]*><\/script>\s*/, () => `<script>\n${bundle}\n</script>\n`);

// 注意：不再往 HTML 里注入任何「这是单文件版」的标记。
// 早先注入过 <meta name="pdscope-standalone">，但 Tauri 复用的就是同一个文件，
// 会连带把桌面版也标成单文件版。形态判定已全部移到运行期（app.js 的 ENV），这里保持中立。

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, html, 'utf8');

const st = await stat(OUT);
const stale = join(ROOT, 'dist', 'index.html');
if (existsSync(stale)) {
  rmSync(stale);                     // Tauri 现在直接加载 PDScope.html，旧的重复入口清掉
}

console.log('');
console.log('  ✔ 单文件版已生成');
console.log('  ─────────────────────────────────────────');
console.log(`  输出   ${OUT}`);
console.log(`  体积   ${(st.size / 1024).toFixed(1)} KB`);
console.log(`  模块   ${order.length} 个，源码 ${(totalBytes / 1024).toFixed(1)} KB`);
if (collisions.length) console.log(`  警告   ${collisions.length} 处顶层重名`);
console.log('');
console.log('  双击该 HTML 即可在任意系统上运行，无需 Node；');
console.log('  Tauri 桌面版也直接加载它，无需另做入口。');
console.log('');
