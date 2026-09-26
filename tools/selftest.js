/**
 * selftest.js — 用合成 PD 报文验证协议解析层
 *
 * 直接把「4B5B 符号流」拼成 BMC 解码后的比特数组喂给 PdDecoder，
 * 检查 SOP / Header / Data / CRC / EOP 与 PDO 语义是否逐字段还原。
 */
import { PdDecoder } from '../src/js/core/pd.js';
import { EdgeExtractor, BmcDecoder, UI_US, collectRunStats, estimateSampleRate } from '../src/js/core/bmc.js';
import { parseSampleRate, DEFAULT_SAMPLE_RATE } from '../src/js/core/atkcc.js';
import {
  DEC4B5B, SOP_SEQUENCES, EOP_SYM,
} from '../src/js/core/pd_tables.js';

const INV = {};
for (let i = 0; i < 32; i++) { const v = DEC4B5B[i]; if (INV[v] === undefined) INV[v] = i; }

function symBits(sym) {
  const code = INV[sym]; const out = [];
  for (let k = 0; k < 5; k++) out.push((code >> k) & 1);
  return out;
}
const pushSym = (bits, s) => bits.push(...symBits(s));
function pushNib(bits, v, n) { for (let i = 0; i < n; i++) pushSym(bits, (v >>> (4 * i)) & 0xF); }
const pushU16 = (bits, v) => pushNib(bits, v & 0xFFFF, 4);
function pushU32(bits, v) { pushU16(bits, v & 0xFFFF); pushU16(bits, (v >>> 16) & 0xFFFF); }

function crc32(bytes) {
  const T = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); T[n] = c >>> 0; }
  let c = 0xFFFFFFFF;
  for (const b of bytes) c = T[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/** 按 USB PD 规范组装 Header */
function mkHeader({ n = 0, id = 0, powerRole = 1, rev = 3, dataRole = 1, type = 1 }) {
  const r = Math.max(1, Math.min(3, rev)) - 1;
  const t = rev === 3 ? (type & 0x1F) : (type & 0x0F);
  return ((n & 7) << 12) | ((id & 7) << 9) | ((powerRole & 1) << 8) | ((r & 3) << 6) | ((dataRole & 1) << 5) | t;
}

function buildPacket(sopIndex, header, dataWords) {
  const bits = [];
  for (const s of SOP_SEQUENCES[sopIndex]) pushSym(bits, s);
  pushU16(bits, header);
  for (const w of dataWords) pushU32(bits, w >>> 0);
  const bytes = [header & 0xFF, (header >>> 8) & 0xFF];
  for (const w of dataWords) bytes.push(w & 0xFF, (w >>> 8) & 0xFF, (w >>> 16) & 0xFF, (w >>> 24) & 0xFF);
  const crc = crc32(bytes);
  pushU32(bits, crc);
  pushSym(bits, EOP_SYM);
  return { bits, crc };
}

// PPS PDO: 5V~11V / 5A
const ppsPdo = ((3 << 30) | (0x6E << 17) | (0x32 << 8) | 0x64) >>> 0;
// Fixed 5V/3A source PDO
const fixedPdo = ((0x0064 << 10) | 300) >>> 0;

const cases = [
  { name: 'GOOD CRC', sop: 0, header: mkHeader({ type: 1, id: 1 }), data: [], expectType: 'GOOD CRC' },
  { name: 'Source_Cap x2', sop: 0, header: mkHeader({ type: 1, n: 2, id: 3 }), data: [fixedPdo, ppsPdo], expectType: 'Source_Cap' },
  {
    name: 'Sink_Cap x1', sop: 0, header: mkHeader({ type: 4, n: 1, id: 2, powerRole: 0, dataRole: 0 }),
    data: [fixedPdo], expectType: 'Sink_Cap',
  },
  {
    name: "VDM SOP'", sop: 1, header: mkHeader({ type: 15, n: 1, id: 1 }),
    data: [0xFF008001], expectType: 'VDM',
  },
  {
    name: 'Alert (bit31 data)', sop: 0, header: mkHeader({ type: 6, n: 1, id: 5 }),
    data: [0xDB702B99], expectType: 'Alert',
  },
  {
    name: 'Source_Cap x7', sop: 0, header: mkHeader({ type: 1, n: 7, id: 7 }),
    data: [fixedPdo, ppsPdo, fixedPdo, ppsPdo, fixedPdo, ppsPdo, fixedPdo], expectType: 'Source_Cap',
  },
  {
    name: 'Spec Rev 2.0', sop: 0, header: mkHeader({ type: 1, n: 1, id: 1, rev: 2 }),
    data: [fixedPdo], expectType: 'Source_Cap', expectRev: 2,
  },
  {
    name: 'Request (RDO)', sop: 0, header: mkHeader({ type: 2, n: 1, id: 0, powerRole: 0 }),
    data: [((1 << 28) | (1 << 10) | 300) >>> 0], expectType: 'Request',
  },
];

const pd = new PdDecoder({ sampleRate: 2500000 });
let pass = 0, fail = 0;
for (const c of cases) {
  const { bits, crc } = buildPacket(c.sop, c.header, c.data);
  const pkt = pd.decode({
    bits, edges: bits.map((_, i) => i), startSample: 0, endSample: bits.length, bitrate: 600000,
  }, 0);
  const ok = !!pkt && pkt.crcOk === true
    && pkt.header === c.header
    && pkt.crc === crc
    && pkt.msgType === c.expectType
    && (c.expectRev === undefined || pkt.rev === c.expectRev)
    && JSON.stringify(pkt.dataWords) === JSON.stringify(c.data.map((w) => w >>> 0));
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name.padEnd(20)} sop=${pkt?.sop ?? '-'} type=${pkt?.msgType ?? '-'} rev=r${pkt?.rev} role=${pkt?.role} id=${pkt?.msgId} n=${pkt?.nObjects} crc=${pkt?.crcOk}`);
  if (pkt?.summary) console.log('      note: ' + pkt.summary);
  if (!ok) {
    console.log('      expect header=0x' + c.header.toString(16) + ' crc=0x' + crc.toString(16) + ' type=' + c.expectType + ' data=' + JSON.stringify(c.data.map((w) => '0x' + (w >>> 0).toString(16))));
    console.log('      got    ' + (pkt ? JSON.stringify({ header: '0x' + pkt.header.toString(16), crc: '0x' + pkt.crc.toString(16), type: pkt.msgType, data: pkt.dataWords.map((w) => '0x' + w.toString(16)) }) : 'null'));
  }
  ok ? pass++ : fail++;
}
/* ═══════════ ② 采样率不是写死的：任意采样率下都能解，且能从波形反推 ═══════════ */

/** 把「一串报文」编成 BMC 电平采样：每个位边界必有一次跳变，位为 1 时位中间再跳一次。
 *  包与包之间留一段无跳变的空闲，且空闲之后的第一位仍从跳变开始（真实设备就是这样）。 */
function bmcEncode(packets, fs, { leadUs = 6, gapUs = 12 } = {}) {
  const us = (v) => v * fs / 1e6;
  const bitSamples = us(2 * UI_US);          // 1 bit = 2 UI
  const edges = [];
  let t = us(leadUs);
  edges.push(t);                             // 第一个位单元的起始跳变（之前是空闲电平）
  for (const bits of packets) {
    for (const b of bits) {
      if (b) edges.push(t + bitSamples / 2);
      t += bitSamples;
      edges.push(t);
    }
    t += us(gapUs);                          // 空闲：间隔 > maxbit 即视为包结束
    edges.push(t);                           // 下一包的起始跳变
  }
  const total = Math.ceil(t);
  // 采样并打包成 LSB 优先的字节流（与 .atkcc 的存法一致）
  const bytes = new Uint8Array(Math.ceil(total / 8));
  let ei = 0, high = 0;
  for (let i = 0; i < total; i++) {
    while (ei < edges.length && Math.round(edges[ei]) <= i) { high ^= 1; ei++; }
    if (high) bytes[i >> 3] |= 1 << (i & 7);
  }
  return bytes;
}

/** 走完整链路：边沿提取 → BMC 状态机 → PD 解析 */
function decodeSamples(bytes, sampleRate) {
  const ex = new EdgeExtractor({ bitOrder: 'lsb' });
  const bmc = new BmcDecoder({ sampleRate });
  const pd = new PdDecoder({ sampleRate });
  const out = [];
  const feed = (raw) => { if (raw) { const p = pd.decode(raw, 0); if (p) out.push(p); } };
  ex.push(bytes, 0, (e) => feed(bmc.pushEdge(e)));
  ex.flush((e) => feed(bmc.pushEdge(e, true)), bmc.maxbit + 1);
  return out;
}

const streamPackets = [], streamTypes = [];
for (const c of cases) {
  const { bits } = buildPacket(c.sop, c.header, c.data);
  streamPackets.push(bits);
  streamTypes.push(c.expectType);
}

const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name.padEnd(20)} ${extra}`);
  ok ? pass++ : fail++;
};

// 真实设备常见的采样率区间，外加一个极端值
for (const fs of [1500000, 2500000, 4000000, 6000000]) {
  const mhz = (fs / 1e6).toFixed(2);
  const bytes = bmcEncode(streamPackets, fs);

  const decoded = decodeSamples(bytes, fs);
  const okDecode = decoded.length === cases.length && decoded.every((p, i) => p.msgType === streamTypes[i] && p.crcOk === true);

  const est = estimateSampleRate(collectRunStats(bytes));
  const errRate = est ? Math.abs(est.sampleRate - fs) / fs : 1;
  const okEst = !!est && errRate <= 0.08;
  const decoded2 = est ? decodeSamples(bytes, est.sampleRate) : [];
  const okFallback = decoded2.length === cases.length && decoded2.every((p, i) => p.msgType === streamTypes[i]);

  const wrong = decodeSamples(bytes, fs * 2);          // 采样率写错一倍
  const okWrong = !(wrong.length === cases.length && wrong.every((p) => p.crcOk === true));

  check(`${mhz} MHz 采样`, okDecode && okEst && okFallback && okWrong,
    `报文 ${decoded.length}/${cases.length} · 反推 ${est ? (est.sampleRate / 1e6).toFixed(3) : '—'} MHz（误差 ${(errRate * 100).toFixed(2)}%）`
    + ` · 按反推值解出 ${decoded2.length}/${cases.length} · 错一倍时解出 ${wrong.length} 条`);
}

// 采样率声明的解析：不同键名 / 单位都要认
for (const [text, want, src] of [
  ['SamplingFrequency=2500', 2500000, 'declared'],
  ['SampleRate=2500000', 2500000, 'declared'],
  ['sampling_freq = 2.5 MHz', 2500000, 'declared'],
  ['SampleRate=12000 kHz', 12000000, 'declared'],
  ['Resolution=16', DEFAULT_SAMPLE_RATE, 'default'],
  ['', DEFAULT_SAMPLE_RATE, 'default'],
]) {
  const r = parseSampleRate(text);
  check('解析采样率声明', r.hz === want && r.source === src, `${JSON.stringify(text).padEnd(24)} → ${r.hz}Hz ${r.source}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
