/**
 * decoder.js — USB Power Delivery 报文解码器（独立库的主入口）
 *
 * 流水线：BMC 解出的「比特序列」→ 4B5B 符号 → SOP 有序集 → 16bit Header
 *         → N×32bit Data Object → CRC32 → EOP → 逐对象语义解析。
 *
 * 与 ATK-C 官方上位机 / sigrok usb_power_delivery 的语义对齐，并在其基础上补齐：
 *   • SOP'/SOP'' 线缆链路的 VDM（plug 信令）——线缆 e-Marker 的 Discover Identity
 *     响应按 PD 3.2 Table 6.34…6.45 逐位还原（无源/有源线缆 VDO、VPD VDO、旧 AMA VDO）。
 *   • 扩展消息（Chapter 6.5）按数据块内的绝对字节号寻址，覆盖 SCEDB/SDB/GBCDB/
 *     制造商/安全/固件/PPS Status/国家码/SKEDB/ECDB/EPR 能力等，并处理分块拼接。
 *   • 跨版本差异：BIST 模式（PD 2.0 vs 3.x）、线缆最大 VBUS 电压码（3.0 vs 3.1+）、
 *     EPR 相关字段与消息类型的最低版本提示。
 *
 * 本文件属于 `src/js/pd/` 独立库：仅依赖同目录模块，浏览器 / Node 双栈通用，
 * 可整目录复制到别的工程复用（对外只暴露 PdDecoder 与若干解析函数）。
 */

import {
  DEC4B5B, SYM_EOP, ORDERED_SET_BY_KEY, ORDERED_SET_BY_NAME, matchOrderedSet,
} from './symbols.js';
import {
  CTRL_TYPES, DATA_TYPES, EXT_TYPES, MSG_CATEGORY, SPEC_REV,
  CTRL_DEPRECATED, CTRL_MIN_REV, DATA_MIN_REV, EXT_MIN_REV, EXT_MSG_LIMITS, revTextNum, PD_SPEC_PROFILES,
} from './tables.js';
import { pdoParse, rdoParse } from './pdo.js';
import { vdmParse } from './vdm.js';
import { extendedParse } from './extended.js';
import {
  bistParse, batteryStatusParse, alertParse, enterUsbParse,
  sourceInfoParse, revisionParse, eprModeParse, countryCodeParse,
} from './data.js';
import { crc32 } from './crc.js';
import { pdHex } from './format.js';
import { pdCreateEprState, pdTrackEpr, pdDescribeEpr, pdEprPowerSwap } from './epr.js';

/** 有序集名称 → 链路（'port' | 'cable'），用于 VDM/扩展消息判定方向与字段含义 */
const LINK_OF_SOP = {
  'SOP': 'port',
  "SOP'": 'cable',
  "SOP''": 'cable',
  "SOP' Debug": 'cable',
  "SOP'' Debug": 'cable',
  'Cable Reset': 'cable',
  'Hard Reset': 'port',
};

/** 控制消息的一句话说明（仅对需要解释的类型给出，其余留空） */
const CTRL_SUMMARY = {
  3: '接收请求',
  4: '拒绝请求',
  6: '电源就绪',
  9: '请求交换数据角色 (DR_Swap)',
  10: '请求交换电源角色 (PR_Swap)',
  11: '请求交换 VCONN 提供方 (VCONN_Swap)',
  12: '暂不能响应，稍后重试',
  13: '软复位：复位指定链路的协议状态并重新协商，保持供电',
  14: '数据复位',
  15: '数据复位完成',
  16: '不支持该请求',
  19: '快速角色交换请求',
};

/**
 * 「符号值 → 查表下标」的反查表（`DEC4B5B` 的逆），下标域 0x00…0x16。
 *
 * 这里有个必须说清的细节：`DEC4B5B` 的**下标**才是「按时间顺序排的 5 个采样位」
 * （下标 bit k = 第 k 个采样位），而它的**值**才是符号语义（0x00…0x0F 是数据，
 * 0x11…0x16 是 K-code）。所以从「符号值」反推采样位时，要先换成下标再按位展开 ——
 * 直接拿符号值当位序列用会得到一份**镜像**的线路码（症状：SOP 认不出来，
 * 或错误地匹配成 Hard Reset 之类）。
 *
 * 0x00…0x0F 与 0x11…0x16 在 32 个下标里各出现恰好一次（只有 0x10 非法码重复），
 * 所以这个反查是严格可逆的。
 */
const CODE_TO_INDEX = (() => {
  const t = new Int8Array(0x17).fill(-1);
  for (let c = 0; c < 32; c++) {
    const v = DEC4B5B[c];
    if (v <= 0x16 && t[v] < 0) t[v] = c;
  }
  return t;
})();

/** 一个符号值（0x00…0x0F 数据 / 0x11…0x16 K-code）→ 5 个采样位，bit0 时间最早 */
function pushSymbol(bits, value) {
  const c = CODE_TO_INDEX[value];
  for (let k = 0; k < 5; k++) bits.push((c >> k) & 1);
}

/** 一个逻辑字节 → 10 个采样位（先低半字节、后高半字节，故 16/32bit 值读出来是**小端**） */
function pushByte(bits, b) {
  pushSymbol(bits, b & 0xF);
  pushSymbol(bits, (b >>> 4) & 0xF);
}

/** 建立一份全新的解码状态（跨报文关联用） */
function createState() {
  return {
    pdos: { source: {}, sink: {} },   // 位置 → PDO 摘要文本（供 RDO / EPR_Request 反查）
    pdoMeta: { source: {}, sink: {} },// 位置 → PDO 元信息（kind 等）
    svidList: null,                   // 最近一次 Discover SVIDs 结果
    identity: null,                   // 最近一次 Discover Identity（端口/线缆）结果
    lastVdm: null,
    chunks: {},                      // 按发送方和消息类型隔离的扩展数据块
    messages: {},                    // 每个发送方最近的 MessageID/内容
    modes: {}, activeModes: {},
    capabilities: { spr: { source: null, sink: null }, epr: { source: null, sink: null } },
    epr: pdCreateEprState(),
  };
}

export class PdDecoder {
  /**
   * @param {{sampleRate:number, specRevision?:'2.0'|'3.0'|'3.1'|'3.2'|null}} opts
   */
  constructor({ sampleRate, specRevision = null }) {
    if (!(sampleRate > 0)) throw new RangeError('sampleRate 必须大于 0');
    if (specRevision !== null && !PD_SPEC_PROFILES[specRevision]) throw new RangeError('specRevision 必须为 2.0/3.0/3.1/3.2 或 null');
    this.sampleRate = sampleRate;
    this.specRevision = specRevision;
    this.reset();
  }

  /** 清空跨报文状态。切换通道 / 重新解码前调用。 */
  reset({ preserveSequence = false } = {}) {
    if (!preserveSequence || this.packetSeq === undefined) this.packetSeq = 0;
    this.st = createState();
    this.linkStates = new Map();
    this.channelRoles = new Map();
    this.lastSopPowerRole = 'SRC';
  }

  /* ────────────────────────── 位 / 符号读取 ────────────────────────── */

  _sym(i) {
    const b = this.bits;
    if (i + 4 >= b.length) return 0x10;
    return DEC4B5B[(b[i] & 1) | ((b[i + 1] & 1) << 1) | ((b[i + 2] & 1) << 2)
      | ((b[i + 3] & 1) << 3) | ((b[i + 4] & 1) << 4)];
  }

  _byte() {
    const lo = this._nibble(), hi = this._nibble();
    return lo === null || hi === null ? null : lo | (hi << 4);
  }

  _nibble() {
    if (this.bits.length - this.idx < 5) { this.warn('数据被截断', 'TRUNC'); this.idx = this.bits.length; return null; }
    const s = this._sym(this.idx);
    this.idx += 5;
    if (s > 0xF) { this.warn(`非法 4B5B 符号 0x${s.toString(16).toUpperCase()}`, 'SYM'); return null; }
    return s;
  }

  _short() {
    const lo = this._byte(), hi = this._byte();
    return lo === null || hi === null ? null : lo | (hi << 8);
  }

  _word() {
    const lo = this._short(), hi = this._short();
    if (lo === null || hi === null) return null;
    return ((hi << 16) | lo) >>> 0;
  }

  warn(longm, shortm) {
    if (this.warnings.length < 16) this.warnings.push({ long: longm, short: shortm });
  }

  /* ────────────────────────── SOP 扫描 ────────────────────────── */

  /**
   * 从比特流里找有序集。命中 4 个符号中的 3 个即认定为该有序集（容错），
   * 返回「Header 起始比特下标」；Hard Reset / Cable Reset 记入 specialPacket 并返回 -1。
   */
  _scanSop() {
    for (let i = 0; i + 19 < this.bits.length; i++) {
      const k = [this._sym(i), this._sym(i + 5), this._sym(i + 10), this._sym(i + 15)];
      let set = ORDERED_SET_BY_KEY[k.join()];
      if (!set) {
        const best = matchOrderedSet(k);
        if (best && best.matched >= 3) set = best.set;
      }
      if (!set) continue;

      this.sopBitOffset = i;
      if (set.name === 'Hard Reset' || set.name === 'Cable Reset') {
        this.specialPacket = set.name;
        this.packetSop = null;
        return -1;
      }
      this.packetSop = set.name;
      return i + 20;
    }
    this.warn('未找到报文起始有序集', 'NOSOP');
    return -1;
  }

  /* ────────────────────────── Header 字段 ────────────────────────── */

  headRevCode() { return (this.head >>> 6) & 3; }
  headRev() { return this.headRevCode() + 1; }              // 1…4（3.2 与 3.1 同码）
  headRevText() { return SPEC_REV[this.headRevCode()]; }     // '1.0' | '2.0' | '3.x' | 'Reserved（11b）'
  /** PD 3.0（码 2）起才有 Extended 位与 5bit Message Type */
  headModern() { return this.headRevCode() >= 2; }
  headExt() { return this.headModern() ? ((this.head >>> 15) & 1) : 0; }
  headId() { return (this.head >>> 9) & 7; }
  headPowerRole() { return (this.head >>> 8) & 1; }
  headDataRole() { return (this.head >>> 5) & 1; }
  headCount() { return (this.head >>> 12) & 7; }
  headType() { return this.headModern() ? (this.head & 0x1F) : (this.head & 0x0F); }

  /* ────────────────────────── 详情发射器 ────────────────────────── */

  _makeEmitter() {
    const self = this;
    return {
      object(title) { self.details.push({ key: 'Object', value: String(title) }); },
      detail(key, value) { self.details.push({ key: String(key), value: String(value) }); },
      note(text) { if (text != null && text !== '') self.summaryParts.push(String(text)); },
      warn(text, code = 'FIELD') { self.warn(text, code); },
    };
  }

  /* ────────────────────────── 主入口 ────────────────────────── */

  /**
   * @param {{bits:number[], edges:number[], startSample:number, endSample:number, bitrate:number}} raw
   * @param {number} channel
   * @returns {object|null}
   */
  decode(raw, channel = 0) {
    this.bits = raw.bits;
    this.idx = 0;
    this.warnings = [];
    this.details = [];
    this.summaryParts = [];
    this.dataWords = [];
    this.text = '';
    this.specialPacket = null;
    this.packetSop = null;
    this.sopBitOffset = -1;
    this.crcExtra = null;
    this.dataBytesOverride = null;
    this.extHeadInfo = null;
    this.extBlock = null;
    this.extAssembly = null;
    this.extCompleteBytes = null;
    this.request = null;
    this.isRetry = false;
    this.stateValid = true;
    this.packetRaw = raw;
    this.channel = channel;
    this.em = this._makeEmitter();

    const hdrIdx = this._scanSop();

    if (hdrIdx < 0 && this.specialPacket) return this._specialPacket(raw, channel);
    if (hdrIdx < 0) return null;
    const existing = this.linkStates.get(`${channel}:${this.packetSop}`);
    if (existing?.bist && !raw.synthetic && this.bits.length - hdrIdx === 1024) return this._bistFrame(raw, channel, hdrIdx, existing);

    this.packetSeq++;
    const tms = raw.startSample / this.sampleRate * 1000;
    this.text = `#${this.packetSeq} (${tms.toFixed(4)}ms): `;
    this.idx = hdrIdx;
    this.head = this._short();
    if (this.head === null) return null;

    const t = this.headType();
    const isExt = this.headExt() === 1;
    const nObjects = this.headCount();

    let shortm;
    if (isExt) shortm = EXT_TYPES[t] ?? 'Reserved';
    else if (nObjects === 0) shortm = CTRL_TYPES[t] ?? 'Reserved';
    else shortm = DATA_TYPES[t] ?? 'Reserved';
    const profile = this.headModern() ? (this.specRevision ?? '3.2') : '2.0';
    this.messageDefined = PD_SPEC_PROFILES[profile][isExt ? 'ext' : nObjects ? 'data' : 'control'].includes(t);
    if (!this.messageDefined) shortm = 'Reserved';

    this.stateKey = `${channel}:${this.packetSop}`;
    const previousState = this.linkStates.get(this.stateKey) ?? createState();
    this.st = JSON.parse(JSON.stringify(previousState));

    const link = LINK_OF_SOP[this.packetSop] ?? 'port';
    const role = this._resolveRole(link);
    this.resolvedRole = role;
    this.em.object('Message Header');
    this.em.detail('原始值', `0x${pdHex(this.head, 4)}`);
    this.em.detail(this.headModern() ? 'Extended [B15]' : 'Reserved [B15]', (this.head >>> 15) & 1);
    if (!this.headModern()) this.em.detail('Reserved [B4]', (this.head >>> 4) & 1);
    this.em.detail('Number of Data Objects [B14-12]', nObjects);
    this.em.detail('MessageID [B11-9]', this.headId());
    this.em.detail(link === 'cable' ? 'Cable Plug [B8]' : 'Port Power Role [B8]', link === 'cable' ? (this.headPowerRole() ? 'Plug' : 'Port') : role);
    this.em.detail('Specification Revision [B7-6]', this.headRevText());
    this.em.detail(link === 'cable' ? 'Reserved [B5]' : 'Port Data Role [B5]', link === 'cable' ? this.headDataRole() : this.headDataRole() ? 'DFP' : 'UFP');
    this.em.detail('Message Type', `${t} · ${shortm}`);

    const longm = `(r${this.headRev()}) ${role}[${this.headId()}]: ${shortm}`;
    this.text += longm;

    /* 版本合法性提示 */
    this._versionHints(t, isExt, nObjects, shortm);

    /* 载荷 */
    let extHeader = null;
    let nObj = nObjects;
    let crc, calc, crcOk;
    if (isExt) {
      // 扩展消息的载荷长度不能采信 Header 的计数位（见 _readExtended 注释），
      // 由 _readExtended 内部连同 CRC 一起定长读出。
      const r = this._readExtended(t, link);
      extHeader = r.extHead;
      nObj = r.objCount;
      crc = r.crc; calc = r.calc; crcOk = r.crcOk;
    } else {
      // 先把全部数据对象读进来：VDM 等类型需要「整条报文」才能解析（例如 Discover Identity
      // 的 VDO 链要按顺序配对），不能边读边解析。
      for (let i = 0; i < nObjects; i++) this.dataWords.push(this._word());
      /* CRC + EOP */
      crc = this._word();
      calc = this._computeCrc();
      crcOk = crc !== null && this.dataWords.every(w => w !== null) && crc === calc;
    }
    if (!crcOk) this.warn(`CRC 校验失败：读到的 ${crc === null ? '缺失' : '0x' + pdHex(crc)} ≠ 计算的 0x${pdHex(calc)}`, 'CRC');

    let eop = false;
    if (this.bits.length >= this.idx + 5 && this._sym(this.idx) === SYM_EOP) { eop = true; this.idx += 5; }
    else this.warn('缺少 EOP（报文结束符）', 'EOP');

    if (raw.wireBytes && raw.wireBytes.length !== 2 + (this.dataBytesOverride?.length ?? nObjects * 4)) {
      this.warn('逻辑字节长度与 Header/Extended Header 不匹配', 'LENGTH');
      this.stateValid = false;
    }
    const frameValid = crcOk && eop && !this.warnings.some(w => ['TRUNC', 'SYM', 'LENGTH'].includes(w.short));
    this._messageHistory(t, isExt, frameValid);
    if (isExt) this._parseExtended(t, link, frameValid);
    else if (this.dataWords.every(w => w !== null)) {
      this._validateMessage(t, nObjects, link);
      if (nObjects && this.messageDefined && (t === 1 || t === 4)) {
        const capRole = t === 1 ? 'source' : 'sink';
        this.st.pdos[capRole] = {}; this.st.pdoMeta[capRole] = {};
      }
      if (t === 15 && nObjects > 0 && this.messageDefined) this._vdm(link);
      else for (let i = 0; i < nObjects; i++) this._payload(i, t, link);
      if (nObjects && this.messageDefined && (t === 1 || t === 4)) {
        const capRole = t === 1 ? 'source' : 'sink';
        this._validateCapabilities(capRole);
        this._storeCapabilities('spr', capRole);
      }
      if (!nObjects && CTRL_SUMMARY[t] && this.messageDefined) this.summaryParts.push(CTRL_SUMMARY[t]);
      if (!nObjects && t === 13 && this.messageDefined) {
        this.st.chunks = {}; this.st.messages = {};
      }
      if (!nObjects && (t === 14 || t === 15) && this.messageDefined) this.st.activeModes = {};
    }
    if (frameValid && this.stateValid && !this.isRetry) {
      if (this.messageDefined && this.packetSop === 'SOP') {
        pdTrackEpr(this.st, this.em, { type: t, ext: isExt, count: nObjects, sender: this.headPowerRole(),
          words: this.dataWords, request: this.request, extBytes: this.extCompleteBytes,
          endTimeMs: raw.endSample / this.sampleRate * 1000 });
        this._trackSwap(t, nObjects, isExt);
      }
      this.linkStates.set(this.stateKey, this.st);
      if (this.packetSop === 'SOP') this.channelRoles.set(channel, role);
    } else this.st = previousState;

    const epr = this.packetSop === 'SOP' ? JSON.parse(JSON.stringify(this.st.epr)) : null;
    if (epr && ((isExt && [16, 17, 18].includes(t)) || (!isExt && nObjects && [9, 10].includes(t))
      || epr.mode === 'epr' || previousState.epr.mode === 'epr'
      || this.warnings.some(w => w.short.startsWith('EPR_') || w.short === 'SWAP_SEQUENCE'))) pdDescribeEpr(epr, this.em);

    return this._finish(raw, channel, {
      sop: this.packetSop,
      msgType: shortm,
      msgTypeRaw: t,
      msgKind: isExt ? 'ext' : (nObjects === 0 ? 'control' : 'data'),
      role,
      header: this.head,
      extHeader,
      msgId: this.headId(),
      rev: this.headRev(),
      revText: this.headRevText(),
      powerRole: this.headPowerRole(),
      dataRole: this.headDataRole(),
      link,
      nObjects: nObj,
      crc,
      crcCalc: calc,
      crcOk,
      eop,
      frameValid,
      isRetry: this.isRetry,
      roleInferred: link === 'cable' && !this.headPowerRole(),
      specProfile: this.headModern() ? this.specRevision : '2.0',
      extended: this.extHeadInfo,
      reassembly: this.extAssembly,
      request: this.request,
      epr,
      category: MSG_CATEGORY[shortm] ?? (isExt ? 'data' : 'control'),
    });
  }

  /**
   * 由「**已经解码好的** PD 报文逻辑字节」解出一条报文。
   *
   * 为什么需要它：ATK-C 的 .atkcc 存的是原始电平采样，本类要先跑 BMC → 4B5B 才能拿到报文；
   * 而 POWER-Z 这类分析仪的导出（SQLite 的 `Raw` 列）里，报文已经是逻辑字节了：
   *
   *     [Header 2B 小端][Data Object ×N，各 4B 小端]        —— 不含 CRC，不含 SOP/EOP
   *
   * 为了**一条解析路径都不想复制**，这里反过来把逻辑字节铺成一份「1bit/采样」的数组：
   *   SOP 有序集符号 → 各字节（低半字节先行）→ 按规范算出的 CRC-32 → EOP
   * 这份 bits 与 `BmcDecoder` 的输出格式完全等价（`_sym()` 就是它的逆），
   * 于是 `decode()` 原样复用 —— 头部字段、VDM、PDO/RDO、扩展消息、
   * 跨报文状态（PDO 登记表、SOP 电源角色）全都一致，不会出现两套解析慢慢跑偏。
   *
   * @param {ArrayLike<number>} wire  逻辑字节（Header + Data Objects）
   * @param {{sop?:string, timeMs?:number, channel?:number,
   *          crcRecorded?:boolean, crc?:number|null, extra?:object}} [o]
   *   sop          有序集名：'SOP' | "SOP'" | "SOP''"
   *   timeMs       报文时间戳（毫秒），按 sampleRate 换算成 startSample。
   *   crc          实收 CRC。未提供时仅补齐内部解码流程，返回 crcOk=null。
   *   crcRecorded  兼容旧调用；仅设为 true 而没有 crc 时仍不能校验。
   * @returns {object|null}
   */
  decodeWire(wire, { sop = 'SOP', timeMs = 0, channel = 0, crcRecorded = false, crc: receivedCrc = null, extra = null } = {}) {
    const set = ORDERED_SET_BY_NAME[sop] || ORDERED_SET_BY_NAME['SOP'];

    const bits = [];
    for (const s of set.sequence) pushSymbol(bits, s);
    const n = wire.length >>> 0;
    for (let i = 0; i < n; i++) pushByte(bits, wire[i]);

    // 内部重建的编码比特只用于复用解析流程。
    const calc = crc32(wire);
    const crcValue = receivedCrc === null ? calc : receivedCrc >>> 0;
    for (const b of [crcValue & 0xFF, (crcValue >>> 8) & 0xFF, (crcValue >>> 16) & 0xFF, (crcValue >>> 24) & 0xFF]) pushByte(bits, b);
    pushSymbol(bits, SYM_EOP);

    const durMs = bits.length / 300; // PD 数据率 300 kbit/s，600 kHz 为半位时钟
    const raw = {
      bits,
      edges: [],
      startSample: timeMs * this.sampleRate / 1000,
      endSample: (timeMs + durMs) * this.sampleRate / 1000,
      bitrate: 300000,
      synthetic: true,
      wireBytes: wire,
    };

    const pkt = this.decode(raw, channel);
    if (!pkt) return null;

    pkt.synthetic = true;                 // 报文不是从采样波形解出来的
    pkt.crcCalc = calc;
    pkt.crcRecorded = receivedCrc !== null;
    // 按 300 kbit/s 估算编码部分时长，不含前导码/空闲，不是波形实测值。
    pkt.bitrateNominal = true;
    if (receivedCrc === null) { pkt.crc = null; pkt.crcOk = null; pkt.frameValid = null; }
    if (crcRecorded && receivedCrc === null) pkt.warnings.push({ short: 'CRC_UNKNOWN', long: 'crcRecorded 未提供实收 CRC，无法验证 CRC' });
    if (extra) Object.assign(pkt, extra);
    return pkt;
  }

  /** 方向：与官方上位机的三值口径一致（SRC / SNK / Plug），细节另放字段 */
  _resolveRole(link) {
    const ppr = this.headPowerRole();
    const dr = this.headDataRole();
    if (this.packetSop === 'SOP') {
      const role = ppr ? 'SRC' : 'SNK';
      return role;
    }
    if (link === 'cable') return ppr ? 'Plug' : (this.channelRoles.get(this.channel) ?? this.lastSopPowerRole);
    return this.lastSopPowerRole;
  }

  /**
   * 版本合法性提示。
   * Header 的修订号只能表示到「3.x」。未选择基线时，3.x 专属报文只能给出歧义说明；
   * 调用方显式选择某份本地规范 PDF 时，则可按该基线报告消息过早/已废弃，但不推断设备的精确版本。
   */
  _versionHints(t, isExt, nObjects, shortm) {
    const revText = this.headRevText();
    const revCode = this.headRevCode();
    const isGoodCrc = !isExt && nObjects === 0 && t === 1;
    // PD 3.x explicitly makes this field don't-care for GoodCRC. Keep its raw value in
    // the Header details, but do not reject an otherwise valid acknowledgement because
    // the two bits happen to be 11b (or any other value).
    // Use the selected specification's rule even when the received GoodCRC itself carries
    // a legacy-looking or reserved Revision code. Without an explicit profile, only a 3.x
    // Header gives us grounds to apply the PD 3.x don't-care rule; PD 2.0 reserves 10b/11b.
    const modernGoodCrcRules = this.specRevision
      ? this.specRevision !== '2.0'
      : this.headModern();
    const ignoreGoodCrcRevision = isGoodCrc && modernGoodCrcRules;
    if (ignoreGoodCrcRevision) {
      this.em.detail('Revision 语义', `GoodCRC 的 Revision 字段按 PD 3.x 忽略（原始值 ${revText}）`);
    }
    const reservedRevision = revText.startsWith('Reserved')
      || (this.specRevision === '2.0' && revCode >= 2);
    if (!ignoreGoodCrcRevision && reservedRevision) {
      const reservedBits = revCode.toString(2).padStart(2, '0');
      this.warn(`Header 的 Specification Revision 是保留值 ${reservedBits}b（所选 PD ${this.specRevision ?? '3.x'} 规范规定不得使用），版本判定不可靠`, 'REV');
      this.stateValid = false;
      return;
    }
    // 规范：00b（Revision 1.0）已废弃，接收端一律按 Revision 2.0 解读
    const legacy1 = revCode === 0;
    const revNum = legacy1 ? 2.0 : revTextNum(revText);
    if (legacy1 && nObjects > 0) {
      this.summaryParts.push('（Revision 域为 00b：已废弃，按 Revision 2.0 解读）');
    }
    const min = isExt ? EXT_MIN_REV[t] : (nObjects === 0 ? CTRL_MIN_REV[t] : DATA_MIN_REV[t]);
    // Header 的 10b 只写着 3.x。若调用方明确选择了某份 PDF，按所选配置检查；
    // 没有选择时才保留 3.0/3.1/3.2 的歧义，避免把已知 3.1/3.2 配置仍报告成未知。
    const checkRevision = this.headModern() && this.specRevision
      ? revTextNum(this.specRevision)
      : (this.headModern() ? null : revNum);
    if (!ignoreGoodCrcRevision && min !== undefined) {
      if (checkRevision !== null && checkRevision + 1e-9 < min) {
        this.warn(`消息类型「${shortm}」自 PD ${min.toFixed(1)} 起才定义，所选规范为 PD ${this.specRevision ?? checkRevision.toFixed(1)}`, 'REV');
      } else if (checkRevision === null && revText === '3.x' && min > 3.0 && min <= 3.2) {
        this.summaryParts.push(`（「${shortm}」自 PD ${min.toFixed(1)} 起定义；报文头只能标到 3.x，无法区分 3.0/3.1/3.2）`);
      }
    }
    if (!isExt && nObjects === 0 && CTRL_DEPRECATED[shortm] && this.headModern()) {
      this.em.detail('版本差异', `${shortm}：PD 3.2 已废弃；PD 2.0/3.0/3.1 中仍有定义，Header 无法区分 3.x`);
      if (this.specRevision === '3.2') this.warn(`${shortm} 在 PD 3.2 中已废弃`, 'DEPR');
    }
    if (!this.headModern() && (this.head & 0x8010)) this.warn('PD 2.0 Header 的 B15/B4 为 Reserved', 'RESERVED');
    if (this.packetSop !== 'SOP' && this.headDataRole()) this.warn('Cable Header 的 B5 为 Reserved', 'RESERVED');
  }

  _messageHistory(t, isExt, valid) {
    if (!valid || (!isExt && !this.headCount() && (t === 1 || t === 13))) return;
    const sender = String(this.headPowerRole());
    const fingerprint = `${this.head}:${this.dataBytesOverride ?? this.dataWords}`;
    const prev = this.st.messages[sender];
    this.isRetry = !!(prev && prev.id === this.headId() && prev.fingerprint === fingerprint);
    if (this.isRetry) this.em.detail('重传', `同一发送方、MessageID ${this.headId()} 和内容重复`);
    // 被动抓包可能缺失消息，不能仅凭 ID 跳变断言违规。
    this.st.messages[sender] = { id: this.headId(), fingerprint };
  }

  _context(link) {
    return { rev: this.headRev(), revText: this.headRevText(), specRevision: this.headModern() ? this.specRevision : '2.0',
      sop: this.packetSop, sopName: this.packetSop, link, role: this.resolvedRole,
      dataRole: this.headDataRole(), nObjects: this.headCount() };
  }

  _validateMessage(t, n, link) {
    if (!this.messageDefined) return;
    if (!n) {
      if (link === 'cable' && ![0, 1, 3, 4, 12, 13, 16, 18, 24].includes(t)
        && !(t === 21 && this.specRevision === '3.0')) this.warn('该控制消息仅允许 SOP（旧版 Get_Country_Codes 曾允许 SOP*）', 'SOP');
      return;
    }
    const count = ({ 2: [1], 3: [1], 5: [1], 6: [1], 7: [1], 8: [1], 9: [2], 10: [1],
      11: this.specRevision === '3.1' ? [1] : this.specRevision === '3.2' ? [2] : [1, 2], 12: [1] })[t];
    if (count && !count.includes(n)) { this.warn(`数据对象数量 ${n} 不符合消息 ${t} 的格式（${count.join('/')}）`, 'COUNT'); this.stateValid = false; }
    if (link === 'cable' && ![3, 8, 12, 15].includes(t)) this.warn('此数据消息仅允许 SOP', 'SOP');
    if (t === 11 && this.resolvedRole === 'SNK') this.warn('Source_Info 的发送方应为 Source', 'ROLE');
    if ([2, 9, 10].includes(t) && t !== 10 && this.resolvedRole === 'SRC') this.warn('Request/EPR_Request 的发送方应为 Sink', 'ROLE');
  }

  _trackSwap(t, n, isExt = false) {
    const pending = this.st.pendingSwap;
    if (isExt) {
      if (pending?.kind === 'fast_power') {
        this.warn('FR_Swap 过程中出现扩展消息，交换序列被中断，完成状态未知', 'SWAP_SEQUENCE');
        this.st.epr.phase = 'fr_swap_unknown';
      }
      this.st.pendingSwap = null;
      return;
    }
    if (!n && (t === 10 || t === 11 || t === 19)) {
      if (t === 19 && this.headPowerRole()) { this.warn('FR_Swap 应由原 Sink 发出', 'ROLE'); return; }
      this.st.pendingSwap = { kind: t === 11 ? 'vconn' : t === 19 ? 'fast_power' : 'power', sender: this.headPowerRole(),
        blocked: t === 10 && this.st.epr.mode === 'epr' };
    } else if (pending?.kind === 'fast_power' && pending.stage && !n && t === 6) {
      const expected = pending.stage === 'source_off' ? 0 : 1;
      if (this.headPowerRole() !== expected) {
        this.warn(`FR_Swap 尚未观察到 ${expected ? 'New Source' : 'New Sink'} 的 PS_RDY，不能确认交换完成`, 'SWAP_SEQUENCE'); return;
      }
      if (expected === 0) { pending.stage = 'source_on'; this.st.epr.phase = 'fr_swap_source_on'; }
      else {
        this.st.pdos = { source: {}, sink: {} }; this.st.pdoMeta = { source: {}, sink: {} };
        pdEprPowerSwap(this.st); this.st.messages = {}; this.st.pendingSwap = null;
      }
    } else if (pending && !n && [3, 4, 12, 16].includes(t) && pending.sender !== this.headPowerRole()) {
      if (t === 3 && pending.blocked) this.warn('EPR 模式中接受了禁止的 PR_Swap', 'EPR_PR_SWAP');
      else if (t === 3 && pending.kind === 'fast_power') {
        pending.stage = 'source_off'; this.st.epr.phase = 'fr_swap_source_off';
        // 接下来两个端点的 Header 电源角色互换，不能沿用按旧角色索引的去重历史。
        const accepted = this.st.messages[String(this.headPowerRole())];
        this.st.messages = accepted ? { [this.headPowerRole()]: accepted } : {};
        return;
      }
      else if (t === 3 && pending.kind === 'power') {
        this.st.pdos = { source: {}, sink: {} }; this.st.pdoMeta = { source: {}, sink: {} };
        pdEprPowerSwap(this.st); this.st.messages = {};
      }
      this.st.pendingSwap = null;
    } else if (pending && (n || ![1, 5].includes(t))) {
      if (pending.kind === 'fast_power') {
        this.warn('FR_Swap 的 PS_RDY 序列被其他消息中断，交换完成状态未知', 'SWAP_SEQUENCE');
        this.st.epr.phase = 'fr_swap_unknown';
      }
      this.st.pendingSwap = null;
    }
  }

  _validateCapabilities(role) {
    const entries = Object.values(this.st.pdoMeta[role]);
    let prev = null;
    const seen = new Set();
    const rank = { fixed: 0, battery: 1, variable: 2, spr_avs: 3, pps: 4, epr_avs: 5 };
    for (const m of entries) {
      const r = rank[m.kind];
      const voltage = m.kind === 'fixed' || m.kind === 'pps' ? m.maxVoltage : m.minVoltage;
      const key = `${m.kind}:${m.minVoltage}:${m.maxVoltage}`;
      if (seen.has(key)) this.warn(`PDO #${m.position} 的类型和电压与前项重复`, 'PDO_ORDER');
      if (prev && m.isEpr === prev.isEpr && (r < prev.rank || r === prev.rank && voltage < prev.voltage)) this.warn(`PDO #${m.position} 不符合 PDO 类型和电压排序`, 'PDO_ORDER');
      seen.add(key); prev = { rank: r, voltage, isEpr: m.isEpr };
    }
    if (role !== 'source') {
      for (const m of entries) if (m.kind === 'epr_avs' && m.power > this.st.sinkMaximumPdp) {
        this.warn('EPR Sink AVS Maximum Power 超过 Sink_Capabilities_Extended 的 EPR Maximum PDP', 'AVS_CAP'); m.valid = false;
      }
      return;
    }
    const fixed = entries.filter(m => m.kind === 'fixed');
    for (const m of entries.filter(m => m.kind === 'spr_avs')) {
      for (const [v, i] of [[15, m.current15], [20, m.current20]]) {
        const f = fixed.find(p => !p.isEpr && p.maxVoltage === v);
        if ((v === 15 || i > 0 || f) && (!f || f.current !== i)) {
          this.warn(`SPR AVS 的 ${v}V 电流必须与对应 Fixed PDO 一致`, 'AVS_CAP'); m.valid = false;
        }
      }
    }
    const eprEntries = entries.filter(m => m.isEpr);
    if (eprEntries.length) {
      const avs = eprEntries.filter(m => m.kind === 'epr_avs');
      if (avs.length !== 1) this.warn('EPR 能力区应包含且只包含一个 EPR AVS APDO', 'AVS_CAP');
      const maxFixed = Math.max(0, ...fixed.filter(m => m.isEpr).map(m => m.maxVoltage));
      for (const m of avs) if (m.maxVoltage !== maxFixed) {
        this.warn('EPR Source AVS 的最高电压必须匹配最高 EPR Fixed PDO', 'AVS_CAP'); m.valid = false;
      }
    }
  }

  _storeCapabilities(range, role) {
    // DRP 可在当前相反电源角色下回复能力查询；该信息不能替换正在供电端的能力表。
    if (this.headPowerRole() !== (role === 'source' ? 1 : 0)) return;
    this.st.capabilities[range][role] = { pdos: { ...this.st.pdos[role] }, pdoMeta: { ...this.st.pdoMeta[role] } };
  }

  _computeCrc() {
    const headBytes = [this.head & 0xFF, (this.head >>> 8) & 0xFF];
    if (this.crcExtra) return crc32(headBytes.concat(this.crcExtra));
    const bytes = headBytes.slice();
    for (const w of this.dataWords) bytes.push(w & 0xFF, (w >>> 8) & 0xFF, (w >>> 16) & 0xFF, (w >>> 24) & 0xFF);
    return crc32(bytes);
  }

  /* ────────────────────────── 载荷解析 ────────────────────────── */

  _payload(idx, t, link) {
    const em = this.em;
    const data = this.dataWords[idx];
    const ctx = this._context(link);
    let summary = '';

    if (!this.messageDefined) {
      em.object(`Reserved 数据对象 #${idx + 1}`); em.detail('原始值', `0x${pdHex(data)}`);
      em.note(`Reserved · 0x${pdHex(data)}`); return;
    }

    if (t === 2) {
      this.request = rdoParse(this.st, em, data, { ...ctx, isEpr: false, capabilities: this.st.capabilities.spr.source });
    } else if (t === 1 || t === 4) {
      const role = t === 1 ? 'source' : 'sink';
      const r = pdoParse(this.st, em, data, { ...ctx, role, position: idx + 1, isEpr: false });
      em.note(r.summary);
    } else if (t === 9) {
      if (idx === 0) {
        const pos = data >>> 28;
        const copy = this.dataWords[1];
        let meta = null, ref = null;
        if (copy != null) {
          const r = pdoParse(this.st, em, copy, { ...ctx, role: 'source', position: pos, isEpr: pos >= 8, register: false });
          const caps = this.st.capabilities.epr.source;
          const prior = caps?.pdoMeta[pos];
          // 已捕获的最近 EPR 能力优先；副本不能放宽广告电流/功率限制。
          meta = prior ?? r.meta; ref = caps?.pdos[pos] ?? r.ref;
          if (prior && prior.raw !== copy) this.warn('EPR_Request 的 PDO 副本与最近能力表不一致', 'PDO_COPY');
          if (caps && !prior) this.warn('EPR_Request 指向最近 EPR 能力表中未提供的 PDO 槽位', 'PDO_COPY');
          em.detail('PDO 副本', `引用 #${pos}，仅用于本次请求解码`);
        }
        this.request = rdoParse(this.st, em, data, { ...ctx, isEpr: true, meta, ref });
        if (this.warnings.some(w => w.short === 'PDO_COPY')) this.request.valid = false;
      } else {
        em.detail(`EPR_Request 对象 #${idx + 1}`, `0x${pdHex(data)}（请求的 PDO 副本）`);
      }
    } else if (t === 15) {
      // VDM 需要整条报文，由 decode() 统一调用 _vdm()，不会走到这里
      this._vdm(link);
    } else if (t === 3) {
      summary = bistParse(em, data, idx, ctx);
      if ((ctx.revText === '2.0' || ctx.revText === '1.0') && (data >>> 28) <= 1) this.st.bist = { register: 255, totalBits: 0, bitErrors: 0 };
    } else if (t === 10) {
      summary = eprModeParse(em, data, idx, ctx);
    } else if (t === 5) {
      em.object('Battery_Status 数据对象（BSDO）');
      summary = batteryStatusParse(em, data);
    } else if (t === 6) {
      summary = alertParse(em, data, idx, ctx);
    } else if (t === 8) {
      em.object('Enter_USB 数据对象（EUDO）');
      summary = enterUsbParse(em, data, ctx);
    } else if (t === 11) {
      summary = sourceInfoParse(em, data, idx, ctx);
    } else if (t === 12) {
      em.object('Revision 数据对象（RMDO）');
      summary = revisionParse(em, data);
    } else if (t === 7) {
      summary = countryCodeParse(em, data);
    } else {
      em.object(`数据对象 #${idx + 1}`);
      em.detail('原始值', `0x${pdHex(data)}`);
      summary = `0x${pdHex(data)}`;
      em.note(summary);
    }
    this.text += ` - ${summary}`;
  }

  /** VDM：把整条报文的全部数据对象交给 vdmParse（含 plug 信令的线缆 VDO） */
  _vdm(link) {
    if (!this.dataWords.length) { this.em.note('VDM 未携带数据对象'); return; }
    const ctx = this._context(link);
    vdmParse(this.st, this.em, this.dataWords, ctx);
  }

  /* ────────────────────────── 扩展消息 ────────────────────────── */

  /**
   * 读扩展消息：扩展头 → 数据块 → CRC，并把整块交给 extendedParse 做语义解析。
   *
   * 长度为什么不能直接信 Header？
   *   Table 6.3 规定：Extended=1 且 Chunked=0 时，Header 里的 Number of Data Objects 是
   *   **保留位，接收方必须忽略**；长度只能由扩展头的 Data Size 决定。
   *   而 Data Size 的解读还要分两种：
   *     • Chunked=1 —— Data Size 是「整个数据块」的总字节数，本块从 chunkNum×MaxChunkLen 起；
   *       且载荷要补齐到 4 字节边界（补 00h），补齐字节计入 CRC；
   *     • Chunked=0 —— Data Size 就是本消息的全部数据字节数，**不做补齐**（补齐只针对分块消息）。
   *
   * 实际抓包里各家实现并不完全一致（例如苹果会在非分块扩展消息里把计数位填 0，
   * 也有实现会多补几个 00h），所以这里对「补 / 不补」两种长度都试一遍，用 CRC 反证挑出正确的那份；
   * 都不过 CRC 时退回规范读法并如实报警，不猜。
   *
   * @returns {{extHead:number, objCount:number, crc:number, calc:number, crcOk:boolean}}
   */
  _readExtended(t, link) {
    const extHead = this._short();
    const chunked = !!((extHead >>> 15) & 1);
    const chunkNum = (extHead >>> 11) & 0x0F;
    const reqChunk = !!((extHead >>> 10) & 1);
    const dataSize = extHead & 0x1FF;

    this.extHeadInfo = { chunked, chunkNum, reqChunk, dataSize };
    if (extHead === null) this.stateValid = false;
    if (extHead & 0x200) this.warn('Extended Header 的 B9 为 Reserved', 'RESERVED');
    if (dataSize > 260 || chunkNum > 9 || (!chunked && (reqChunk || chunkNum)) || (reqChunk && dataSize)) {
      this.warn('Extended Header 的 Data Size / Chunk Number / Request Chunk 组合无效', 'EXT_HEADER');
      this.stateValid = false;
    }
    if (chunked && !this.headCount()) { this.warn('Chunked 消息必须携带至少 1 个数据对象', 'COUNT'); this.stateValid = false; }
    if (!chunked && link === 'cable') { this.warn('线缆扩展消息必须使用 Chunked 格式', 'EXT_HEADER'); this.stateValid = false; }

    const hdrBytes = [this.head & 0xFF, (this.head >>> 8) & 0xFF];
    const extBytes = [extHead & 0xFF, (extHead >>> 8) & 0xFF];
    const cands = this._extCandidates({ chunked, chunkNum, reqChunk, dataSize });

    let pick = null;
    for (const c of cands) {
      const r = this._readExtTry(c, hdrBytes, extBytes);
      if (r.ok) { pick = r; break; }
      if (!pick) pick = r;                    // 都不匹配时用第一个候选兜底
    }
    this.idx = pick.endIdx;
    this.warnings.push(...pick.warnings);
    if (pick.compat) this.warn('非分块扩展消息含规范之外的补齐字节，已根据 CRC 识别并保留', 'EXT_PADDING');

    const { payload, pad, bytes } = pick;
    const payloadBytes = bytes.slice(0, payload);

    // 线上真实字节 = 扩展头(2) + 数据块(+补齐)。非分块扩展消息不补齐时，
    // 总长 % 4 != 0（如 Data Size=25 → 27 字节），末个「数据对象」只占 3 字节。
    const body = extBytes.concat(bytes);
    // 「数据对象 (hex)」一栏：按 4 字节回填，让界面与其它消息一致地显示原始字节。
    // 末组不足 4 字节时补 0 只为凑齐对象视图，真实字节另由 dataBytesOverride 给出。
    for (let i = 0; i < body.length; i += 4) {
      if (body.slice(i, i + 4).some(b => b === null)) { this.dataWords.push(null); continue; }
      this.dataWords.push((body[i] | ((body[i + 1] ?? 0) << 8)
        | ((body[i + 2] ?? 0) << 16) | ((body[i + 3] ?? 0) << 24)) >>> 0);
    }
    this.dataBytesOverride = body;

    this.extBlock = { bytes: payloadBytes, off: pick.off, dataSize, chunked, chunkNum, reqChunk };
    if (bytes.slice(payload).some(b => b !== 0)) this.warn('扩展消息的补齐字节必须为 0', 'PADDING');
    if (chunked) {
      const expected = reqChunk ? 1 : Math.ceil((2 + Math.min(Math.max(dataSize - pick.off, 0), 26)) / 4);
      if (this.headCount() !== expected || (!reqChunk && (pick.off >= dataSize && !(dataSize === 0 && chunkNum === 0)))) {
        this.warn('扩展分块的长度/编号与总 Data Size 不匹配', 'EXT_LENGTH'); this.stateValid = false;
      }
    }

    return {
      extHead,
      objCount: Math.ceil((2 + payload + pad) / 4),
      crc: pick.crc, calc: pick.calc, crcOk: pick.ok,
    };
  }

  /** 按「(数据字节数, 补齐字节数, 整块偏移)」列出可尝试的几种读法，顺序即优先级 */
  _extCandidates({ chunked, chunkNum, reqChunk, dataSize }) {
    const out = [];
    if (reqChunk) return [{ payload: 0, pad: Math.max(this.headCount() * 4 - 2, 0), off: chunkNum * 26 }];
    if (chunked) {
      const cap = Math.max(this.headCount() * 4 - 2, 0);          // 分块消息的计数位有效，用它定本块长度
      const off = chunkNum * EXT_MSG_LIMITS.chunkLen;
      const payload = Math.min(Math.max(dataSize - off, 0), cap, 26);
      return [{ payload, pad: Math.max(cap - payload, 0), off }];
    }
    const size = Math.min(dataSize, EXT_MSG_LIMITS.maxLen);
    out.push({ payload: size, pad: 0, off: 0 });                 // 规范读法：非分块不补齐
    const padded = Math.max(Math.ceil((2 + size) / 4) * 4 - 2, 0);
    if (padded > size) out.push({ payload: size, pad: padded - size, off: 0, compat: true });
    return out;
  }

  /** 试读一种长度：读数据块 + CRC，比对成功返回 ok；失败把 idx 与警告回滚，便于换一种再试 */
  _readExtTry(cand, hdrBytes, extBytes) {
    const saveIdx = this.idx;
    const saveWarn = this.warnings.length;
    const n = cand.payload + cand.pad;
    const bytes = new Array(n);
    for (let i = 0; i < n; i++) bytes[i] = this._byte();
    const crc = this._word();
    const calc = crc32(new Uint8Array(hdrBytes.concat(extBytes, bytes)));
    const warnings = this.warnings.slice(saveWarn);
    const ok = crc !== null && bytes.every(b => b !== null) && crc === calc && !warnings.length;
    const endIdx = this.idx;
    this.idx = saveIdx; this.warnings.length = saveWarn;
    return { ...cand, bytes, crc, calc, ok, endIdx, warnings };
  }

  _parseExtended(t, link, frameValid) {
    const bk = this.extBlock;
    if (!bk) return;
    const em = this.em;
    em.object('Extended Header');
    for (const [key, value] of Object.entries(this.extHeadInfo)) em.detail(key, value);
    if (bk.bytes.some(b => b === null)) {
      this.extAssembly = { status: 'truncated', complete: false, totalBytes: bk.dataSize };
      em.note('扩展数据被截断或包含非法符号');
      return;
    }
    if (bk.reqChunk) {
      this.extAssembly = { status: 'request', chunkNum: bk.chunkNum, complete: false };
      em.note(`请求扩展消息分块 #${bk.chunkNum}`);
      return; // Request Chunk 不是对应消息的数据块
    }
    let assembled = bk;
    if (bk.chunked) {
      const key = `${this.headPowerRole()}:${t}`;
      let transfer = this.st.chunks[key];
      if (bk.chunkNum === 0 && !this.isRetry) transfer = { size: bk.dataSize, bytes: [], next: 0, parts: {} };
      if (transfer && transfer.size === bk.dataSize && transfer.parts[bk.chunkNum]?.join() === bk.bytes.join()) {
        // 同一分块的重传保持已经收到的后续分块。
      } else if (transfer && transfer.size === bk.dataSize && transfer.next === bk.chunkNum && transfer.bytes.length === bk.off) {
        transfer.parts[bk.chunkNum] = bk.bytes.slice();
        transfer.bytes.push(...bk.bytes); transfer.next++;
      } else {
        transfer = null;
        this.warn('扩展分块缺少前块、顺序错误或总长度变化，不能重组', 'CHUNK_GAP');
      }
      const complete = !!(frameValid && this.stateValid && transfer && transfer.bytes.length === bk.dataSize);
      this.extAssembly = { status: complete ? 'complete' : 'partial', complete, chunkNum: bk.chunkNum,
        receivedBytes: transfer?.bytes.length ?? bk.bytes.length, totalBytes: bk.dataSize,
        bytes: complete ? transfer.bytes.slice() : null };
      if (frameValid && this.stateValid) {
        if (transfer) this.st.chunks[key] = transfer;
        else delete this.st.chunks[key];
      }
      if (!complete) {
        em.detail('分块', `#${bk.chunkNum}，偏移 ${bk.off}，${bk.bytes.length}/${bk.dataSize} 字节，尚未完整重组`);
        // 部分块仅展示原始内容，避免半个 PDO 或字符串被解释成完整能力。
        em.detail('分块数据', bk.bytes.map(b => b === null ? '??' : pdHex(b, 2)).join(' '));
        em.note(`扩展消息分块 #${bk.chunkNum}（待重组）`);
        return;
      }
      assembled = { ...bk, off: 0, bytes: transfer.bytes.slice(), complete: true };
      em.detail('重组', `已按顺序重组 ${transfer.next} 块，共 ${bk.dataSize} 字节`);
    } else {
      const complete = frameValid && this.stateValid;
      this.extAssembly = { status: complete ? 'complete' : 'invalid', complete, receivedBytes: bk.bytes.length,
        totalBytes: bk.dataSize, bytes: complete ? bk.bytes.slice() : null };
    }
    if (!this.messageDefined) {
      em.detail('Reserved 扩展数据', assembled.bytes.map(b => pdHex(b, 2)).join(' '));
      em.note('该消息类型在选定规范中为 Reserved'); return;
    }
    if (t === 17 || t === 18) {
      const capRole = t === 17 ? 'source' : 'sink';
      this.st.pdos[capRole] = {}; this.st.pdoMeta[capRole] = {};
      const bytes = assembled.bytes;
      const maxBytes = this.specRevision ? 44 : 52;
      if (bytes.length < 4 || bytes.length % 4 || bytes.length > maxBytes) this.stateValid = false;
    }
    const s = extendedParse(this.st, em, t, assembled, this._context(link));
    if (t === 17 || t === 18) {
      const capRole = t === 17 ? 'source' : 'sink';
      this._validateCapabilities(capRole);
      this._storeCapabilities('epr', capRole);
      if (link !== 'port' || this.warnings.some(w => w.short === 'EXT_FIELD')) this.stateValid = false;
    }
    if (t === 16 && (assembled.bytes.length !== 2 || link !== 'port')) this.stateValid = false;
    if (frameValid && this.stateValid) this.extCompleteBytes = assembled.bytes;
    if (s) em.note(s);
  }

  /* ────────────────────────── 特殊短报文 ────────────────────────── */

  /** PD 2.0 Figure 5-35/36: 1024 raw PRBS-8 bits, without Header/CRC/EOP. */
  _bistFrame(raw, channel, off, previous) {
    this.packetSeq++;
    this.text = `#${this.packetSeq} (${(raw.startSample / this.sampleRate * 1000).toFixed(4)}ms): BIST_Test_Frame`;
    this.st = JSON.parse(JSON.stringify(previous));
    const state = this.st.bist;
    let register = state.register, errors = 0;
    const bytes = new Array(128).fill(0);
    for (let i = 0; i < 1024; i++) {
      const bit = this.bits[off + i] & 1;
      const next = ((register >>> 7) ^ (register >>> 5) ^ (register >>> 4) ^ (register >>> 3)) & 1;
      // Figure 5-35 的 Transmit out 位于反馈节点，不是寄存器 bit7。
      if (bit !== next) errors++;
      register = ((register << 1) & 255) | next;
      bytes[i >>> 3] |= bit << (i & 7);
    }
    Object.assign(state, { register, totalBits: state.totalBits + 1024, bitErrors: state.bitErrors + errors });
    this.linkStates.set(`${channel}:${this.packetSop}`, this.st);
    this.dataBytesOverride = bytes;
    this.em.object('BIST Test Frame');
    this.em.detail('PRBS-8', 'x⁸ + x⁶ + x⁵ + x⁴ + 1，初值 FFh，帧间连续');
    this.em.detail('位数', 1024);
    this.em.detail('本帧错误位', errors);
    this.em.detail('累计错误位', state.bitErrors);
    this.em.note(`BIST PRBS-8 测试帧：1024 位，${errors} 个错误位`);
    return this._finish(raw, channel, { sop: this.packetSop, msgType: 'BIST_Test_Frame', msgTypeRaw: null, msgKind: 'test',
      role: null, header: null, extHeader: null, msgId: null, rev: 2, revText: '2.0', powerRole: null, dataRole: null,
      link: LINK_OF_SOP[this.packetSop], nObjects: 0, crc: null, crcCalc: null, crcOk: null, eop: null,
      bist: { bits: 1024, bitErrors: errors, totalBits: state.totalBits, totalBitErrors: state.bitErrors }, category: 'data' });
  }

  _specialPacket(raw, channel) {
    this.packetSeq++;
    const tms = raw.startSample / this.sampleRate * 1000;
    this.text = `#${this.packetSeq} (${tms.toFixed(4)}ms): ${this.specialPacket}`;
    for (const key of this.linkStates.keys()) {
      if (key.startsWith(`${channel}:`) && (this.specialPacket === 'Hard Reset' || key !== `${channel}:SOP`)) this.linkStates.delete(key);
    }
    this.st = this.linkStates.get(`${channel}:SOP`) ?? createState();
    if (this.specialPacket === 'Hard Reset') {
      this.channelRoles.delete(channel); this.lastSopPowerRole = 'SRC';
      this.st.epr = pdCreateEprState('spr');
      this.linkStates.set(`${channel}:SOP`, this.st);
    }
    return this._finish(raw, channel, {
      sop: this.specialPacket,
      msgType: this.specialPacket,
      msgTypeRaw: null,
      msgKind: 'special',
      role: this.lastSopPowerRole,
      header: null,
      extHeader: null,
      msgId: null,
      rev: null,
      revText: null,
      powerRole: null,
      dataRole: null,
      link: LINK_OF_SOP[this.specialPacket] ?? 'port',
      nObjects: 0,
      crc: null,
      crcCalc: null,
      crcOk: null,
      eop: null,
      summary: this.specialPacket === 'Hard Reset'
        ? '硬复位：发送方要求链路立即回到默认状态并重新建链'
        : '线缆复位：复位线缆 e-Marker 的 VCONN 相关逻辑',
      category: 'control',
      epr: JSON.parse(JSON.stringify(this.st.epr)),
    });
  }

  /* ────────────────────────── 组装 packet ────────────────────────── */

  _finish(raw, channel, o) {
    const summary = this.summaryParts.filter(Boolean).join(' ; ') || o.summary || '';
    if (summary) this.text += ` - ${summary}`;

    let bytes;
    if (this.dataBytesOverride) {
      bytes = this.dataBytesOverride.slice();      // 扩展消息：线上真实字节（可能不是 4 的整数倍）
    } else {
      bytes = [];
      for (const w of this.dataWords) bytes.push(...(w === null ? [null, null, null, null] : [w & 0xFF, (w >>> 8) & 0xFF, (w >>> 16) & 0xFF, (w >>> 24) & 0xFF]));
    }

    return {
      seq: this.packetSeq,
      channel,
      ...o,
      summary,
      startSample: raw.startSample,
      endSample: raw.endSample,
      timeMs: raw.startSample / this.sampleRate * 1000,
      endTimeMs: raw.endSample / this.sampleRate * 1000,
      durationUs: (raw.endSample - raw.startSample) / this.sampleRate * 1e6,
      bitrate: raw.bitrate,
      dataWords: this.dataWords.slice(),
      dataBytes: bytes,
      dataHex: bytes.map((b) => b === null ? '??' : b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
      details: this.details,
      warnings: this.warnings.slice(),
      text: this.text,
    };
  }
}
