#!/usr/bin/env node
/**
 * cli.js — 命令行解析抓包，输出 PD 报文表
 *
 * 用法：
 *   node tools/cli.js <file> [--channel 0] [--json] [--csv] [--limit 50] [--verbose]
 *                            [--rate 2500000]
 *
 * 支持两种格式，按文件内容自动分流（不看扩展名）：
 *   · .atkcc —— 正点原子 ATK-C 抓的原始电平采样，走 BMC → 4B5B；
 *   · .sqlite —— POWER-Z 分析仪导出的库，报文已经是逻辑字节。
 *
 * 采样率默认取文件声明（channel.ini），文件没声明或声明得离谱时用波形节拍反推；
 * `--rate` 可强制指定，用于排查异常文件（解不出来时先怀疑采样率）。
 */
import { readFile } from 'node:fs/promises';
import { AtkccCapture, scanChannelActivity } from '../src/js/core/atkcc.js';
import { PowerzCapture, sniffPowerz } from '../src/js/core/powerz.js';
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

const RATE_SRC = { declared: '文件声明', measured: '波形实测', default: '默认值', override: '手动指定', powerz: '分析仪时间戳' };

const args = parseArgs(process.argv);
if (!args.file) {
  console.error('用法: node tools/cli.js <file> [--channel N] [--json|--csv] [--limit N] [--channels] [--scan N] [--rate HZ]');
  process.exit(1);
}

const bytes = new Uint8Array(await readFile(args.file));
const tOpen = Date.now();

// 格式分流：POWER-Z 的 SQLite 与 ATK-C 的 ZIP 靠文件内容区分，扩展名只作参考
const inflate = await makeNodeInflator();
const pzKind = sniffPowerz(bytes);
const cap = pzKind ? PowerzCapture.open(bytes) : await AtkccCapture.open(bytes, { inflate });
const pz = !!pzKind;
console.error(`[open] ${Date.now() - tOpen}ms  ${pz ? `POWER-Z（${cap.meta.protocol}，${cap.meta.tableRows} 行事件）` : 'ATK-C（原始采样）'}`
  + `  采样率=${cap.meta.sampleRate}Hz`
  + (pz ? '（分析仪毫秒时间戳，按 1 采样点 = 1 ms 映射）' : `${cap.meta.sampleRateRaw ? `（${cap.meta.sampleRateRaw}）` : '（文件未声明）'}`)
  + `  totalSamples=${cap.meta.totalSamples}  duration=${cap.durationSec.toFixed(3)}s  channels=${cap.meta.channels.length}`);

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
  ? await cap.decode()
  : await decodeChannel(cap, args.channel, {
    inflate,
    sampleRate: args.rate,
    onProgress: (p) => { if (process.stderr.isTTY) process.stderr.write(`\r[decode] ch${p.channel} chunk ${p.chunk}/${p.chunks} packets=${p.packets}`); },
  });
console.error(`\n[decode] ${Date.now() - t0}ms  packets=${stats.packetCount}  badCrc=${stats.badCrc}`
  + `${pz ? `  badWire=${stats.badWire}  truncatedRows=${stats.truncatedRows}  connect=${stats.connectCount}/${stats.disconnectCount}` : `  edges=${stats.edges}`}`
  + `  dur=${stats.durationSec.toFixed(3)}s`);
console.error(`[rate]   实际采用 ${stats.sampleRate}Hz（${RATE_SRC[stats.sampleRateSource] || stats.sampleRateSource}）`
  + `${stats.sampleRateMeasured ? ` · 波形实测 ${stats.sampleRateMeasured}Hz` : ''}`);
if (stats.sampleRateNote) console.error(`[rate]   ${stats.sampleRateNote}`);
if (stats.unsupported) console.error(`[warn]   ${stats.unsupported}（${stats.unsupportedMsgs} 条原始帧未做语义解析）`);

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
