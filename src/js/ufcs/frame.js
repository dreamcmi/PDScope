/**
 * frame.js — UFCS 数据包的「切帧」：从一段逻辑字节里认出报文边界
 *
 * 规范第 7 章物理层 / 第 8 章协议层给了三种包结构，**都是由高字节到低字节依次发送**
 * （即下列字节顺序就是线上顺序）：
 *
 *   控制消息（图 13）  消息头(2B) │ 控制命令(1B) │ CRC(1B)
 *   数据消息（图 14/25） 消息头(2B) │ 命令(1B) │ 数据长度(1B) │ 数据(N B) │ CRC(1B)
 *   自定义消息（图 15/40）消息头(2B) │ 厂家识别码(2B) │ 数据长度(1B) │ 数据(N B) │ CRC(1B)
 *
 * 消息头（2 字节，表 13）：
 *   bit15…13 设备地址（001b 供电 / 010b 充电 / 011b 线缆 / 其它保留）
 *   bit12…9  消息编号
 *   bit8…3   协议版本编号
 *   bit2…0   消息类型（000b 控制 / 001b 数据 / 010b 自定义）
 *
 * 「数据长度」只数**数据区**，不含命令/长度/厂家识别码本身，也不含 CRC。
 * 控制消息没有长度字段（恒为 1 字节命令）。
 *
 * ── 为什么需要 withCrc 两种读法 ────────────────────────────────────
 * POWER-Z 这类分析仪导出时，有的实现把 CRC 一起存下来，有的只存到消息主体为止
 * （PD 那条路径就是后者，见 core/powerz.js）。两种情况下「整帧字节数」差 1，
 * 靠「哪一种读法刚好把 blob 消费完 / CRC 是否吻合」就能判定，不必猜。
 */

import { UFCS_CTRL_CMD, UFCS_DATA_CMD, UFCS_VERSION, ufcsVersionText } from './tables.js';
import { ufcsCrc8 } from './crc.js';

/** 解析 16 bit 消息头 */
export function ufcsHeaderInfo(hdr) {
  const addr = (hdr >> 13) & 0b111;
  const msgNo = (hdr >> 9) & 0b1111;
  const verCode = (hdr >> 3) & 0b111111;
  const mtype = hdr & 0b111;
  return {
    hdr: hdr & 0xFFFF,
    addr, msgNo, verCode, mtype,
    verText: UFCS_VERSION[verCode] ?? ufcsVersionText(verCode),
    verKnown: UFCS_VERSION[verCode] !== undefined,
    mtypeText: ['控制消息', '数据消息', '自定义消息'][mtype] ?? null,
    addrValid: addr >= 1 && addr <= 3,
    mtypeValid: mtype <= 2,
  };
}

/**
 * 一个包从消息头开始、到 CRC（不含）为止的字节数。
 * @returns {number} bodyEnd 相对 off 的偏移；-1 = 结构不成立（截断 / 长度域越界）
 */
export function ufcsFrameBodySize(bytes, off) {
  const n = bytes.length;
  if (off + 2 > n) return -1;
  const mtype = bytes[off + 1] & 0b111;
  if (mtype === 0) return 3;                                  // 头 2 + 命令 1
  if (mtype === 1) {
    if (off + 4 > n) return -1;
    const len = bytes[off + 3];
    if (len < 1 || len > 59) return -1;                       // 规范：数据 1…59 字节
    return 4 + len;                                           // 头 2 + 命令 1 + 长度 1 + 数据
  }
  if (mtype === 2) {
    if (off + 5 > n) return -1;
    const len = bytes[off + 4];
    if (len < 1 || len > 58) return -1;                       // 规范：数据 1…58 字节
    return 5 + len;                                           // 头 2 + 厂家识别码 2 + 长度 1 + 数据
  }
  return -1;                                                  // bit2…0 = 011b 及以上保留
}

/**
 * 「这一段结构上像不像一条报文」的**结构分**（只看消息头字段与命令编号是否合法，
 * **不看 CRC**）。CRC 的结论单独用 `crcOk` 表达、在定位时按等级处理 —— 不能把
 * 「CRC 对不上」压成负分，否则一条真·坏包会输给某个恰好能凑整的误读。
 *
 * @returns {number} <0 = 结构不成立；越大越可信
 */
export function ufcsFrameScore(bytes, off, withCrc) {
  const bodySize = ufcsFrameBodySize(bytes, off);
  if (bodySize < 0) return -1;
  const total = bodySize + (withCrc ? 1 : 0);
  if (off + total > bytes.length) return -1;

  const h = ufcsHeaderInfo((bytes[off] << 8) | bytes[off + 1]);
  if (!h.addrValid || !h.mtypeValid) return -1;

  let score = 1;
  if (h.verKnown) score += 1;                                 // 版本编号命中已知值
  if (h.mtype === 0) {
    if (UFCS_CTRL_CMD[bytes[off + 2]]) score += 2;
  } else if (h.mtype === 1) {
    if (UFCS_DATA_CMD[bytes[off + 2]]) score += 2;
  } else {
    score += 1;                                               // 自定义消息的厂家域不校验
  }
  return score;
}

/**
 * 从 off 起连续切帧，必须**正好消费到字节末尾**，否则视为「这套读法不成立」。
 *
 * @param {Uint8Array} bytes
 * @param {number} off
 * @param {boolean} withCrc
 * @param {number} [maxFrames]
 * @returns {null | Array<{off:number,total:number,bodyEnd:number,hdr:number,crc:number|null,
 *                         calc:number,crcOk:boolean|null,structScore:number}>}
 */
export function ufcsSplitFrames(bytes, off, withCrc, maxFrames = 64) {
  const out = [];
  let i = off;
  while (i < bytes.length) {
    if (out.length >= maxFrames) return null;
    const bodySize = ufcsFrameBodySize(bytes, i);
    if (bodySize < 0) return null;
    const bodyEnd = i + bodySize;
    const total = bodySize + (withCrc ? 1 : 0);
    if (i + total > bytes.length) return null;

    const hdr = (bytes[i] << 8) | bytes[i + 1];
    const h = ufcsHeaderInfo(hdr);
    if (!h.addrValid || !h.mtypeValid) return null;

    const calc = ufcsCrc8(bytes.subarray(i, bodyEnd));
    const crc = withCrc ? bytes[bodyEnd] : null;
    out.push({
      off: i, total, bodyEnd, hdr, calc,
      crc,
      crcOk: withCrc ? crc === calc : null,
      structScore: ufcsFrameScore(bytes, i, withCrc),
    });
    i = bodyEnd + (withCrc ? 1 : 0);
  }
  return i === bytes.length ? out : null;
}

/**
 * 在「前面可能带容器前缀（时间戳 / 链路字节 / Training 0xAA）」的一段 blob 里
 * 定位 UFCS 报文起点，并逐帧切分。
 *
 * 做法是**穷举起始偏移 × 两种 CRC 读法**（前缀最长 16 字节），按三级择优：
 *
 *   A 级  带 CRC 且**每一帧的 CRC-8 都对得上**   —— 最可信，正常抓包的绝大多数行是这个
 *   B 级  带 CRC 但**有帧对不上**               —— 真·坏包仍要解出来（不能当成「没存 CRC」）
 *   C 级  不带 CRC（分析仪只存到消息主体为止）   —— CRC 由本工具补算，`crcOk` 记 null
 *
 * 同级内比结构分（消息头字段 + 命令编号是否合法），再比前缀长短（越短越可能是真的容器头）。
 * 这样无论容器前缀是 0 / 4 字节时间戳 / 时间戳+链路字节，都落回同一条解析路径。
 *
 * @param {Uint8Array} blob
 * @param {{maxPrefix?:number}} [opts]
 * @returns {null | {prefixBytes:number, withCrc:boolean, tier:number, structScore:number,
 *                  frames:Array, prefix:Uint8Array}}
 */
export function ufcsLocateFrames(blob, { maxPrefix = 16 } = {}) {
  const n = blob.length;
  if (n < 3) return null;                 // 最小的一帧是「控制消息 + 无 CRC」= 3 字节
  let best = null;

  const better = (a, b) => {
    if (!b) return true;
    if (a.tier !== b.tier) return a.tier < b.tier;
    if (a.structScore !== b.structScore) return a.structScore > b.structScore;
    return a.prefixBytes < b.prefixBytes;
  };

  // 前缀最多占到「只剩 3 字节」为止 —— 那是「控制消息 + 无 CRC」这一最小可行帧的长度。
  // （早先写成 n-4 会把「4 字节前缀 + 无 CRC 控制帧」这种组合整个漏掉。）
  const limit = Math.min(maxPrefix, n - 3);
  for (let p = 0; p <= limit; p++) {
    for (const withCrc of [true, false]) {
      const frames = ufcsSplitFrames(blob, p, withCrc);
      if (!frames || !frames.length) continue;
      const allOk = withCrc && frames.every((f) => f.crcOk === true);
      const cand = {
        prefixBytes: p,
        withCrc,
        tier: allOk ? 0 : (withCrc ? 1 : 2),
        structScore: frames.reduce((s, f) => s + f.structScore, 0),
        frames,
        prefix: blob.subarray(0, p),
      };
      if (better(cand, best)) best = cand;
    }
  }
  return best;
}

