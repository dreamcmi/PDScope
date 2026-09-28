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
 * UFCS 抓包（国产融合快充协议）同理，只是表名换成 `ufcs_chart` / `ufcs_table`，
 * 模拟量换 `DP` / `DM`，报文换 `src/js/ufcs/` 那套独立解析库（UART 起止位 →
 * 消息头 / 三种消息结构 / CRC-8，见 T/TAF 083—2024）。
 *
 * ── Raw blob 的内部结构（实测归纳，与 powerz-rs 的结论一致）───────────
 * 一行的 Raw 是**若干事件首尾相接**（本工程遇到的 PD 样本里恰好每行一个）：
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
 *   UFCS 的 Raw 则是**另一套帧结构**：4 字节毫秒时间戳打头、后面直接跟 UFCS 报文、
 *   没有 marker 字节；存不存 CRC 各家实现不一。因此这里不假设结构，
 *   改用「穷举前缀长度 × 两种 CRC 读法 + 消息头合法性 + CRC-8 反证」定位，
 *   见 `parseUfcsBlob()` 与 `src/js/ufcs/frame.js`。
 *
 * ── 与 ATK 路径的关系 ────────────────────────────────────────────────
 * 这里**不碰 BMC**：PD 报文交给 `PdDecoder#decodeWire()`，与 .atkcc 共用同一套
 * 头部/VDM/PDO/扩展消息语义解析；UFCS 报文交给 `UfcsDecoder#decode()`。
 * 两条路径解出来的报文对象字段完全同形（sop / msgType / role / details / crcOk /
 * startSample …），所以界面、筛选、导出、详情面板只有「协议相关的那几处」分叉。
 *
 * 时间基准：POWER-Z 只记录毫秒时间戳，没有「采样点」概念。本工程统一按
 * **1 采样点 = 1 ms**（`POWERZ_RATE`）映射，于是 `totalSamples / sampleRate`
 * 仍是秒、`startSample` 仍是时间轴坐标，所有既有换算不必为新格式开分支。
 */

import { SqliteReader, isSqlite } from './sqlite.js';
import { PdDecoder } from '../pd/index.js';
import { UfcsDecoder, ufcsLocateFrames, ufcsLinkAck } from '../ufcs/index.js';
import { linkGoodCrc } from './pipeline.js';
import { yieldToMain } from './bmc.js';

/** 时间基准：1 采样点 = 1 毫秒（POWER-Z 只有毫秒时间戳） */
export const POWERZ_RATE = 1000;

/** SOP 字节 → 有序集名 */
export const SOP_BY_BYTE = { 0: 'SOP', 1: "SOP'", 2: "SOP''" };

/**
 * 两种导出的表名与展示信息。
 *
 * 可选的 `unsupported` 字段是「认得容器、但还没写语义解析」的**扩展点**：
 * 设了它，界面就会走「原始帧照收、模拟量照画、报文列表留空并说明原因」那条路
 * （app.js 的 `stats.unsupported` 分支）。**目前两种导出都已实现解析**（PD 走
 * `src/js/pd/`、UFCS 走 `src/js/ufcs/`），所以这个字段暂时没人设置 —— 留着是为了
 * 下次给 POWER-Z 加第三种导出时不用回头改界面。
 */
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
    /**
     * UFCS 的报文格式与 PD 完全不同（UART 起止位 + 8.2 的三种消息结构 + CRC-8），
     * 走 `src/js/ufcs/` 那套独立解析库，不再共用 4B5B / 报文头 / PDO 那一套表。
     */
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

/* ────────────────────────── UFCS 的 Raw blob ────────────────────────── */

/**
 * **连接 / 断开事件**（只在 PD 导出里见过，UFCS 导出若也沿用同一 marker 就一并认下）。
 * 结构：`45 │ ts(3B 小端, 毫秒) │ 00 │ code`，code 0x11=连接 0x12=断开。
 */
export function isPowerzConnectBlob(blob) {
  return blob.length === 6 && blob[0] === 0x45 && blob[3] === 0x00
    && (blob[5] === 0x11 || blob[5] === 0x12);
}
export function parsePowerzConnectBlob(blob) {
  const ts = blob[1] | (blob[2] << 8) | (blob[3] << 16);
  return { kind: blob[5] === 0x12 ? 'disconnect' : 'connect', tsMs: ts };
}

/**
 * 把一个 UFCS 的 Raw blob 拆成「一至多条 UFCS 报文」。
 *
 * ── 为什么不像 PD 那样按固定 marker 拆 ──────────────────────────────
 * PD 那套 marker（0x80…0xBF 低 6 位 = 总长-1）是分析仪私有约定；UFCS 的 blob 是
 * **另一套帧结构**（4 字节毫秒时间戳打头、后面直接跟 UFCS 报文、没有 marker 字节），
 * 硬按 PD 去拆只会把每一行都判成「拼不通」。
 *
 * 因此这里不做结构假设，而是**穷举起始偏移 × 两种 CRC 读法**，用
 * 「能否正好消费完整行 + CRC-8 是否吻合 + 消息头字段是否合法」三项一起判定，
 * 取分最高的一种（见 `src/js/ufcs/frame.js#ufcsLocateFrames`）。这样无论前缀是
 * 0 / 4 字节时间戳 / 时间戳+链路字节，都落回同一条解析路径；分析仪存不存 CRC 也都能认。
 *
 * @param {Uint8Array} blob
 * @returns {{frames:Array<{bytes:Uint8Array,crc:number|null,calc:number,crcOk:boolean|null,withCrc:boolean}>,
 *            truncated:boolean, prefixBytes:number, withCrc:boolean,
 *            dirByte:number|null, lineHint:'D+'|'D-'|null}}
 */
export function parseUfcsBlob(blob) {
  const loc = ufcsLocateFrames(blob);
  if (!loc) {
    return {
      frames: [], truncated: true, prefixBytes: 0, withCrc: false, dirByte: null, lineHint: null,
    };
  }
  // 前缀 ≥5 字节时，紧邻报文的那一个字节很可能是「链路标记」（PD 侧对应 sop 字节）。
  // 0/1 按「供电设备侧(D+) / 充电设备侧(D−)」解读，其余取值不作解释、只当诊断信息留着。
  const dirByte = loc.prefixBytes >= 5 ? blob[loc.prefixBytes - 1] : null;
  const lineHint = dirByte === 0 ? 'D+' : dirByte === 1 ? 'D-' : null;

  return {
    frames: loc.frames.map((f) => ({
      bytes: blob.subarray(f.off, f.bodyEnd),
      crc: loc.withCrc ? f.crc : null,
      calc: f.calc,
      crcOk: loc.withCrc ? f.crcOk : null,
      withCrc: loc.withCrc,
    })),
    truncated: false,
    prefixBytes: loc.prefixBytes,
    withCrc: loc.withCrc,
    dirByte,
    lineHint,
  };
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
        await yieldToMain();
        if (shouldStop?.()) break;
      }
    }
    rows.sort((a, b) => a.t - b.t);

    // ── 2. 拆事件 / 拆报文 ──
    // 两条协议各拆各的：PD 按分析仪私有的 marker 拆「包裹报文」，
    // UFCS 按规范的消息头结构定位（见 parseUfcsBlob）。
    const events = [];
    let truncated = 0;
    let frameCount = 0;
    let unlocated = 0;          // UFCS：既拆不出报文、也不像连接事件的残行
    const ufcsBlobs = [];       // UFCS：{ blob, t } —— 第 3 步再解
    if (kind === 'pd') {
      for (const row of rows) {
        if (!(row.raw instanceof Uint8Array) && !(row.raw instanceof ArrayBuffer)) continue;
        const blob = row.raw instanceof Uint8Array ? row.raw : new Uint8Array(row.raw);
        const r = parsePowerzBlob(blob);
        for (const ev of r.events) events.push({ ...ev, rowT: row.t, vbus: row.vbus, ibus: row.ibus });
        if (r.truncated) truncated++;
      }
    } else {
      for (const row of rows) {
        const blob = toU8(row.raw);
        if (!blob) continue;
        const r = parseUfcsBlob(blob);
        if (!r.frames.length) {
          // 拆不出 UFCS 报文 —— 先看它是不是沿用了 PD 的连接/断开事件格式
          if (isPowerzConnectBlob(blob)) events.push({ ...parsePowerzConnectBlob(blob), rowT: row.t });
          else unlocated++;
          continue;
        }
        frameCount += r.frames.length;
        ufcsBlobs.push({ ...r, t: row.t, vbus: row.vbus, ibus: row.ibus });
      }
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
          await yieldToMain();
          if (shouldStop?.()) break;
        }
      }
    } else {
      // UFCS：每条报文交给独立库的 UfcsDecoder。时间基准取 SQLite 的 `Time` 列
      // （与 `ufcs_chart` 的 ADC 采样同一套时基，×1000 得毫秒），保证时间轴对得上；
      // 容器前缀里那 4 字节时间戳只作诊断信息，不拿它定时间。
      const ufcs = new UfcsDecoder({ sampleRate: POWERZ_RATE });
      let k = 0;
      const totalFrames = frameCount || 1;
      for (const b of ufcsBlobs) {
        for (const f of b.frames) {
          const pkt = ufcs.decode(f.bytes, {
            crc: f.crc,
            crcCalc: f.calc,
            withCrc: f.withCrc,
            timeMs: Math.round(b.t * 1000),
            line: b.lineHint,
            dirByte: b.dirByte,
            prefixBytes: b.prefixBytes,
            channel: 0,
          });
          if (pkt) packets.push(pkt);
          if ((++k & 255) === 0) {
            onProgress?.({ phase: 'decode', ratio: k / totalFrames, packets: packets.length });
            await yieldToMain();
            if (shouldStop?.()) break;
          }
        }
        if (shouldStop?.()) break;
      }
    }

    // 序号 + 时间排序（时间戳可能并列，保持解析顺序）
    packets.sort((a, b) => a.startSample - b.startSample || a.seq - b.seq);
    packets.forEach((p, idx) => { p.index = idx; });
    if (kind === 'ufcs') ufcsLinkAck(packets);      // ACK/NCK 与被确认报文配对
    else linkGoodCrc(packets);

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
      badCrc: kind === 'ufcs' ? packets.filter((p) => p.crcOk === false).length : 0,
      crcUnknown: kind === 'ufcs'
        ? packets.filter((p) => p.crcOk === null).length
        : packets.length,                // PD：分析仪不存 CRC，无从判定 —— 不是「零错误」
      warnings: packets.reduce((s, p) => s + (p.warnings?.length ?? 0), 0),
      badWire,
      truncatedRows: truncated,
      connectCount: connects.length,
      disconnectCount: disconnects.length,
      unsupportedMsgs,
      ufcsFrames: kind === 'ufcs' ? frameCount : 0,
      ufcsUnlocatedRows: unlocated,
      events: events.map((e) => ({ kind: e.kind, tsMs: e.tsMs })),
      tableRows: rows.length,
      chartRows: this.meta.chartRows,
    };

    return { packets, stats };
  }
}

/** Uint8Array / ArrayBuffer / 其它 → Uint8Array（不是字节就返回 null） */
function toU8(raw) {
  if (raw instanceof Uint8Array) return raw;
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw);
  return null;
}
