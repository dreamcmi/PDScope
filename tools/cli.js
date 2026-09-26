#!/usr/bin/env node
/**
 * cli.js — 命令行解析 .atkcc，输出 PD 报文表
 *
 * 用法：
 *   node tools/cli.js <file.atkcc> [--channel 0] [--json] [--csv] [--limit 50] [--verbose]
 *                                  [--rate 2500000]
 *
 * 采样率默认取文件声明（channel.ini），文件没声明或声明得离谱时用波形节拍反推；
 * `--rate` 可强制指定，用于排查异常文件（解不出来时先怀疑采样率）。
 */
import { readFile } from 'node:fs/promises';
import { AtkccCapture, scanChannelActivity } from '../src/js/core/atkcc.js';
import { decodeChannel, busAt } from '../src/js/core/pipeline.js';
import { makeNodeInflator } from '../src/js/core/inflate.js';

function parseArgs(argv) {
  const a = { file: null, channel: 0, json: false, csv: false, limit: 0, verbose: false, listChannels: false, scan: 0, rate: 0 };
  for (let i = 2; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--channel') a.channel = Number(argv[++i]);
    else if (v === '--json') a.json = true;
    else if (v === '--csv') a.csv = true;
    else if (v === '--limit') a.limit = Number(argv[++i]);
    else if (v === '--verbose') a.verbose = true;
    else if (v === '--channels') a.listChannels = true;
    else if (v === '--scan') a.scan = Number(argv[++i]) || 4;
    else if (v === '--rate') a.rate = Number(argv[++i]) || 0;
    else if (!a.file) a.file = v;
  }
  return a;
}

function fmtMs(ms) {
  const s = ms / 1000;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

const RATE_SRC = { declared: '文件声明', measured: '波形实测', default: '默认值', override: '手动指定' };

const args = parseArgs(process.argv);
if (!args.file) {
  console.error('用法: node tools/cli.js <file.atkcc> [--channel N] [--json|--csv] [--limit N] [--channels] [--scan N] [--rate HZ]');
  process.exit(1);
}

const inflate = await makeNodeInflator();
const bytes = new Uint8Array(await readFile(args.file));
const tOpen = Date.now();
const cap = await AtkccCapture.open(bytes, { inflate });
console.error(`[open] ${Date.now() - tOpen}ms  声明采样率=${cap.meta.sampleRate}Hz`
  + `${cap.meta.sampleRateRaw ? `（${cap.meta.sampleRateRaw}）` : '（文件未声明）'}`
  + `  totalSamples=${cap.meta.totalSamples}  duration=${cap.durationSec.toFixed(3)}s  channels=${cap.meta.channels.length}`);

if (args.listChannels) {
  for (const c of cap.meta.channels) {
    console.error(`  ch${String(c.channel).padStart(2)}  chunks=${String(c.chunks.length).padStart(3)}  bytes=${c.totalBytes}`);
  }
  process.exit(0);
}

if (args.scan) {
  for (const c of cap.meta.channels) {
    const r = await scanChannelActivity(cap, c.channel, inflate, args.scan);
    console.log(`ch${String(c.channel).padStart(2)}  非空闲字节=${String(r.activity).padStart(10)}  (扫描 ${r.scannedChunks} 块 / ${(r.bytes / 1048576).toFixed(1)} MiB)`);
  }
  process.exit(0);
}

const t0 = Date.now();
const { packets, stats } = await decodeChannel(cap, args.channel, {
  inflate,
  sampleRate: args.rate,
  onProgress: (p) => { if (process.stderr.isTTY) process.stderr.write(`\r[decode] ch${p.channel} chunk ${p.chunk}/${p.chunks} packets=${p.packets}`); },
});
console.error(`\n[decode] ${Date.now() - t0}ms  packets=${stats.packetCount}  badCrc=${stats.badCrc}  edges=${stats.edges}  dur=${stats.durationSec.toFixed(3)}s`);
console.error(`[rate]   实际采用 ${stats.sampleRate}Hz（${RATE_SRC[stats.sampleRateSource] || stats.sampleRateSource}）`
  + `${stats.sampleRateMeasured ? ` · 波形实测 ${stats.sampleRateMeasured}Hz` : ''}`);
if (stats.sampleRateNote) console.error(`[rate]   ${stats.sampleRateNote}`);

// 把 VBUS/IBUS 附到包上
for (const p of packets) {
  const b = busAt(cap.meta.bus, p.startSample);
  p.vbus = b.vbus; p.ibus = b.ibus;
}

const list = args.limit ? packets.slice(0, args.limit) : packets;

if (args.json) {
  console.log(JSON.stringify({
    meta: {
      sampleRate: stats.sampleRate,
      sampleRateSource: stats.sampleRateSource,
      sampleRateDeclared: stats.sampleRateDeclared,
      sampleRateMeasured: stats.sampleRateMeasured,
      totalSamples: cap.meta.totalSamples,
      stats,
    },
    packets: list,
  }, null, 2));
} else if (args.csv) {
  const head = ['#', 'SOP', 'MsgType', 'ID', 'Direction', 'Elapsed', 'VBUS(V)', 'IBUS(A)', 'Data', 'CRC', 'Note'];
  console.log(head.join(','));
  for (const p of list) {
    console.log([
      p.index, p.sop, p.msgType, p.msgId ?? '', p.role, fmtMs(p.timeMs),
      p.vbus.toFixed(3), p.ibus.toFixed(3), `"${p.dataHex}"`,
      p.crcOk === null ? '' : (p.crcOk ? 'OK' : 'BAD'), `"${p.summary.replace(/"/g, '""')}"`,
    ].join(','));
  }
} else {
  console.log('#     SOP     MsgType              ID  Dir    Elapsed         VBUS/IBUS          Data                                     Note');
  for (const p of list) {
    console.log([
      String(p.index).padEnd(5),
      p.sop.padEnd(7),
      (p.msgType ?? '').padEnd(20),
      String(p.msgId ?? '').padEnd(3),
      (p.role ?? '').padEnd(6),
      fmtMs(p.timeMs).padEnd(15),
      `${p.vbus.toFixed(3)}V/${p.ibus.toFixed(3)}A`.padEnd(18),
      (p.dataHex ?? '').padEnd(40),
      p.summary ?? '',
    ].join(' '));
    if (args.verbose) {
      for (const d of p.details) console.log(`        · ${d.key}: ${d.value}`);
      for (const w of p.warnings) console.log(`        ! ${w.long}`);
    }
  }
}
