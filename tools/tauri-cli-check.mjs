#!/usr/bin/env node
/**
 * tauri-cli-check.mjs — 桌面版**命令行导出 CSV**（`pdscope.exe 抓包 --csv`）的自检
 *
 * 为什么单独一个脚本：这条路是「Rust 外壳 + 页面里的导出实现」拼起来的，
 * `tools/tauri-e2e.mjs` 测的是界面那两条路（`--drop` / `--open`），**不开窗口**的这条它测不到。
 *
 * 判据只有一条，但足够硬：**同一个抓包，exe 导出来的 CSV 必须与
 * `node tools/cli.js --csv` 的参考结果逐字节相同**（两者共用 `src/js/core/csv.js`，
 * 差的只是「谁读文件、谁写文件」）。除此之外再补几条边界：
 * 默认输出名、`--limit`、`--out -`（不带 BOM）、`--help` 的退出码、
 * 输入不存在（退出码 2）、非抓包文件（退出码 1 且**不留半截文件**）。
 *
 * 用法：
 *   npm run app:exe                                  # 先出可执行文件
 *   node tools/tauri-cli-check.mjs                   # 现造一份 UFCS 样本跑全套
 *   node tools/tauri-cli-check.mjs --file "../制糖40w-ip18pro.atkcc"
 *   node tools/tauri-cli-check.mjs --self            # 只验参考侧（不跑 exe，无需 Rust 工具链）
 *
 * 产物落在 `artifacts/cli-check/`（导出的 CSV 留着，方便人工翻一眼），失败时退出码非 0。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, openSync, closeSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AtkccCapture } from '../src/js/core/atkcc.js';
import { PowerzCapture, sniffPowerz } from '../src/js/core/powerz.js';
import { decodeChannel, busAt } from '../src/js/core/pipeline.js';
import { makeNodeInflator } from '../src/js/core/inflate.js';
import { csvExport, CSV_BOM } from '../src/js/core/csv.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const OUTDIR = join(ROOT, 'artifacts', 'cli-check');
const SYNTH = join(ROOT, 'artifacts', '_ufcs_synth.sqlite');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const SELF = argv.includes('--self');

/** 与 tools/tauri-e2e.mjs 同一套找法：`tauri build` 出 PDScope.exe，`cargo build` 出 pdscope.exe */
function detectExe() {
  const dir = join(ROOT, 'src-tauri', 'target', 'release');
  try {
    const found = readdirSync(dir).find((f) => /^pdscope\.exe$/i.test(f) || /^pdscope$/i.test(f));
    if (found) return join(dir, found);
  } catch { /* 目录还不存在 */ }
  return join(dir, process.platform === 'win32' ? 'pdscope.exe' : 'pdscope');
}

const EXE = arg('--exe') ? resolve(ROOT, arg('--exe')) : detectExe();

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; console.log(`  \u2714 ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  \u2718 ${name}${extra ? '  ' + extra : ''}`); }
};

/* ── 参考侧：与 tools/cli.js --csv 同一套（同一批模块、同一个 csvExport） ────── */
async function reference(file) {
  const bytes = new Uint8Array(await readFile(file));
  const inflate = await makeNodeInflator();
  const pzKind = sniffPowerz(bytes);
  const cap = pzKind ? PowerzCapture.open(bytes) : await AtkccCapture.open(bytes, { inflate });
  const channel = 0;
  const { packets, stats } = pzKind
    ? await cap.decode()
    : await decodeChannel(cap, channel, { inflate, bitOrder: 'lsb' });
  for (const p of packets) {
    const b = busAt(cap.meta.bus, p.startSample);
    p.vbus = b.vbus; p.ibus = b.ibus;
  }
  return csvExport({
    fileName: basename(file),
    channel,
    meta: cap.meta,
    rate: stats.sampleRate,
    packets,
    stats,
    decodedMs: 0,
  });
}

/** 跑一次 exe，返回 { code, stdout, stderr }（stdout 是 Buffer：要比字节） */
function runExe(args, timeout = 180000) {
  const r = spawnSync(EXE, args, { cwd: ROOT, timeout, maxBuffer: 256 * 1024 * 1024 });
  return {
    code: r.status,
    stdout: r.stdout || Buffer.alloc(0),
    stderr: r.stderr || Buffer.alloc(0),
    error: r.error,
  };
}

const sameBytes = (a, b) => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')) === 0;

/* ── 主流程 ─────────────────────────────────────────────────────────── */
console.log('');
console.log('  PDScope 命令行导出自检（--csv）');
console.log('  ─────────────────────────────────────────────');

const wantFile = arg('--file', null);
let sample = wantFile ? resolve(ROOT, wantFile) : SYNTH;
if (!existsSync(sample) && wantFile) {
  console.error(`找不到样本：${sample}`);
  process.exit(1);
}
if (!existsSync(sample)) {
  console.log('  现造一份 UFCS 样本（tools/make-test-ufcs.mjs）…');
  const gen = spawnSync(process.execPath, [join(ROOT, 'tools', 'make-test-ufcs.mjs')], { cwd: ROOT, stdio: 'inherit' });
  if (gen.status !== 0 || !existsSync(SYNTH)) { console.error('造样本失败'); process.exit(1); }
  sample = SYNTH;
}
console.log(`  样本：  ${sample}`);
console.log(`  参考：  node tools/cli.js --csv（同一个 csvExport）`);
if (!SELF) console.log(`  可执行：${EXE}`);
console.log('');

const ref = await reference(sample);

/* 参考侧自身的格式约束：exe 那份要逐字节等于它，所以先确认它没坏 */
check('参考 CSV 带 BOM / CRLF / 不留尾行', ref.csv.startsWith(CSV_BOM)
  && ref.csv.includes('\r\n') && !ref.csv.endsWith('\n'));
check('参考 CSV 行数 = 报文数 + 表头', ref.csv.split('\r\n').length === ref.rows + 1,
  `${ref.packets} 条报文 / ${ref.rows} 行`);

if (SELF) {
  console.log(`\n  （--self：只验了参考侧，没跑 exe）\n\n  ${pass} 通过, ${fail} 失败\n`);
  process.exit(fail ? 1 : 0);
}

if (!existsSync(EXE)) {
  console.error(`  找不到可执行文件：${EXE}\n  先跑：npm run app:exe（或 cargo build --release）\n`);
  process.exit(1);
}

await mkdir(OUTDIR, { recursive: true });
const stem = basename(sample).replace(/\.(atkcc|sqlite|db)$/i, '');

/* ① 指定输出路径：内容必须与参考逐字节相同。
      显式给 `--channel 0`：多通道 .atkcc 不指定时页面会自动挑一条（那是另一码事，
      下面 ② 单独测），这里要的是「同一条通道、同一份字节」。 */
const out1 = join(OUTDIR, `${stem}-explicit.csv`);
await rm(out1, { force: true });
const r1 = runExe([sample, '--csv', out1, '--channel', '0']);
check('exe --csv <路径> 退出码 0', r1.code === 0, `code=${r1.code}${r1.error ? ` ${r1.error.message}` : ''}`);
const b1 = existsSync(out1) ? await readFile(out1, 'utf8') : '';
check('exe 导出的 CSV 与 node tools/cli.js --csv 逐字节相同', sameBytes(b1, ref.csv),
  `${Buffer.byteLength(b1)} vs ${Buffer.byteLength(ref.csv)} 字节`);
check('exe 摘要行出现在输出里', /命令行导出/.test(r1.stdout.toString('utf8'))
  && r1.stdout.toString('utf8').includes(`${ref.packets} 条`)
  && r1.stdout.toString('utf8').includes(`导出 ${ref.rows} 行`));

/* ② 默认输出名：与输入同目录的 <主干>-ch<通道>.csv。
      不指定通道，从摘要里读回它实际用的是哪条 —— 这样单通道与多通道样本都成立。 */
// 先把上一次可能留下的同名文件清掉，免得「本来就在那儿」被当成这次写出来的
for (const f of readdirSync(dirname(sample))) {
  if (f.startsWith(`${stem}-ch`) && f.endsWith('.csv')) await rm(join(dirname(sample), f), { force: true });
}
const r2 = runExe([sample, '--csv']);
const usedCh = Number((r2.stdout.toString('utf8').match(/·\s*ch(-?\d+)/) || [])[1]);
const defaultOut = join(dirname(sample), `${stem}-ch${Number.isFinite(usedCh) ? usedCh : 0}.csv`);
const b2 = existsSync(defaultOut) ? await readFile(defaultOut, 'utf8') : '';
check('exe 不给输出路径时按「同目录 + -ch<通道>」落盘', r2.code === 0 && b2.length > 0,
  basename(defaultOut));
check('默认落盘那份也是同一套格式（表头一致）',
  b2.split('\r\n')[0] === ref.csv.split('\r\n')[0]);

/* ③ --limit：只截行数，不动表头 */
const out3 = join(OUTDIR, `${stem}-limit3.csv`);
await rm(out3, { force: true });
const r3 = runExe([sample, '--csv', out3, '--channel', '0', '--limit', '3']);
const b3 = existsSync(out3) ? await readFile(out3, 'utf8') : '';
check('exe --limit 3 只出表头 + 3 行', r3.code === 0 && b3.split('\r\n').length === 4
  && b3.split('\r\n')[0] === ref.csv.split('\r\n')[0]);

/* ④ --out -：CSV 走标准输出，且按约定不带 BOM；提示语让位到标准错误 */
const r4 = runExe([sample, '--csv', '--channel', '0', '--out', '-']);
check('exe --out - 把 CSV 打到标准输出（无 BOM）',
  r4.code === 0 && sameBytes(r4.stdout.toString('utf8'), ref.csv.slice(1))
    && r4.stdout[0] !== 0xEF,
  `${r4.stdout.length} 字节`);

/* ⑤ --help / --version */
const r5 = runExe(['--help']);
check('exe --help 退出码 0 且给出用法', r5.code === 0 && /用法/.test(r5.stdout.toString('utf8')));
const r6 = runExe(['--version']);
check('exe --version 退出码 0', r6.code === 0 && /PDScope/.test(r6.stdout.toString('utf8')),
  r6.stdout.toString('utf8').trim());

/* ⑥ 用法错误：输入不存在 → 退出码 2 */
const r7 = runExe([join(OUTDIR, '不存在.atkcc'), '--csv']);
check('输入不存在时退出码 2（用法/参数错）', r7.code === 2, `code=${r7.code}`);

/* ⑦ 导出失败：不是抓包的字节 → 退出码 1，且不留半截 CSV */
const junk = join(OUTDIR, '不是抓包.bin');
// 清掉上一次可能留下的产物（文件名主干里含 `.bin`：页面只去掉 .atkcc/.sqlite/.db）
for (const f of readdirSync(dirname(junk))) {
  if (f.startsWith('不是抓包')) await rm(join(dirname(junk), f), { force: true });
}
await writeFile(junk, Buffer.from('这不是一个抓包文件，只是一段随便写的字节。\n', 'utf8'));
const r8 = runExe([junk, '--csv']);
const leftover = readdirSync(OUTDIR).filter((f) => f.startsWith('不是抓包') && f !== '不是抓包.bin');
check('非抓包文件导出失败（退出码 1）', r8.code === 1, `code=${r8.code}`);
check('失败时不留下半截 CSV', leftover.length === 0, leftover.join(' / '));

/* ⑧ 编码：落盘一律 UTF-8（带 BOM），与终端/控制台类型无关。
      `--out -` 被重定向到**磁盘文件**时要自己认出来并补 BOM（Windows 靠 GetFileType）——
      这里用 Node 打开一个真实文件当 stdout 句柄，模拟 `cmd /c "... --out - > 出.csv"`。 */
const out9 = join(OUTDIR, `${stem}-redirect.csv`);
await rm(out9, { force: true });
const fd = openSync(out9, 'w');
const r9 = spawnSync(EXE, [sample, '--csv', '--channel', '0', '--out', '-'], {
  cwd: ROOT, timeout: 180000, stdio: ['ignore', fd, 'pipe'],
});
closeSync(fd);
const b9 = existsSync(out9) ? await readFile(out9, 'utf8') : '';
check('exe --out - 重定向到文件时自动带 BOM（UTF-8 不变）',
  r9.status === 0 && sameBytes(b9, ref.csv), `${Buffer.byteLength(b9)} 字节`);

/* ⑨ --bom / --no-bom：强制两种行为 */
const out10 = join(OUTDIR, `${stem}-nobom.csv`);
await rm(out10, { force: true });
const r10 = runExe([sample, '--csv', out10, '--channel', '0', '--no-bom']);
const b10 = existsSync(out10) ? await readFile(out10, 'utf8') : '';
check('exe --no-bom 落盘不带 BOM（其余与参考一致）',
  r10.code === 0 && sameBytes(b10, ref.csv.slice(1)), `${Buffer.byteLength(b10)} 字节`);

const r11 = runExe([sample, '--csv', '--channel', '0', '--out', '-', '--bom']);
check('exe --out - --bom 强制带 BOM（管道里也带）',
  r11.code === 0 && r11.stdout[0] === 0xEF && sameBytes(r11.stdout.toString('utf8'), ref.csv),
  `前 3 字节 ${[...r11.stdout.slice(0, 3)].map((b) => b.toString(16).toUpperCase()).join(' ')}`);

console.log('');
console.log('  ─────────────────────────────────────────────');
console.log(`  ${pass} 通过, ${fail} 失败`);
console.log(`  产物目录：${OUTDIR}`);
console.log('');
process.exit(fail ? 1 : 0);
