#!/usr/bin/env node
/**
 * syntax.mjs — 只做语法检查（不执行）
 *
 * 为什么需要它：界面脚本（src/ui/app.js）在 Node 里 import 会直接碰 DOM，
 * 跑不起来；而语法错误（比如重复声明一个变量）会让页面整片空白，
 * 表现为「e2e 卡到超时才失败」，排查起来很不直观。所以在自检链最前面
 * 先过一遍 `node --check`，几秒内就把这类问题指出来。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const files = [];
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js') || e.name.endsWith('.mjs')) files.push(p);
  }
};
walk('src');
walk('tools');

let bad = 0;
for (const f of files) {
  try {
    execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
  } catch (err) {
    bad++;
    const msg = String(err.stderr || err.message).split('\n').slice(0, 5).join('\n');
    console.log(`✗ ${f}\n${msg}`);
  }
}
console.log(bad ? `\n${bad} 个文件有语法错误` : `语法检查通过（${files.length} 个文件）`);
process.exit(bad ? 1 : 0);
