#!/usr/bin/env node
/**
 * ci-checksum.mjs — 为 CI 产物生成 SHA256 校验和
 *
 * 单独写一个的原因：CI 跑在三个系统上，取证命令各不相同
 * （sha256sum / shasum -a 256 / Get-FileHash），用 Node 自带的 crypto 三平台一句话搞定。
 *
 * 用法：
 *   node tools/ci-checksum.mjs --name windows11-x64   # 哈希当前目录下 PDScope-windows11-x64* 的全部归档
 *   node tools/ci-checksum.mjs --paths a.exe b.msi    # 手动指定文件
 *
 * 每个归档输出一个同名的 `<归档名>.sha256`，内容一行一文件，与 `sha256sum -c` 兼容。
 * 用「归档名 + .sha256」而不是统一的 SHA256SUMS.txt，是因为各目标的产物最后会被
 * 汇总到同一个 Release 里 —— 统一名字会互相覆盖，带上目标名才不会撞。
 *
 * 一个文件都没扫到时**非零退出**：在 CI 里「没产物」必须是错误，不能静静地上传空包。
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

// ── 参数 ──────────────────────────────────────────────────────────────
const opts = { name: '', out: '', paths: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--name') opts.name = argv[++i] ?? '';
  else if (a === '--out') opts.out = argv[++i] || '';
  else if (a === '--paths') {
    while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.paths.push(argv[++i]);
  } else if (a === '-h' || a === '--help') {
    console.log('用法：node tools/ci-checksum.mjs --name <目标名> [--paths <文件...>] [--out <文件>]');
    process.exit(0);
  } else {
    console.error(`不认识参数：${a}`);
    process.exit(2);
  }
}

const exists = (p) => {
  try { return lstatSync(p); } catch { return null; }
};

// ── 决定要哈希哪些文件 ────────────────────────────────────────────────
// 每个目标产出的都是**归档文件**：Windows 是 .zip，macOS / Linux 是 .tar.gz。
// 之所以 Windows 也自己压一层而不是散着传：散着传时不同目标会产出同名文件
// （pdscope.exe、PDScope_0.2.0_x64-setup.exe …），汇总到同一个 Release 时会互相覆盖。
// 一个目标可能出多个归档（例如 Windows 的「安装包版」与「绿色版」），所以这里是复数。
const ARCHIVE = /\.(zip|tar\.gz)$/;

let files;
if (opts.paths.length) {
  files = opts.paths.filter((p) => exists(p)?.isFile());
} else if (opts.name) {
  const prefix = `PDScope-${opts.name}`;
  files = readdirSync('.')
    .filter((n) => n.startsWith(prefix) && ARCHIVE.test(n))
    .sort()
    .map((n) => `./${n}`);
} else {
  console.error('要么给 --paths，要么给 --name');
  process.exit(2);
}

if (!files.length) {
  console.error(`没有找到 PDScope-${opts.name || '<目标名>'}* 的 .zip / .tar.gz，无法生成校验和`);
  process.exit(1);
}

if (opts.out && files.length > 1) {
  console.error(`--out 只能配合单个文件使用，现在有 ${files.length} 个`);
  process.exit(2);
}

// ── 逐个归档计算并写出 ────────────────────────────────────────────────
for (const f of files) {
  const name = relative('.', f).split(sep).join('/'); // 统一成正斜杠，供 sha256sum -c 使用
  const bytes = readFileSync(f);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const out = opts.out || `${f}.sha256`;
  writeFileSync(out, `${hash}  ${name}\n`);
  console.log(`  ${hash.slice(0, 16)}…  ${(bytes.length / 1048576).toFixed(2).padStart(7)} MB  ${name}`);
  console.log(`    → ${out}`);
}
