/**
 * powerz.js — POWER-Z（ChargerLAB KM003C 等）SQLite 抓包解析
 *
 * ── 为什么是 SQLite ────────────────────────────────────────────────────
 * ATK-C 存的是原始电平采样（.atkcc：ZIP + 1bit/采样 + BMC 解码），
 * 而 POWER-Z 的 Windows 上位机导出的是 SQLite 库，报文**已经被分析仪解到逻辑字节**了：
 *
 *     pd_chart(Time real, VBUS real, IBUS real, CC1 real, CC2 real)   ADC 采样序列
 *     pd_table(Time real, Vbus real, Ibus real, Raw Blob)             事件流（二进制）
 *     pd_table_key(key integer)                                        会话密钥（导出文件里为空）
 *
 * UFCS 抓包（国产快充协议）同理，只是表名换成 `ufcs_chart` / `ufcs_table`，
 * 模拟量换 `DP` / `DM`。
 *
 * ── Raw blob 的内部结构（实测归纳，与 powerz-rs 的结论一致）───────────
 * 一行的 Raw 是**若干事件首尾相接**（本工程遇到的样本里恰好每行一个）：
 *
 *   ┌ 连接/状态事件：6 字节，固定 ────────────────────────────────┐
 *   │ 45 │ ts(3B 小端, 毫秒) │ 00 │ code  （0x11=连接, 0x12=断开）  │
 *   └────────────────────────────────────────────────────────────┘
 *   ┌ 包裹的 PD 报文：变长 ──────────────────────────────────────┐
 *   │ marker │ ts(4B 小端, 毫秒) │ sop │ wire（逻辑字节，无 CRC）  │
 *   └────────────────────────────────────────────────────────────┘
 *   marker ∈ 0x80…0xBF：低 6 位 = 总长-1（总长含 marker 自身），高 2 位未用；
 *   sop：0=SOP，1=SOP'，2=SOP''；
 *   wire = [Header 2B 小端][Data Object ×N，各 4B 小端]，**不含 CRC、不含 SOP/EOP**
 *          （CRC 由 pd 库按规范重算，仅用于走通解析，见 PdDecoder#decodeWire）。
 *
 * ── 与 ATK 路径的关系 ────────────────────────────────────────────────
 * 这里**不碰 BMC**：报文交给 `PdDecoder#decodeWire()`，与 .atkcc 共用同一套
 * 头部/VDM/PDO/扩展消息语义解析，所以两条路径解出来的报文对象字段完全同形，
 * 界面、筛选、导出、详情面板一行都不用改。
 *
 * 时间基准：POWER-Z 只记录毫秒时间戳，没有「采样点」概念。本工程统一按
 * **1 采样点 = 1 ms**（`POWERZ_RATE`）映射，于是 `totalSamples / sampleRate`
 * 仍是秒、`startSample` 仍是时间轴坐标，所有既有换算不必为新格式开分支。
 */

import { SqliteReader, isSqlite } from './sqlite.js';
import { PdDecoder } from '../pd/index.js';
import { linkGoodCrc } from './pipeline.js';

/** 时间基准：1 采样点 = 1 毫秒（POWER-Z 只有毫秒时间戳） */
export const POWERZ_RATE = 1000;

/** SOP 字节 → 有序集名 */
export const SOP_BY_BYTE = { 0: 'SOP', 1: "SOP'", 2: "SOP''" };

/** 两种导出的表名与展示信息 */
export const POWERZ_KINDS = {
  pd: {
    table: 'pd_table', chart: 'pd_chart',
    protocol: 'USB PD',
    /** 额外两路模拟量的名字，对应 `bus[].a` / `bus[].b`（VBUS/IBUS 是共有的两路） */
    busLabels: ['CC1', 'CC2'],
    title: 'POWER-Z · USB PD',
  },
  ufcs: {
    table: 'ufcs_table', chart: 'ufcs_chart',
    protocol: 'UFCS', busLabels: ['DP', 'DM'],
    title: 'POWER-Z · UFCS',
    /** UFCS 是另一份独立规范，本工程目前只做「容器 + 模拟量」 */
    unsupported: 'UFCS 报文的语义解析尚未实现（该协议不在本工程参考的 USB PD 规范内）',
  },
};

/**
 * 只看文件头与 sqlite_master，判断是不是 POWER-Z 导出。
 * 不做全表扫描，因此对 4 MB 的库也是毫秒级。
 *
 * @returns {'pd'|'ufcs'|null}
 */
export function sniffPowerz(u8) {
  if (!isSqlite(u8)) return null;
  try {
    const db = new SqliteReader(u8);
    if (db.hasTable('pd_table')) return 'pd';
    if (db.hasTable('ufcs_table')) return 'ufcs';
  } catch {
    /* 魔数对但不是我们认识的库（例如别的 App 的 sqlite）——当作不支持 */
  }
  return null;
}

/* ────────────────────────── Raw blob → 事件 ────────────────────────── */

/**
 * 把一个 Raw blob 拆成事件序列。
 * 遇到拼不通的字节就停下并如实标记（`truncated`），不硬猜长度。
 *
 * @param {Uint8Array} blob
 * @returns {{events:Array<object>, truncated:boolean}}
 */
export function parsePowerzBlob(blob) {
  const events = [];
  let off = 0;
  let truncated = false;

  while (off < blob.length) {
    const marker = blob[off];

    if (marker === 0x45) {
      if (off + 6 > blob.length) { truncated = true; break; }
      const ts = blob[off + 1] | (blob[off + 2] << 8) | (blob[off + 3] << 16);
      const code = blob[off + 5];
      events.push({
        kind: code === 0x12 ? 'disconnect' : (code === 0x11 ? 'connect' : `event:0x${code.toString(16)}`),
        tsMs: ts,
      });
      off += 6;
      continue;
    }

    if (marker >= 0x80 && marker <= 0xBF) {
      const total = marker & 0x3F;
      if (total < 5) { truncated = true; break; }
      const wireLen = total - 5;
      const size = total + 1;
      if (off + size > blob.length) { truncated = true; break; }
      const ts = (blob[off + 1] | (blob[off + 2] << 8)
        | (blob[off + 3] << 16) | (blob[off + 4] << 24)) >>> 0;
      events.push({
        kind: 'msg',
        tsMs: ts,
        sopByte: blob[off + 5],
        wire: blob.subarray(off + 6, off + 6 + wireLen),
      });
      off += size;
      continue;
    }

    // 既不是连接事件也不是包裹报文 —— 说明不是我们认识的 blob，停下
    truncated = true;
    break;
  }

  return { events, truncated };
}

/* ────────────────────────── 抓包对象 ────────────────────────── */

export class PowerzCapture {
  constructor(db, kind, u8) {
    this.db = db;
    this.kind = kind;
    this.info = POWERZ_KINDS[kind];
    this.bytes = u8;
    this.fileBytes = u8.length;
    this.meta = this._buildMeta();
  }

  /**
   * @param {Uint8Array} u8
   * @returns {PowerzCapture}
   */
  static open(u8) {
    const kind = sniffPowerz(u8);
    if (!kind) {
      throw new Error('不是 POWER-Z 导出文件（既不是 SQLite，也没有 pd_table / ufcs_table）');
    }
    return new PowerzCapture(new SqliteReader(u8), kind, u8);
  }

  _buildMeta() {
    const { db, info } = this;

    const tableRows = db.hasTable(info.table) ? db.count(info.table) : 0;
    const chartRows = db.hasTable(info.chart) ? db.count(info.chart) : 0;

    // ── 模拟量序列 → 与 .atkcc 的 bus.ini 同形的 {sample, vbus, ibus, …} ──
    // 时间单位由秒换成毫秒，与 POWERZ_RATE 的口径对齐。
    const bus = [];
    let tMax = 0;
    if (chartRows) {
      for (const r of db.rows(info.chart)) {
        const t = Number(r[0]);
        if (!Number.isFinite(t)) continue;
        const sample = Math.round(t * 1000);
        bus.push({ sample, t, vbus: Number(r[1]) || 0, ibus: Number(r[2]) || 0, a: Number(r[3]) || 0, b: Number(r[4]) || 0 });
        if (sample > tMax) tMax = sample;
      }
      bus.sort((x, y) => x.sample - y.sample);
    }

    const channel = {
      channel: 0,
      label: info.protocol,
      totalSamples: tMax,
      totalBytes: this.fileBytes,
      chunks: [],                       // 没有「分块」概念，留空数组让界面统一处理
    };

    return {
      source: 'powerz',
      kind: this.kind,
      title: info.title,
      protocol: info.protocol,
      unsupported: info.unsupported || null,

      sampleRate: POWERZ_RATE,
      sampleRateSource: 'powerz',
      sampleRateRaw: null,
      samplingFrequencyRaw: null,
      sampleRateNote: 'POWER-Z 导出的是毫秒时间戳，没有采样点波形；时间轴按「1 采样点 = 1 ms」映射',

      totalSamples: tMax,
      durationSec: tMax / POWERZ_RATE,
      channels: [channel],
      channelMap: new Map([[0, channel]]),
      channelCount: 1,

      bus,
      busLabels: info.busLabels,

      tableRows,
      chartRows,
      entryCount: 0,
      fileBytes: this.fileBytes,
      sqlite: {
        pageSize: this.db.pageSize,
        pageCount: this.db.pageCount,
        textEncoding: this.db.textEncoding,
        writeVersion: this.db.writeVersion,
      },
    };
  }

  get durationSec() { return this.meta.totalSamples / POWERZ_RATE; }
  effectiveSampleLimit() { return this.meta.totalSamples; }
  async readChunk() { return null; }    // 没有采样分块可供读取

  /**
   * 解析成报文列表。产出与 `core/pipeline.js#decodeChannel()` 同形的 `{packets, stats}`，
   * 因此界面侧两条路径可以共用同一段渲染代码。
   *
   * @param {{onProgress?:Function, shouldStop?:()=>boolean}} [opts]
   */
  async decode({ onProgress, shouldStop } = {}) {
    const { db, kind, info } = this;

    // ── 1. 取全部行并按时间排序（导出文件一般已有序，这里不依赖它）──
    const rows = [];
    const tableRows = this.meta.tableRows || 0;
    let i = 0;
    for (const r of db.rows(info.table)) {
      rows.push({ t: Number(r[0]) || 0, vbus: Number(r[1]) || 0, ibus: Number(r[2]) || 0, raw: r[3] });
      if ((i++ & 2047) === 2047) {
        onProgress?.({ phase: 'read', ratio: tableRows ? i / tableRows : 0, packets: 0 });
        await new Promise((res) => setTimeout(res, 0));
        if (shouldStop?.()) break;
      }
    }
    rows.sort((a, b) => a.t - b.t);

    // ── 2. 拆事件 ──
    // 只对 PD 拆。UFCS 的 Raw 是另一套帧格式（4B 毫秒时间戳 + 自己的帧结构，无 marker 字节），
    // 硬按 PD 的 marker 去拆只会把每一行都判成「拼不通」—— 那是误导，不如老实不拆。
    const events = [];
    let truncated = 0;
    let frameCount = 0;
    if (kind === 'pd') {
      for (const row of rows) {
        if (!(row.raw instanceof Uint8Array) && !(row.raw instanceof ArrayBuffer)) continue;
        const blob = row.raw instanceof Uint8Array ? row.raw : new Uint8Array(row.raw);
        const r = parsePowerzBlob(blob);
        for (const ev of r.events) events.push({ ...ev, rowT: row.t, vbus: row.vbus, ibus: row.ibus });
        if (r.truncated) truncated++;
      }
    } else {
      frameCount = rows.length;     // 本工程样本里每行一帧，仅作计数
    }

    const connects = events.filter((e) => e.kind === 'connect');
    const disconnects = events.filter((e) => e.kind === 'disconnect');

    // ── 3. 逐条解报文 ──
    const packets = [];
    let badWire = 0;
    let unsupportedMsgs = 0;

    if (kind === 'pd') {
      // 与 .atkcc 路径共用同一个解码器 → 跨报文状态（PDO 登记表、SOP 电源角色）语义一致
      const pd = new PdDecoder({ sampleRate: POWERZ_RATE });
      const msgs = events.filter((e) => e.kind === 'msg');
      for (let k = 0; k < msgs.length; k++) {
        const ev = msgs[k];
        const wire = ev.wire;
        // 自检：Header 声明的对象数应当与 blob 给的长度吻合，不吻合说明拆帧错了
        if (wire.length >= 2) {
          const hdr = wire[0] | (wire[1] << 8);
          if (2 + 4 * ((hdr >> 12) & 7) !== wire.length) badWire++;
        } else badWire++;

        const pkt = pd.decodeWire(wire, {
          sop: SOP_BY_BYTE[ev.sopByte] ?? 'SOP',
          timeMs: ev.tsMs,
          channel: 0,
          crcRecorded: false,
          extra: { sopByte: ev.sopByte, powerz: true },
        });
        if (pkt) packets.push(pkt);

        if ((k & 255) === 255) {
          onProgress?.({ phase: 'decode', ratio: (k + 1) / msgs.length, packets: packets.length });
          await new Promise((res) => setTimeout(res, 0));
          if (shouldStop?.()) break;
        }
      }
    } else {
      unsupportedMsgs = frameCount;
    }

    // 序号 + 时间排序（时间戳可能并列，保持解析顺序）
    packets.sort((a, b) => a.startSample - b.startSample || a.seq - b.seq);
    packets.forEach((p, idx) => { p.index = idx; });
    linkGoodCrc(packets);

    const totalSamples = Math.max(this.meta.totalSamples, packets.length ? packets[packets.length - 1].endSample : 0);

    const stats = {
      channel: 0,
      source: 'powerz',
      kind,
      protocol: info.protocol,
      unsupported: info.unsupported || null,
      totalSamples,
      durationSec: totalSamples / POWERZ_RATE,
      sampleRate: POWERZ_RATE,
      sampleRateSource: 'powerz',
      sampleRateNote: null,
      edges: 0,
      trimmedBytes: 0,
      packetCount: packets.length,
      badCrc: 0,                          // 分析仪不存 CRC，无从判定 —— 不是「零错误」
      crcUnknown: packets.length,
      warnings: packets.reduce((s, p) => s + (p.warnings?.length ?? 0), 0),
      badWire,
      truncatedRows: truncated,
      connectCount: connects.length,
      disconnectCount: disconnects.length,
      unsupportedMsgs,
      events: events.map((e) => ({ kind: e.kind, tsMs: e.tsMs })),
      tableRows: rows.length,
      chartRows: this.meta.chartRows,
    };

    return { packets, stats };
  }
}
