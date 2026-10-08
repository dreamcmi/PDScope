/**
 * pdstream.js — POWER-Z 的 `.pdStream` / `.ufcsStream` 容器
 *
 * ── 这是什么 ────────────────────────────────────────────────────────
 * POWER-Z 上位机可以导出 SQLite 或独立记录流：
 *
 *   · `.sqlite`   三张表：`pd_chart`（ADC 采样序列）、`pd_table`（事件行 + `Raw` blob）、
 *                 `pd_table_key`（会话密钥，导出文件里为空）
 *   · `.pdStream` **只有 `pd_table` 那部分**：二进制、无文件头 / 无索引 / 无校验和
 *   · `.ufcsStream` 同样的外层布局，payload 来自 `ufcs_table.Raw`
 *
 * 协议由 Raw 的已知记录布局确定，报文语义交给对应的 PD / UFCS 解码器，
 * 本文件只负责把「表格」从二进制里读出来，然后交给 `PowerzCapture` 现成的解码流程。
 * 与 `.sqlite` 的唯一实质差别是**没有 ADC 波形**（没有 `pd_chart`），
 * 于是时间轴没有曲线可画 —— 界面已有的「这份抓包没有模拟量轨迹数据」分支正好接住。
 *
 * ── 字节布局（实测归纳，依据见 doc/format-pdstream.md）────────────────
 * 文件 = 记录首尾相接，重复 N 次；**没有文件头、没有尾、没有索引**：
 *
 *   ┌ u32 BE  payloadLen   payload 的字节数（实测取值 6 / 8 / 12 / 28 / 32）
 *   ├ u8[]    payload      与同名 `.sqlite` 的 `pd_table.Raw` **逐字节相同**
 *   ├ f64 BE  Time         秒（相对抓包起点，单调不减）
 *   ├ f64 BE  Vbus         伏
 *   └ f64 BE  Ibus         安
 *
 * 三个 double 是**大端** IEEE-754 —— SQLite 里的 REAL 同样是大端，两边同源，
 * 这也是「按大端读出来能和 sqlite 精确相等」的原因。一条记录固定 28 字节开销
 * （4 字节长度 + 3×8 字节 double）。
 *
 * ── 怎么认它（没有魔数可用）─────────────────────────────────────────
 * 文件开头就是一条普通记录，所以只能**靠结构自证**：按上面的布局走一遍，要求
 *   ① 每一步长度都落在合理区间；
 *   ② **结束位置正好等于文件长度**（多一个字节都不认）；
 *   ③ Time 有限、非负、单调不减；Vbus / Ibus 在物理量程内；
 *   ④ 至少三条记录，且可识别的 Raw 属于同一种协议。
 * 外层结构相同不能证明是 PD，必须同时检查 Raw 内容。结构检查
 * 也顺带排除了 ZIP（首 4 字节 `PK\x03\x04` = 0x504b0304，远超长度上限）与 SQLite
 * （`SQLite format 3` 同理）。
 *
 * 反过来，把行写成流也支持（`writePdStream`）：测试要造样本，用户也可能想把
 * 手里的 `.sqlite` 转成更小的 `.pdStream`。
 */

import { PowerzCapture, POWERZ_KINDS, POWERZ_RATE, parsePowerzBlob } from './powerz.js';
import { ufcsParseRecord, ufcsParseEvent } from '../ufcs/index.js';

/** 每条记录的定长开销：4 字节长度 + 3 个 f64 */
export const PDSTREAM_REC_FIXED = 28;

/** payload 的合法上限。实测最大 32 字节（带扩展消息的 PD 帧），留足余量但挡住乱数据 */
export const PDSTREAM_MAX_PAYLOAD = 4096;

/**
 * 结构自证的额外门槛：至少要能读出这么多条记录才认。
 * 太短的文件（一两条）走完也可能是巧合，不值得为它改判断逻辑。
 */
const MIN_RECORDS = 3;

/** 物理量程兜底（PD 3.1 EPR 上限 48V / 5A，各留一倍余量） */
const MAX_VOLT = 120;
const MAX_AMP = 20;

/**
 * 把 POWER-Z 记录流读成数组（函数名保留以兼容原调用）。
 *
 * 不做任何猜测：任何一步对不上就抛错并说明**卡在哪里**（偏移 + 原因），
 * 这样「打不开」时能直接看出是文件被截断、还是根本不是这个格式。
 *
 * @param {Uint8Array} u8
 * @returns {{records:Array<{time:number,vbus:number,ibus:number,raw:Uint8Array}>,
 *            bytes:number, payloadBytes:number, bytesConsumed:number}}
 */
export function readPdStream(u8) {
  const fail = (off, why) => {
    const e = new Error(`不是 .pdStream：偏移 0x${off.toString(16)} 处${why}`);
    e.offset = off;
    throw e;
  };
  if (!(u8 instanceof Uint8Array)) throw new Error('不是 .pdStream：入参不是字节');
  if (u8.length < PDSTREAM_REC_FIXED * MIN_RECORDS) throw new Error('不是 .pdStream：文件太短');

  const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const records = [];
  let off = 0;
  let payloadBytes = 0;
  let lastTime = -Infinity;

  while (off < u8.length) {
    if (off + PDSTREAM_REC_FIXED > u8.length) fail(off, '剩余字节装不下一条记录');
    const len = view.getUint32(off, false);                     // BE
    if (len === 0) fail(off, 'payload 长度为 0');
    if (len > PDSTREAM_MAX_PAYLOAD) fail(off, `payload 长度 ${len} 超出上限`);
    const end = off + 4 + len + 24;
    if (end > u8.length) fail(off, `payload 长度 ${len} 越过了文件末尾`);

    const time = view.getFloat64(off + 4 + len, false);         // BE
    const vbus = view.getFloat64(off + 12 + len, false);
    const ibus = view.getFloat64(off + 20 + len, false);
    if (!Number.isFinite(time) || time < 0) fail(off, `Time 不是有限的非负数（${time}）`);
    if (time < lastTime) fail(off, `Time 倒退（${time} < ${lastTime}）`);
    if (!Number.isFinite(vbus) || vbus < 0 || vbus > MAX_VOLT) fail(off, `Vbus 超出量程（${vbus}）`);
    if (!Number.isFinite(ibus) || Math.abs(ibus) > MAX_AMP) fail(off, `Ibus 超出量程（${ibus}）`);

    // raw 用 subarray 共享底层 buffer：不复制字节，131 KB 的样本读起来是零拷贝
    records.push({ time, vbus, ibus, raw: u8.subarray(off + 4, off + 4 + len) });
    payloadBytes += len;
    lastTime = time;
    off = end;
  }

  if (records.length < MIN_RECORDS) fail(0, `只读出 ${records.length} 条记录，不足以确认格式`);
  return { records, bytes: u8.length, payloadBytes, bytesConsumed: off };
}

/**
 * 检查完整外层结构与 Raw 协议。未知、混合或截断的流返回 null，不复制字节。
 *
 * @param {Uint8Array} u8
 * @returns {'pd'|'ufcs'|null}
 */
export function sniffPowerzStream(u8) {
  if (!(u8 instanceof Uint8Array)) return null;
  if (u8.length < PDSTREAM_REC_FIXED * MIN_RECORDS) return null;
  try {
    const view = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    let off = 0;
    let n = 0;
    let lastTime = -Infinity;
    let kind = null;
    while (off < u8.length) {
      if (off + PDSTREAM_REC_FIXED > u8.length) return null;
      const len = view.getUint32(off, false);
      if (len === 0 || len > PDSTREAM_MAX_PAYLOAD) return null;
      const end = off + 4 + len + 24;
      if (end > u8.length) return null;
      const time = view.getFloat64(off + 4 + len, false);
      const vbus = view.getFloat64(off + 12 + len, false);
      const ibus = view.getFloat64(off + 20 + len, false);
      if (!Number.isFinite(time) || time < 0 || time < lastTime) return null;
      if (!Number.isFinite(vbus) || vbus < 0 || vbus > MAX_VOLT) return null;
      if (!Number.isFinite(ibus) || Math.abs(ibus) > MAX_AMP) return null;
      const rowKind = powerzStreamRowKind(u8.subarray(off + 4, off + 4 + len));
      if (rowKind) {
        if (kind && kind !== rowKind) return null;
        kind = rowKind;
      }
      lastTime = time;
      off = end;
      n++;
    }
    return n >= MIN_RECORDS ? kind : null;
  } catch {
    return null;
  }
}

/** 两种流共享外层结构，协议由 Raw 的已知记录布局确定，不能只看扩展名。 */
function powerzStreamRowKind(raw) {
  if (ufcsParseRecord(raw)) return 'ufcs';
  const pd = parsePowerzBlob(raw);
  if (!pd.truncated && pd.events.length && pd.events.every(e => e.kind !== 'msg'
    || (e.sopByte <= 2 && pdStreamWireLengthValid(e.wire)))) return 'pd';
  if (ufcsParseEvent(raw)) return 'ufcs';
  return null;
}

function pdStreamWireLengthValid(wire) {
  if (wire.length < 2) return false;
  if ((wire[1] & 0x80) && ((wire[0] >>> 6) & 3) >= 2) {
    if (wire.length < 4) return false;
    if (!(wire[3] & 0x80)) {
      const size = wire[2] | ((wire[3] & 1) << 8);
      if (size > 260) return false;
      const end = 4 + size;
      return wire.length === end || wire.length === 2 + Math.ceil((2 + size) / 4) * 4 && wire.slice(end).every(b => b === 0);
    }
  }
  return wire.length === 2 + 4 * ((wire[1] >>> 4) & 7);
}

/** 兼容原有 PD-only 调用；UFCS 流不会被识别为 PD。 */
export function sniffPdStream(u8) { return sniffPowerzStream(u8) === 'pd'; }
export function sniffUfcsStream(u8) { return sniffPowerzStream(u8) === 'ufcs'; }

/**
 * 把 PD / UFCS 表行写成共享的记录流字节（函数名保留以兼容原调用）。
 * 行的形状为 `{time, vbus, ibus, raw}`，
 * 时间必须是非减的（写入前按 Time 排序，与 sqlite 路径的读法保持一致）。
 *
 * @param {Array<{time:number, vbus:number, ibus:number, raw:Uint8Array|ArrayBuffer}>} rows
 * @returns {Uint8Array}
 */
export function writePdStream(rows) {
  const list = rows
    .map((r) => {
      const raw = r.raw instanceof Uint8Array ? r.raw : new Uint8Array(r.raw);
      return { time: Number(r.time) || 0, vbus: Number(r.vbus) || 0, ibus: Number(r.ibus) || 0, raw };
    })
    .sort((a, b) => a.time - b.time);
  let total = 0;
  for (const r of list) total += 4 + r.raw.length + 24;

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let off = 0;
  for (const r of list) {
    view.setUint32(off, r.raw.length, false);
    out.set(r.raw, off + 4);
    view.setFloat64(off + 4 + r.raw.length, r.time, false);
    view.setFloat64(off + 12 + r.raw.length, r.vbus, false);
    view.setFloat64(off + 20 + r.raw.length, r.ibus, false);
    off += 4 + r.raw.length + 24;
  }
  return out;
}

/* ────────────────────────── 抓包对象 ────────────────────────── */

/**
 * 记录流只有一张「表」。这里做一个**只读的虚拟表适配器**，
 * 形状对齐 `SqliteReader` 的那几个方法，于是 `PowerzCapture` 的构造与解码流程
 * 一行都不用改（报文语义、事件拆分、CRC 口径全部复用）。
 */
class PdStreamTable {
  constructor(parsed, kind) {
    this.parsed = parsed;
    this.name = POWERZ_KINDS[kind].table;
    this.rows_ = parsed.records;
  }

  hasTable(name) { return name === this.name; }
  count(name) { return this.hasTable(name) ? this.rows_.length : 0; }
  *rows(name) {
    if (!this.hasTable(name)) return;
    for (const r of this.rows_) yield [r.time, r.vbus, r.ibus, r.raw];
  }

  // `PowerzCapture#_buildMeta` 会把这些抄进 `meta.sqlite`；这里如实给 null（不是 SQLite）
  pageSize = null;
  pageCount = null;
  textEncoding = null;
  writeVersion = null;
}

export class PowerzStreamCapture extends PowerzCapture {
  /**
   * @param {Uint8Array} u8
   * @param {ReturnType<typeof readPdStream>} parsed
   */
  constructor(u8, parsed, kind) {
    super(new PdStreamTable(parsed, kind), kind, u8);
    this.container = kind === 'ufcs' ? 'ufcsstream' : 'pdstream';
    this.parsed = parsed;

    const m = this.meta;
    // 时间基准：记录里的 Time 就是秒，按「1 采样点 = 1 ms」映射（与 .sqlite 同一套口径）。
    // 没有 `pd_chart` 就没有采样序列，但**报文时间照样撑起时间轴** —— 末条记录的时间即总长。
    const totalSamples = Math.max(m.totalSamples, Math.round(parsed.records[parsed.records.length - 1].time * POWERZ_RATE));
    m.totalSamples = totalSamples;
    m.durationSec = totalSamples / POWERZ_RATE;
    m.channels[0].totalSamples = totalSamples;

    const extension = kind === 'ufcs' ? '.ufcsStream' : '.pdStream';
    m.title = `POWER-Z · ${extension}`;
    m.container = this.container;
    m.sqlite = null;                                  // 不是 SQLite，别让界面去读页大小
    m.busLabels = [];                                 // 没有第三、第四路模拟量 → 也没有「差分线」档
    m.stream = {
      records: parsed.records.length,
      bytes: parsed.bytes,
      payloadBytes: parsed.payloadBytes,
      firstTime: parsed.records[0].time,
      lastTime: parsed.records[parsed.records.length - 1].time,
    };
    m.sampleRateNote = `POWER-Z 的 ${extension} 含报文、时间戳和逐报文测量值，没有 ADC 波形；`
      + '时间轴按「1 采样点 = 1 ms」映射（与同名的 .sqlite 一致）';
  }

  /**
   * @param {Uint8Array} u8
   * @returns {PowerzStreamCapture}
   */
  static open(u8) {
    const parsed = readPdStream(u8);                  // 认不出会抛错并指出卡在哪个偏移
    const kinds = new Set(parsed.records.map(r => powerzStreamRowKind(r.raw)).filter(Boolean));
    if (kinds.size !== 1) throw new Error('POWER-Z 记录流的协议无法确定或混有 PD / UFCS 记录');
    return new PowerzStreamCapture(u8, parsed, [...kinds][0]);
  }

  /** 覆写取行方式：流程照旧，只是行来自二进制流而不是 SQLite 表 */
  *_tableRows() {
    for (const r of this.parsed.records) yield [r.time, r.vbus, r.ibus, r.raw];
  }
}

export class PdStreamCapture extends PowerzStreamCapture {
  constructor(u8, parsed) { super(u8, parsed, 'pd'); }
  static open(u8) {
    const cap = PowerzStreamCapture.open(u8);
    if (cap.kind !== 'pd') throw new Error('这是 UFCS 记录流，不能按 USB PD 解析');
    return new PdStreamCapture(u8, cap.parsed);
  }
}
