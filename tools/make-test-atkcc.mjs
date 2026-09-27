#!/usr/bin/env node
/**
 * make-test-atkcc.mjs — 造 `.atkcc` 测试样本，专供「打开卡不卡」这类性能问题复现。
 *
 * 为什么需要它：仓库里那 7 份真实抓包**都复现不出卡顿**（最长主线程阻塞只有 83 ms）。
 * 原因是解码成本跟**磁盘体积没关系** —— 每块固定 1 MiB 未压缩，
 * 空闲段（全 0xFF / 0x00）几乎不产生边沿，所以真实抓包里大多数块都很便宜。
 * 要复现「卡死」必须造出**边沿密集**的块。
 *
 * 两种模式：
 *   --fill 0x55     每块全部填 0x55（逐位交替 1/0）→ **每位都是跳变**，840 万个边沿/块。
 *                   这种块 deflate 后只有 1 KB 左右，所以是「文件极小、解码极重」的极端样本，
 *                   正对应「几十 KB 的文件打开却卡死」。
 *   --fill random   伪随机字节 → 不可压缩，边沿密度约 50%。体积大但更接近「噪声线」。
 *   --rounds N      不填内容，改为把源文件的数据块**重复 N 轮**（保持真实波形）。
 *
 * 元数据（channel.ini / bus.ini / 0/channel.ini）按新块数**同步改写**，尤其是
 * `0/channel.ini` 第 2 行的总采样数 —— 不改就会被 `effectiveSampleLimit` 提前截断，
 * 解码量根本涨不上去，样本也就白造了。
 *
 * 用法：
 *   node tools/make-test-atkcc.mjs --fill 0x55 --chunks 16 --out "../_worst.atkcc"
 *   node tools/make-test-atkcc.mjs --src "../苹果40w-ip18pro.atkcc" --rounds 30 --out "../_long.atkcc"
 */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { ZipReader, ZipEntry } from '../src/js/core/zip.js';
import { CHUNK_SIZE } from '../src/js/core/atkcc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const SRC = arg('--src', null);
const OUT = resolve(ROOT, arg('--out', '../_test.atkcc'));
const FILL = arg('--fill', null);
const CHUNKS = Number(arg('--chunks', 16));
const ROUNDS = Number(arg('--rounds', 0));
const CHANNELS = Number(arg('--channels', 1));

const ENC = new TextEncoder();
const entryOf = (zr, n) => zr.entries.find((e) => e.name === n);

/* ── 造数据块内容 ─────────────────────────────────────── */
function fillChunk() {
  const d = new Uint8Array(CHUNK_SIZE);
  if (FILL === 'random') {
    // xorshift32：确定性，样本可复现
    let s = 0x12345678;
    for (let i = 0; i < d.length; i++) {
      s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
      d[i] = s & 0xFF;
    }
  } else {
    d.fill(0x55);                       // 逐位交替 → 每一位都是边沿
  }
  return d;
}

/* ── 组装 ZIP（deflate，跟真实文件一致） ────────────────── */
function crc32(buf) {
  if (!crc32.t) {
    crc32.t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); crc32.t[n] = c >>> 0; }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = crc32.t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildZip(items) {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const it of items) {
    const nameBytes = ENC.encode(it.name);
    const body = it.store ? Buffer.from(it.data) : deflateRawSync(Buffer.from(it.data), { level: 6 });
    const crc = crc32(it.data);
    const method = it.store ? 0 : 8;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0, 6); lh.writeUInt16LE(method, 8);
    lh.writeUInt16LE(0, 10); lh.writeUInt16LE(0x2821, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(body.length, 18);
    lh.writeUInt32LE(it.data.length, 22);
    lh.writeUInt16LE(nameBytes.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, nameBytes, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4); cd.writeUInt16LE(20, 6); cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(method, 10); cd.writeUInt16LE(0, 12); cd.writeUInt16LE(0x2821, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(it.data.length, 24);
    cd.writeUInt16LE(nameBytes.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(cd, nameBytes);

    offset += lh.length + nameBytes.length + body.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4); eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(items.length, 8); eocd.writeUInt16LE(items.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cdBuf, eocd]);
}

/* ── 组装条目 ─────────────────────────────────────────── */
const items = [];
let totalSamples = 0;
let mode = '';

if (FILL) {
  mode = `合成填充 ${FILL}`;
  const perCh = Math.max(1, Math.ceil(CHUNKS / CHANNELS));
  items.push({ name: 'channel.ini', data: ENC.encode('SamplingFrequency=2500\n') });
  items.push({ name: 'bus.ini', data: ENC.encode('sample=0,vbus=5.000,ibus=0.000\n') });

  for (let c = 0; c < CHANNELS; c++) {
    for (let i = 0; i < perCh; i++) {
      items.push({ name: `0/${c}-${i}.bin`, data: fillChunk() });
      totalSamples += CHUNK_SIZE * 8;
    }
  }
  // 0/channel.ini：第1行通道组号，第2行总采样数，后面固定 320 行 "0,0"
  const iniLines = ['0', String(totalSamples)];
  for (let i = 0; i < 320; i++) iniLines.push('0,0');
  items.push({ name: '0/channel.ini', data: ENC.encode(iniLines.join('\n') + '\n') });
} else {
  /* 重复真实样本的数据块 */
  const src = new Uint8Array(await readFile(resolve(ROOT, SRC)));
  const zr = new ZipReader(src);
  const isBin = (n) => /^(\d+)\/(\d+)-(\d+)\.bin$/i.test(n);
  const meta = zr.entries.filter((e) => !isBin(e.name) && !e.isDirectory);
  const bins = zr.entries.filter((e) => isBin(e.name));
  if (!bins.length) { console.error('源文件里没有数据块'); process.exit(1); }

  const inflateRawSync = (await import('node:zlib')).inflateRawSync;
  const rawOf = (e) => (e.method === 8 ? inflateRawSync(zr.raw(e)) : zr.raw(e));

  for (const e of meta) {
    let data = new Uint8Array(rawOf(e));
    if (e.name === '0/channel.ini') data = null;          // 稍后按新块数重写
    if (data) items.push({ name: e.name, data, store: e.method === 0 });
  }

  const chans = [...new Set(bins.map((e) => Number(/^(\d+)\/(\d+)-/.exec(e.name)[2])))].sort((a, b) => a - b);
  const perRound = bins.length;
  for (let r = 0; r < ROUNDS; r++) {
    for (const ch of chans) {
      const list = bins.filter((e) => Number(/^(\d+)\/(\d+)-/.exec(e.name)[2]) === ch)
        .sort((a, b) => Number(/-(\d+)\.bin$/.exec(a.name)[1]) - Number(/-(\d+)\.bin$/.exec(b.name)[1]));
      for (const e of list) {
        const idx = items.filter((x) => x.name.startsWith(`0/${ch}-`)).length;
        items.push({ name: `0/${ch}-${idx}.bin`, data: new Uint8Array(rawOf(e)) });
        totalSamples += CHUNK_SIZE * 8;
      }
    }
  }
  const iniLines = ['0', String(totalSamples)];
  for (let i = 0; i < 320; i++) iniLines.push('0,0');
  items.push({ name: '0/channel.ini', data: ENC.encode(iniLines.join('\n') + '\n') });
  mode = `重复真实数据 ${ROUNDS} 轮（${perRound} 块/轮）`;
}

const out = buildZip(items);
await writeFile(OUT, out);
const binCount = items.filter((x) => x.name.endsWith('.bin')).length;

console.log('');
console.log('  造测试样本');
console.log('  ─────────────────────────────────────────────');
console.log(`  模式：    ${mode}`);
console.log(`  通道数：  ${FILL ? CHANNELS : 1}`);
console.log(`  数据块：  ${binCount} 块 × 1 MiB = ${binCount} MiB 未压缩`);
console.log(`  声明采样：${totalSamples}（${(totalSamples / 2500000).toFixed(1)} s @2.5MHz）`);
console.log(`  产物：    ${OUT}`);
console.log(`  体积：    ${(out.length / 1048576).toFixed(2)} MB`);
console.log('');
void ZipEntry; void basename;
