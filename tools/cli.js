#!/usr/bin/env node
/**
 * cli.js — 命令行解析抓包，输出 PD 报文表
 *
 * 用法：
 *   node tools/cli.js <file> [--channel 0] [--json] [--csv] [--limit 50] [--verbose]
 *                            [--rate 2500000] [--spec 2.0|3.0|3.1|3.2|auto]
 *
 * 支持两种格式，按文件内容自动分流（不看扩展名）：
 *   · .atkcc —— 正点原子 ATK-C 抓的原始电平采样，走 BMC → 4B5B；
 *   · .sqlite —— POWER-Z 分析仪导出的库，报文已经是逻辑字节。
 *
 * 采样率默认取文件声明（channel.ini），文件没声明或声明得离谱时用波形节拍反推；
 * `--rate` 可强制指定，用于排查异常文件（解不出来时先怀疑采样率）。
 *
 * `--csv` 与界面「另存为」、桌面版命令行导出走的是**同一个模块**（src/js/core/csv.js），
 * 三者列名 / 转义 / 行尾完全一致。打到标准输出时**不带 BOM**（管道里那三个字节只会碍事），
 * 落盘的那两条路带 BOM（Excel 双击不乱码）。
 */
import { readFile } from 'node:fs/promises';
import { AtkccCapture, scanChannelActivity } from '../src/js/core/atkcc.js';
import { PowerzCapture, sniffPowerz } from '../src/js/core/powerz.js';
import { PowerzStreamCapture, sniffPowerzStream } from '../src/js/core/pdstream.js';
import { decodeChannel, attachBusValues } from '../src/js/core/pipeline.js';
import { makeNodeInflator } from '../src/js/core/inflate.js';
import { csvExport, csvClock } from '../src/js/core/csv.js';
import { PD_SPEC_PROFILES } from '../src/js/pd/index.js';

function parseArgs(argv) {
  const a = { file: null, channel: 0, json: false, csv: false, limit: 0, verbose: false, listChannels: false, scan: 0, rate: 0, specRevision: null };
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
    else if (v === '--spec') {
      const value = argv[++i];
      if (value !== 'auto' && !PD_SPEC_PROFILES[value]) throw new Error('--spec 必须为 2.0/3.0/3.1/3.2/auto');
      a.specRevision = value === 'auto' ? null : value;
    }
    else if (!a.file) a.file = v;
  }
  return a;
}

// 时标格式化与 CSV 都来自共享模块，别在这里另写一份（界面 / 桌面版命令行共用同一份）
const fmtMs = csvClock;

const RATE_SRC = { declared: '文件声明', measured: '波形实测', default: '默认值', override: '手动指定', powerz: '分析仪时间戳' };

let args;
try { args = parseArgs(process.argv); }
catch (err) { console.error(err.message); process.exit(1); }
if (!args.file) {
  console.error('用法: node tools/cli.js <file> [--channel N] [--json|--csv] [--limit N] [--channels] [--scan N] [--rate HZ] [--spec 2.0|3.0|3.1|3.2|auto]');
  process.exit(1);
}

const bytes = new Uint8Array(await readFile(args.file));
const tOpen = Date.now();

// 格式分流：POWER-Z 的 SQLite / .pdStream 与 ATK-C 的 ZIP 靠文件内容区分，扩展名只作参考
const inflate = await makeNodeInflator();
const pzKind = sniffPowerz(bytes);
const streamKind = !pzKind && sniffPowerzStream(bytes);
const cap = pzKind ? PowerzCapture.open(bytes)
  : streamKind ? PowerzStreamCapture.open(bytes)
    : await AtkccCapture.open(bytes, { inflate });
const pz = !!pzKind || !!streamKind;
const container = pzKind ? 'SQLite' : streamKind ? (streamKind === 'ufcs' ? '.ufcsStream' : '.pdStream') : 'ATK-C';
console.error(`[open] ${Date.now() - tOpen}ms  ${pz ? `POWER-Z（${cap.meta.protocol}，${cap.meta.tableRows} 行事件，${container}）` : 'ATK-C（原始采样）'}`
  + `  采样率=${cap.meta.sampleRate}Hz`
  + (pz ? '（分析仪毫秒时间戳，按 1 采样点 = 1 ms 映射）' : `${cap.meta.sampleRateRaw ? `（${cap.meta.sampleRateRaw}）` : '（文件未声明）'}`)
  + `  totalSamples=${cap.meta.totalSamples}  duration=${cap.durationSec.toFixed(3)}s  channels=${cap.meta.channels.length}`
  + (streamKind ? `  无 ADC 波形（${container} 含逐报文测量值）` : ''));

if (args.listChannels) {
  if (pz) console.error('  分析仪导出没有「分块通道」概念（单通路）');
  else for (const c of cap.meta.channels) {
    console.error(`  ch${String(c.channel).padStart(2)}  chunks=${String(c.chunks.length).padStart(3)}  bytes=${c.totalBytes}`);
  }
  process.exit(0);
}

if (args.scan) {
  if (pz) { console.error('  --scan 只对 .atkcc 的原始采样有意义（分析仪导出没有活动度可扫）'); process.exit(0); }
  for (const c of cap.meta.channels) {
    const r = await scanChannelActivity(cap, c.channel, inflate, args.scan);
    console.log(`ch${String(c.channel).padStart(2)}  非空闲字节=${String(r.activity).padStart(10)}  (扫描 ${r.scannedChunks} 块 / ${(r.bytes / 1048576).toFixed(1)} MiB)`);
  }
  process.exit(0);
}

const t0 = Date.now();
const { packets, stats } = pz
  ? await cap.decode({ specRevision: args.specRevision })
  : await decodeChannel(cap, args.channel, {
    inflate,
    sampleRate: args.rate,
    specRevision: args.specRevision,
    onProgress: (p) => { if (process.stderr.isTTY) process.stderr.write(`\r[decode] ch${p.channel} chunk ${p.chunk}/${p.chunks} packets=${p.packets}`); },
  });
console.error(`\n[decode] ${Date.now() - t0}ms  packets=${stats.packetCount}  badCrc=${stats.badCrc}`
  + `${pz ? `  badWire=${stats.badWire}  truncatedRows=${stats.truncatedRows}  connect=${stats.connectCount}/${stats.disconnectCount}` : `  edges=${stats.edges}`}`
  + `  dur=${stats.durationSec.toFixed(3)}s`);
console.error(`[rate]   实际采用 ${stats.sampleRate}Hz（${RATE_SRC[stats.sampleRateSource] || stats.sampleRateSource}）`
  + `${stats.sampleRateMeasured ? ` · 波形实测 ${stats.sampleRateMeasured}Hz` : ''}`);
if (stats.sampleRateNote) console.error(`[rate]   ${stats.sampleRateNote}`);
if (cap.meta.protocol !== 'UFCS') console.error(`[spec]   ${args.specRevision || 'auto（Header 的 3.x 保留精确版本歧义）'}`);
if (stats.unsupported) console.error(`[warn]   ${stats.unsupported}（${stats.unsupportedMsgs} 条原始帧未做语义解析）`);

// 把 VBUS/IBUS 附到包上
attachBusValues(packets, cap.meta.bus);

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
  // 走的就是桌面版命令行 `--csv` 那条路（`csvExport`）：同一份 CSV、同一套摘要与提示。
  // 只有 BOM 一项按出口决定 —— 打到标准输出时不要它，落盘时才要，见文件头注释。
  const res = csvExport({
    fileName: args.file.replace(/^.*[\\/]/, ''),
    channel: args.channel,
    meta: cap.meta,
    rate: stats.sampleRate,
    packets,
    stats,
    decodedMs: Date.now() - t0,
  }, { limit: args.limit, bom: false });
  for (const n of res.notes) console.error(`[note]   ${n}`);
  process.stdout.write(res.csv + '\n');
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
      `${Number.isFinite(p.vbus) ? p.vbus.toFixed(3) : '—'}V/${Number.isFinite(p.ibus) ? p.ibus.toFixed(3) : '—'}A`.padEnd(18),
      (p.dataHex ?? '').padEnd(40),
      p.summary ?? '',
    ].join(' '));
    if (args.verbose) {
      for (const d of p.details) console.log(`        · ${d.key}: ${d.value}`);
      for (const w of p.warnings) console.log(`        ! ${w.long}`);
    }
  }
}
