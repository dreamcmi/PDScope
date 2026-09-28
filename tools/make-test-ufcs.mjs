#!/usr/bin/env node
/**
 * make-test-ufcs.mjs — 造一份**合成**的 UFCS 抓包（POWER-Z `.sqlite` 形态）
 *
 * 为什么要造：真实 UFCS 样本（`ufcs_vivo_x300u.sqlite`）是抓来的私货，按 `.gitignore`
 * 不入库，于是 CI 与「刚 clone 下来」的机器上跑不了 `npm run e2e:ufcs`。
 * 这里按 T/TAF 083—2024 的结构，用手拼的报文 + 最小 SQLite 库补上这份输入，
 * 与 `make-test-atkcc.mjs`（造压力样本）是一个路数。
 *
 * ⚠ 它验证的是**集成链条**（容器嗅探 → 逐行定位 → UFCS 解码 → 报文表 / 详情 / 筛选），
 *   **不是**协议符合性 —— 报文是我按规范自己拼的，拿它证明「解析器符合规范」是循环论证。
 *   规范符合性由 `tools/selftest.js` 的字段级用例兜底，真实容器格式则由抓来的样本兜底。
 *
 * 造出来的库刻意覆盖了几种情形，好让 e2e 一次把岔路走全：
 *   · 数据 / 控制两类消息、一条单向命令（方向由规范表判定）
 *   · 一条**坏 CRC** 的报文（界面要标红、统计行要计数）
 *   · 一行动**状态事件**（`ts | code | 00 00 | 0x40`，不承载报文）
 *   · 一行**定位不出报文**的残行（界面要说清「没有一行能认出」，而不是假装解析失败）
 *   · 每行前缀都是实测归纳出的 9 字节容器布局，覆盖 `ufcsParseRecord` 那条「认得出来」的路
 *
 * ⚠ 容器布局（9 字节前缀 + 帧）是**实测归纳**出来的私有约定，不是规范内容。
 *   这里照着它造样本，是为了让 e2e 走通「按容器给出的链路定方向」那条路；
 *   证明容器格式正确仍是抓来的真实样本的职责。
 *
 * 用法：
 *   node tools/make-test-ufcs.mjs                        # → artifacts/_ufcs_synth.sqlite
 *   node tools/make-test-ufcs.mjs --out /tmp/x.sqlite
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const OUT = resolve(ROOT, arg('--out', 'artifacts/_ufcs_synth.sqlite'));

/* ══════════════ UFCS 组帧（规范 8.2）══════════════ */

/** CRC-8：多项式 X⁸+X⁵+X³+1（0x29）、初值 0x00，覆盖消息头 + 消息主体（规范 8.2） */
function crc8(bytes) {
  let c = 0;
  for (const b of bytes) {
    c ^= b & 0xFF;
    for (let i = 0; i < 8; i++) c = (c & 0x80) ? (((c << 1) ^ 0x29) & 0xFF) : ((c << 1) & 0xFF);
  }
  return c;
}

const VER_1_2_0 = 0b001001;          // 表 13：低 2bit 大版本 / 中 2bit 中版本 / 高 2bit 小版本
const ADDR = { SRC: 0b001, SNK: 0b010, CABLE: 0b011 };
const MTYPE = { control: 0b000, data: 0b001, custom: 0b010 };
const be16 = (v) => [(v >> 8) & 0xFF, v & 0xFF];

/** 容器每行固定的 0xAA 字节（Training 序列，规范 7.4.6，不进 CRC 覆盖范围） */
const TRAINING = 0xAA;
/** 状态事件行的末字节，把它与「残行」区分开 */
const EVENT_TAIL = 0x40;

/**
 * 拼一条 UFCS 帧：消息头(2B 大端) + 主体 + CRC-8(1B)。
 * 消息头里的地址栏是**接收方**（表 13），不是发送方。
 * @param {{to:number, no:number, ver?:number, mtype:number, body:number[]}} f
 */
function frame({ to, no, ver = VER_1_2_0, mtype, body }) {
  const hdr = (to << 13) | (no << 9) | (ver << 3) | mtype;
  const b = [(hdr >> 8) & 0xFF, hdr & 0xFF, ...body];
  b.push(crc8(b));
  return Uint8Array.from(b);
}

/**
 * 一行 Raw 的容器布局（实测归纳，见 `src/js/ufcs/frame.js` 顶部）：
 *
 *     ts(4B 小端 ms) │ x0 │ x1 │ len │ flag │ 0xAA │ UFCS 帧(N 字节，末字节是 CRC-8)
 *
 *   · x0 / x1 —— 该帧在**本方向字节流**里的起止游标（各 1 字节，mod 256），诊断用；
 *   · len     —— 长度域 = N + 1（把 Training 那一个字节也算进线上字节数）；
 *   · flag    —— 物理链路：0 = D+（供电设备侧发送）/ 1 = D−（充电设备侧发送）。
 *
 * @param {number} tsMs
 * @param {0|1} flag
 * @param {Uint8Array} fr 已含 CRC 的完整帧
 * @param {{x0:number, x1:number}} cur 该帧在本方向字节流里的起止游标
 */
function wrap(tsMs, flag, fr, cur) {
  return Uint8Array.from([
    tsMs & 0xFF, (tsMs >>> 8) & 0xFF, (tsMs >>> 16) & 0xFF, (tsMs >>> 24) & 0xFF,
    cur.x0 & 0xFF, cur.x1 & 0xFF,
    fr.length + 1, flag, TRAINING,
    ...fr,
  ]);
}

/** 一行**状态事件**：`ts(4B 小端 ms) │ code │ 00 │ 00 │ 0x40` */
function wrapEvent(tsMs, code) {
  return Uint8Array.from([
    tsMs & 0xFF, (tsMs >>> 8) & 0xFF, (tsMs >>> 16) & 0xFF, (tsMs >>> 24) & 0xFF,
    code, 0x00, 0x00, EVENT_TAIL,
  ]);
}

/** 一种输出模式（表 16）→ 8 字节 */
function mode(no, curStep, voltStep, maxV, minV, maxI, minI) {
  const v = (BigInt(no) << 60n) | (BigInt(curStep) << 57n) | (BigInt(voltStep) << 56n)
    | (BigInt(maxV) << 40n) | (BigInt(minV) << 24n) | (BigInt(maxI) << 8n) | BigInt(minI);
  const o = [];
  for (let i = 7; i >= 0; i--) o.push(Number((v >> BigInt(i * 8)) & 0xFFn));
  return o;
}

/* ══════════════ 一段合成对话（时间单位：秒）══════════════
   `line` 是**物理链路**，与规范的单向命令表必须自洽（否则方向判据会互相打架）：
     0 = D+（供电设备侧发送）  1 = D−（充电设备侧发送）
   —— 报文里那些 `to: ADDR.SNK` 的都是供电设备发的，所以 line=0；
      `to: ADDR.SRC` 的都是充电设备发的，所以 line=1。 */

const DIALOGUE = [
  { // 1. 供电设备报能力：3 种输出模式（5.5V/11V/20V）
    t: 0.000, line: 0,
    fr: frame({
      to: ADDR.SNK, no: 1, mtype: MTYPE.data,
      body: [0x01, 24,
        ...mode(1, 2, 1, 550, 340, 600, 50),
        ...mode(2, 2, 1, 1100, 550, 500, 50),
        ...mode(3, 2, 1, 2000, 1100, 500, 50)],
    }),
  },
  { // 2. 充电设备应答（控制消息 ACK，消息编号跟随被确认报文）
    t: 0.005, line: 1,
    fr: frame({ to: ADDR.SRC, no: 1, mtype: MTYPE.control, body: [0x01] }),
  },
  { // 3. 充电设备请求：模式 1、5.1 V、3 A
    t: 0.010, line: 1,
    fr: frame({
      to: ADDR.SRC, no: 2, mtype: MTYPE.data,
      body: [0x02, 8, 0x10, 0x00, 0x00, 0x00, ...be16(510), ...be16(300)],
    }),
  },
  { // 4. 供电设备表示已就绪（控制消息，Power_Ready 只可能由供电设备发）
    t: 0.015, line: 0,
    fr: frame({ to: ADDR.SNK, no: 2, mtype: MTYPE.control, body: [0x05] }),
  },
  { // 5. 供电设备上报当前状态：周期 1s、内部 25℃、接口 30℃、输出 9 V / 2 A
    t: 0.020, line: 0,
    fr: frame({
      to: ADDR.SNK, no: 3, mtype: MTYPE.data,
      body: [0x03, 8, 0x00, 0x0A, 75, 80, ...be16(900), ...be16(200)],
    }),
  },
  { // 6. 充电设备上报扩展状态：电池电量 95.5%、功率 65 W
    t: 0.025, line: 1,
    fr: frame({
      to: ADDR.SRC, no: 4, mtype: MTYPE.data,
      body: [0x0D, 6, 0x10, ...be16(0x254E), 0x20, ...be16(65)],
    }),
  },
  { // 7. 线缆信息（接收方是线缆电子标签 011b，规范里没有单向定义 → 方向只能靠链路字节给）
    t: 0.030, line: 0,
    fr: frame({
      to: ADDR.CABLE, no: 5, mtype: MTYPE.data,
      body: [0x05, 10, 0x2C, 0xA3, 0x00, 0x01, 0x00, 0x64, ...be16(2000), ...be16(500)],
    }),
  },
  { // 8. 一条 **坏 CRC** 的请求：界面要标红、统计行要计入「CRC 错误」
    t: 0.035, line: 1,
    bad: true,
    fr: frame({
      to: ADDR.SRC, no: 6, mtype: MTYPE.data,
      body: [0x02, 8, 0x20, 0x00, 0x00, 0x00, ...be16(1100), ...be16(500)],
    }),
  },
];

/** 一行**状态事件**：`ts | 04 | 00 00 | 0x40`，不承载报文 */
const STATE_EVENT = { t: 0.0375, code: 0x04 };

/**
 * 一行既拆不出 UFCS 报文、也不是状态事件的残行。
 * 刻意让首字节落在 0x00 附近（既是合法地址也像消息头），CRC 又对不上 ——
 * 这样穷举定位也得不出「正好消费完整行」的解，才真的会走「未定位」统计。
 */
const UNLOCATED = Uint8Array.from([0x00, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00]);

/* 一行的容器按键「行号」自增，同一方向的行还各带一条字节游标（x0..x1），
   与真实样本一样链式接续 —— 这样 e2e 才能顺带验证「游标不跳号」这件事。 */
const rows = [];
let rowNo = 0;
const cursor = { 0: 0, 1: 0 };          // 每条物理链路各自的字节游标
for (const d of DIALOGUE) {
  const fr = Uint8Array.from(d.fr);
  if (d.bad) fr[fr.length - 1] ^= 0xFF;
  const x0 = cursor[d.line] & 0xFF;
  const x1 = (cursor[d.line] + fr.length - 1) & 0xFF;
  cursor[d.line] = (cursor[d.line] + fr.length) & 0xFF;
  rows.push({ t: d.t, blob: wrap(Math.round(d.t * 1000), d.line, fr, { x0, x1 }) });
  rowNo++;
}
rows.push({ t: STATE_EVENT.t, blob: wrapEvent(Math.round(STATE_EVENT.t * 1000), STATE_EVENT.code) });
rowNo++;
rows.push({ t: 0.040, blob: UNLOCATED });

/** ADC 采样序列（ufcs_chart）：VBUS 跟着协商往上走，DP/DM 给一点点抖动好画出线 */
const chartRows = [];
for (let i = 0; i <= 45; i++) {
  const t = i / 1000;                                   // 0 … 0.045 s
  const v = t < 0.020 ? 5.0 : t < 0.035 ? 9.0 : 20.0;
  const c = t < 0.020 ? 0.5 : t < 0.035 ? 2.0 : 2.5;
  chartRows.push([Number(t.toFixed(4)), v, c, 0.30 + (i % 3) * 0.01, 0.30 - (i % 3) * 0.01]);
}

/* ══════════════ 最小 SQLite 写库器 ══════════════
   只够这个脚本用：页大小 4096、每张表恰好一页叶子页、记录头 < 128 字节。
   与 tools/selftest.js 里那份是同一套写法（各自独立，互不依赖）。 */

function encVarint(n) {
  const buf = [];
  let v = n;
  do { buf.unshift(v & 0x7f); v = Math.floor(v / 128); } while (v > 0);
  for (let i = 0; i < buf.length - 1; i++) buf[i] |= 0x80;
  return buf;
}
function encValue(v) {
  if (v === null) return { st: 0, bytes: [] };
  if (typeof v === 'string') {
    const b = [...new TextEncoder().encode(v)];
    return { st: 13 + 2 * b.length, bytes: b };
  }
  if (v instanceof Uint8Array) return { st: 12 + 2 * v.length, bytes: [...v] };
  if (Number.isInteger(v) && v >= 0) {
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
  const headerLen = 1 + stBytes.length;
  if (headerLen > 127) throw new Error('记录头过长');
  return Uint8Array.from([headerLen, ...stBytes, ...parts.flatMap((p) => p.bytes)]);
}
function leafPage(pageSize, cells, { page1 = false } = {}) {
  const base = page1 ? 100 : 0;
  const page = new Uint8Array(pageSize);
  let contentStart = pageSize;
  const offs = [];
  for (const c of cells) {
    const cell = [...encVarint(c.length), ...encVarint(offs.length + 1), ...c];
    contentStart -= cell.length;
    offs.push(contentStart);
    page.set(cell, contentStart);
  }
  page[base] = 0x0d;
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
  head[16] = 16; head[17] = 0;                     // 页大小 4096
  head[18] = 1; head[19] = 1; head[20] = 0;        // 回滚日志模式、无保留区
  head[21] = 64; head[22] = 32; head[23] = 32;
  set32(head, 24, 1);                              // 变更计数
  set32(head, 28, 2 + dataPages.length);           // 库总页数
  set32(head, 40, 1);                              // schema cookie
  set32(head, 44, 1);                              // schema 格式
  set32(head, 56, 1);                              // 文本编码 = UTF-8
  set32(head, 92, 1);                              // version-valid-for
  set32(head, 96, 3045000);                        // 写库的 SQLite 版本号
  p1.set(head, 0);

  const out = new Uint8Array(pageSize * (2 + dataPages.length));
  out.set(p1, 0);
  dataPages.forEach((p, i) => out.set(p, pageSize * (i + 1)));
  return out;
}

/* ══════════════ 出库 ══════════════ */

const sqlite = buildSqlite([
  {
    name: 'ufcs_chart', cols: ['Time real', 'VBUS real', 'IBUS real', 'DP real', 'DM real'],
    rows: chartRows,
  },
  {
    name: 'ufcs_table', cols: ['Time real', 'Vbus real', 'Ibus real', 'Raw Blob'],
    rows: rows.map((r) => [r.t, 9.0, 2.0, r.blob]),
  },
]);

await mkdir(dirname(OUT), { recursive: true });
await writeFile(OUT, sqlite);

console.log(`已生成  ${OUT}`);
console.log(`  ${(sqlite.length / 1024).toFixed(1)} KB · ufcs_table ${rows.length} 行`
  + `（${DIALOGUE.length} 条报文，其中 1 条坏 CRC；1 行状态事件；1 行定位不出报文）`
  + `· ufcs_chart ${chartRows.length} 点`);
console.log('  接着可以跑：npm run e2e:ufcs:synth');
