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
  DEC4B5B, SYM_EOP, ORDERED_SET_BY_KEY, matchOrderedSet,
} from './symbols.js';
import {
  CTRL_TYPES, DATA_TYPES, EXT_TYPES, MSG_CATEGORY, SPEC_REV,
  CTRL_DEPRECATED, CTRL_MIN_REV, DATA_MIN_REV, EXT_MIN_REV, EXT_MSG_LIMITS, revTextNum,
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
  13: '软复位：双方回到默认状态但保持供电',
  14: '数据复位',
  15: '数据复位完成',
  16: '不支持该请求',
  19: '快速角色交换请求',
};

/** 建立一份全新的解码状态（跨报文关联用） */
function createState() {
  return {
    pdos: { source: {}, sink: {} },   // 位置 → PDO 摘要文本（供 RDO / EPR_Request 反查）
    pdoMeta: { source: {}, sink: {} },// 位置 → PDO 元信息（kind 等）
    svidList: null,                   // 最近一次 Discover SVIDs 结果
    identity: null,                   // 最近一次 Discover Identity（端口/线缆）结果
    lastVdm: null,
    extCarry: null,                   // EPR 能力分块拼接的跨包尾巴
  };
}

export class PdDecoder {
  /**
   * @param {{sampleRate:number}} opts
   */
  constructor({ sampleRate }) {
    this.sampleRate = sampleRate;
    this.reset();
  }

  /** 清空跨报文状态。切换通道 / 重新解码前调用。 */
  reset() {
    this.packetSeq = 0;
    this.st = createState();
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
    const i = this.idx;
    if (this.bits.length - i <= 10) { this.warn('数据被截断', 'TRUNC'); return 0x0BAD; }
    const k0 = this._sym(i), k1 = this._sym(i + 5);
    this.idx += 10;
    return (k0 & 0x0F) | ((k1 & 0x0F) << 4);
  }

  _nibble() {
    if (this.bits.length - this.idx <= 5) { this.warn('数据被截断', 'TRUNC'); return 0x0BAD; }
    const s = this._sym(this.idx);
    if (s > 0xF) { this.warn(`非法 4B5B 符号 0x${s.toString(16).toUpperCase()}`, 'SYM'); return 0x0BAD; }
    this.idx += 5;
    return s;
  }

  _short() {
    if (this.bits.length - this.idx <= 20) { this.warn('报文被截断', 'TRUNC'); return 0x0BAD; }
    let val = 0;
    for (let i = 0; i < 4; i++) {
      const s = this._sym(this.idx + i * 5);
      if (s > 0xF) { this.warn(`非法 4B5B 符号 0x${s.toString(16).toUpperCase()}`, 'SYM'); return 0x0BAD; }
      val |= (s << (4 * i));      // 低 4bit 先行 → 小端
    }
    this.idx += 20;
    return val >>> 0;
  }

  _word() {
    const lo = this._short(), hi = this._short();
    if (lo === 0x0BAD || hi === 0x0BAD) { this.warn('读取 32bit 对象失败', 'WORD'); return 0x0BAD0BAD; }
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
    this.packetRaw = raw;
    this.channel = channel;
    this.em = this._makeEmitter();

    const hdrIdx = this._scanSop();

    if (hdrIdx < 0 && this.specialPacket) return this._specialPacket(raw, channel);
    if (hdrIdx < 0) return null;

    this.packetSeq++;
    const tms = raw.startSample / this.sampleRate * 1000;
    this.text = `#${this.packetSeq} (${tms.toFixed(4)}ms): `;
    this.idx = hdrIdx;
    this.head = this._short();
    if (this.head === 0x0BAD) return null;

    const t = this.headType();
    const isExt = this.headExt() === 1;
    const nObjects = this.headCount();

    let shortm;
    if (isExt) shortm = EXT_TYPES[t] ?? `EXT?${t}`;
    else if (nObjects === 0) shortm = CTRL_TYPES[t] ?? `CTRL?${t}`;
    else shortm = DATA_TYPES[t] ?? `DATA?${t}`;

    const link = LINK_OF_SOP[this.packetSop] ?? 'port';
    const role = this._resolveRole(link);
    this.resolvedRole = role;

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
      if (t === 15) {
        this._vdm(link);
      } else {
        for (let i = 0; i < nObjects; i++) this._payload(i, t, link);
      }
      if (nObjects === 0 && CTRL_SUMMARY[t]) this.summaryParts.push(CTRL_SUMMARY[t]);

      /* CRC + EOP */
      crc = this._word();
      calc = this._computeCrc();
      crcOk = crc === calc;
    }
    if (!crcOk) this.warn(`CRC 校验失败：读到的 0x${pdHex(crc)} ≠ 计算的 0x${pdHex(calc)}`, 'CRC');

    let eop = false;
    if (this.bits.length >= this.idx + 5 && this._sym(this.idx) === SYM_EOP) { eop = true; this.idx += 5; }
    else this.warn('缺少 EOP（报文结束符）', 'EOP');

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
      category: MSG_CATEGORY[shortm] ?? (isExt ? 'data' : 'control'),
    });
  }

  /** 方向：与官方上位机的三值口径一致（SRC / SNK / Plug），细节另放字段 */
  _resolveRole(link) {
    const ppr = this.headPowerRole();
    const dr = this.headDataRole();
    if (this.packetSop === 'SOP') {
      const role = ppr ? 'SRC' : 'SNK';
      this.lastSopPowerRole = role;
      return role;
    }
    if (link === 'cable') return ppr ? 'Plug' : this.lastSopPowerRole;
    return this.lastSopPowerRole;
  }

  /**
   * 版本合法性提示。
   * Header 的修订号只能表示到「3.x」，所以「3.1 才定义的报文」出现在 r3 包里**不是错误**，
   * 只能用一句说明带过；只有连 3.x 都够不着的（如 PD 2.0 包里出现 3.0 才有的类型）才报警告。
   */
  _versionHints(t, isExt, nObjects, shortm) {
    const revText = this.headRevText();
    if (revText.startsWith('Reserved')) {
      this.warn('Header 的 Specification Revision 是保留值 11b（规范规定不得使用），版本判定不可靠', 'REV');
      return;
    }
    // 规范：00b（Revision 1.0）已废弃，接收端一律按 Revision 2.0 解读
    const legacy1 = this.headRevCode() === 0;
    const revNum = legacy1 ? 2.0 : revTextNum(revText);
    if (legacy1 && nObjects > 0) {
      this.summaryParts.push('（Revision 域为 00b：已废弃，按 Revision 2.0 解读）');
    }
    const min = isExt ? EXT_MIN_REV[t] : (nObjects === 0 ? CTRL_MIN_REV[t] : DATA_MIN_REV[t]);
    if (min !== undefined && revNum + 1e-9 < min) {
      if (revText === '3.x' && min <= 3.2) {
        this.summaryParts.push(`（「${shortm}」自 PD ${min.toFixed(1)} 起定义；报文头只能标到 3.x，无法区分 3.0/3.1/3.2）`);
      } else {
        this.warn(`消息类型「${shortm}」自 PD ${min.toFixed(1)} 起才定义，本包声明为 r${this.headRev()}`, 'REV');
      }
    }
    if (!isExt && nObjects === 0 && CTRL_DEPRECATED[shortm]) {
      this.warn(`${shortm}：${CTRL_DEPRECATED[shortm]}`, 'DEPR');
    }
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
    const ctx = {
      rev: this.headRev(), revText: this.headRevText(),
      sop: this.packetSop, link, role: this.resolvedRole,
    };
    let summary = '';

    if (t === 2) {
      rdoParse(this.st, em, data, { isEpr: false });
    } else if (t === 1 || t === 4) {
      const role = t === 1 ? 'source' : 'sink';
      const r = pdoParse(this.st, em, data, { role, position: idx + 1, isEpr: false, revText: ctx.revText });
      em.note(r.summary);
    } else if (t === 9) {
      if (idx === 0) {
        rdoParse(this.st, em, data, { isEpr: true });
      } else {
        const r = pdoParse(this.st, em, data, { role: 'source', position: idx + 1, isEpr: true, revText: ctx.revText });
        em.note(`EPR 能力副本 #${idx} · ${r.summary}`);
      }
    } else if (t === 15) {
      // VDM 需要整条报文，由 decode() 统一调用 _vdm()，不会走到这里
      this._vdm(link);
    } else if (t === 3) {
      summary = bistParse(em, data, idx, ctx);
    } else if (t === 10) {
      summary = eprModeParse(em, data, idx);
    } else if (t === 5) {
      em.object('Battery_Status 数据对象（BSDO）');
      summary = batteryStatusParse(em, data);
    } else if (t === 6) {
      summary = alertParse(em, data, idx);
    } else if (t === 8) {
      em.object('Enter_USB 数据对象（EUDO）');
      summary = enterUsbParse(em, data);
    } else if (t === 11) {
      summary = sourceInfoParse(em, data, idx);
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
    const ctx = {
      rev: this.headRev(), revText: this.headRevText(),
      sop: this.packetSop, link, role: this.resolvedRole,
    };
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

    const hdrBytes = [this.head & 0xFF, (this.head >>> 8) & 0xFF];
    const extBytes = [extHead & 0xFF, (extHead >>> 8) & 0xFF];
    const cands = this._extCandidates({ chunked, chunkNum, reqChunk, dataSize });

    let pick = null;
    for (const c of cands) {
      const r = this._readExtTry(c, hdrBytes, extBytes);
      if (r.ok) { pick = r; break; }
      if (!pick) pick = r;                    // 都不匹配时用第一个候选兜底
    }
    if (!pick.ok) pick = this._readExtTry(cands[0], hdrBytes, extBytes);   // 让 idx 停在正确位置

    const { payload, pad, bytes } = pick;
    const payloadBytes = bytes.slice(0, payload);

    // 线上真实字节 = 扩展头(2) + 数据块(+补齐)。非分块扩展消息不补齐时，
    // 总长 % 4 != 0（如 Data Size=25 → 27 字节），末个「数据对象」只占 3 字节。
    const body = extBytes.concat(bytes);
    // 「数据对象 (hex)」一栏：按 4 字节回填，让界面与其它消息一致地显示原始字节。
    // 末组不足 4 字节时补 0 只为凑齐对象视图，真实字节另由 dataBytesOverride 给出。
    for (let i = 0; i < body.length; i += 4) {
      this.dataWords.push((body[i] | ((body[i + 1] ?? 0) << 8)
        | ((body[i + 2] ?? 0) << 16) | ((body[i + 3] ?? 0) << 24)) >>> 0);
    }
    this.dataBytesOverride = body;

    const ctx = { rev: this.headRev(), revText: this.headRevText(), sop: this.packetSop, link, sopName: this.packetSop };
    const bk = {
      bytes: payloadBytes, off: pick.off, dataSize, chunked, chunkNum, reqChunk,
      _carry: this.st.extCarry,
    };

    const em2 = this.em;
    const s = extendedParse(this.st, em2, t, bk, ctx);
    this.st.extCarry = bk._tail ?? null;
    if (s) em2.note(s);
    if (pick.off > 0 && !bk._tail) em2.detail('说明', `本包是分块数据的第 ${chunkNum + 1} 块（从整块偏移 ${pick.off} 字节处开始）`);

    return {
      extHead,
      objCount: Math.ceil((2 + payload + pad) / 4),
      crc: pick.crc, calc: pick.calc, crcOk: pick.ok,
    };
  }

  /** 按「(数据字节数, 补齐字节数, 整块偏移)」列出可尝试的几种读法，顺序即优先级 */
  _extCandidates({ chunked, chunkNum, reqChunk, dataSize }) {
    const out = [];
    if (reqChunk) return [{ payload: 0, pad: 0, off: 0 }];        // 请求分块：Data Size 必为 0
    if (chunked) {
      const cap = Math.max(this.headCount() * 4 - 2, 0);          // 分块消息的计数位有效，用它定本块长度
      const off = chunkNum * EXT_MSG_LIMITS.chunkLen;
      const payload = Math.min(Math.max(dataSize - off, 0), cap);
      return [{ payload, pad: Math.max(cap - payload, 0), off }];
    }
    const size = Math.min(dataSize, EXT_MSG_LIMITS.maxLen);
    out.push({ payload: size, pad: 0, off: 0 });                 // 规范读法：非分块不补齐
    const padded = Math.max(Math.ceil((2 + size) / 4) * 4 - 2, 0);
    if (padded > size) out.push({ payload: size, pad: padded - size, off: 0 });   // 兼容补齐 00h 的发送方
    if (size > 0) out.push({ payload: Math.max(size - 3, 0), pad: 0, off: 0 });   // 兼容少补的发送方
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
    const ok = crc === calc;
    if (!ok) { this.idx = saveIdx; this.warnings.length = saveWarn; }
    return { ...cand, bytes, crc, calc, ok };
  }

  /* ────────────────────────── 特殊短报文 ────────────────────────── */

  _specialPacket(raw, channel) {
    this.packetSeq++;
    const tms = raw.startSample / this.sampleRate * 1000;
    this.text = `#${this.packetSeq} (${tms.toFixed(4)}ms): ${this.specialPacket}`;
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
    });
  }

  /* ────────────────────────── 组装 packet ────────────────────────── */

  _finish(raw, channel, o) {
    const summary = this.summaryParts.filter(Boolean).join(' ; ');
    if (summary) this.text += ` - ${summary}`;

    let bytes;
    if (this.dataBytesOverride) {
      bytes = this.dataBytesOverride.slice();      // 扩展消息：线上真实字节（可能不是 4 的整数倍）
    } else {
      bytes = [];
      for (const w of this.dataWords) bytes.push(w & 0xFF, (w >>> 8) & 0xFF, (w >>> 16) & 0xFF, (w >>> 24) & 0xFF);
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
      dataHex: bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '),
      details: this.details,
      warnings: this.warnings.slice(),
      text: this.text,
    };
  }
}
