#!/usr/bin/env node
/**
 * ci-checksum.mjs — 为 CI 产物生成 SHA256 校验和
 *
 * 单独写一个的原因：CI 跑在三个系统上，取证命令各不相同
 * （sha256sum / shasum -a 256 / Get-FileHash），用 Node 自带的 crypto 三平台一句话搞定。
 *
 * 用法：
 *   node tools/ci-checksum.mjs --dir PDScope-windows11-x64-v0.3.1   # 哈希该目录下所有文件（排除 .sha256）
 *   node tools/ci-checksum.mjs --prefix PDScope-windows11-x64       # 哈希当前目录下以该前缀开头的文件
 *   node tools/ci-checksum.mjs --paths a.exe b.msi                  # 手动指定文件
 *
 * 每个文件输出一个同名的 `<文件>.sha256`，内容一行一文件，与 `sha256sum -c` 兼容。
 * 用「每个文件一个 .sha256」而不是统一的 SHA256SUMS.txt，是因为各目标的产物最后会被
 * 汇总到同一个 Release 里 —— 统一名字会互相覆盖，带上目标名才不会撞。
 *
 * 一个文件都没扫到时**非零退出**：在 CI 里「没产物」必须是错误，不能静静地上传空包。
 */

import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

// ── 参数 ──────────────────────────────────────────────────────────────
const opts = { name: '', prefix: '', dir: '', out: '', paths: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--name') opts.name = argv[++i] ?? '';
  else if (a === '--prefix') opts.prefix = argv[++i] ?? '';
  else if (a === '--dir') opts.dir = argv[++i] ?? '';
  else if (a === '--out') opts.out = argv[++i] || '';
  else if (a === '--paths') {
    while (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.paths.push(argv[++i]);
  } else if (a === '-h' || a === '--help') {
    console.log('用法：node tools/ci-checksum.mjs (--dir <目录> | --prefix <前缀> | --paths <文件...>)');
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
// 每个目标的产物现在是**散文件**（不再打成 zip / tar.gz），每个文件配一个 .sha256。
// 散着传所以不同目标会产出同名文件（pdscope.exe、setup.exe …），汇总到同一个
// Release 时靠「前缀含目标名」区分，所以产物名统一是 PDScope-<目标>-<版本段>-<内容>。
// 排除自身生成的 .sha256，避免二次哈希时把旧的校验和文件也算进去。
const SHA = /\.sha256$/;

let files;
if (opts.paths.length) {
  files = opts.paths.filter((p) => exists(p)?.isFile() && !SHA.test(p));
} else if (opts.dir) {
  const st = exists(opts.dir);
  if (!st || !st.isDirectory()) {
    console.error(`目录不存在：${opts.dir}`);
    process.exit(1);
  }
  files = readdirSync(opts.dir)
    .filter((n) => !SHA.test(n))
    .sort()
    .map((n) => `${opts.dir}/${n}`);
} else if (opts.prefix) {
  files = readdirSync('.')
    .filter((n) => n.startsWith(opts.prefix) && !SHA.test(n))
    .sort()
    .map((n) => `./${n}`);
} else if (opts.name) {
  // 兼容旧用法：--name 等价于前缀 PDScope-<name>
  const prefix = `PDScope-${opts.name}`;
  files = readdirSync('.')
    .filter((n) => n.startsWith(prefix) && !SHA.test(n))
    .sort()
    .map((n) => `./${n}`);
} else {
  console.error('要么给 --paths，要么给 --dir，要么给 --prefix');
  process.exit(2);
}

if (!files.length) {
  console.error(`没有找到 ${opts.dir || opts.prefix || opts.name || '<目标名>'} 下的文件，无法生成校验和`);
  process.exit(1);
}

if (opts.out && files.length > 1) {
  console.error(`--out 只能配合单个文件使用，现在有 ${files.length} 个`);
  process.exit(2);
}

// ── 逐个文件计算并写出 ────────────────────────────────────────────────
// sha 文件里只写**文件名**（basename），不写目录路径：这样用户把文件与 .sha256
// 放在同一目录下 `sha256sum -c <文件>.sha256` 就能直接校验，不必管下载解压后的路径。
for (const f of files) {
  const name = f.split(/[\\/]/).pop(); // 只要文件名，供 sha256sum -c 使用
  const bytes = readFileSync(f);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const out = opts.out || `${f}.sha256`;
  writeFileSync(out, `${hash}  ${name}\n`);
  console.log(`  ${hash.slice(0, 16)}…  ${(bytes.length / 1048576).toFixed(2).padStart(7)} MB  ${name}`);
  console.log(`    → ${out}`);
}
