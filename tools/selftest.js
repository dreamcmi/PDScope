/**
 * selftest.js — 用合成 PD 报文验证协议解析层
 *
 * 直接把「4B5B 符号流」拼成 BMC 解码后的比特数组喂给 PdDecoder，
 * 检查 SOP / Header / Data / CRC / EOP 与 PDO 语义是否逐字段还原。
 */
import { PdDecoder } from '../src/js/core/pd.js';
import { EdgeExtractor, BmcDecoder, UI_US, collectRunStats, estimateSampleRate } from '../src/js/core/bmc.js';
import { parseSampleRate, DEFAULT_SAMPLE_RATE } from '../src/js/core/atkcc.js';
import { SqliteReader, isSqlite } from '../src/js/core/sqlite.js';
import { PdStreamCapture, sniffPdStream, readPdStream, writePdStream } from '../src/js/core/pdstream.js';
import { PowerzCapture, sniffPowerz, parsePowerzBlob, POWERZ_RATE } from '../src/js/core/powerz.js';
import { UfcsDecoder, ufcsCrc8, ufcsLocateFrames, ufcsSplitFrames, ufcsHeaderInfo, ufcsParseRecord, ufcsParseEvent } from '../src/js/ufcs/index.js';
import { buildBusSeries } from '../src/js/core/pipeline.js';
import { csvText, csvHead, csvBase, csvFileName, csvExport, CSV_BOM, CSV_EOL } from '../src/js/core/csv.js';
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
  { name: 'GoodCRC', sop: 0, header: mkHeader({ type: 1, id: 1 }), data: [], expectType: 'GoodCRC' },
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

/* ═══════════ ⑤ 分析仪导出（POWER-Z / SQLite）路径 ═══════════
 *  ATK-C 存的是原始电平（要先跑 BMC → 4B5B）；POWER-Z 存的是**分析仪已经解好的逻辑字节**
 *  ＋两张普通的 SQLite 表。这条路径上有三件自己写的东西要盯住：
 *    ① SQLite 的只读页/记录解析（core/sqlite.js）
 *    ② Raw blob 的事件拆帧（core/powerz.js#parsePowerzBlob）
 *    ③ 逻辑字节回灌 PD 解码器（pd/decoder.js#decodeWire）
 *  下面用一个**手搓的最小 SQLite 库**做回归 —— 不依赖任何真实样本文件，CI 上也能跑。 */

/* ── ⑤.0 只够 selftest 用的最小 SQLite 生成器 ─────────────────────────
   页大小固定 4096、每张表恰好一页叶子页、记录头 < 128 字节。
   varint / serial type / cell / 页头都按规范自己写一遍 —— 万一 core/sqlite.js
   的读法写错了，这里也会跟着错得一致，所以额外的价值在于「格式理解对不对」由
   真实样本（tools/powerz-inspect.mjs）兜底，而「改动有没有把读路径弄坏」由这里兜底。 */
function encVarint(n) {
  const buf = [];
  let v = n;
  do { buf.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
  for (let i = 0; i < buf.length - 1; i++) buf[i] |= 0x80;   // 除末字节外都置续读位
  return buf;
}
function encValue(v) {
  if (v === null) return { st: 0, bytes: [] };
  if (typeof v === 'string') {
    const b = [...new TextEncoder().encode(v)];
    return { st: 13 + 2 * b.length, bytes: b };
  }
  if (v instanceof Uint8Array) return { st: 12 + 2 * v.length, bytes: [...v] };
  if (Number.isInteger(v) && v >= 0) {                       // 整数按最短字节数存
    if (v === 0) return { st: 8, bytes: [] };
    if (v === 1) return { st: 9, bytes: [] };
    const bytes = [];
    for (let x = v; x > 0; x = Math.floor(x / 256)) bytes.unshift(x & 0xff);
    return { st: bytes.length, bytes };
  }
  const dv = new DataView(new ArrayBuffer(8));
  dv.setFloat64(0, v, false);
  return { st: 7, bytes: [...new Uint8Array(dv.buffer)] };
}
function makeRecord(values) {
  const parts = values.map(encValue);
  const stBytes = parts.flatMap((p) => encVarint(p.st));
  const headerLen = 1 + stBytes.length;                      // 头长含它自己那个 varint
  if (headerLen > 127) throw new Error('测试用记录头过长');
  return Uint8Array.from([headerLen, ...stBytes, ...parts.flatMap((p) => p.bytes)]);
}
/** 一页表叶子页：cell 从页尾往前放，cell 指针数组紧跟页头 */
function leafPage(pageSize, cells, { page1 = false } = {}) {
  const base = page1 ? 100 : 0;                              // 第 1 页前面还有 100 字节库头
  const page = new Uint8Array(pageSize);
  let contentStart = pageSize;
  const offs = [];
  for (const c of cells) {
    const cell = [...encVarint(c.length), ...encVarint(offs.length + 1), ...c];
    contentStart -= cell.length;
    offs.push(contentStart);
    page.set(cell, contentStart);
  }
  page[base] = 0x0d;                                         // 表叶子页
  page[base + 3] = (cells.length >> 8) & 0xff;
  page[base + 4] = cells.length & 0xff;
  page[base + 5] = (contentStart >> 8) & 0xff;
  page[base + 6] = contentStart & 0xff;
  for (let i = 0; i < offs.length; i++) {
    page[base + 8 + 2 * i] = (offs[i] >> 8) & 0xff;
    page[base + 8 + 2 * i + 1] = offs[i] & 0xff;
  }
  return page;
}
function buildSqlite(specs) {
  const pageSize = 4096;
  const master = [];
  const dataPages = [];
  for (const s of specs) {
    master.push(['table', s.name, s.name, 2 + dataPages.length, `CREATE TABLE ${s.name}(${s.cols.join(', ')})`]);
    dataPages.push(leafPage(pageSize, s.rows.map(makeRecord)));
  }
  const p1 = leafPage(pageSize, master.map(makeRecord), { page1: true });
  const head = new Uint8Array(100);
  head.set(new TextEncoder().encode('SQLite format 3\u0000'));
  const set32 = (a, o, v) => {
    a[o] = (v >>> 24) & 0xff; a[o + 1] = (v >>> 16) & 0xff;
    a[o + 2] = (v >>> 8) & 0xff; a[o + 3] = v & 0xff;
  };
  head[16] = 16; head[17] = 0;                               // 页大小 4096
  head[18] = 1; head[19] = 1; head[20] = 0;                  // 回滚日志模式、无保留区
  head[21] = 64; head[22] = 32; head[23] = 32;
  set32(head, 24, 1);                                        // 变更计数
  set32(head, 28, 2 + dataPages.length);                     // 库总页数
  set32(head, 40, 1);                                        // schema cookie
  set32(head, 44, 1);                                        // schema 格式
  set32(head, 56, 1);                                        // 文本编码 = UTF-8
  set32(head, 92, 1);                                        // version-valid-for
  set32(head, 96, 3045000);                                  // 写库的 SQLite 版本号
  p1.set(head, 0);

  const out = new Uint8Array(pageSize * (2 + dataPages.length));
  out.set(p1, 0);
  dataPages.forEach((p, i) => out.set(p, pageSize * (i + 1)));
  return out;
}

/* ── ⑤.1 Raw blob 拆帧 ── */
{
  const evtConnect = Uint8Array.from([0x45, 100, 0, 0, 0x00, 0x11]);   // 毫秒 100 处插入
  const evtDisc = Uint8Array.from([0x45, 900 & 0xff, 900 >> 8, 0, 0x00, 0x12]);
  const wrap = (sop, ts, wire) => {
    const total = wire.length + 5;                            // 含 marker / ts / sop / wire
    return Uint8Array.from([0x80 | total, ts & 0xff, (ts >>> 8) & 0xff, (ts >>> 16) & 0xff,
      (ts >>> 24) & 0xff, sop, ...wire]);
  };

  const c = parsePowerzBlob(evtConnect);
  check('blob 拆帧：插入事件', c.events.length === 1 && c.events[0].kind === 'connect'
    && c.events[0].tsMs === 100 && !c.truncated, JSON.stringify(c.events));

  const d = parsePowerzBlob(evtDisc);
  check('blob 拆帧：拔出事件', d.events.length === 1 && d.events[0].kind === 'disconnect'
    && d.events[0].tsMs === 900, JSON.stringify(d.events));

  const wire = [0x11, 0xA1, 0x2C, 0x01, 0x00, 0x00];
  const m = parsePowerzBlob(wrap(2, 250, wire));
  const ev = m.events[0];
  check('blob 拆帧：包裹报文', m.events.length === 1 && !m.truncated && ev.kind === 'msg'
    && ev.tsMs === 250 && ev.sopByte === 2
    && ev.wire.length === wire.length && ev.wire.every((b, i) => b === wire[i]),
    `ts=${ev?.tsMs} sop=${ev?.sopByte} wire=${ev?.wire?.length}B`);

  // 多个事件首尾相接
  const multi = Uint8Array.from([...evtConnect, ...wrap(0, 250, wire), ...evtDisc]);
  const mm = parsePowerzBlob(multi);
  check('blob 拆帧：多事件串联', mm.events.length === 3 && !mm.truncated
    && mm.events.map((e) => e.kind).join(',') === 'connect,msg,disconnect',
    mm.events.map((e) => `${e.kind}@${e.tsMs}ms`).join(' '));

  // 拼不通的必须如实标记，不能硬猜长度
  const t1 = parsePowerzBlob(Uint8Array.from([0x8b, 0x01]));
  const t2 = parsePowerzBlob(Uint8Array.from([0x01, 0xff]));
  check('blob 拆帧：截断如实标记', t1.truncated && t1.events.length === 0
    && t2.truncated && t2.events.length === 0, `len过短=${t1.truncated} 未知标记=${t2.truncated}`);
}

/* ── ⑤.2 逻辑字节回灌解码器（decodeWire）── */
{
  const header = mkHeader({ n: 1, id: 0, type: 1, rev: 3 });          // Source_Cap ×1
  const wire = Uint8Array.from([
    header & 0xff, (header >>> 8) & 0xff,
    ...b4(fixedPdo),
  ]);
  const dec = new PdDecoder({ sampleRate: POWERZ_RATE });
  const p = dec.decodeWire(wire, { sop: 'SOP', timeMs: 250, channel: 0 });

  check('decodeWire：语义与原路径一致', !!p
    && p.msgType === 'Source_Cap' && p.msgKind === 'data' && p.nObjects === 1
    && p.sop === 'SOP' && p.role === 'SRC' && p.header === header
    && p.dataWords[0] === (fixedPdo >>> 0), `type=${p?.msgType} n=${p?.nObjects} role=${p?.role}`);

  check('decodeWire：时间戳直接当采样点', !!p
    && p.startSample === 250 && p.timeMs === 250 && p.synthetic === true,
    `startSample=${p?.startSample} timeMs=${p?.timeMs}`);

  // 分析仪不存 CRC：可以补算以便走通流程，但绝不能据此宣称「校验通过」
  check('decodeWire：CRC 未记录 ≠ 通过', !!p
    && p.crc === null && p.crcOk === null && p.crcRecorded === false
    && p.crcCalc === crc32(wire), `crc=${p?.crc} crcOk=${p?.crcOk} calc=0x${p?.crcCalc?.toString(16)}`);

  const cbl = dec.decodeWire(wire, { sop: "SOP'" });
  check('decodeWire：SOP\' 走线缆链路', !!cbl && cbl.sop === "SOP'" && cbl.link === 'cable',
    `sop=${cbl?.sop} link=${cbl?.link}`);

  // 分析仪给的字节未必都合法（截断、保留类型…）：可以解不出东西，但不许抛异常、
  // 更不许在这种情况下把 CRC 说成通过 —— 那等于替对方的数据背书。
  let threw = null, weird = [];
  for (const bad of [Uint8Array.from([0x00, 0x00]), Uint8Array.from([0xff, 0xff, 0x00]),
    new Uint8Array(0), Uint8Array.from([0x01])]) {
    try { weird.push(dec.decodeWire(bad, { sop: 'SOP' })); } catch (e) { threw = e; }
  }
  check('decodeWire：畸形字节不抛异常且不谎报 CRC',
    !threw && weird.every((p) => p === null || p.crcOk === null),
    threw ? `抛了 ${threw.message}` : weird.map((p) => (p ? `${p.msgType}/crcOk=${p.crcOk}` : 'null')).join(' , '));

  // 与既有路径的解析文本/详情同形（界面两条路径共用同一段渲染）
  const expectHex = b4(fixedPdo).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
  check('decodeWire：详情分组同形', !!p
    && hasDetail(p, 'Object', 'PDO #1') && p.dataHex === expectHex,
    `dataHex=${p?.dataHex} details=${p?.details?.length}`);
}

/* ── ⑤.3 SQLite 读取 + PowerzCapture 端到端 ── */
{
  const pzHeader = mkHeader({ n: 1, id: 0, type: 1, rev: 3 });
  const pzWire = Uint8Array.from([
    pzHeader & 0xff, (pzHeader >>> 8) & 0xff, ...b4(fixedPdo),
  ]);
  const wrap = (sop, ts) => {
    const total = pzWire.length + 5;
    return Uint8Array.from([0x80 | total, ts & 0xff, (ts >>> 8) & 0xff, (ts >>> 16) & 0xff,
      (ts >>> 24) & 0xff, sop, ...pzWire]);
  };

  const db = buildSqlite([
    {
      name: 'pd_chart', cols: ['Time real', 'VBUS real', 'IBUS real', 'CC1 real', 'CC2 real'],
      rows: [[0, 5.0, 1.5, 0.6, 0.02], [1.0, 9.0, 1.25, 0.6, 0.02], [2.5, 20.0, 2.0, 1.2, 0.02]],
    },
    {
      name: 'pd_table', cols: ['Time real', 'Vbus real', 'Ibus real', 'Raw Blob'],
      rows: [
        [0, 5.0, 1.5, Uint8Array.from([0x45, 100, 0, 0, 0x00, 0x11])],
        [2.0, 9.0, 1.25, wrap(0, 250)],
        [3.0, 20.0, 2.0, wrap(1, 400)],
      ],
    },
    { name: 'pd_table_key', cols: ['key integer'], rows: [] },
  ]);

  check('SQLite 读取：识别与建表语句', isSqlite(db) && sniffPowerz(db) === 'pd'
    && sniffPowerz(new Uint8Array(64)) === null,
    new SqliteReader(db).describe());

  const db2 = new SqliteReader(db);
  check('SQLite 读取：行数与列值', db2.count('pd_table') === 3 && db2.count('pd_chart') === 3
    && db2.count('pd_table_key') === 0
    && [...db2.rows('pd_chart')][2][1] === 20, `pd_table=${db2.count('pd_table')} 行`);

  const cap = PowerzCapture.open(db);
  const bus = cap.meta.bus;
  check('PowerzCapture：模拟量 → 时间轴数据', cap.meta.source === 'powerz'
    && cap.meta.kind === 'pd' && cap.meta.sampleRate === POWERZ_RATE
    && cap.meta.busLabels.join('/') === 'CC1/CC2' && cap.meta.channels.length === 1
    && bus.length === 3 && bus[0].vbus === 5 && bus[0].a === 0.6
    && bus[2].sample === 2500 && bus[2].vbus === 20,
    `bus=${bus.length} 点 · 末点 ${bus[bus.length - 1]?.vbus}V @ ${bus[bus.length - 1]?.sample}ms`);

  const ser = buildBusSeries(bus, cap.meta.totalSamples, POWERZ_RATE);
  check('buildBusSeries：额外通道一并展开', ser.hasAux === true && ser.ca[0] === 0.6
    && ser.ca[ser.n - 1] === 1.2 && ser.camax === 1.2 && ser.vmax === 20,
    `n=${ser.n} vmax=${ser.vmax} camax=${ser.camax}`);

  const { packets, stats } = await cap.decode();
  check('PowerzCapture：端到端解出报文', packets.length === 2
    && packets[0].msgType === 'Source_Cap' && packets[1].msgType === 'Source_Cap'
    && packets[0].sop === 'SOP' && packets[1].sop === "SOP'"
    && packets[0].startSample === 250 && packets[1].startSample === 400
    && packets.every((p) => p.crcOk === null),
    packets.map((p) => `${p.sop} ${p.msgType}@${p.startSample}`).join(' | '));

  check('PowerzCapture：统计口径', stats.connectCount === 1 && stats.disconnectCount === 0
    && stats.badWire === 0 && stats.truncatedRows === 0 && stats.unsupportedMsgs === 0
    && stats.badCrc === 0 && stats.crcUnknown === packets.length && stats.warnings === 0,
    `连接 ${stats.connectCount} · badWire ${stats.badWire} · CRC 未知 ${stats.crcUnknown}`);

  /* ── ⑤.3b 同一个抓包的另一半容器：POWER-Z 的 `.pdStream` ──────────────
     `.pdStream` 里装的就是 `pd_table` 那四列（二进制记录流，无文件头 / 无索引），
     所以这里把**同一批行**再走一遍 `.pdStream` 路径：解出来的报文必须与上面
     SQLite 路径逐字段一致 —— 换容器只能改变「字节怎么摆」，不该改变语义。

     另外这个格式**没有魔数可依**（文件开头就是一条普通记录），全靠结构自证，
     认错的代价是把垃圾文件当抓包打开，所以「什么不该认」和「什么该认」一样要测。 */
  {
    const rows = [];
    for (const r of new SqliteReader(db).rows('pd_table')) {
      rows.push({ time: r[0], vbus: r[1], ibus: r[2], raw: r[3] });
    }
    const stream = writePdStream(rows);
    check('.pdStream：写出来的字节能被结构自证认出',
      sniffPdStream(stream) === true && readPdStream(stream).records.length === rows.length,
      `${stream.length} 字节 / ${rows.length} 条记录`);

    const back = readPdStream(stream).records;
    check('.pdStream：读回来的字段一字节不差',
      back.length === rows.length
      && back.every((r, i) => r.time === rows[i].time && r.vbus === rows[i].vbus && r.ibus === rows[i].ibus
        && r.raw.length === rows[i].raw.length && r.raw.every((b, k) => b === rows[i].raw[k])),
      `${back.length} 条 · 末条 t=${back[back.length - 1]?.time}s`);

    const pds = PdStreamCapture.open(stream);
    const pdsDecoded = await pds.decode();
    const key = (p) => [p.sop, p.msgType, p.role, p.startSample, p.dataHex, p.crcOk, p.index].join('|');
    check('.pdStream：解出来的报文与 SQLite 路径逐字段一致',
      pdsDecoded.packets.length === packets.length
      && pdsDecoded.packets.every((p, i) => key(p) === key(packets[i])),
      pdsDecoded.packets.map((p) => `${p.sop} ${p.msgType}@${p.startSample}`).join(' | '));

    // 时长口径：`.pdStream` 没有 ADC 表，总长只能取「最后一条记录的时间」
    // （这里 3.0s = pd_table 末行），而 SQLite 那份是 max(chart 末点 2.5s, 报文末点)。
    // 差别是这两种容器**固有的**：少了采样序列，时间轴就只能按事件画到底。
    check('.pdStream：统计口径与 SQLite 路径一致（连接事件照收）',
      pdsDecoded.stats.connectCount === stats.connectCount
      && pdsDecoded.stats.tableRows === rows.length && pdsDecoded.stats.chartRows === 0
      && pdsDecoded.stats.durationSec === rows[rows.length - 1].time,
      `连接 ${pdsDecoded.stats.connectCount} · 行 ${pdsDecoded.stats.tableRows} · `
      + `时长 ${pdsDecoded.stats.durationSec}s（= 末条记录；SQLite 那份是 ${stats.durationSec}s）`);

    check('.pdStream：容器元信息如实（不是 SQLite、没有 ADC 波形）',
      pds.meta.source === 'powerz' && pds.meta.container === 'pdstream' && pds.meta.sqlite === null
      && pds.meta.bus.length === 0 && pds.meta.chartRows === 0 && pds.meta.busLabels.length === 0
      && pds.meta.totalSamples === rows[rows.length - 1].time * POWERZ_RATE && /\.pdStream/.test(pds.meta.title),
      `${pds.meta.title} · totalSamples=${pds.meta.totalSamples} · 记录 ${pds.meta.stream.records} 条`);

    // 负例：截断 / 多一个字节 / 伪随机 / ZIP 头，以及「时间倒退」这种结构上说不通的数据
    const trunc = stream.subarray(0, stream.length - 3);
    const extra = Uint8Array.from([...stream, 0]);
    const junk = Uint8Array.from({ length: 4096 }, (_, i) => (i * 37 + 11) & 0xFF);
    const zipHead = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, ...new Uint8Array(2000)]);
    check('.pdStream：认不出就明说（截断 / 多字节 / 乱码 / ZIP 头）',
      !sniffPdStream(trunc) && !sniffPdStream(extra) && !sniffPdStream(junk) && !sniffPdStream(zipHead)
      && !sniffPdStream(new Uint8Array(8)));

    const backward = Uint8Array.from(stream);
    const dv = new DataView(backward.buffer);
    const timeOffs = [];
    for (let off = 0; off < backward.length;) {
      const len = dv.getUint32(off, false);
      timeOffs.push(off + 4 + len);
      off += 4 + len + 24;
    }
    dv.setFloat64(timeOffs[1], dv.getFloat64(timeOffs[0], false) - 1, false);
    check('.pdStream：时间倒退不算这个格式', !sniffPdStream(backward));

    let msg = '';
    try { readPdStream(trunc); } catch (e) { msg = e.message; }
    check('.pdStream：读不动时说明卡在哪个偏移', /不是 \.pdStream/.test(msg) && /偏移/.test(msg), msg);
  }
}

/* ── ⑤.4 UFCS：报文语义解析（独立库 src/js/ufcs/ + core/powerz.js 的容器层）──
   UFCS 的物理层就是 UART，规范（T/TAF 083—2024）第 8 章定义了三种消息结构。
   下面用**照规范自己拼的帧**做回归：CRC-8、消息头四段位域、控制/数据/自定义三类
   消息、方向还原、ACK 配对，以及容器前缀定位（存不存 CRC、带不带链路字节）。 */
{
  /** 按规范拼一条 UFCS 帧：消息头(2B 大端) + 主体 + CRC-8(1B) */
  const mkFrame = (addr, msgNo, ver, mtype, body) => {
    const hdr = (addr << 13) | (msgNo << 9) | (ver << 3) | mtype;
    const b = [(hdr >> 8) & 0xFF, hdr & 0xFF, ...body];
    b.push(ufcsCrc8(b));
    return Uint8Array.from(b);
  };
  const be16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];
  /** 8 字节输出模式（表 16） */
  const mkMode = (no, cs, vs, maxV, minV, maxI, minI) => {
    const v = (BigInt(no) << 60n) | (BigInt(cs) << 57n) | (BigInt(vs) << 56n)
      | (BigInt(maxV) << 40n) | (BigInt(minV) << 24n) | (BigInt(maxI) << 8n) | BigInt(minI);
    const o = [];
    for (let i = 7; i >= 0; i--) o.push(Number((v >> BigInt(i * 8)) & 0xFFn));
    return o;
  };

  /* ① CRC-8：用「表驱动」再实现一遍（写法与库里的逐位版不同），两边必须一致。
     单靠一个已知向量钉不住整个算法，随机比对才防得住转录错误。 */
  const CRC8_T = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = (c & 0x80) ? (((c << 1) ^ 0x29) & 0xFF) : ((c << 1) & 0xFF);
      t[i] = c;
    }
    return t;
  })();
  const crc8Ref = (bytes) => { let c = 0; for (const b of bytes) c = CRC8_T[(c ^ b) & 0xFF]; return c; };
  let same = 0;
  for (let n = 0; n < 400; n++) {
    const len = 1 + (n % 24);
    const buf = Uint8Array.from({ length: len }, (_, i) => (n * 31 + i * 17 + 7) & 0xFF);
    if (ufcsCrc8(buf) === crc8Ref(buf)) same++;
  }
  check('UFCS：CRC-8 与参照实现一致', same === 400, `${same}/400 组相同（多项式 0x29）`);

  /* ② 消息头位域（表 13） */
  const h = ufcsHeaderInfo((0b010 << 13) | (0b1010 << 9) | (0b010001 << 3) | 0b001);
  check('UFCS：消息头位域', h.addr === 0b010 && h.msgNo === 0b1010 && h.mtype === 0b001
    && h.verCode === 0b010001 && h.verText === '1.0.1' && h.addrValid && h.mtypeValid,
    `addr=${h.addr} no=${h.msgNo} ver=${h.verText} type=${h.mtype}`);

  /* ③ 三类消息的语义 */
  const dec = new UfcsDecoder({ sampleRate: POWERZ_RATE });

  const ping = mkFrame(0b001, 3, 0b000001, 0, [0x00]);
  const pPing = dec.decodeFrame(ping, { timeMs: 1, line: 'D-' });
  check('UFCS：控制消息 Ping', pPing.msgType === 'Ping' && pPing.msgKind === 'control'
    && pPing.crcOk === true && pPing.role === 'SNK' && pPing.sop === 'D-',
    `${pPing.msgType} ${pPing.sop} ${pPing.role} crc=${pPing.crcOk}`);

  // Output_Capabilities：模式2 = 5.5~11V / 0.5~5A（表 16 的示例）
  const ocBody = [0x01, 16, ...mkMode(1, 2, 1, 550, 340, 600, 50), ...mkMode(2, 2, 1, 1100, 550, 500, 50)];
  const pOc = dec.decodeFrame(mkFrame(0b010, 1, 0b001001, 1, ocBody), { timeMs: 2 });
  const ocTxt = pOc.details.map((d) => `${d.key}=${d.value}`).join('|');
  check('UFCS：Output_Capabilities 逐字段', pOc.msgType === 'Output_Capabilities'
    && pOc.role === 'SRC' && pOc.sop === 'D+'
    && /最大输出电压 \[B55-40\]=1100 × 10mV = 11 V/.test(ocTxt)
    && /最小输出电流 \[B7-0\]=50 × 10mA = 0.5 A/.test(ocTxt)
    && /电流调节步进 \[B59-57\]=2 · 30 mA/.test(ocTxt),
    pOc.summary);

  // Request：模式 1、5.1V、3A（规范 8.2.4.2 的例子）
  const reqBody = [0x02, 8, 0x10, 0x00, 0x00, 0x00, ...be16(510), ...be16(300)];
  const pReq = dec.decodeFrame(mkFrame(0b001, 2, 0b001001, 1, reqBody), { timeMs: 3 });
  check('UFCS：Request 逐字段', /请求模式 1：5.1 V \/ 3 A/.test(pReq.summary) && pReq.role === 'SNK',
    pReq.summary);

  // Cable_Information：10 字节，VID/阻抗/承载能力
  const pCab = dec.decodeFrame(mkFrame(0b001, 4, 0b001001, 1,
    [0x05, 10, ...be16(0x1234), ...be16(0), ...be16(100), ...be16(2000), ...be16(500)]), { timeMs: 4, line: 'D+' });
  check('UFCS：Cable_Information 逐字段',
    /线缆承载 20 V \/ 5 A · 阻抗 100 mΩ · VID 0x1234/.test(pCab.summary) && pCab.role === 'Plug',
    pCab.summary);

  // 厂家自定义消息：消息头(2) + 厂家识别码(2) + 长度(1) + 数据(N) + CRC
  const pCus = dec.decodeFrame(mkFrame(0b010, 5, 0b001001, 2, [0x12, 0x34, 3, 0xAA, 0xBB, 0xCC]), { timeMs: 5 });
  check('UFCS：厂家自定义消息', pCus.msgKind === 'custom' && pCus.msgType === 'Manufacturer_Custom'
    && /0x1234/.test(pCus.summary) && pCus.crcOk === true, pCus.summary);

  // Sink_Information_Extended：电池电量 0x254E = 95.50%（规范 8.2.4.13 的例子）
  // 每项 3 字节 = 类型(高 4bit)+保留(低 4bit) │ 状态数据(16bit)；type=0001b 即「电池电量」
  const pExt = dec.decodeFrame(mkFrame(0b001, 6, 0b001001, 1, [0x0D, 3, 0x10, ...be16(0x254E)]), { timeMs: 6 });
  check('UFCS：Sink_Info_Extended 类型/数据', /电池电量=95.5 %/.test(pExt.summary), pExt.summary);

  // Refuse：拒绝原因 0x04
  const pRef = dec.decodeFrame(mkFrame(0b001, 7, 0b001001, 1, [0x09, 4, 0x02, 0x00, 0x00, 0x04]), { timeMs: 7 });
  check('UFCS：Refuse 拒绝原因', /超出范围/.test(pRef.summary), pRef.summary);

  // 坏 CRC 必须被发现，且不能影响其它字段的解析
  const badFrame = mkFrame(0b001, 8, 0b001001, 1, reqBody);
  badFrame[badFrame.length - 1] ^= 0xFF;
  const pBad = dec.decodeFrame(badFrame, { timeMs: 8 });
  check('UFCS：CRC 错误被识别', pBad.crcOk === false && pBad.msgType === 'Request'
    && pBad.warnings.some((w) => w.short === 'CRC') && /请求模式 1/.test(pBad.summary),
    `crcOk=${pBad.crcOk}`);

  // 长度不符要报出来（Request 声明 8，实际给 5）
  const pShort = dec.decodeFrame(mkFrame(0b001, 9, 0b001001, 1, [0x02, 5, 1, 2, 3, 4, 5]), { timeMs: 9 });
  check('UFCS：数据长度校验', pShort.warnings.some((w) => w.short === 'LEN'), pShort.warnings.map((w) => w.short).join(','));

  // 方向与规范不符要报出来（Request 只可能由充电设备发给供电设备）
  const pWrongDir = dec.decodeFrame(mkFrame(0b010, 10, 0b001001, 1, reqBody), { timeMs: 10 });
  check('UFCS：方向与规范不符告警', pWrongDir.warnings.some((w) => w.short === 'DIR'),
    pWrongDir.warnings.map((w) => w.short).join(','));

  /* ④ 容器定位：前缀长度 / 存不存 CRC，都要能落回同一条解析路径 */
  const ts4 = [0x40, 0xE2, 0x01, 0x00];
  const locPlain = ufcsLocateFrames(Uint8Array.from([...ts4, ...ping]));
  check('UFCS：容器 4B 时间戳 + 带 CRC', locPlain && locPlain.prefixBytes === 4 && locPlain.withCrc === true
    && locPlain.frames.length === 1, locPlain ? `前缀 ${locPlain.prefixBytes}B / CRC ${locPlain.withCrc}` : 'null');

  const locDir = ufcsLocateFrames(Uint8Array.from([...ts4, 0x01, ...ping]));
  check('UFCS：容器 时间戳 + 链路字节', locDir && locDir.prefixBytes === 5 && locDir.withCrc === true
    && locDir.frames.length === 1, locDir ? `前缀 ${locDir.prefixBytes}B` : 'null');

  const noCrc = Uint8Array.from([...ts4, ...ping.subarray(0, ping.length - 1)]);
  const locNoCrc = ufcsLocateFrames(noCrc);
  const pNoCrc = locNoCrc ? dec.decodeFrame(noCrc.subarray(locNoCrc.prefixBytes), { timeMs: 11 }) : null;
  check('UFCS：容器不存 CRC', locNoCrc && locNoCrc.withCrc === false && pNoCrc
    && pNoCrc.crcOk === null && pNoCrc.msgType === 'Ping' && pNoCrc.crcCalc === ping[ping.length - 1],
    locNoCrc ? `前缀 ${locNoCrc.prefixBytes}B / crcOk=${pNoCrc?.crcOk}` : 'null');

  const multi = Uint8Array.from([0x80 | 0, ...ping, ...mkFrame(0b010, 4, 0b001001, 0, [0x01])]);
  check('UFCS：一行两帧', ufcsSplitFrames(multi, 1, true)?.length === 2, String(ufcsSplitFrames(multi, 1, true)?.length));

  /* ④b 分析仪容器（实测归纳的 9 字节布局）—— 这条布局认出来，方向才有硬依据可依。
         布局：ts(4B LE ms) │ x0 │ x1 │ len(=N+1) │ flag │ 0xAA │ 帧(N 含 CRC) */
  const recLine = (tsMs, flag, fr, x0, x1) => Uint8Array.from([
    tsMs & 0xFF, (tsMs >>> 8) & 0xFF, (tsMs >>> 16) & 0xFF, (tsMs >>> 24) & 0xFF,
    x0, x1, fr.length + 1, flag, 0xAA, ...fr,
  ]);
  const rec = ufcsParseRecord(recLine(0x0001E240, 0, ping, 0x00, ping.length - 1));
  check('UFCS：容器 9B 前缀被认出', !!rec && rec.prefixBytes === 9 && rec.training === true
    && rec.lenField === ping.length + 1 && rec.tsMs === 0x0001E240,
    rec ? `前缀 ${rec.prefixBytes}B len=${rec.lenField} ts=${rec.tsMs}` : 'null');
  check('UFCS：容器链路字节 → 物理方向', rec && rec.line === 'D+' && rec.counter.x0 === 0x00
    && rec.counter.x1 === ping.length - 1 && rec.frames[0].crcOk === true,
    rec ? `${rec.line} x0=${rec.counter.x0} x1=${rec.counter.x1}` : 'null');
  check('UFCS：容器链路字节 1 → D−', ufcsParseRecord(recLine(1, 1, ping, 0, 3))?.line === 'D-');

  // 反证：长度域对不上、Training 字节不是 0xAA、flag 越界 —— 都不许硬认
  const badLen = recLine(1, 0, ping, 0, 3); badLen[6] = 0x7F;
  check('UFCS：容器长度域不符则不认', ufcsParseRecord(badLen) === null);
  const badTr = recLine(1, 0, ping, 0, 3); badTr[8] = 0x55;
  check('UFCS：容器无 Training 字节则不认', ufcsParseRecord(badTr) === null);
  const badFlag = recLine(1, 2, ping, 0, 3);
  check('UFCS：容器链路字节越界则不认', ufcsParseRecord(badFlag) === null);

  // 状态事件行：ts(4B LE ms) │ code │ 00 │ 00 │ 0x40 —— 不承载报文，必须能单独认出来
  const ev = ufcsParseEvent(Uint8Array.from([0x40, 0xE2, 0x01, 0x00, 0x04, 0x00, 0x00, 0x40]));
  check('UFCS：状态事件行', ev && ev.code === 0x04 && ev.tsMs === 0x0001E240,
    ev ? `code=0x${ev.code.toString(16)} ts=${ev.tsMs}` : 'null');
  check('UFCS：状态事件不与报文混淆',
    ufcsParseEvent(recLine(1, 0, ping, 0, 3)) === null
    && ufcsParseEvent(Uint8Array.from([0x40, 0xE2, 0x01, 0x00, 0x04, 0x00, 0x00, 0x41])) === null);

  /* ⑤ 端到端：手搓 SQLite（含真实 UFCS 帧）→ PowerzCapture → 报文列表
        行的容器前缀用实测的 9 字节布局；再掺一行状态事件、一行残行 */
  const reqFull = [0x02, 8, 0x10, 0x00, 0x00, 0x00, ...be16(510), ...be16(300)];
  const lines = [
    { t: 0, blob: recLine(0, 0, mkFrame(0b010, 1, 0b001001, 1, ocBody), 0x00, 0x1B) },  // SRC → SNK
    { t: 0.01, blob: recLine(10, 1, mkFrame(0b001, 1, 0b001001, 0, [0x01]), 0x00, 0x03) }, // SNK 的 ACK
    { t: 0.02, blob: recLine(20, 1, mkFrame(0b001, 2, 0b001001, 1, reqFull), 0x04, 0x12) },
    { t: 0.03, blob: recLine(30, 0, mkFrame(0b010, 2, 0b001001, 0, [0x05]), 0x1C, 0x1E) },
    { t: 0.04, blob: recLine(40, 1, (() => { const f = mkFrame(0b001, 3, 0b001001, 1, reqFull); f[f.length - 1] ^= 0xFF; return f; })(), 0x13, 0x21) },
    { t: 0.045, blob: Uint8Array.from([0x40, 0x2C, 0x00, 0x00, 0x03, 0x00, 0x00, 0x40]) }, // 状态事件行
    { t: 0.05, blob: Uint8Array.from([0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]) },         // 认不出来的残行
  ];
  const ufcs = buildSqlite([
    {
      name: 'ufcs_chart', cols: ['Time real', 'VBUS real', 'IBUS real', 'DP real', 'DM real'],
      rows: [[0, 5.0, 1.0, 0.01, 0.02], [1.0, 9.0, 2.0, 0.01, 0.02]],
    },
    {
      name: 'ufcs_table', cols: ['Time real', 'Vbus real', 'Ibus real', 'Raw Blob'],
      rows: lines.map(({ t, blob }) => [t, 5.0, 1.0, blob]),
    },
  ]);

  check('UFCS：识别为另一种导出', sniffPowerz(ufcs) === 'ufcs');

  const cap = PowerzCapture.open(ufcs);
  const { packets, stats } = await cap.decode();
  const types = packets.map((p) => p.msgType).join(',');
  check('UFCS：端到端解出报文', packets.length === 5
    && types === 'Output_Capabilities,ACK,Request,Power_Ready,Request',
    types);
  check('UFCS：方向与链路', packets[0].sop === 'D+' && packets[0].role === 'SRC'
    && packets[1].sop === 'D-' && packets[1].role === 'SNK'
    && packets[2].role === 'SNK' && packets[3].role === 'SRC',
    packets.map((p) => `${p.sop}/${p.role}`).join(' '));
  check('UFCS：ACK 与被确认报文配对', packets[1].ackOf === 0 && packets[1].ackType === 'Output_Capabilities'
    && packets[0].ackOf === undefined, `ackOf=${packets[1].ackOf}`);
  check('UFCS：CRC 统计口径', stats.badCrc === 1 && stats.crcUnknown === 0
    && stats.unsupportedMsgs === 0 && stats.ufcsUnlocatedRows === 1 && stats.ufcsFrames === 5,
    `bad=${stats.badCrc} unknown=${stats.crcUnknown} 残行=${stats.ufcsUnlocatedRows}`);
  // 方向全部来自容器给出的链路，一条都不该落到「按地址猜」——这是这次修的核心
  check('UFCS：方向全部有硬依据（无推断）', stats.ufcsDirFromLine === 5 && stats.ufcsDirInferred === 0
    && packets.every((p) => !p.roleInferred),
    `link=${stats.ufcsDirFromLine} 推断=${stats.ufcsDirInferred}`);
  // 容器来源字段（layout/training/lenField…）不再上界面，但必须照常随报文透出：
  // 排查「换了别的分析仪」时，全靠这几个字段区分是容器层变了还是协议层有问题。
  check('UFCS：报文仍带容器来源字段（界面不展示）', packets.every((p) => p.ufcs?.layout === 'record' && p.ufcs.training === true),
    packets.map((p) => p.ufcs?.layout).join(','));
  // 容器字段（时间戳 / 游标 / 长度 / 链路 / Training）不进详情面板：它们没有规范条文可对照，
  // 摆在与「消息头」「CRC」相邻的位置会被当成标准字段读。数据照常透出（见上一条）即可。
  const leaked = packets.flatMap((p) => p.details.filter((d) => d.key === 'Object' && d.value.includes('容器')));
  check('UFCS：详情面板不含容器字段', leaked.length === 0, leaked.map((d) => d.value).join(' / '));
  check('UFCS：状态事件单独统计，不计入报文', stats.ufcsEvents === 1
    && stats.ufcsEventCodes.length === 1 && stats.ufcsEventCodes[0].code === 0x03
    && stats.ufcsEventCodes[0].n === 1,
    `n=${stats.ufcsEvents} ${JSON.stringify(stats.ufcsEventCodes)}`);
  check('UFCS：模拟量可用且不再标注未实现', cap.meta.busLabels.join('/') === 'DP/DM'
    && cap.meta.bus.length === 2 && cap.meta.unsupported === null && stats.unsupported === null);

  // 不是分析仪导出的库（魔数对但没有我们认识的表）必须判为不支持，而不是勉强当 PD 解
  const alien = buildSqlite([{ name: 'logs', cols: ['ts integer'], rows: [[1]] }]);
  check('非 POWER-Z 的 SQLite 判为不支持', isSqlite(alien) && sniffPowerz(alien) === null);
}

/* ═══════════ ⑥ CSV 导出（src/js/core/csv.js） ═══════════
 *  界面「另存为」、桌面版命令行 `--csv`、`node tools/cli.js --csv` 三个出口共用这一份实现，
 *  所以这里测的是「三个出口共同承诺的那点格式」：列名 / 引号转义 / 行尾 / BOM / CRC 三态。
 *  只喂**手搓的报文对象**，不碰容器与解码——格式回归就该与解析路径解耦。 */
{
  const mk = (over = {}) => ({
    index: 0, sop: 'SOP', msgType: 'Source_Capabilities', msgId: 1, role: 'SRC',
    nObjects: 7, dataLen: 28, timeMs: 1234.5, vbus: 5.1, ibus: 2.25,
    dataHex: 'AA BB', crcOk: true, summary: '固定 5 V / 3 A', ...over,
  });

  // ① 行尾 / BOM / 结尾不留空行：Excel 与命令行重定向都按这个来
  const one = csvText([mk()], { protocol: 'USB PD' });
  check('CSV：带 BOM、CRLF 行尾、结尾无空行',
    one.startsWith(CSV_BOM) && one.includes('\r\n') && !one.endsWith('\n')
      && one.split(CSV_EOL).length === 2,
    `${one.length} 字符`);
  check('CSV：不要 BOM 时前三个字节不留痕',
    !csvText([mk()], { bom: false }).startsWith(CSV_BOM));

  // ② 每个字段都加引号；字段里的引号翻倍（RFC 4180），否则摘要一带引号整表就散列了
  const quoted = csvText([mk({ summary: '他说"5V"' })], { protocol: 'USB PD' });
  check('CSV：字段一律加引号，内部引号翻倍',
    quoted.includes('"他说""5V"""') && !/,(?=[^"])/.test(quoted.split(CSV_EOL)[1].slice(1, -1)),
    quoted.split(CSV_EOL)[1]);

  // ③ 列数：表头几列，每行就得几列（今天 13 列；将来加列时这条会立刻发现漏填）
  const rows = csvText([mk(), mk({ index: 1 })], { protocol: 'USB PD' }).split(CSV_EOL);
  check('CSV：每行列数与表头一致', rows.every((r) => r.split('","').length === csvHead('USB PD').length),
    `${rows[0].split('","').length} 列`);

  // ④ 第 6 列按协议换含义：PD 是数据对象个数，UFCS 是数据字节数
  check('CSV：列头按协议换第 6 列（Objects / Bytes）',
    csvHead('USB PD')[5] === 'Objects' && csvHead('UFCS')[5] === 'Bytes');
  const ufcsRow = csvText([mk({ nObjects: 28, dataLen: 24, role: 'SRC', sop: 'D+' })], { protocol: 'UFCS' })
    .split(CSV_EOL)[1];
  check('CSV：UFCS 取 dataLen（不是 nObjects）', ufcsRow.split('","')[5] === '24', ufcsRow.split('","')[5]);

  // ⑤ CRC 是**三态**：通过 / 校验错 / 未记录（POWER-Z 的 PD 报文就是第三种）。
  //    未记录必须留空，写成 OK 就是替分析仪的数据背书。
  const crcOf = (v) => csvText([mk({ crcOk: v })], { protocol: 'USB PD' }).split(CSV_EOL)[1].split('","')[11];
  check('CSV：CRC 三态（OK / BAD / 空）', crcOf(true) === 'OK' && crcOf(false) === 'BAD' && crcOf(null) === '',
    `${crcOf(true)} / ${crcOf(false)} / "${crcOf(null)}"`);

  // ⑥ 时标两列同源：字符串是给人看的，裸毫秒是给算差值用的
  const t = csvText([mk({ timeMs: 3661123.4567 })], { protocol: 'USB PD' }).split(CSV_EOL)[1].split('","');
  check('CSV：时标两列（hh:mm:ss.mmm + 裸毫秒）',
    t[6] === '01:01:01.123' && t[7] === '3661123.4567', `${t[6]} / ${t[7]}`);

  // ⑦ 默认导出名与界面一致：去扩展名 + 带通道号（多通道文件换个通道不该覆盖上一份）
  check('CSV：默认文件名 <主干>-ch<通道>.csv',
    csvFileName('绿联70w.atkcc', 3) === '绿联70w-ch3.csv'
      && csvFileName('山泽60w.SQLITE', 0) === '山泽60w-ch0.csv'
      && csvBase('a.db') === 'a' && csvBase('dump') === 'dump' && csvBase('') === 'pdscope',
    csvFileName('绿联70w.atkcc', 3));

  // ⑧ 空报文表也要出一份只有表头的合法 CSV（命令行导出零报文时不该产出空文件）
  const empty = csvText([], { protocol: 'USB PD' });
  check('CSV：零报文时仍输出表头', empty === CSV_BOM + csvHead('USB PD').map((h) => `"${h}"`).join(','));

  // ⑨ 导出件：命令行导出（桌面版与 tools/cli.js）拼出来的这一整包 ——
  //    文件名、行数、摘要里的那些话都在这里，两个出口共用，所以只测这一处。
  const doc = {
    fileName: '山泽60w-ip18pro.sqlite',
    channel: 2,
    rate: 1000,
    meta: { protocol: 'UFCS', source: 'powerz', sampleRateSource: 'powerz' },
    packets: [mk({ sop: 'D+', role: 'SRC', dataLen: 24 }), mk({ index: 1, crcOk: null, dataLen: 0 })],
    stats: { sampleRateSource: 'powerz', crcUnknown: 2, badCrc: 0, durationSec: 9.91 },
    decodedMs: 12,
    channelPick: { picked: 2, noiseRejected: 1, allNoisy: false },
  };
  const limited = csvExport(doc, { limit: 1 });
  check('CSV：导出件带建议文件名与通道', limited.fileName === '山泽60w-ip18pro-ch2.csv'
    && limited.channel === 2 && limited.protocol === 'UFCS' && limited.source === 'powerz',
    `${limited.fileName} ch${limited.channel}`);
  check('CSV：limit 只截行数，不动报文总数', limited.rows === 1 && limited.packets === 2
    && limited.csv.split(CSV_EOL).length === 2, `${limited.rows}/${limited.packets}`);
  check('CSV：摘要里如实报「CRC 未记录 / 自动选道 / 截断」',
    limited.notes.some((n) => /CRC 未记录/.test(n))
      && limited.notes.some((n) => /自动选了 ch2/.test(n))
      && limited.notes.some((n) => /只导了前 1 条/.test(n)),
    limited.notes.join(' | '));
  const full = csvExport(doc);
  check('CSV：不给 limit 就是全部，且默认带 BOM',
    full.rows === 2 && full.csv.startsWith(CSV_BOM) && full.notes.every((n) => !/只导了前/.test(n)),
    `${full.rows} 行`);
  check('CSV：采样率摘要按量级取单位', full.sampleRateText === '1.00 kHz', full.sampleRateText);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
