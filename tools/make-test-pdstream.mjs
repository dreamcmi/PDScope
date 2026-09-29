#!/usr/bin/env node
/**
 * make-test-pdstream.mjs — 造一份 POWER-Z `.pdStream` 样本（或把现成抓包转成它）
 *
 * 为什么需要它：`.pdStream` 没有魔数可认（文件开头就是一条普通记录），
 * 自检与 e2e 都得有**真实字节**才能验证「结构自证」这套判据；而私有抓包不入库，
 * CI 上也没有 —— 所以这里手搓一份最小的 PD 协商序列。
 *
 * 两种用法：
 *
 *   node tools/make-test-pdstream.mjs                      # 合成一份最小样本（默认写到 artifacts/）
 *   node tools/make-test-pdstream.mjs --src 抓包.sqlite     # 把真实抓包转成 .pdStream（只搬 pd_table）
 *   node tools/make-test-pdstream.mjs --src 抓包.pdStream   # 也可以流→流（验证往返一致）
 *
 * 合成的那份刻意覆盖三种记录形状：
 *   · 6 字节的连接/状态事件行（`45 │ ts(3B LE) │ 00 │ code`）—— 解不出报文，但必须照收
 *   · 8 字节的短报文（GoodCRC / Request / Accept / PS_RDY：Header 无数据对象）
 *   · 12 字节带一个数据对象的报文（Source_Cap / Sink_Cap）
 *
 * 字节布局见 `src/js/core/pdstream.js` 顶部注释与 doc/format-pdstream.md。
 */
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { writePdStream } from '../src/js/core/pdstream.js';
import { PowerzCapture, sniffPowerz } from '../src/js/core/powerz.js';
import { PdStreamCapture, sniffPdStream } from '../src/js/core/pdstream.js';

const args = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};
const OUT = resolve(arg('--out', 'artifacts/_pdstream_synth.pdStream'));
const SRC = arg('--src', null);

/** 按 USB PD 规范组装 Header（与 tools/selftest.js 同一套位域） */
function mkHeader({ n = 0, id = 0, powerRole = 1, rev = 3, dataRole = 1, type = 1 }) {
  const r = Math.max(1, Math.min(3, rev)) - 1;
  const t = rev === 3 ? (type & 0x1F) : (type & 0x0F);
  return ((n & 7) << 12) | ((id & 7) << 9) | ((powerRole & 1) << 8) | ((r & 3) << 6) | ((dataRole & 1) << 5) | t;
}

/** 逻辑字节（Header 2B LE + 每个数据对象 4B LE）—— 与 `.sqlite` 的 `Raw` 里那段同形，不含 CRC */
function wireOf(header, dataWords = []) {
  const w = [header & 0xFF, (header >>> 8) & 0xFF];
  for (const d of dataWords) w.push(d & 0xFF, (d >>> 8) & 0xFF, (d >>> 16) & 0xFF, (d >>> 24) & 0xFF);
  return w;
}

/**
 * 包一条 PD 报文成 `Raw` blob：`marker │ ts(4B LE, ms) │ sop │ wire`
 * marker 的低 6 位 = 总长 - 1（总长含 marker 自身）。
 */
function rawOf(tsMs, sop, wire) {
  const total = 1 + 4 + 1 + wire.length;
  const marker = 0x80 | ((total - 1) & 0x3F);
  return Uint8Array.from([
    marker,
    tsMs & 0xFF, (tsMs >>> 8) & 0xFF, (tsMs >>> 16) & 0xFF, (tsMs >>> 24) & 0xFF,
    sop,
    ...wire,
  ]);
}

/** 连接/状态事件：6 字节 `45 │ ts(3B LE, ms) │ 00 │ code`（0x11=连接，0x12=断开） */
function eventOf(tsMs, code) {
  return Uint8Array.from([0x45, tsMs & 0xFF, (tsMs >>> 8) & 0xFF, (tsMs >>> 16) & 0xFF, 0x00, code]);
}

/* Fixed 5V/3A 电源 PDO：电压 100×50mV=5V、电流 300×10mA=3A */
const PDO_5V3A = ((0x0064 << 10) | 300) >>> 0;
/* RDO：按 1 号 PDO 请求 5V/3A（Operating Current 300×10mA） */
const RDO_5V3A = ((1 << 28) | (300 << 10) | 300) >>> 0;

/** 合成一条最小但完整的 PD 协商（类型码按规范：1=GoodCRC, 2=Request, 3=Accept, 6=PS_RDY；数据消息 1=Source_Cap, 4=Sink_Cap） */
function synthRows() {
  const rows = [];
  const add = (t, raw, vbus, ibus) => rows.push({ time: t, vbus, ibus, raw });
  const hdr = mkHeader;
  add(0.500, eventOf(500, 0x11), 0, 0);                                              // 连接事件（解不出报文）
  add(0.521, rawOf(521, 1, wireOf(hdr({ type: 15, n: 1, id: 0 }), [0x00000000])), 5.02, 0);      // SOP' VDM：Discover Identity
  add(0.522, rawOf(522, 1, wireOf(hdr({ type: 1, id: 0 }))), 5.02, 0);                            // SOP' GoodCRC（线缆侧）
  add(0.523, rawOf(523, 0, wireOf(hdr({ type: 1, n: 1, id: 0 }), [PDO_5V3A])), 5.02, 0);           // SOP  Source_Cap
  add(0.530, rawOf(530, 0, wireOf(hdr({ type: 1, id: 0, powerRole: 0 }))), 5.02, 0);               // SOP  GoodCRC（Sink 侧）
  add(0.545, rawOf(545, 0, wireOf(hdr({ type: 2, n: 1, id: 0, powerRole: 0, dataRole: 0 }), [RDO_5V3A])), 5.02, 0.10); // SOP Request
  add(0.560, rawOf(560, 0, wireOf(hdr({ type: 3, id: 0 }))), 5.05, 0.42);                          // SOP  Accept
  add(0.600, rawOf(600, 0, wireOf(hdr({ type: 6, id: 0 }))), 5.10, 0.75);                          // SOP  PS_RDY
  add(1.200, rawOf(1200, 0, wireOf(hdr({ type: 4, n: 1, id: 1, powerRole: 0, dataRole: 0 }), [PDO_5V3A])), 5.10, 1.48); // SOP Sink_Cap
  add(2.500, eventOf(2500, 0x12), 0.01, 0);                                          // 断开事件
  return rows;
}

let rows;
let how;
if (SRC) {
  const u8 = new Uint8Array(readFileSync(SRC));
  if (sniffPowerz(u8)) {
    const cap = PowerzCapture.open(u8);
    rows = [];
    for (const r of cap.db.rows(cap.info.table)) rows.push({ time: r[0], vbus: r[1], ibus: r[2], raw: r[3] });
    how = `从 ${SRC} 的 ${cap.info.table} 转出`;
  } else if (sniffPdStream(u8)) {
    rows = PdStreamCapture.open(u8).parsed.records.map((r) => ({ ...r }));
    how = `从 ${SRC} 原样搬运（流 → 流）`;
  } else {
    console.error(`无法识别 ${SRC}：既不是 POWER-Z 的 .sqlite，也不是 .pdStream`);
    process.exit(2);
  }
} else {
  rows = synthRows();
  how = '合成的最小 PD 协商';
}

const out = writePdStream(rows);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, out);

const lens = {};
for (const r of rows) {
  const n = r.raw.length;
  lens[n] = (lens[n] || 0) + 1;
}
console.log(`已生成  ${OUT}`);
console.log(`  来源：    ${how}`);
console.log(`  记录：    ${rows.length} 条（payload 长度 ${Object.entries(lens).map(([l, c]) => `${l}B×${c}`).join('  ')}）`);
console.log(`  体积：    ${out.length} 字节（每条固定开销 28 字节）`);
console.log(`  时间跨度：${rows[0].time}s … ${rows[rows.length - 1].time}s`);
if (!existsSync(OUT)) process.exit(1);
