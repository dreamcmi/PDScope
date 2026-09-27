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

/* ═══════════ ③ 独立 PD 库（src/js/pd/）的增强能力 ═══════════
 *  线缆链路的 plug 信令（e-Marker Discover Identity 的 VDO 链）、
 *  扩展消息（含分块）、跨版本字段（BIST 模式）。 */

const b4 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
const hasDetail = (p, key, needle) =>
  (p.details || []).some((d) => d.key === key && String(d.value).includes(needle));
const hasField = (p, needle) => (p.details || []).some((d) => String(d.key).includes(needle));

/** 组装一条扩展消息：Header 的 Extended 位置位 + 16bit 扩展头 + 数据块 */
function buildExtPacket(sopIndex, type, payload, { rev = 3, id = 0, chunked = false, chunkNum = 0, reqChunk = false } = {}) {
  const dataSize = payload.length;
  const nObjects = Math.max(1, Math.ceil((2 + dataSize) / 4));
  const capacity = Math.max(nObjects * 4 - 2, 0);
  const pad = capacity - dataSize;
  const extHead = ((chunked ? 1 : 0) << 15) | ((chunkNum & 0xF) << 11) | ((reqChunk ? 1 : 0) << 10) | (dataSize & 0x1FF);
  const header = mkHeader({ type, n: nObjects, rev, id }) | (1 << 15);
  const bytes = [header & 0xFF, (header >>> 8) & 0xFF, extHead & 0xFF, (extHead >>> 8) & 0xFF,
    ...payload, ...new Array(pad).fill(0)];
  const crc = crc32(bytes);
  const bits = [];
  for (const s of SOP_SEQUENCES[sopIndex]) pushSym(bits, s);
  pushU16(bits, header);
  pushU16(bits, extHead);
  for (const b of payload) pushNib(bits, b, 2);
  for (let i = 0; i < pad; i++) pushNib(bits, 0, 2);
  pushU32(bits, crc);
  pushSym(bits, EOP_SYM);
  return { bits, crc };
}

const decodeBits = (bits) => pd.decode(
  { bits, edges: bits.map((_, i) => i), startSample: 0, endSample: bits.length, bitrate: 600000 }, 0);

/* ── ③.1 线缆 e-Marker 的 Discover Identity（plug 信令）── */
const vdmHead = ((0xFF00 << 16) | (1 << 15) | (1 << 6) | 1) >>> 0;   // ACK · Discover Identity
const idHdrCable = ((3 << 27) | (3 << 21) | 0x2CA3) >>> 0;            // Passive Cable + USB Type-C Plug
const passiveCableVdo = ((2 << 18) | (1 << 17) | (1 << 13) | (3 << 9) | (2 << 5)) >>> 0; // 50V / 5A / EPR / <10ns

{
  const { bits, crc } = buildPacket(1, mkHeader({ type: 15, n: 5, id: 0, rev: 3 }),
    [vdmHead, idHdrCable, 0, ((0xC701 << 16) | 0) >>> 0, passiveCableVdo]);
  const p = decodeBits(bits);
  check("SOP' 线缆 DiscIdent", !!p && p.crcOk === true && p.crc === crc
    && p.sop === "SOP'" && p.msgType === 'VDM' && p.link === 'cable'
    && hasDetail(p, 'Object', 'VDO #2 · ID Header VDO')
    && hasDetail(p, 'Object', 'VDO #3 · Cert Stat VDO')
    && hasDetail(p, 'Object', 'VDO #4 · Product VDO')
    && hasDetail(p, 'Object', 'VDO #5 · Passive Cable VDO')
    && hasField(p, 'USB Vendor ID')
    && (p.summary || '').includes('无源线缆'),
    `summary: ${p?.summary}`);
}

/* ── ③.2 端口 Discover Identity（UFP + Padding + DFP）── */
{
  const idHdrPort = ((2 << 27) | (2 << 23) | (3 << 21) | 0x1234) >>> 0;
  const { bits } = buildPacket(0, mkHeader({ type: 15, n: 7, id: 1, rev: 3 }),
    [vdmHead, idHdrPort, 0, 0x00010002, 0x2A000003, 0, 0x00000005]);
  const p = decodeBits(bits);
  check('端口 DiscIdent 三件套', !!p && p.crcOk === true
    && hasDetail(p, 'Object', 'VDO #5 · UFP VDO')
    && hasDetail(p, 'Object', 'VDO #6 · Padding')
    && hasDetail(p, 'Object', 'VDO #7 · DFP VDO'),
    `summary: ${p?.summary}`);
}

/* ── ③.3 EPR_Source_Capabilities 扩展消息 ── */
{
  const eprFixed = ((0 << 30) | (560 << 10) | 500) >>> 0;                      // 28 V / 5 A
  const eprAvs = ((3 << 30) | (1 << 28) | (480 << 17) | (150 << 8) | 140) >>> 0; // 15~48 V / 140 W
  const { bits, crc } = buildExtPacket(0, 17, b4(eprFixed).concat(b4(eprAvs)), { rev: 3, id: 4 });
  const p = decodeBits(bits);
  check('EPR_Source_Capabilities', !!p && p.crcOk === true && p.crc === crc
    && p.msgType === 'EPR_Source_Capabilities' && p.msgKind === 'ext' && p.extHeader != null
    && hasDetail(p, 'Object', 'PDO #1') && hasDetail(p, 'Object', 'PDO #2')
    && (p.summary || '').includes('EPR_Fixed') && (p.summary || '').includes('EPR_AVS')
    && (p.dataHex || '').length > 0,
    `extHeader=0x${p?.extHeader?.toString(16)} summary: ${p?.summary}`);
}

/* ── ③.4 分块扩展消息：跨块的 PDO 要拼回来，拼不回来的要如实标注 ── */
{
  // 8 个 PDO（32 字节），声明 dataSize=30 → 块 0 覆盖 byte0-25，块 1 覆盖 byte26-29，
  // 第 7 个 PDO 正好被切成 2+2 字节，考验跨分块拼接。
  const pdos = [];
  for (let i = 0; i < 8; i++) pdos.push(((0 << 30) | ((100 + i * 20) << 10) | 300) >>> 0);
  const whole = pdos.flatMap(b4);

  const c0 = decodeBits(buildExtPacket(0, 17, whole.slice(0, 26), { rev: 3, id: 4, chunked: true, chunkNum: 0 }).bits);
  const c1 = decodeBits(buildExtPacket(0, 17, whole.slice(26, 30), { rev: 3, id: 4, chunked: true, chunkNum: 1 }).bits);
  const ok0 = c0?.crcOk === true && hasDetail(c0, 'Object', 'PDO #6');

  // 跨块拼接：同一解码器实例连续解两块，块 1 应把第 7 个 PDO 补全
  const fresh = new PdDecoder({ sampleRate: 2500000 });
  const raw = (bits) => ({ bits, edges: bits.map((_, i) => i), startSample: 0, endSample: bits.length, bitrate: 600000 });
  fresh.decode(raw(buildExtPacket(0, 17, whole.slice(0, 26), { rev: 3, id: 4, chunked: true, chunkNum: 0 }).bits), 0);
  const j = fresh.decode(raw(buildExtPacket(0, 17, whole.slice(26, 30), { rev: 3, id: 4, chunked: true, chunkNum: 1 }).bits), 0);
  const okJoin = hasDetail(j, '分块对齐', '由上一分块') && hasDetail(j, 'Object', 'PDO #7');

  // 没有前块时，不能猜：必须标注「跨分块」
  const lone = decodeBits(buildExtPacket(0, 17, whole.slice(26, 30), { rev: 3, id: 4, chunked: true, chunkNum: 1 }).bits);
  const okLone = hasDetail(lone, '状态', '跨分块') && (lone.summary || '').includes('无 PDO');

  check('分块扩展消息拼接', ok0 && okJoin && okLone,
    `块0:${c0?.summary?.slice(0, 40)} | 拼接:${okJoin} | 无前块:${lone?.summary}`);
}

/* ── ③.5 BIST 模式跨版本：同一数值在 PD 2.0 / 3.x 下含义不同 ── */
{
  const p2 = decodeBits(buildPacket(0, mkHeader({ type: 3, n: 1, id: 2, rev: 2 }), [0x00000000]).bits);
  const p3 = decodeBits(buildPacket(0, mkHeader({ type: 3, n: 1, id: 2, rev: 3 }), [0x80000000]).bits);
  const p3bad = decodeBits(buildPacket(0, mkHeader({ type: 3, n: 1, id: 2, rev: 3 }), [0x00000000]).bits);
  check('BIST 跨版本（2.0/3.x）',
    p2?.crcOk === true && (p2.summary || '').includes('Receiver')
    && p3?.crcOk === true && (p3.summary || '').includes('Test Data')
    && p3bad?.crcOk === true && (p3bad.summary || '').includes('未知模式'),
    `r2:0x0→「${p2?.summary}」 r3:0x8→「${p3?.summary}」 r3:0x0→「${p3bad?.summary}」`);
}

/* ── ③.6 Discover SVIDs：一个 VDO 里两两成对 ── */
{
  const svidHdr = ((0xFF00 << 16) | (1 << 15) | (1 << 6) | 2) >>> 0;
  const { bits } = buildPacket(0, mkHeader({ type: 15, n: 2, id: 3, rev: 3 }),
    [svidHdr, (((0xFF01) << 16) | 0x0000) >>> 0]);
  const p = decodeBits(bits);
  check('Discover SVIDs', !!p && p.crcOk === true
    && hasDetail(p, 'Object', 'VDO #2 · Responder VDO')
    && (p.summary || '').includes('0xFF01'),
    `summary: ${p?.summary}`);
}

/* ═══════════ ④ 采样率声明 ═══════════ */

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
