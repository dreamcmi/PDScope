/**
 * pd.js — USB Power Delivery 报文解码器
 *
 * 与 ATK-C（sigrok usb_power_delivery）解码语义逐字段对齐：
 *   4B5B 符号 -> SOP 帧同步 -> 16bit Header -> N×32bit Data Object
 *   -> CRC32(zlib) 校验 -> EOP -> 逐对象语义解析（PDO / RDO / VDM / 扩展消息）
 *
 * 输入是 BMC 解码器产出的比特序列，输出结构化的 packet 对象。
 */

import {
  DEC4B5B, SYM_ERR, SYM_NAME, EOP_SYM, SOP_SEQUENCES, START_OF_PACKETS, SOP_SHORT,
  CTRL_TYPES, DATA_TYPES, EXT_TYPES, BIST_MODES, VDM_CMDS, VDM_ACK,
  EPR_MODE_ACTION, EPR_MODE_DATA, EXT_CONTROL_MSG_TYPES, PEAK_CURRENT_DETAILS,
  MSG_CATEGORY,
} from './pd_tables.js';

// ── zlib 兼容 CRC32 ─────────────────────────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const fmtNum = (v) => {
  if (Number.isInteger(v)) return String(v);
  // 去掉浮点尾巴，例如 15.000000000000002 -> 15
  const r = Math.round(v * 1000) / 1000;
  return String(r);
};
const u32 = (b) => [b & 0xFF, (b >>> 8) & 0xFF, (b >>> 16) & 0xFF, (b >>> 24) & 0xFF];
const flagVal = (enabled, t = 'Supported', f = 'Not supported') => enabled ? `1 (${t})` : `0 (${f})`;

const SOP_ALIAS = { 'SOP1': "SOP'", 'SOP2': "SOP''" };

export class PdDecoder {
  /**
   * @param {{sampleRate:number}} opts
   */
  constructor({ sampleRate }) {
    this.sampleRate = sampleRate;
    this.reset();
  }

  reset() {
    this.packetSeq = 0;
    this.storedPdos = { source: {}, sink: {} };
    this.pdoMeta = { source: {}, sink: {} };
    this.capMark = new Array(14).fill(0);
    this.lastSopPowerRole = 'SRC';
    this.eprCapState = {};
  }

  // ── 4B5B / 位读取 ─────────────────────────────────────────────────────
  _sym(i) {
    const b = this.bits;
    return DEC4B5B[(b[i] & 1) | ((b[i + 1] & 1) << 1) | ((b[i + 2] & 1) << 2)
      | ((b[i + 3] & 1) << 3) | ((b[i + 4] & 1) << 4)];
  }

  _byte() {
    const i = this.idx;
    if (this.bits.length - i <= 10) { this.warn('Truncated', '!'); return 0x0BAD; }
    const k0 = this._sym(i), k1 = this._sym(i + 5);
    this.idx += 10;
    return (k0 & 0x0F) | ((k1 & 0x0F) << 4);
  }

  _short() {
    if (this.bits.length - this.idx <= 20) { this.warn('Truncated packet', 'TRUNC!'); return 0x0BAD; }
    let val = 0;
    for (let i = 0; i < 4; i++) {
      const s = this._sym(this.idx + i * 5);
      if (s > 0xF) { this.warn(`Invalid symbol: ${s}`, 'SYM!'); return 0x0BAD; }
      val |= (s << (4 * i));
    }
    this.idx += 20;
    return val >>> 0;
  }

  _word() {
    const lo = this._short(), hi = this._short();
    if (lo === 0x0BAD || hi === 0x0BAD) { this.warn('Failed to read word', 'WORD!'); return 0x0BAD0BAD; }
    return ((hi << 16) | lo) >>> 0;
  }

  _findCorruptedSop(k) {
    for (const seq of SOP_SEQUENCES) {
      let same = 0;
      for (let i = 0; i < k.length; i++) if (k[i] === seq[i]) same++;
      if (same >= 3) return START_OF_PACKETS[seq.join()];
    }
    return null;
  }

  /** 从比特流中扫描出 SOP，返回包头起始下标（-1 表示不是报文） */
  _scanSop() {
    for (let i = 0; i < this.bits.length - 19; i++) {
      const k = [this._sym(i), this._sym(i + 5), this._sym(i + 10), this._sym(i + 15)];
      let sym = START_OF_PACKETS[k.join()];
      if (!sym) sym = this._findCorruptedSop(k);
      if (sym) {
        this.sopBitOffset = i;
        if (sym === 'Hard Reset' || sym === 'Cable Reset') {
          this.specialPacket = sym;
          this.packetSop = null;
          return -1;
        }
        this.packetSop = sym;
        return i + 20;
      }
    }
    this.warn('No start of packet found', 'XXX');
    return -1;
  }

  // ── Header 字段 ───────────────────────────────────────────────────────
  headExt() { return this.headRev() === 3 ? ((this.head >>> 15) & 1) : 0; }
  headId() { return (this.head >>> 9) & 7; }
  headPowerRole() { return (this.head >>> 8) & 1; }
  headDataRole() { return (this.head >>> 5) & 1; }
  headRev() { return ((this.head >>> 6) & 3) + 1; }
  headType() { return this.headRev() === 3 ? (this.head & 0x1F) : (this.head & 0xF); }
  headCount() { return (this.head >>> 12) & 7; }

  warn(longm, shortm) { if (this.warnings.length < 12) this.warnings.push({ long: longm, short: shortm }); }

  _computeCrc() {
    let bytes;
    if (this.headExt() === 1) {
      bytes = [this.head & 0xFF, (this.head >>> 8) & 0xFF];
      bytes = bytes.concat(this.crcBytes || []);
    } else {
      bytes = [this.head & 0xFF, (this.head >>> 8) & 0xFF];
      for (const d of this.dataWords) bytes = bytes.concat(u32(d));
    }
    return crc32(bytes);
  }

  // ── 主解码入口 ────────────────────────────────────────────────────────
  /**
   * @param {{bits:number[], edges:number[], startSample:number, endSample:number, bitrate:number}} raw
   * @param {number} channel
   * @returns {object|null}
   */
  decode(raw, channel = 0) {
    this.bits = raw.bits;
    this.edges = raw.edges;
    this.idx = 0;
    this.warnings = [];
    this.dataWords = [];
    this.extData = [];
    this.extDataSizes = [];
    this.crcBytes = null;
    this.packetSop = null;
    this.specialPacket = null;
    this.text = '';
    this.details = [];
    this.summaryParts = [];

    const hdrIdx = this._scanSop();

    // Hard Reset / Cable Reset 是独立的短报文，没有 header
    if (hdrIdx < 0 && this.specialPacket) {
      this.packetSeq++;
      const tms = raw.startSample / this.sampleRate * 1000;
      this.text = `#${this.packetSeq} (${tms.toFixed(4)}ms): ${this.specialPacket}`;
      return this._makePacket(raw, channel, {
        sop: this.specialPacket,
        msgType: this.specialPacket,
        msgKind: 'special',
        role: this.lastSopPowerRole,
        summary: this.specialPacket === 'Hard Reset' ? '收到 Hard Reset' : '收到 Cable Reset',
        category: 'control',
        nObjects: 0,
        header: null,
        crcOk: null,
      });
    }
    if (hdrIdx < 0) return null;

    this.packetSeq++;
    const tstampMs = raw.startSample / this.sampleRate * 1000;
    this.text += `#${this.packetSeq} (${tstampMs.toFixed(4)}ms): `;

    this.idx = hdrIdx;
    this.head = this._short();
    if (this.head === 0x0BAD) return null;

    // 消息类型短名
    const t = this.headType();
    let shortm, isExt = this.headExt() === 1;
    if (isExt) shortm = EXT_TYPES[t] ?? 'EXT???';
    else if (this.headCount() === 0) shortm = CTRL_TYPES[t] ?? 'CTR???';
    else shortm = DATA_TYPES[t] ?? 'DAT???';

    // 方向（Port Power Role）
    let role;
    if (this.packetSop === 'SOP') {
      role = this.headPowerRole() ? 'SRC' : 'SNK';
      this.lastSopPowerRole = role;
      if (this.headDataRole() !== this.headPowerRole()) role += this.headDataRole() ? '/DFP' : '/UFP';
    } else if (this.packetSop === "SOP'" || this.packetSop === "SOP''"
      || this.packetSop === "SOP' Debug" || this.packetSop === "SOP'' Debug") {
      role = this.headPowerRole() ? 'Plug' : this.lastSopPowerRole;
    } else {
      role = this.lastSopPowerRole;
    }

    const longm = `(r${this.headRev()}) ${role}[${this.headId()}]: ${shortm}`;
    this.text += longm;

    if (isExt) {
      this.extHead = this._short();
      this.chunked = !!((this.extHead >>> 15) & 1);
      this.chunkNum = (this.extHead >>> 11) & 0x0F;
      this.reqChunk = !!((this.extHead >>> 10) & 1);
      this.dataSize = this.extHead & 0x1FF;
      this._decodeExtendedPayload(t, raw);
    } else {
      for (let i = 0; i < this.headCount(); i++) {
        const w = this._word();
        this.dataWords.push(w);
        this._payload(i, t);
      }
    }

    // CRC
    const crc = this._word();
    const calc = this._computeCrc();
    const crcOk = crc === calc;
    if (!crcOk) this.warn(`Bad CRC ${hex8(crc)} != ${hex8(calc)}`, 'CRC!');

    // EOP
    let eop = false;
    if (this.bits.length >= this.idx + 5 && this._sym(this.idx) === EOP_SYM) { eop = true; this.idx += 5; }
    else this.warn('No EOP', 'EOP!');

    const summaryParts = this.summaryParts.filter(Boolean);
    const summary = summaryParts.join(' ; ');

    return this._makePacket(raw, channel, {
      sop: this.packetSop,
      msgType: shortm,
      msgKind: isExt ? 'ext' : (this.headCount() === 0 ? 'control' : 'data'),
      msgTypeRaw: t,
      role,
      header: this.head,
      extHeader: isExt ? this.extHead : null,
      msgId: this.headId(),
      rev: this.headRev(),
      powerRole: this.headPowerRole(),
      dataRole: this.headDataRole(),
      nObjects: this.headCount(),
      crc,
      crcCalc: calc,
      crcOk,
      eop,
      summary,
      category: MSG_CATEGORY[shortm] ?? (isExt ? 'data' : 'control'),
    });
  }

  _makePacket(raw, channel, o) {
    const bytes = [];
    for (const w of this.dataWords) bytes.push(...u32(w));
    return {
      seq: this.packetSeq,
      channel,
      ...o,
      startSample: raw.startSample,
      endSample: raw.endSample,
      timeMs: raw.startSample / this.sampleRate * 1000,
      endTimeMs: raw.endSample / this.sampleRate * 1000,
      durationUs: (raw.endSample - raw.startSample) / this.sampleRate * 1e6,
      bitrate: raw.bitrate,
      dataWords: this.dataWords.slice(),
      dataBytes: bytes,
      dataHex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
      details: this.details,
      warnings: this.warnings.slice(),
      text: this.text,
    };
  }

  // ── 载荷解析 ──────────────────────────────────────────────────────────
  _pushDetail(key, value) { this.details.push({ key, value: String(value) }); }

  _payload(idx, t) {
    this.summaryParts = this.summaryParts || [];
    const dataVal = this.dataWords[idx];
    let summary = '';
    if (t === 2) summary = this._rdo(dataVal);
    else if (t === 9) {
      summary = idx === 0 ? this._rdo(dataVal) : this._pdo(dataVal, idx + 1, false, 'source');
    } else if (t === 1 || t === 4) {
      summary = this._pdo(dataVal, idx + 1, false, t === 1 ? 'source' : 'sink');
    } else if (t === 15) summary = this._vdm(idx, dataVal);
    else if (t === 3) summary = this._bist(idx, dataVal);
    else if (t === 10) summary = this._eprMode(idx, dataVal);
    else if (t === 5) summary = this._batteryStatus(dataVal);
    else if (t === 6) summary = this._alert(dataVal);
    else if (t === 8) summary = this._enterUsb(dataVal);
    else if (t === 11) summary = this._sourceInfo(dataVal);
    else if (t === 12) summary = this._revision(dataVal);
    else summary = `[${idx + 1}] 0x${hex8(dataVal)}`;
    if (summary) this.summaryParts.push(summary);
    this.text += ` - ${summary}`;
  }

  _decodeExtendedPayload(t, raw) {
    this.summaryParts = [];
    const capacity = Math.max(this.headCount() * 4 - 2, 0);
    const payloadSize = this._extChunkPayloadSize(capacity);
    const chunkOffset = this.chunked ? this.chunkNum * 26 : 0;
    const payloadBytes = [];
    for (let i = 0; i < payloadSize; i++) payloadBytes.push(this._byte());
    const padBytes = Math.max(capacity - payloadSize, 0);
    for (let i = 0; i < padBytes; i++) this._byte();

    this.crcBytes = [this.extHead & 0xFF, (this.extHead >>> 8) & 0xFF]
      .concat(payloadBytes, new Array(padBytes).fill(0));

    // 按 4 字节分组还原为 32bit 对象（需要考虑 chunk 偏移导致的非对齐）
    const groups = [];
    if (payloadSize > 0) {
      let first = 4 - (chunkOffset % 4);
      if (first === 0) first = 4;
      first = Math.min(first, payloadSize);
      let consumed = 0;
      while (consumed < payloadSize) {
        const g = consumed === 0 ? first : Math.min(4, payloadSize - consumed);
        groups.push(g);
        consumed += g;
      }
    }
    const bytesToU32 = (arr) => {
      let v = 0;
      for (let i = 0; i < Math.min(arr.length, 4); i++) v |= (arr[i] & 0xFF) << (8 * i);
      return v >>> 0;
    };
    let bi = 0;
    groups.forEach((g, i) => {
      const val = bytesToU32(payloadBytes.slice(bi, bi + g));
      this.extData.push(val);
      this.extDataSizes.push(g);
      bi += g;
      this._payloadExtended(i, t, val);
    });
  }

  _extChunkPayloadSize(capacity) {
    if (this.reqChunk) return 0;
    if (this.chunked) {
      const off = this.chunkNum * 26;
      return Math.min(Math.max(this.dataSize - off, 0), capacity);
    }
    return Math.min(this.dataSize, capacity);
  }

  _extBytes(idx) {
    const size = idx < this.extDataSizes.length ? this.extDataSizes[idx] : 4;
    return { bytes: u32(this.extData[idx]).slice(0, size), partial: size < 4 };
  }

  _payloadExtended(idx, t, val) {
    let summary = `[${idx + 1}] `;
    if (val === 0 && t !== 15 && t !== 17 && t !== 18) { this.summaryParts.push(summary + '0'); return; }
    if (t === 16) summary += this._extControl(idx, val);
    else if (t === 17 || t === 18) summary += this._eprCapDev(t, idx, val, t === 17 ? 'source' : 'sink');
    else if (t === 1) summary += this._srcCapExt(val, idx);
    else if (t === 2) summary += this._statusExt(val, idx);
    else if (t === 12) summary += this._ppsStatusExt(val, idx);
    else if (t === 14) summary += this._countryCodesExt(val, idx);
    else if (t === 15) summary += this._snkCapExt(val, idx);
    else summary += `Unhandled ext type: ${t}`;
    this.summaryParts.push(summary);
    this.text += ` - ${summary}`;
  }

  // ── PDO ───────────────────────────────────────────────────────────────
  _pdo(pdo, idx, isEpr = false, role = 'source') {
    const t1 = (pdo >>> 30) & 0x3;
    const VM = 0.05, CM = 0.01, PM = 0.25;
    const roleName = role === 'source' ? 'Source' : 'Sink';
    this.capMark[idx] = t1;
    this._pushDetail('Object', `PDO #${idx}`);
    this._pushDetail('Raw', `0x${hex8(pdo)}`);
    this._pushDetail('Power Range', isEpr ? 'EPR' : 'SPR');
    this._pushDetail('Role', roleName);
    const meta = { type: t1, role, isEpr, kind: 'unknown' };
    let summary, name;

    if (t1 === 0) {
      name = isEpr ? 'EPR_Fixed' : 'Fixed';
      const mv = ((pdo >>> 10) & 0x3FF) * VM;
      const ma = (pdo & 0x3FF) * CM;
      summary = `[${name}] ${fmtNum(mv)}V ${fmtNum(ma)}A (${fmtNum(mv * ma)}W)`;
      this._pushDetail('Supply Type[B31-30]', `00b Fixed Supply PDO`);
      this._pushDetail('Voltage[B19-10]', `${fmtNum(mv)} V`);
      if (role === 'source' && !isEpr) {
        this._pushDetail('Maximum Current[B9-0]', `${fmtNum(ma)} A`);
        this._pushDetail('Maximum Power', `${fmtNum(mv * ma)} W`);
        this._pushDetail('Dual-Role Power[B29]', flagVal((pdo >>> 29) & 1));
        this._pushDetail('USB Suspend Supported[B28]', flagVal((pdo >>> 28) & 1));
        this._pushDetail('Unconstrained Power[B27]', flagVal((pdo >>> 27) & 1));
        this._pushDetail('USB Communications Capable[B26]', flagVal((pdo >>> 26) & 1));
        this._pushDetail('Dual-Role Data[B25]', flagVal((pdo >>> 25) & 1));
        this._pushDetail('Unchunked Ext Msg[B24]', flagVal((pdo >>> 24) & 1));
        this._pushDetail('EPR Capable[B23]', flagVal((pdo >>> 23) & 1));
        this._pushDetail('Reserved[B22]', (pdo >>> 22) & 1);
        this._peakDetails('Peak Current', (pdo >>> 20) & 0x3, 'B21-20');
      } else if (role === 'source' && isEpr) {
        this._pushDetail('Maximum Current[B9-0]', `${fmtNum(ma)} A`);
        this._pushDetail('Maximum Power', `${fmtNum(mv * ma)} W`);
        this._pushDetail('Reserved[B29-23]', '0x' + ((pdo >>> 23) & 0x7F).toString(16).padStart(2, '0').toUpperCase());
        this._peakDetails('Peak Current', (pdo >>> 20) & 0x3, 'B21-20');
      } else if (role === 'sink' && !isEpr) {
        this._pushDetail('Operational Current[B9-0]', `${fmtNum(ma)} A`);
        this._pushDetail('Dual-Role Power[B29]', flagVal((pdo >>> 29) & 1));
        this._pushDetail('Higher Capability[B28]', flagVal((pdo >>> 28) & 1));
        this._pushDetail('Unconstrained Power[B27]', flagVal((pdo >>> 27) & 1));
        this._pushDetail('USB Communications Capable[B26]', flagVal((pdo >>> 26) & 1));
        this._pushDetail('Dual-Role Data[B25]', flagVal((pdo >>> 25) & 1));
        this._pushDetail('FRS Current[B24-23]', this._frsText((pdo >>> 23) & 0x3));
        this._pushDetail('Reserved[B22-20]', (pdo >>> 20) & 0x7);
      } else if (role === 'sink' && isEpr) {
        this._pushDetail('Operational Current[B9-0]', `${fmtNum(ma)} A`);
        this._pushDetail('Reserved[B29-20]', '0x' + ((pdo >>> 20) & 0x3FF).toString(16).padStart(3, '0').toUpperCase());
      } else {
        this._pushDetail('Current[B9-0]', `${fmtNum(ma)} A`);
        this._pushDetail('Power', `${fmtNum(mv * ma)} W`);
        this._pushDetail('Upper Bits[B29-20]', '0x' + ((pdo >>> 20) & 0x3FF).toString(16).padStart(3, '0').toUpperCase());
      }
      this.storedPdos[role][idx] = `${name} ${fmtNum(mv)}V`;
      meta.kind = 'fixed';
    } else if (t1 === 1) {
      name = isEpr ? 'EPR_Battery' : 'Battery';
      const minv = ((pdo >>> 10) & 0x3FF) * VM;
      const maxv = ((pdo >>> 20) & 0x3FF) * VM;
      const mw = (pdo & 0x3FF) * PM;
      summary = `[${name}] ${fmtNum(minv)}/${fmtNum(maxv)}V ${fmtNum(mw)}W`;
      this._pushDetail('Supply Type[B31-30]', `01b Battery PDO`);
      this._pushDetail('Maximum Voltage[B29-20]', `${fmtNum(maxv)} V`);
      this._pushDetail('Minimum Voltage[B19-10]', `${fmtNum(minv)} V`);
      this._pushDetail(role === 'source' ? 'Maximum Allowable Power[B9-0]' : 'Operational Power[B9-0]', `${fmtNum(mw)} W`);
      this.storedPdos[role][idx] = `${name} ${fmtNum(minv)}/${fmtNum(maxv)}V`;
      meta.kind = 'battery';
    } else if (t1 === 2) {
      name = isEpr ? 'EPR_Variable' : 'Variable';
      const minv = ((pdo >>> 10) & 0x3FF) * VM;
      const maxv = ((pdo >>> 20) & 0x3FF) * VM;
      const ma = (pdo & 0x3FF) * CM;
      summary = `[${name}] ${fmtNum(minv)}/${fmtNum(maxv)}V ${fmtNum(ma)}A`;
      this._pushDetail('Supply Type[B31-30]', `10b Variable Supply PDO`);
      this._pushDetail('Maximum Voltage[B29-20]', `${fmtNum(maxv)} V`);
      this._pushDetail('Minimum Voltage[B19-10]', `${fmtNum(minv)} V`);
      this._pushDetail(role === 'source' ? 'Maximum Current[B9-0]' : 'Operational Current[B9-0]', `${fmtNum(ma)} A`);
      this.storedPdos[role][idx] = `${name} ${fmtNum(minv)}/${fmtNum(maxv)}V`;
      meta.kind = 'variable';
    } else if (t1 === 3) {
      const t2 = (pdo >>> 28) & 0x3;
      meta.apdoType = t2;
      if (t2 === 0) {
        name = 'PPS';
        const minv = ((pdo >>> 8) & 0xFF) * 0.1;
        const maxv = ((pdo >>> 17) & 0xFF) * 0.1;
        const ma = (pdo & 0x7F) * 0.05;
        const limited = (pdo >>> 27) & 1;
        summary = `[PPS] ${fmtNum(minv)}/${fmtNum(maxv)}V ${fmtNum(ma)}A${limited ? ' [limited]' : ''}`;
        this._pushDetail('Supply Type[B31-30]', '11b Augmented PDO');
        this._pushDetail('APDO Type[B29-28]', '00b SPR PPS');
        this._pushDetail('PPS Power Limited[B27]', flagVal(limited));
        this._pushDetail('Reserved[B26-25]', (pdo >>> 25) & 0x3);
        this._pushDetail('Maximum Voltage[B24-17]', `${fmtNum(maxv)} V`);
        this._pushDetail('Reserved[B16]', (pdo >>> 16) & 1);
        this._pushDetail('Minimum Voltage[B15-8]', `${fmtNum(minv)} V`);
        this._pushDetail('Reserved[B7]', (pdo >>> 7) & 1);
        this._pushDetail(role === 'source' ? 'Maximum Current[B6-0]' : 'Required Current[B6-0]', `${fmtNum(ma)} A`);
        this._pushDetail('Approx Power @ Vmax', `${fmtNum(maxv * ma)} W`);
        this.storedPdos[role][idx] = `PPS ${fmtNum(minv)}/${fmtNum(maxv)}V`;
        meta.kind = 'pps';
      } else if (t2 === 1) {
        name = 'EPR_AVS';
        const minv = ((pdo >>> 8) & 0xFF) * 0.1;
        const maxv = ((pdo >>> 17) & 0x1FF) * 0.1;
        const pdp = (pdo & 0xFF);
        summary = `[EPR_AVS] ${fmtNum(minv)}~${fmtNum(maxv)}V (${fmtNum(pdp)}W)`;
        this._pushDetail('Supply Type[B31-30]', '11b Augmented PDO');
        this._pushDetail('APDO Type[B29-28]', '01b EPR AVS');
        this._peakDetails('Peak Current', (pdo >>> 26) & 0x3, 'B27-26');
        this._pushDetail('Maximum Voltage[B25-17]', `${fmtNum(maxv)} V`);
        this._pushDetail('Reserved[B16]', (pdo >>> 16) & 1);
        this._pushDetail('Minimum Voltage[B15-8]', `${fmtNum(minv)} V`);
        this._pushDetail('PDP[B7-0]', `${fmtNum(pdp)} W`);
        this._pushDetail('Approx Current @ Vmax', `${fmtNum(maxv > 0 ? pdp / maxv : 0)} A`);
        this.storedPdos[role][idx] = `EPR_AVS ${fmtNum(minv)}-${fmtNum(maxv)}V ${fmtNum(pdp)}W`;
        meta.kind = 'epr_avs';
      } else if (t2 === 2) {
        name = 'SPR_AVS';
        const c15 = ((pdo >>> 10) & 0x3FF) * 0.01;
        const c20 = (pdo & 0x3FF) * 0.01;
        summary = `[SPR_AVS] 9~20V 15V:${fmtNum(c15)}A 20V:${fmtNum(c20)}A`;
        this._pushDetail('Supply Type[B31-30]', '11b Augmented PDO');
        this._pushDetail('APDO Type[B29-28]', '10b SPR AVS');
        if (role === 'source') {
          this._peakDetails('Peak Current', (pdo >>> 26) & 0x3, 'B27-26');
          this._pushDetail('Reserved[B25-20]', (pdo >>> 20) & 0x3F);
        } else {
          this._pushDetail('Reserved[B27-20]', (pdo >>> 20) & 0xFF);
        }
        this._pushDetail('Current @ 9V-15V[B19-10]', `${fmtNum(c15)} A`);
        this._pushDetail('Current @ 15V-20V[B9-0]', `${fmtNum(c20)} A`);
        this.storedPdos[role][idx] = 'SPR_AVS 9-20V';
        meta.kind = 'spr_avs';
      } else {
        name = 'Reserved_APDO';
        summary = `[Reserved_APDO] [raw: ${hex8(pdo)}]`;
        this._pushDetail('Supply Type[B31-30]', '11b Augmented PDO');
        this._pushDetail('APDO Type[B29-28]', `1${t2.toString(2).padStart(2, '0')}b Reserved`);
        this.storedPdos[role][idx] = `Reserved_APDO [raw:${hex8(pdo)}]`;
        meta.kind = 'reserved_apdo';
      }
    } else {
      name = 'Reserved';
      summary = `[Reserved] [raw: ${hex8(pdo)}]`;
      this.storedPdos[role][idx] = `Reserved [raw:${hex8(pdo)}]`;
    }

    this.pdoMeta[role][idx] = meta;
    this.lastPdoName = name;
    return summary;
  }

  _peakDetails(field, mode, range) {
    const info = PEAK_CURRENT_DETAILS[mode] ?? PEAK_CURRENT_DETAILS[0];
    this._pushDetail(`${field}[${range}]`, `${info.code} ${info.summary}`);
    info.steps.forEach((s, i) => this._pushDetail(`Peak Profile ${i + 1}`, s));
  }

  _frsText(v) {
    return {
      0: '00b Fast Role Swap not supported',
      1: '01b Default USB Port',
      2: '10b 1.5A @ 5V',
      3: '11b 3.0A @ 5V',
    }[v] ?? 'Unknown';
  }

  // ── RDO ───────────────────────────────────────────────────────────────
  _getRolePdoRef(pos, role) {
    if (pos in this.storedPdos[role]) {
      return [this.storedPdos[role][pos], this.pdoMeta[role][pos] ?? { kind: 'unknown' }];
    }
    return ['Unknown PDO', { kind: 'unknown' }];
  }

  _rdo(rdo) {
    const pos = (rdo >>> 28) & 0x0F;
    if (pos === 0 || pos >= 0x0E) {
      const s = `(RDO Invalid Position ${pos})`;
      this._pushDetail('Object Position[B31-28]', `${pos} (invalid)`);
      this._pushDetail('Raw', `0x${hex8(rdo)}`);
      return s;
    }
    const [refPdo, meta] = this._getRolePdoRef(pos, 'source');
    const kind = meta.kind ?? 'unknown';
    const giveBack = (rdo >>> 27) & 1;

    if (refPdo === 'Unknown PDO' && kind === 'unknown') {
      const s = `(RDO ${pos}: 未识别到 SOURCE CAP 包，无法解析)`;
      this._pushDetail('Object Position[B31-28]', pos);
      this._pushDetail('Referenced PDO', '未识别到 SOURCE CAP 包');
      this._pushDetail('*Ref', '无');
      this._pushDetail('Raw', `0x${hex8(rdo)}`);
      return s;
    }

    this._pushDetail('Object Position[B31-28]', pos);
    this._pushDetail('Referenced PDO', refPdo);
    this._pushDetail('*Ref', '实时');
    this._pushDetail('Raw', `0x${hex8(rdo)}`);
    this._pushDetail('GiveBack[B27]', flagVal(giveBack, 'Deprecated bit set', 'Deprecated bit clear'));
    this._pushDetail('Capability Mismatch[B26]', flagVal((rdo >>> 26) & 1));
    this._pushDetail('USB Communications Capable[B25]', flagVal((rdo >>> 25) & 1));
    this._pushDetail('No USB Suspend[B24]', flagVal((rdo >>> 24) & 1));
    this._pushDetail('Unchunked Ext Msg[B23]', flagVal((rdo >>> 23) & 1));
    this._pushDetail('EPR Capable[B22]', flagVal((rdo >>> 22) & 1));

    let s;
    if (kind === 'pps') {
      const ov = ((rdo >>> 9) & 0x0FFF) * 0.02;
      const oa = (rdo & 0x7F) * 0.05;
      s = `(RDO ${pos}: ${refPdo}) ${fmtNum(ov)}V ${fmtNum(oa)}A`;
      this._pushDetail('Reserved[B21]', (rdo >>> 21) & 1);
      this._pushDetail('Output Voltage[B20-9]', `${fmtNum(ov)} V`);
      this._pushDetail('Reserved[B8-7]', (rdo >>> 7) & 3);
      this._pushDetail('Operating Current[B6-0]', `${fmtNum(oa)} A`);
    } else if (kind === 'spr_avs' || kind === 'epr_avs') {
      const ov = ((rdo >>> 9) & 0x0FFF) * 0.025;
      const oa = (rdo & 0x7F) * 0.05;
      s = `(RDO ${pos}: ${refPdo}) ${fmtNum(ov)}V ${fmtNum(oa)}A`;
      this._pushDetail('Reserved[B21]', (rdo >>> 21) & 1);
      this._pushDetail('Output Voltage[B20-9]', `${fmtNum(ov)} V`);
      this._pushDetail('Reserved[B8-7]', (rdo >>> 7) & 3);
      this._pushDetail('Operating Current[B6-0]', `${fmtNum(oa)} A`);
    } else if (kind === 'battery') {
      const ow = ((rdo >>> 10) & 0x3FF) * 0.25;
      const mw = (rdo & 0x3FF) * 0.25;
      s = `(RDO ${pos}: ${refPdo}) op ${fmtNum(ow)}W max ${fmtNum(mw)}W`;
      this._pushDetail('Reserved[B21-20]', (rdo >>> 20) & 3);
      this._pushDetail('Operating Power[B19-10]', `${fmtNum(ow)} W`);
      this._pushDetail('Maximum Operating Power[B9-0]', `${fmtNum(mw)} W`);
    } else {
      const oa = ((rdo >>> 10) & 0x3FF) * 0.01;
      const ma = (rdo & 0x3FF) * 0.01;
      s = `(RDO ${pos}: ${refPdo}) op ${fmtNum(oa)}A max ${fmtNum(ma)}A`;
      this._pushDetail('Reserved[B21-20]', (rdo >>> 20) & 3);
      this._pushDetail('Operating Current[B19-10]', `${fmtNum(oa)} A`);
      this._pushDetail('Maximum Operating Current[B9-0]', `${fmtNum(ma)} A`);
    }
    return s;
  }

  // ── 其余数据消息 ──────────────────────────────────────────────────────
  _batteryStatus(data) {
    const capacity = (data >>> 16) & 0xFFFF;
    const info = (data >>> 8) & 0xFF;
    const chargeState = (info >>> 2) & 0x3;
    const chargeText = ['Charging', 'Discharging', 'Idle', 'Reserved'][chargeState];
    const capText = capacity === 0xFFFF ? 'Unknown' : `${fmtNum(capacity * 0.1)} Wh`;
    const s = `Capacity:${capText} Present:${(info >>> 1) & 1 ? 'Y' : 'N'} Status:${chargeText}`;
    this._pushDetail('Battery Present Capacity[B31-16]', capText);
    this._pushDetail('Invalid Battery Ref[B8]', flagVal(info & 1, 'Invalid', 'Valid'));
    this._pushDetail('Battery Present[B9]', flagVal((info >>> 1) & 1));
    this._pushDetail('Charging Status[B11-10]', chargeText);
    this._pushDetail('Reserved Info[B15-12]', '0x' + ((info >>> 4) & 0xF).toString(16).toUpperCase());
    this._pushDetail('Reserved[B7-0]', '0x' + (data & 0xFF).toString(16).padStart(2, '0').toUpperCase());
    return s;
  }

  _alert(data) {
    const bits = (data >>> 24) & 0xFF;
    const names = {
      1: 'Battery Status Change', 2: 'OCP', 3: 'OTP', 4: 'Operating Condition Change',
      5: 'Source Input Change', 6: 'OVP', 7: 'Extended Alert',
    };
    const on = [];
    for (const [bit, nm] of Object.entries(names)) if (bits & (1 << bit)) on.push(nm);
    const s = 'Alerts:' + (on.length ? on.join(', ') : ' None');
    this._pushDetail('Type of Alert[B31-24]', '0x' + bits.toString(16).padStart(2, '0').toUpperCase());
    this._pushDetail('Battery Status Change[B25]', flagVal(bits & (1 << 1)));
    this._pushDetail('OCP Event[B26]', flagVal(bits & (1 << 2)));
    this._pushDetail('OTP Event[B27]', flagVal(bits & (1 << 3)));
    this._pushDetail('Operating Condition Change[B28]', flagVal(bits & (1 << 4)));
    this._pushDetail('Source Input Change[B29]', flagVal(bits & (1 << 5)));
    this._pushDetail('OVP Event[B30]', flagVal(bits & (1 << 6)));
    this._pushDetail('Extended Alert[B31]', flagVal(bits & (1 << 7)));
    this._pushDetail('Fixed Batteries[B23-20]', '0x' + ((data >>> 20) & 0xF).toString(16).toUpperCase());
    this._pushDetail('Hot Swappable Batteries[B19-16]', '0x' + ((data >>> 16) & 0xF).toString(16).toUpperCase());
    this._pushDetail('Reserved[B15-0]', '0x' + (data & 0xFFFF).toString(16).padStart(4, '0').toUpperCase());
    return s;
  }

  _enterUsb(data) {
    const mode = (data >>> 28) & 0x7;
    const speed = (data >>> 21) & 0x7;
    const ctype = (data >>> 19) & 0x3;
    const ccur = (data >>> 17) & 0x3;
    const modeText = { 0: 'USB 2.0', 1: 'USB 3.2', 2: 'USB4' }[mode] ?? 'Reserved';
    const speedText = {
      0: 'USB 2.0 only', 1: 'USB 3.2 Gen1', 2: 'USB 3.2 Gen2 / USB4 Gen2',
      3: 'USB4 Gen3', 4: 'USB4 Gen4',
    }[speed] ?? 'Reserved';
    const typeText = {
      0: 'Passive', 1: 'Active Re-timer', 2: 'Active Re-driver', 3: 'Optically Isolated',
    }[ctype] ?? 'Reserved';
    const curText = { 0: 'VBUS not supported', 1: 'Reserved', 2: '3A', 3: '5A' }[ccur] ?? 'Reserved';
    const s = `${modeText} ${speedText} ${typeText}`;
    this._pushDetail('USB Mode[B30-28]', modeText);
    this._pushDetail('USB4 DRD[B26]', flagVal((data >>> 26) & 1));
    this._pushDetail('USB3 DRD[B25]', flagVal((data >>> 25) & 1));
    this._pushDetail('Cable Speed[B23-21]', speedText);
    this._pushDetail('Cable Type[B20-19]', typeText);
    this._pushDetail('Cable Current[B18-17]', curText);
    this._pushDetail('PCIe Support[B16]', flagVal((data >>> 16) & 1));
    this._pushDetail('DP Support[B15]', flagVal((data >>> 15) & 1));
    this._pushDetail('TBT Support[B14]', flagVal((data >>> 14) & 1));
    this._pushDetail('Host Present[B13]', flagVal((data >>> 13) & 1));
    return s;
  }

  _sourceInfo(data) {
    const portType = (data >>> 31) & 1;
    const typeText = portType ? 'Guaranteed Capability Port' : 'Managed Capability Port';
    const maxPdp = (data >>> 16) & 0xFF, presPdp = (data >>> 8) & 0xFF, repPdp = data & 0xFF;
    const s = `${typeText} Max:${maxPdp}W Present:${presPdp}W Reported:${repPdp}W`;
    this._pushDetail('Port Type[B31]', typeText);
    this._pushDetail('Port Maximum PDP[B23-16]', `${maxPdp} W`);
    this._pushDetail('Port Present PDP[B15-8]', `${presPdp} W`);
    this._pushDetail('Port Reported PDP[B7-0]', `${repPdp} W`);
    return s;
  }

  _revision(data) {
    const rm = (data >>> 28) & 0xF, rn = (data >>> 24) & 0xF;
    const vm = (data >>> 20) & 0xF, vn = (data >>> 16) & 0xF;
    const s = `Revision ${rm}.${rn} Version ${vm}.${vn}`;
    this._pushDetail('Revision.major[B31-28]', rm);
    this._pushDetail('Revision.minor[B27-24]', rn);
    this._pushDetail('Version.major[B23-20]', vm);
    this._pushDetail('Version.minor[B19-16]', vn);
    return s;
  }

  _vdm(idx, data) {
    const vid = (data >>> 16) & 0xFFFF;
    const struct = (data >>> 15) & 1;
    if (idx === 0) {
      let txt = 'VDM';
      this._pushDetail('Object', 'VDO #1');
      this._pushDetail('SVID[B31-16]', '0x' + vid.toString(16).padStart(4, '0').toUpperCase());
      this._pushDetail('Structured[B15]', flagVal(struct));
      if (struct) {
        const cmd = data & 0x1F;
        const ack = (data >>> 6) & 3;
        const pos = (data >>> 8) & 7;
        const verMajor = (data >>> 13) & 3;
        const verMinor = (data >>> 11) & 3;
        const majorText = { 0: 'Version 1.0 (Deprecated)', 1: 'Version 2.x' }[verMajor] ?? 'Reserved';
        const minorText = cmd <= 15
          ? ({ 0: 'Version 2.0', 1: 'Version 2.1' }[verMinor] ?? 'Reserved')
          : `Defined by SVID (${verMinor.toString(2).padStart(2, '0')}b)`;
        txt = `${VDM_ACK[ack]} ${VDM_CMDS[cmd] ?? 'cmd?'}${pos ? ` pos ${pos}` : ''}`;
        this._pushDetail('Structured VDM Version Major[B14-13]', `${majorText} (${verMajor.toString(2).padStart(2, '0')}b)`);
        this._pushDetail('Structured VDM Version Minor[B12-11]', minorText);
        this._pushDetail('Object Position[B10-8]', pos);
        this._pushDetail('Command Type[B7-6]', VDM_ACK[ack]);
        this._pushDetail('Command[B4-0]', `${VDM_CMDS[cmd] ?? 'Unknown'} (${cmd})`);
      } else {
        txt = `unstruct [${(data & 0x7FFF).toString(16).padStart(4, '0')}]`;
        this._pushDetail('Payload[B14-0]', '0x' + (data & 0x7FFF).toString(16).padStart(4, '0').toUpperCase());
      }
      return `${txt} SVID:${vid.toString(16).padStart(4, '0')}`;
    }
    this._pushDetail('Object', `VDO #${idx + 1}`);
    this._pushDetail('Payload', `0x${hex8(data)}`);
    return `VDO:${hex8(data)}`;
  }

  _bist(idx, data) {
    const mode = data >>> 28;
    const counter = data & 0xFFFF;
    let modeName = BIST_MODES[mode] ?? 'INVALID';
    if (mode === 2) modeName = `Counter[= ${counter}]`;
    const s = idx === 0 ? `mode ${modeName}` : 'invalid BRO';
    this._pushDetail('Object', `BIST Data Object #${idx + 1}`);
    this._pushDetail('Mode[B31-28]', `${modeName} (${mode})`);
    this._pushDetail('Counter[B15-0]', counter);
    return s;
  }

  _eprMode(idx, data) {
    const action = (data >>> 24) & 0xFF;
    const field = (data >>> 16) & 0xFF;
    let txt = EPR_MODE_ACTION[action] ?? 'Unknown';
    if (action === 4) txt += '  ' + (EPR_MODE_DATA[field] ?? 'Unknown cause');
    this._pushDetail('Object', `EPR Mode Data Object #${idx + 1}`);
    this._pushDetail('Action[B31-24]', `${EPR_MODE_ACTION[action] ?? 'Unknown'} (${action})`);
    this._pushDetail('Data[B23-16]', `${EPR_MODE_DATA[field] ?? 'Unknown cause'} (${field})`);
    return txt;
  }

  // ── 扩展消息 ──────────────────────────────────────────────────────────
  _presentTempFlag(v) {
    return { 0: 'Not supported', 1: 'Normal', 2: 'Warning', 3: 'Over temperature' }[v] ?? 'Reserved';
  }

  _statusExt(val, idx) {
    const b = u32(val);
    if (idx === 0) {
      const tempText = b[0] === 0 ? 'Not supported' : (b[0] === 1 ? '<2C' : `${b[0]}C`);
      const powerState = b[3] & 0x7;
      const powerText = {
        0: 'Status not supported', 1: 'S0', 2: 'Modern Standby', 3: 'S3',
        4: 'S4', 5: 'S5', 6: 'G3',
      }[powerState] ?? 'Reserved';
      const indText = { 0: 'Off LED', 1: 'On LED', 2: 'Blinking LED', 3: 'Breathing LED' }[(b[3] >>> 3) & 0x7] ?? 'Reserved';
      const s = `Temp:${tempText} Input:0x${b[1].toString(16).padStart(2, '0').toUpperCase()} State:${powerText}`;
      this._pushDetail('Internal Temp[Byte0]', tempText);
      this._pushDetail('External Power[Byte1.Bit1]', flagVal((b[1] >>> 1) & 1));
      this._pushDetail('External Power Type[Byte1.Bit2]', (b[1] >>> 2) & 1 ? 'AC' : 'DC');
      this._pushDetail('Internal Battery[Byte1.Bit3]', flagVal((b[1] >>> 3) & 1));
      this._pushDetail('Internal Non-Battery[Byte1.Bit4]', flagVal((b[1] >>> 4) & 1));
      this._pushDetail('Present Battery Input[Byte2]', '0x' + b[2].toString(16).padStart(2, '0').toUpperCase());
      this._pushDetail('New Power State[Byte3.B2-0]', powerText);
      this._pushDetail('State Indicator[Byte3.B5-3]', indText);
      return s;
    }
    const tempStatus = b[1] & 0x3;
    const s = `Events:0x${b[0].toString(16).padStart(2, '0').toUpperCase()} Temp:${['Normal', 'Warning', 'Over temperature', 'Reserved'][tempStatus]} PowerStatus:${b[2]}`;
    this._pushDetail('Event Flags[Byte4]', '0x' + b[0].toString(16).padStart(2, '0').toUpperCase());
    this._pushDetail('Temperature Status[Byte5.B1-0]', ['Normal', 'Warning', 'Over temperature', 'Reserved'][tempStatus]);
    this._pushDetail('Power Status[Byte6]', b[2]);
    return s;
  }

  _ppsStatusExt(val, idx) {
    if (idx !== 0) return 'Reserved';
    const ov = val & 0xFFFF, oi = (val >>> 16) & 0xFF, flags = (val >>> 24) & 0xFF;
    const vText = ov === 0xFFFF ? 'Not supported' : `${fmtNum(ov * 0.02)} V`;
    const iText = oi === 0xFF ? 'Not supported' : `${fmtNum(oi * 0.05)} A`;
    const s = `V:${vText} I:${iText} PTF:${this._presentTempFlag((flags >>> 1) & 3)}`;
    this._pushDetail('Output Voltage[Byte1-0]', vText);
    this._pushDetail('Output Current[Byte2]', iText);
    this._pushDetail('PTF[Byte3.B2-1]', this._presentTempFlag((flags >>> 1) & 3));
    this._pushDetail('OMF[Byte3.B3]', (flags >>> 3) & 1 ? 'Current Limit' : 'Constant Voltage');
    return s;
  }

  _countryCodesExt(val, idx) {
    const b = u32(val);
    if (idx === 0) {
      const len = b[0];
      const codes = [];
      for (const i of [2]) {
        if (codes.length >= len) break;
        codes.push(String.fromCharCode(b[i]) + String.fromCharCode(b[i + 1]));
      }
      this._pushDetail('Length[Byte0]', len);
      codes.forEach((c, i2) => this._pushDetail(`Country ${i2 + 1}`, c));
      return `Count:${len} ${codes.join(' ')}`;
    }
    const codes = [];
    for (const i of [0, 2]) {
      if (b[i] === 0 || b[i + 1] === 0) continue;
      codes.push(String.fromCharCode(b[i]) + String.fromCharCode(b[i + 1]));
    }
    codes.forEach((c, i2) => this._pushDetail(`Country ${idx * 2 + i2 + 1}`, c));
    return codes.length ? codes.join(' ') : 'No codes';
  }

  _extControl(idx, val) {
    const { bytes, partial } = this._extBytes(idx);
    const typeByte = bytes[0] ?? 0, dataByte = bytes[1] ?? 0;
    const txt = typeByte in EXT_CONTROL_MSG_TYPES ? EXT_CONTROL_MSG_TYPES[typeByte] : `Unknown Extended Control Type ${typeByte}`;
    this._pushDetail('Object', `Extended Control Data Object #${idx + 1}`);
    this._pushDetail('Control Type[Byte0]', `${EXT_CONTROL_MSG_TYPES[typeByte] ?? 'Unknown'} (${typeByte})`);
    this._pushDetail('Data Byte[Byte1]', '0x' + dataByte.toString(16).padStart(2, '0').toUpperCase());
    if (partial) this._pushDetail('*Pending', 'ECDB is truncated in this packet');
    return txt;
  }

  _eprCapDev(t, idx, val, role) {
    const key = `${t}`;
    const state = this.eprCapState[key] ?? (this.eprCapState[key] = { nextIndex: 1, pendingBytes: null, pendingIndex: null });
    if (this.chunkNum === 0 && idx === 0) {
      state.pendingBytes = null; state.pendingIndex = null; state.nextIndex = 1;
    }
    const { bytes, partial } = this._extBytes(idx);
    if (this.chunkNum === 0) {
      if (partial) {
        const pi = state.nextIndex;
        state.pendingBytes = bytes.slice();
        state.pendingIndex = pi;
        return `[PDO #${pi}] 不完整`;
      }
      const objPos = state.nextIndex; state.nextIndex++;
      return this._eprCapPdo(val, objPos, role);
    }
    if (idx === 0) {
      if (state.pendingBytes && state.pendingBytes.length === 2 && state.pendingIndex != null) {
        const merged = state.pendingBytes.concat(bytes).slice(0, 4);
        let full = 0;
        for (let i = 0; i < merged.length; i++) full |= merged[i] << (8 * i);
        const pi = state.pendingIndex;
        state.pendingBytes = null; state.pendingIndex = null;
        state.nextIndex = pi + 1;
        this._pushDetail('*Merged', '前包补全');
        return this._eprCapPdo(full >>> 0, pi, role);
      }
      return '[[续包] 缺少前包2字节尾部]';
    }
    const objPos = state.nextIndex; state.nextIndex++;
    return this._eprCapPdo(val, objPos, role);
  }

  _eprCapPdo(pdo, objPos, role) {
    if (objPos <= 7 && pdo === 0) {
      this._pushDetail('Object', `PDO #${objPos}`);
      this._pushDetail('Padding', '未使用的SPR槽位为零填充');
      return `[SPR_Padding] PDO #${objPos} 零填充`;
    }
    const supplyType = (pdo >>> 30) & 0x3;
    const fixedVoltage = ((pdo >>> 10) & 0x3FF) * 0.05;
    let isEpr = objPos >= 8;
    if (!isEpr) {
      if (supplyType === 0 && fixedVoltage > 20.0) isEpr = true;
      else if (supplyType === 3 && ((pdo >>> 28) & 0x3) === 1) isEpr = true;
    }
    return this._pdo(pdo, objPos, isEpr, role);
  }

  _srcCapExt(val, idx) {
    if (idx === 0) {
      const vid = val & 0xFFFF, pid = (val >>> 16) & 0xFFFF;
      this._pushDetail('Vendor ID[B15-0]', '0x' + vid.toString(16).padStart(4, '0').toUpperCase());
      this._pushDetail('Product ID[B31-16]', '0x' + pid.toString(16).padStart(4, '0').toUpperCase());
      return `VID:0x${vid.toString(16).padStart(4, '0').toUpperCase()} PID:0x${pid.toString(16).padStart(4, '0').toUpperCase()}`;
    }
    if (idx === 1) {
      this._pushDetail('XID[B31-0]', `0x${hex8(val)}`);
      return `XID:0x${hex8(val)}`;
    }
    if (idx === 2) {
      const fw = val & 0xFF, hw = (val >>> 8) & 0xFF, vreg = (val >>> 16) & 0xFF, holdup = (val >>> 24) & 0xFF;
      const load = (vreg & 3) === 0 ? '150mA' : ((vreg & 3) === 1 ? '500mA' : 'RSVD');
      const ioc = ((vreg >>> 2) & 1) === 0 ? '25%' : '90%';
      const holdStr = holdup === 0 ? 'Not supported' : `${holdup}ms`;
      this._pushDetail('FW Version[7-0]', fw);
      this._pushDetail('HW Version[15-8]', hw);
      this._pushDetail('Load Step[17-16]', load);
      this._pushDetail('IOC Percent[18]', ioc);
      this._pushDetail('Holdup Time[31-24]', holdStr);
      return `FW:${fw} HW:${hw} Load:${load} IOC:${ioc} Hold:${holdStr}`;
    }
    if (idx === 3) {
      const comp = val & 0xFF, touch = (val >>> 8) & 0xFF, peak = (val >>> 16) & 0xFFFF;
      const lps = comp & 1 ? 'Y' : 'N', ps1 = comp & 2 ? 'Y' : 'N', ps2 = comp & 4 ? 'Y' : 'N';
      const low = touch & 1 ? 'Y' : 'N', gnd = touch & 2 ? 'Y' : 'N', pe = touch & 4 ? 'Y' : 'N';
      const ol = Math.min((peak & 0x1F) * 10, 250), period = ((peak >>> 5) & 0x3F) * 20;
      const duty = ((peak >>> 11) & 0xF) * 5, droop = (peak >>> 15) & 1 ? 'Y' : 'N';
      this._pushDetail('Compliance LPS[0]', lps);
      this._pushDetail('Compliance PS1[1]', ps1);
      this._pushDetail('Compliance PS2[2]', ps2);
      this._pushDetail('Touch Low Current[8]', low);
      this._pushDetail('Touch Ground Pin[9]', gnd);
      this._pushDetail('Touch PE[10]', pe);
      this._pushDetail('PeakCurrent1 Overload', `${ol}%`);
      this._pushDetail('PeakCurrent1 Period', `${period} ms`);
      this._pushDetail('PeakCurrent1 Duty', `${duty}%`);
      this._pushDetail('PeakCurrent1 Vdroop', droop);
      return `Comp:LPS=${lps} PS1=${ps1} PS2=${ps2} Peak1:${ol}%/${period}ms/${duty}%`;
    }
    if (idx === 4) {
      const pc2 = val & 0xFFFF, pc3 = (val >>> 16) & 0xFFFF;
      const f = (p) => ({
        ol: Math.min((p & 0x1F) * 10, 250), per: ((p >>> 5) & 0x3F) * 20,
        duty: ((p >>> 11) & 0xF) * 5, droop: (p >>> 15) & 1 ? 'Y' : 'N',
      });
      const a = f(pc2), b2 = f(pc3);
      this._pushDetail('PeakCurrent2 Overload', `${a.ol}%`);
      this._pushDetail('PeakCurrent3 Overload', `${b2.ol}%`);
      return `Peak2:${a.ol}%/${a.per}ms/${a.duty}% Peak3:${b2.ol}%/${b2.per}ms/${b2.duty}%`;
    }
    if (idx === 5) {
      const touchTemp = val & 0xFF, srcInputs = (val >>> 8) & 0xFF, batts = (val >>> 16) & 0xFF, spr = (val >>> 24) & 0x7F;
      const tempStr = { 0: '60950', 1: '62368-1', 2: '62368-2' }[touchTemp] ?? 'RSVD';
      const ext = srcInputs & 1 ? 'Y' : 'N';
      const intB = srcInputs & 4 ? 'Y' : 'N';
      const hot = (batts >>> 4) & 0xF, fixed = batts & 0xF;
      this._pushDetail('Touch Temp Standard[7-0]', tempStr);
      this._pushDetail('External Supply[8]', ext);
      this._pushDetail('Internal Battery[10]', intB);
      this._pushDetail('Hot Swappable Batteries[19-16]', hot);
      this._pushDetail('Fixed Batteries[23-20]', fixed);
      this._pushDetail('SPR PDP Rating[30-24]', `${spr} W`);
      return `Temp:${tempStr} Ext:${ext} Batt:${intB} Slots:H${hot}/F${fixed} SPR:${spr}`;
    }
    if (idx === 6) {
      const epr = val & 0x7F;
      this._pushDetail('EPR PDP Rating[6-0]', `${epr} W`);
      return `EPR:${epr}`;
    }
    this._pushDetail('Raw', `0x${hex8(val)}`);
    return 'N/A';
  }

  _snkCapExt(val, idx) {
    const b = u32(val);
    const pdp = (v) => `${v} W`;
    if (idx === 0) {
      const vid = b[0] | (b[1] << 8), pid = b[2] | (b[3] << 8);
      this._pushDetail('Vendor ID[Byte1-0]', '0x' + vid.toString(16).padStart(4, '0').toUpperCase());
      this._pushDetail('Product ID[Byte3-2]', '0x' + pid.toString(16).padStart(4, '0').toUpperCase());
      return `VID:0x${vid.toString(16).padStart(4, '0').toUpperCase()} PID:0x${pid.toString(16).padStart(4, '0').toUpperCase()}`;
    }
    if (idx === 1) {
      this._pushDetail('XID[Byte7-4]', `0x${hex8(val)}`);
      return `XID:0x${hex8(val)}`;
    }
    if (idx === 2) {
      const skedb = b[2], loadStep = b[3] & 3;
      const loadText = ['150 mA/us (default)', '500 mA/us', 'Reserved', 'Reserved'][loadStep];
      this._pushDetail('FW Version[Byte8]', b[0]);
      this._pushDetail('HW Version[Byte9]', b[1]);
      this._pushDetail('SKEDB Version[Byte10]', skedb === 1 ? 'Version 1.0 (1)' : `Reserved (${skedb})`);
      this._pushDetail('Load Step[Byte11.B1-0]', loadText);
      return `FW:${b[0]} HW:${b[1]} SKEDB:${skedb} Load:${loadText}`;
    }
    if (idx === 3) {
      const load = b[0] | (b[1] << 8);
      const overload = load & 0x1F;
      const period = (load >>> 5) & 0x3F, duty = (load >>> 11) & 0xF;
      const droop = (load >>> 15) & 1;
      const comp = b[2], touchTemp = b[3];
      const tempText = ['Not applicable', 'IEC 60950-1', 'IEC 62368-1 TS1', 'IEC 62368-1 TS2'][touchTemp] ?? 'Reserved';
      this._pushDetail('Percent Overload[Byte12-13.B4-0]', `${Math.min(overload, 25) * 10} %`);
      this._pushDetail('Overload Period[Byte12-13.B10-5]', overload ? `${period * 20} ms` : 'Ignored when overload=0');
      this._pushDetail('Duty Cycle[Byte12-13.B14-11]', overload ? `${duty * 5} %` : 'Ignored when overload=0');
      this._pushDetail('Can Tolerate VBUS Droop[Byte13.B15]', flagVal(droop));
      this._pushDetail('Compliance Requires LPS[Byte14.B0]', flagVal(comp & 1));
      this._pushDetail('Compliance Requires PS1[Byte14.B1]', flagVal((comp >>> 1) & 1));
      this._pushDetail('Compliance Requires PS2[Byte14.B2]', flagVal((comp >>> 2) & 1));
      this._pushDetail('Touch Temp[Byte15]', `${tempText} (${touchTemp})`);
      return `Load:${Math.min(overload, 25) * 10}% Touch:${tempText}`;
    }
    if (idx === 4) {
      const hot = (b[0] >>> 4) & 0xF, fixed = b[0] & 0xF, modes = b[1];
      this._pushDetail('Hot Swappable Battery Slots[Byte16.B7-4]', hot);
      this._pushDetail('Fixed Batteries[Byte16.B3-0]', fixed);
      this._pushDetail('PPS Charging Supported[Byte17.B0]', flagVal(modes & 1));
      this._pushDetail('VBUS Powered[Byte17.B1]', flagVal((modes >>> 1) & 1));
      this._pushDetail('AC Supply Powered[Byte17.B2]', flagVal((modes >>> 2) & 1));
      this._pushDetail('Battery Powered[Byte17.B3]', flagVal((modes >>> 3) & 1));
      this._pushDetail('AVS Supported[Byte17.B5]', flagVal((modes >>> 5) & 1));
      this._pushDetail('SPR Sink Minimum PDP[Byte18]', pdp(b[2] & 0x7F));
      this._pushDetail('SPR Sink Operational PDP[Byte19]', pdp(b[3] & 0x7F));
      return `Batt:${fixed} fixed/${hot} hot PPS:${modes & 1 ? 'Y' : 'N'} AVS:${(modes >>> 5) & 1 ? 'Y' : 'N'} SPR:${b[2] & 0x7F}/${b[3] & 0x7F}W`;
    }
    if (idx === 5) {
      this._pushDetail('SPR Sink Maximum PDP[Byte20]', pdp(b[0] & 0x7F));
      this._pushDetail('EPR Sink Minimum PDP[Byte21]', pdp(b[1]));
      this._pushDetail('EPR Sink Operational PDP[Byte22]', pdp(b[2]));
      this._pushDetail('EPR Sink Maximum PDP[Byte23]', pdp(b[3]));
      return `SPR Max:${b[0] & 0x7F}W EPR Min/Op/Max:${b[1]}/${b[2]}/${b[3]}W`;
    }
    this._pushDetail('Raw', `0x${hex8(val)}`);
    return 'Reserved';
  }
}

function hex8(v) { return (v >>> 0).toString(16).padStart(8, '0').toUpperCase(); }
