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
import { PowerzCapture, sniffPowerz, parsePowerzBlob, POWERZ_RATE } from '../src/js/core/powerz.js';
import { buildBusSeries } from '../src/js/core/pipeline.js';
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
}

/* ── ⑤.4 UFCS：只做容器 + 模拟量，不假装解析 ── */
{
  const ufcs = buildSqlite([
    {
      name: 'ufcs_chart', cols: ['Time real', 'VBUS real', 'IBUS real', 'DP real', 'DM real'],
      rows: [[0, 5.0, 1.0, 0.01, 0.02], [1.0, 9.0, 2.0, 0.01, 0.02]],
    },
    {
      name: 'ufcs_table', cols: ['Time real', 'Vbus real', 'Ibus real', 'Raw Blob'],
      rows: [[0, 5.0, 1.0, Uint8Array.from([1, 2, 3, 4])],
        [1.0, 9.0, 2.0, Uint8Array.from([5, 6, 7, 8])]],
    },
  ]);

  check('UFCS：识别为另一种导出', sniffPowerz(ufcs) === 'ufcs');

  const cap = PowerzCapture.open(ufcs);
  const { packets, stats } = await cap.decode();
  check('UFCS：模拟量可用、语义解析明确标注未实现', packets.length === 0
    && stats.unsupportedMsgs === 2 && !!stats.unsupported
    && stats.badWire === 0 && stats.truncatedRows === 0
    && cap.meta.busLabels.join('/') === 'DP/DM' && cap.meta.bus.length === 2,
    stats.unsupported);

  // 不是分析仪导出的库（魔数对但没有我们认识的表）必须判为不支持，而不是勉强当 PD 解
  const alien = buildSqlite([{ name: 'logs', cols: ['ts integer'], rows: [[1]] }]);
  check('非 POWER-Z 的 SQLite 判为不支持', isSqlite(alien) && sniffPowerz(alien) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
