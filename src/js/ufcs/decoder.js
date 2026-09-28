/**
 * decoder.js — UFCS 报文解码器（`src/js/ufcs/` 独立库的主入口）
 *
 * 流水线：
 *   逻辑字节（消息头 2B + 消息主体 + CRC 1B）
 *     → 消息头四段位域（设备地址 / 消息编号 / 协议版本 / 消息类型）
 *     → 按类型取主体（控制 1B 命令 / 数据 命令+长度+数据 / 自定义 厂家码+长度+数据）
 *     → CRC-8 校验
 *     → 结合物理链路（D+/D-）还原「谁发给谁」
 *     → 逐字段语义解析（payload.js）
 *
 * 依据：T/CCSA 393—2024 / T/TAF 083—2024《移动终端融合快速充电技术要求》。
 *
 * ── 关于「方向」──────────────────────────────────────────────────
 * UFCS 的消息头里只有**接收方**的设备地址（表 13），没有发送方。但物理层是
 * D+/D- 全双工（规范 7.2）：**供电设备 D+ 是 TX、充电设备 D- 是 TX**。
 * 所以「跑在哪条线上」+「接收方是谁」就能唯一确定发送方：
 *
 *   T× \ 收  供电设备(SRC)   充电设备(SNK)   线缆(Plug)
 *   D+        线缆            供电设备        供电设备
 *   D-        充电设备        线缆            充电设备
 *
 * 分析仪导出若带了「链路字节」（见 core/powerz.js）就用它；没带时只能按接收方推断，
 * 并在详情里如实标注「按接收方推断」而不是假装确定。
 *
 * 本文件只依赖同目录模块，浏览器 / Node 双栈通用，且不引入任何 Node 专有 API。
 */

import {
  UFCS_DEV_ADDR, UFCS_ADDR_ROLE, UFCS_CTRL_CMD, UFCS_DATA_CMD, UFCS_MSG_TYPE,
  UFCS_LINE, UFCS_BITS_PER_BYTE, UFCS_BAUD,
  ufcsFixedSender, ufcsPeerOf, ufcsOpposite,
} from './tables.js';
import { ufcsCrc8 } from './crc.js';
import { ufcsHeaderInfo, ufcsFrameBodySize } from './frame.js';
import { ufcsRange, ufcsHex, ufcsHexSpaced } from './format.js';
import { ufcsDataPayload, ufcsCustomPayload, ufcsDumpBytes } from './payload.js';

/** 缺省波特率（规范 7.4.6：115200 为缺省支持档位）。容器不给速率时按它折算「线上时长」。 */
const UFCS_DEFAULT_BAUD = UFCS_BAUD[0];

/** 角色 → 中文名 */
const ufcsRoleText = (r) => (r === 'SRC' ? '供电设备' : r === 'SNK' ? '充电设备' : r === 'Plug' ? '线缆电子标签' : '未知');

/** 控制消息里「自动应答类」命令：它们本身不携带业务含义，配对显示才有价值 */
const UFCS_AUTO_ACK = new Set(['ACK', 'NCK']);

/**
 * 把「设备地址 + 命令 + 链路」还原成「发送方 / 接收方」。
 *
 * 三级判据，越靠前越硬：
 *   ① **规范单向定义**（tables.js#UFCS_FIXED_DIR）—— 例如 Output_Capabilities 只可能
 *      是供电设备发给充电设备，那么接收方地址必然是 010b，发送方唯一确定，链路也随之确定。
 *      此时若消息头里的接收方对不上，说明报文被解错或设备实现有偏差，如实报出来。
 *   ② **物理链路**（分析仪容器给出的链路字节）—— 供电设备 D+ 是 TX、充电设备 D- 是 TX，
 *      配合接收方地址即可唯一确定发送方（线缆也在内）。
 *   ③ **按接收方推断** —— 两条都没有时只能推断，标记 inferred，界面会写明「推断」。
 *
 * @param {number} addr 接收方设备地址（消息头 bit15…13）
 * @param {string|null} line 'D+' | 'D-' | null
 * @param {string|null} fixedSender 规范单向定义给出的发送方角色，或 null
 */
export function ufcsResolveDirection(addr, line, fixedSender = null) {
  const receiver = UFCS_ADDR_ROLE[addr] ?? null;

  if (fixedSender) {
    const expect = ufcsPeerOf(fixedSender);
    return {
      sender: fixedSender, receiver, inferred: false, ambiguous: false, source: 'spec',
      line: UFCS_LINE[fixedSender] ?? null,
      mismatch: expect != null && receiver !== expect,
      expect,
    };
  }

  if (line === 'D+' || line === 'D-') {
    let sender;
    if (line === 'D+') sender = addr === 0b001 ? 'Plug' : 'SRC';
    else sender = addr === 0b010 ? 'Plug' : 'SNK';
    return { sender, receiver, inferred: false, ambiguous: false, source: 'line', line, mismatch: false, expect: null };
  }

  // 没有单向定义、也没有链路信息：只能按接收方推断
  let sender;
  if (addr === 0b010) sender = 'SRC';        // 发给充电设备的，只能是供电设备
  else if (addr === 0b001) sender = 'SNK';   // 发给供电设备的，规范 7.8「缺省由充电设备发起线缆识别」→ 取充电设备
  else sender = 'SNK';
  return {
    sender, receiver, inferred: true,
    ambiguous: addr === 0b011 || addr === 0b001,
    source: 'addr', line: UFCS_LINE[sender] ?? null, mismatch: false, expect: null,
  };
}

/**
 * 给一批 UFCS 报文建立 ACK/NCK → 被确认报文的对应关系。
 *
 * 判据（规范 8.2.3.2 / 8.2.3.3）：**ACK/NCK 的消息编号与其响应的消息相同**，
 * 且是即时应答，必然紧跟在被确认报文的后面。所以按「向前找最近一条同编号、
 * 不同类型」的报文配对即可 —— 比 PD 那套「方向相反」的判据更稳（UFCS 的方向本就是推断出来的）。
 *
 * @param {Array<object>} packets 已按时间排序、已分配 index 的报文
 */
export function ufcsLinkAck(packets) {
  const WINDOW = 16;
  for (const p of packets) {
    if (!UFCS_AUTO_ACK.has(p.msgType) || p.crcOk === false) continue;
    for (let j = p.index - 1; j >= 0 && j > p.index - WINDOW; j--) {
      const q = packets[j];
      if (UFCS_AUTO_ACK.has(q.msgType)) continue;
      if (q.msgId !== p.msgId) continue;
      p.ackOf = q.index;
      p.ackType = q.msgType;
      // ACK/NCK 本身是双向命令，方向无法从报文断定 —— 但它必然是**被确认报文的反方向**。
      // 只在两处都成立时才回填：① 原本就是推断出来的；② 消息头里的接收方正是被确认报文的发送方
      // （ACK 的地址栏必须指向原发送方，规范 8.2.3.2）。任一条不成立就保持推断结果不动。
      const want = ufcsOpposite(q.role);
      if (p.roleInferred && !q.roleInferred && p.ufcs.receiver === q.role) {
        p.role = want;
        p.sop = UFCS_LINE[want] ?? 'D±';
        p.roleInferred = false;
        p.roleFromAck = true;
        p.ufcs.sender = want;
      }
      break;
    }
  }
}

export class UfcsDecoder {
  /**
   * @param {{sampleRate?:number}} [opts] sampleRate 只用于把毫秒时间戳映射成采样点坐标（默认 1000 = 1ms/点）
   */
  constructor({ sampleRate = 1000 } = {}) {
    this.sampleRate = sampleRate;
    this.reset();
  }

  reset() {
    this.packetSeq = 0;
  }

  /** 详情发射器（与 pd 库同形，界面共用一套渲染） */
  _emitter() {
    const self = this;
    return {
      object(title) { self.details.push({ key: 'Object', value: String(title) }); },
      detail(k, v) { self.details.push({ key: String(k), value: String(v) }); },
      note(t) { if (t != null && t !== '') self.summaryParts.push(String(t)); },
    };
  }

  /**
   * 解一条报文。
   *
   * @param {Uint8Array} body 消息头 + 消息主体（**不含 CRC**）
   * @param {object} [o]
   *   crc        读到的 CRC 字节；容器没存 CRC 时传 null（此时 crcOk = null，窗口显示「未记录」）
   *   crcCalc    已知的计算值；不传则这里自己算
   *   timeMs     报文时间戳（毫秒）
   *   line       物理链路：'D+' | 'D-' | null（未知）
   *   dirByte    容器里紧邻报文的那个字节（诊断用，可能是链路编码）
   *   prefixBytes 报文前容器前缀的字节数（0 = 没有前缀）
   *   channel    通道号（固定 0）
   *   baud       波特率；不给按 115200 折算线上时长
   * @returns {object|null}
   */
  decode(body, {
    crc = null, crcCalc = null, timeMs = 0, line = null, dirByte = null,
    prefixBytes = 0, channel = 0, baud = UFCS_DEFAULT_BAUD, withCrc = crc != null,
  } = {}) {
    if (!body || body.length < 3) return null;

    this.details = [];
    this.summaryParts = [];
    this.warnings = [];
    const em = this._emitter();

    const hdr = (body[0] << 8) | body[1];
    const h = ufcsHeaderInfo(hdr);

    if (!h.addrValid) this.warnings.push({ long: `设备地址 ${h.addr.toString(2).padStart(3, '0')}b 是保留值（规范只定义 001b/010b/011b）`, short: 'ADDR' });
    if (!h.mtypeValid) this.warnings.push({ long: `消息类型 ${h.mtype.toString(2).padStart(3, '0')}b 是保留值（规范只定义 000b/001b/010b）`, short: 'MTYPE' });
    if (!h.verKnown) this.warnings.push({ long: `协议版本编号 ${h.verCode.toString(2).padStart(6, '0')}b 不在规范已知取值内（000001b=1.0.0 / 010001b=1.0.1 / 001001b=1.2.0）`, short: 'VER' });

    const calc = crcCalc ?? ufcsCrc8(body);
    const crcOk = withCrc ? crc === calc : null;
    if (crcOk === false) {
      this.warnings.push({ long: `CRC-8 校验失败：读到的 0x${crc.toString(16).toUpperCase().padStart(2, '0')} ≠ 计算的 0x${calc.toString(16).toUpperCase().padStart(2, '0')}`, short: 'CRC' });
    }

    /* ── 消息头位域 ── */
    em.object('消息头（16 bit）');
    em.detail(`设备地址 [${ufcsRange(15, 13)}]`, `${h.addr.toString(2).padStart(3, '0')}b · ${UFCS_DEV_ADDR[h.addr] ?? '保留值（接收端应忽略本条）'}`);
    em.detail(`消息编号 [${ufcsRange(12, 9)}]`, `${h.msgNo}（接收方不判断其是否变化，回复须跟随）`);
    em.detail(`协议版本编号 [${ufcsRange(8, 3)}]`, `${h.verCode.toString(2).padStart(6, '0')}b · UFCS ${h.verText}${h.verKnown ? '' : '（保留值）'}`);
    em.detail(`消息类型 [${ufcsRange(2, 0)}]`, `${h.mtype.toString(2).padStart(3, '0')}b · ${UFCS_MSG_TYPE[h.mtype] ?? '保留值'}`);

    /* ── 方向 ── */
    // cmd 在主体解析阶段才拿到，这里先用消息头里的类型定位「已知命令编号」的情况：
    // 控制消息的命令在 body[2]，数据消息的命令在 body[2]，两种都在同一个位置。
    const probCmd = (h.mtype === 0 || h.mtype === 1) ? body[2] : null;
    const fixed = h.mtype <= 1 ? ufcsFixedSender(h.mtype, probCmd) : null;
    const dir = ufcsResolveDirection(h.addr, line, fixed);
    // 「链路」一栏展示的是**消息跑在哪条线上**：容器给了就用它，没给就按发送方折算
    // （供电设备发 → D+，充电设备发 → D-；线缆发送时两条线都可能，标 D±）。
    const lineLabel = dir.line ?? (UFCS_LINE[dir.sender] ?? 'D±');
    if (dir.mismatch) {
      this.warnings.push({
        long: `方向与规范不符：该命令按规范表定义为 ${ufcsRoleText(dir.sender)} → ${ufcsRoleText(ufcsPeerOf(dir.sender))}，`
          + `但消息头里的接收方是「${UFCS_DEV_ADDR[h.addr] ?? '保留值'}」`,
        short: 'DIR',
      });
    }

    /* ── 主体 ── */
    let cmd = null;
    let dataLen = 0;
    let data = body.subarray(0, 0);
    let msgType = '未知';
    let msgKind = 'control';

    if (h.mtype === 0) {
      msgKind = 'control';
      cmd = body[2];
      const info = UFCS_CTRL_CMD[cmd];
      msgType = info?.name ?? `CTRL?0x${cmd.toString(16).toUpperCase().padStart(2, '0')}`;
      em.object(`控制命令 0x${cmd.toString(16).toUpperCase().padStart(2, '0')}`);
      em.detail('控制命令', info ? `${info.name}（${info.req}）` : '规范表 14 未定义该命令编号');
      if (info) {
        em.detail('发送者 → 接收者（规范表 14）', info.dir);
        em.detail('规范要求', info.req);
        em.note(info.sum);
        if (body.length !== 3) this.warnings.push({ long: `控制消息主体应为 1 字节命令，实际 ${body.length - 2} 字节`, short: 'LEN' });
      } else {
        em.detail('原始主体', `0x${ufcsHex(body.subarray(2))}`);
        this.warnings.push({ long: `控制命令 0x${cmd.toString(16).toUpperCase()} 未在规范表 14 中定义`, short: 'CMD' });
      }
    } else if (h.mtype === 1) {
      msgKind = 'data';
      if (body.length < 4) return null;
      cmd = body[2];
      dataLen = body[3];
      data = body.subarray(4, 4 + dataLen);
      const info = UFCS_DATA_CMD[cmd];
      msgType = info?.name ?? `DATA?0x${cmd.toString(16).toUpperCase().padStart(2, '0')}`;
      em.object(`数据命令 0x${cmd.toString(16).toUpperCase().padStart(2, '0')}`);
      em.detail('命令', info ? `${info.name}（${info.req}）` : '规范表 15 未定义该命令编号');
      em.detail(`数据长度 [${ufcsRange(7, 0)}]`, `${dataLen} 字节`);
      if (info) {
        em.detail('发送者 → 接收者（规范表 15）', info.dir);
        const exp = info.len;
        if (typeof exp === 'number' && dataLen !== exp) {
          this.warnings.push({ long: `${info.name} 的数据长度应为 ${exp} 字节，实际 ${dataLen} 字节`, short: 'LEN' });
        } else if (typeof exp === 'object' && (dataLen % exp.unit !== 0 || dataLen / exp.unit < exp.min || dataLen / exp.unit > exp.max)) {
          this.warnings.push({ long: `${info.name} 的数据长度应为 ${exp.unit}×n 字节（1≤n≤${exp.max}），实际 ${dataLen} 字节`, short: 'LEN' });
        }
      } else {
        this.warnings.push({ long: `数据命令 0x${cmd.toString(16).toUpperCase()} 未在规范表 15 中定义`, short: 'CMD' });
      }
      if (data.length < dataLen) this.warnings.push({ long: `数据域被截断：声明 ${dataLen} 字节，实际只有 ${data.length} 字节`, short: 'TRUNC' });

      const s = ufcsDataPayload(em, cmd, data, this.warnings, { cmd, h, dataLen, name: msgType });
      if (!info) ufcsDumpBytes(em, data);
      if (!s) this.warnings.push({ long: `${msgType} 未能解出字段`, short: 'PARSE' });
    } else {
      msgKind = 'custom';
      if (body.length < 5) return null;
      const vid = (body[2] << 8) | body[3];
      dataLen = body[4];
      data = body.subarray(5, 5 + dataLen);
      msgType = 'Manufacturer_Custom';
      ufcsCustomPayload(em, vid, data);
      if (data.length < dataLen) this.warnings.push({ long: `数据域被截断：声明 ${dataLen} 字节，实际只有 ${data.length} 字节`, short: 'TRUNC' });
    }

    /* ── CRC ── */
    em.object('CRC 校验');
    em.detail('算法', 'CRC-8，多项式 X⁸+X⁵+X³+1（0x29），初值 0x00，覆盖消息头与消息主体');
    em.detail('计算值', `0x${calc.toString(16).toUpperCase().padStart(2, '0')}`);
    em.detail('报文值', withCrc ? `0x${crc.toString(16).toUpperCase().padStart(2, '0')}` : '未记录（分析仪容器未存 CRC）');
    em.detail('结论', crcOk === null ? '无法判定' : (crcOk ? '通过' : '失败'));
    if (crcOk === null) {
      em.note('CRC 由本工具按规范补算（容器未存），不据此宣布校验通过');
    }

    /* ── 容器诊断 ── */
    if (prefixBytes > 0 || dirByte != null) {
      em.object('容器信息（POWER-Z 导出）');
      em.detail('报文前缀', prefixBytes > 0 ? `${prefixBytes} 字节（应为时间戳 / 链路标记）` : '无');
      if (dirByte != null) em.detail('链路字节候选', `0x${dirByte.toString(16).toUpperCase().padStart(2, '0')}${dirByte <= 2 ? `（按 0=D+/1=D−/2=线缆 解读为 ${['D+', 'D-', 'D±'][dirByte]}）` : ''}`);
      em.detail('本帧长度', `${body.length} 字节（消息头+主体）+ ${withCrc ? 1 : 0} 字节 CRC`);
    }

    /* ── 方向补充说明 ── */
    em.object('链路与方向');
    const how = dir.source === 'spec' ? '规范表单向定义（该命令只有唯一发送方）'
      : dir.source === 'line' ? '分析仪容器给出的链路字节 + 接收方地址'
        : '按接收方地址推断';
    em.detail('方向判据', how);
    em.detail('物理链路', `${lineLabel}${dir.source === 'line' ? '（容器给出）' : '（由方向折算）'}`);
    em.detail('接收方', UFCS_DEV_ADDR[h.addr] ?? '保留值');
    em.detail('发送方', `${ufcsRoleText(dir.sender)}${dir.source === 'addr' ? '（推断）' : ''}`);
    if (dir.ambiguous) em.detail('⚠ 方向不确定', '此类命令供电设备与充电设备都会发送，单看报文无法区分，此处按规范 7.8「缺省由充电设备发起」处理');
    em.detail('线序依据', '规范 7.2：供电设备 D+ 为发送（TX）、充电设备 D- 为发送（TX）');

    /* ── 组装 ── */
    const seq = ++this.packetSeq;
    const totalBytes = body.length + (withCrc ? 1 : 0);
    const durUs = totalBytes * UFCS_BITS_PER_BYTE / baud * 1e6;
    const endMs = timeMs + durUs / 1000;

    const summary = this.summaryParts.filter(Boolean).join(' ; ');
    const text = `#${seq} (${timeMs.toFixed(4)}ms): (UFCS) ${dir.sender ?? '?'}[${h.addr}] ${msgType}`
      + (summary ? ` - ${summary}` : '');

    const frameBytes = [];
    for (const b of body) frameBytes.push(b);
    if (withCrc) frameBytes.push(crc);

    return {
      seq,
      channel,
      protocol: 'UFCS',
      source: 'powerz',
      ufcs: {
        addr: h.addr, addrText: UFCS_DEV_ADDR[h.addr] ?? '保留',
        msgNo: h.msgNo, verCode: h.verCode, mtype: h.mtype,
        cmd, dataLen, line: dir.line, sender: dir.sender, receiver: dir.receiver,
        dirInferred: dir.inferred, dirAmbiguous: dir.ambiguous,
        dirByte, prefixBytes, withCrc, baud,
      },

      sop: lineLabel,
      msgType,
      msgTypeRaw: cmd,
      msgKind,
      role: dir.sender ?? 'SNK',
      roleInferred: dir.inferred,
      roleAmbiguous: dir.ambiguous,
      link: dir.receiver === 'Plug' || dir.sender === 'Plug' ? 'cable' : 'port',

      header: hdr,
      extHeader: null,
      msgId: h.msgNo,
      rev: (h.verCode & 0b11),
      revText: h.verText,
      powerRole: dir.sender === 'SRC' ? 1 : 0,
      dataRole: null,

      nObjects: dataLen,
      dataLen,
      objects: null,

      crc: withCrc ? crc : null,
      crcCalc: calc,
      crcOk,
      eop: null,

      summary,
      details: this.details,
      warnings: this.warnings.slice(),
      text,

      startSample: timeMs,
      endSample: endMs,
      timeMs,
      endTimeMs: endMs,
      durationUs: durUs,
      bitrate: baud,
      bitrateNominal: true,        // 波特率取自规范缺省档位，不是从线路上量出来的
      synthetic: true,
      category: msgKind,
      dataWords: [],
      dataBytes: frameBytes,
      dataHex: ufcsHexSpaced(frameBytes),
      frameLen: totalBytes,
    };
  }

  /**
   * 便捷入口：从一段「完整帧字节（含 CRC）」解一条。
   * 容器已经切好帧时用它；不确定容器前缀时用 frame.js#ufcsLocateFrames 先定位。
   */
  decodeFrame(frameBytes, opts = {}) {
    const bodySize = ufcsFrameBodySize(frameBytes, 0);
    if (bodySize < 0) return null;
    const body = frameBytes.subarray(0, bodySize);
    const crc = frameBytes.length > bodySize ? frameBytes[bodySize] : null;
    return this.decode(body, { ...opts, crc, withCrc: crc != null });
  }
}
