#!/usr/bin/env node
/**
 * chunk-cost.mjs — 量出**每一块**数据的解码成本，找出最贵的那一块。
 *
 * 为什么关心这个：`decodeChannel` 每处理 8 个块才让出一次主线程
 * （`if ((i & 7) === 7) await new Promise(r => setTimeout(r, 0))`）。
 * 于是「**单块成本 × 8**」就是主线程可能被连续占住的最长时间 ——
 * 这正是「打开文件时卡死一段时间」的直接来源。
 *
 * 手法：把 capture 包一层，只暴露前 K 块，跑一遍完整解码；
 * `cost(K+1) - cost(K)` 就是第 K 块的成本（解码是流式单向的，所以这个差分成立）。
 * 比「总耗时 ÷ 块数」有意义得多 —— 平均会把真正贵的那几块摊平掉。
 *
 * 顺带记一个反直觉的事实：**解码成本跟磁盘体积没关系**。
 * 每块固定 1 MiB 未压缩，空闲段（全 0xFF / 0x00）几乎不产生边沿，
 * 所以几十 KB 的文件可能装着几百个 1 MiB 块；而几 MB 的文件可能几乎不费时。
 * 真正决定成本的是「这一块里有多少次电平跳变」。
 *
 * 用法：
 *   node tools/chunk-cost.mjs                                  # 扫仓库上一级全部 .atkcc
 *   node tools/chunk-cost.mjs --src "../苹果40w-ip18pro.atkcc"
 *   node tools/chunk-cost.mjs --src "../苹果40w-ip18pro.atkcc" --channel 0
 */
import { readFile, readdir } from 'node:fs/promises';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtkccCapture } from '../src/js/core/atkcc.js';
import { decodeChannel } from '../src/js/core/pipeline.js';
import { makeAutoInflator } from '../src/js/core/inflate.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

const inflate = await makeAutoInflator();
const one = arg('--src', null);
const WANT_CH = arg('--channel', null);
const files = one
  ? [basename(resolve(ROOT, one))]
  : (await readdir(resolve(ROOT, '..'))).filter((f) => /\.atkcc$/i.test(f)).sort();

/** 只暴露前 k 块的 capture 视图（其余字段原样透传） */
function limitCapture(cap, channel, k) {
  const real = cap.meta.channelMap.get(channel);
  const chunks = real.chunks.slice(0, k);
  const totalBytes = chunks.reduce((s, x) => s + x.size, 0);
  const view = { ...real, chunks, totalBytes, totalSamples: totalBytes * 8 };
  const map = new Map(cap.meta.channelMap);
  map.set(channel, view);
  const channels = cap.meta.channels.map((c) => (c.channel === channel ? view : c));
  return {
    meta: { ...cap.meta, channelMap: map, channels },
    readChunk: (ch, i, inf) => cap.readChunk(ch, i, inf),
    effectiveSampleLimit: () => view.totalSamples,
    zip: cap.zip,
  };
}

console.log('');
console.log('  每块解码成本（差分测量）');
console.log('  ────────────────────────────────────────────────────────────────');
console.log('  样本'.padEnd(34) + '通道'.padStart(4) + '块数'.padStart(5)
  + '总ms'.padStart(8) + '最贵块'.padStart(8) + '该块ms'.padStart(8) + '8块合计ms'.padStart(10));

const summary = [];
for (const f of files) {
  const bytes = new Uint8Array(await readFile(resolve(ROOT, '..', f)));
  const cap = await AtkccCapture.open(bytes, { inflate });
  const ch = WANT_CH != null
    ? cap.meta.channels.find((c) => c.channel === Number(WANT_CH))
    : cap.meta.channels[0];
  if (!ch) continue;

  const n = ch.chunks.length;
  // 块太多时只测前 64 块 —— 够了，成本分布不会因为更长而改变
  const limit = Math.min(n, 64);
  const opts = { inflate, bitOrder: 'lsb', sampleRate: cap.meta.sampleRate };

  const costs = [];
  let prev = 0;
  for (let k = 1; k <= limit; k++) {
    const t = performance.now();
    await decodeChannel(limitCapture(cap, ch.channel, k), ch.channel, opts);
    const now = performance.now();
    costs.push(now - prev);
    prev = now;
  }
  const total = prev;
  let maxIdx = 0;
  for (let i = 1; i < costs.length; i++) if (costs[i] > costs[maxIdx]) maxIdx = i;

  console.log(basename(f).padEnd(34) + String(ch.channel).padStart(4) + String(n).padStart(5)
    + total.toFixed(0).padStart(8) + String(maxIdx).padStart(8)
    + costs[maxIdx].toFixed(1).padStart(8) + (costs[maxIdx] * 8).toFixed(0).padStart(10));
  summary.push({ f: basename(f), ch: ch.channel, n, total, maxIdx, maxMs: costs[maxIdx], costs });
}

console.log('');
console.log('  说明：「8 块合计」= 现在内核两次让出主线程之间最多被占住的毫秒数。');
console.log('        > 200 ms 人就能感到「点不动」，> 1 s 就是「卡死」。');
console.log('');

// 给最贵的样本画一下成本分布，看清是「普遍贵」还是「个别块特别贵」
const top = summary.slice().sort((a, b) => b.maxMs - a.maxMs)[0];
if (top && top.costs.length > 4) {
  console.log(`  ${top.f} 通道 ${top.ch} 的前 ${top.costs.length} 块成本分布（ms，█ 每格 2 ms）：`);
  const max = Math.max(...top.costs);
  for (let i = 0; i < top.costs.length; i += 8) {
    const row = top.costs.slice(i, i + 8);
    console.log('    #' + String(i).padStart(3) + '  ' +
      row.map((c) => String(c.toFixed(0)).padStart(3) + ' ' + '█'.repeat(Math.max(1, Math.round(c / 2)))).join('  '));
  }
  console.log('');
  void max;
}
