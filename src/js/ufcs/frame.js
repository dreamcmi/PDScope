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
 * ── 线上还有一个 Training 字节 ────────────────────────────────────
 * 规范 7.4.6：发送方在每个数据包**之前**先发一个 Training 序列 **0xAA**，
 * 接收方靠它算出本次的波特率挡位。它属于物理层、不进 CRC 覆盖范围，
 * 因此**不属于协议意义上的帧**，但分析仪会把它一并计入长度（见 parseUfcsRecord）。
 *
 * ── 两种读法：withCrc ─────────────────────────────────────────────
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
 *
 * 下面两个长度上限（数据 59 / 自定义 58）不是拍的 —— 它们被规范两处条款**同时**卡住：
 *   • 图 25 / 图 40 的框上写死「数据（1~59 字节）」「数据（1~58 字节）」；
 *   • 8.2.1 又规定「消息主体（= 本函数返回值 − 消息头 2 字节）为 1~61 字节」。
 * 于是 数据消息 2+59 = 61、自定义消息 3+58 = 61，两边正好顶到 8.2.1 的上限。
 * 改这两个数字前先回去对表：动一个，另一处就对不上了。
 *
 * 自定义消息的字段次序（头 → 厂家识别码 → 数据长度 → 数据）按图 40 的**框坐标**定，
 * 不能信 PDF 的文本抽取顺序 —— 那玩意儿把图 25 的「命令」排到了「CRC」后面。
 *
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
  // 状态事件的时间戳偶尔也能凑成合法消息头，必须在穷举之前排除。
  if (ufcsParseEvent(blob)) return null;

  // ── 0. 先试分析仪容器布局（见下方 ufcsParseRecord）──
  // 认得出来就用它：它额外给出「物理链路」与容器长度域，是穷举拿不到的信息。
  // 认不出（空行 / 别的导出实现 / 残行）再往下穷举 —— 两条路都保留。
  const rec = ufcsParseRecord(blob);
  if (rec) {
    const allOk = rec.frames.every((f) => f.crcOk === true);
    return {
      prefixBytes: rec.prefixBytes,
      withCrc: true,
      tier: allOk ? 0 : 1,
      structScore: rec.frames.reduce((s, f) => s + f.structScore, 0),
      frames: rec.frames,
      prefix: blob.subarray(0, rec.prefixBytes),
      line: rec.line,
      counter: rec.counter,
      lenField: rec.lenField,
      training: rec.training,
      tsMs: rec.tsMs,
    };
  }

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

/* ══════════════ 分析仪（POWER-Z）的一行 Raw ══════════════

   上一条 UFCS 报文在容器里长什么样，是从 **26099 行真实抓包**（vivo X300 Ultra，
   `ufcs_table`）逐字节反推出来的，**零例外**：

     帧记录（9 + N 字节）
       ts(4B 小端, 毫秒)  x0(1B)  x1(1B)  len(1B)  flag(1B)  0xAA  │ UFCS 帧(N 字节，含 CRC)
       ├──────────────── 9 字节前缀 ────────────────┤            └─ 消息头 + 主体 + CRC

     状态事件（8 字节，不承载协议报文）
       ts(4B 小端, 毫秒)  code(1B)  00  00  0x40

   各字段的实测依据：
   • `ts`  —— 与 SQLite 的 `Time` 列 ×1000 **逐行完全相等**（26094/26094）。属冗余副本，
     时间基准仍以 `Time` 列为准（见 core/powerz.js），这里只作诊断。
   • `len` —— **= N + 1**，即「线上字节数」，把 0xAA 也算进去了（26094/26094 吻合）。
     规范 7.4.6 的 Training 序列确实走在线上，所以分析仪这样数是对的。
   • `flag` —— **物理链路**：0 = 线缆 D+（供电设备侧发送），1 = 线缆 D−（充电设备侧发送）。
     与规范表 14/15 的单向命令定义（`tables.js#UFCS_FIXED_DIR`）**100% 吻合**
     （13045/13045，含 4 条发给线缆的 Get_Cable_Info），所以它是「谁在发」的硬依据，
     不再是猜测。⚠ 它与「接收方地址」高度相关但不完全等价（线缆报文就是反例），
     别拿接收方地址去替代它。
   • `x0`/`x1` —— 该帧在**本方向字节流**里的起止游标（各 1 字节、回绕于 256）。
     按帧长链式接续，实测 13045 + 13049 次接续**零断裂**。纯诊断信息。
   • `0xAA` —— 规范 7.4.6 的 Training 序列。**它不是链路标记**：固定值，恒在帧前 1 字节。
     （早先的实现把它当成「链路字节候选」，于是永远读不出 D+/D−，方向只能靠推断也不自知。）

   上面这套是「实测归纳」而非规范规定的容器格式 —— 规范管不到分析仪怎么存盘。
   因此它对**结构不吻合的导出**必须能退让：先试下面这条「认得出就用」的快路径，
   认不出再落回上面的穷举定位。 */

/** UFCS 的 Training 序列（规范 7.4.6），也在分析仪容器里作为帧前导出现 */
export const UFCS_TRAINING = 0xAA;

/** 状态事件记录的尾标记（与 PD 侧 `45 … 00 code` 的 0x45 是同性质的容器约定） */
export const UFCS_EVENT_TAIL = 0x40;

/**
 * 一个状态事件记录的 opcode → 含义。
 *
 * ⚠ **只出现过 0x02 / 0x03 / 0x04 三种，且没有规范或文档可对照** —— 全部取证如下，
 * 不要凭印象往上加：整个样本 2494 s 里只有 5 条事件，
 *   开抓（t=5.107 s）：03 → 04
 *   收尾（t=2293.499 / 2293.755 / 2293.766 s，紧跟 Exit_UFCS_Mode 之后）：02 → 03 → 04
 * 由此**推断**（不是确证）：0x02 与「退出 / 断电」相关，0x03、0x04 是握手阶段的递进状态。
 * 因此下表只给「倾向性」的说明文字，界面上一律带上「容器约定、待确认」的口径。
 */
export const UFCS_EVENT_CODE = {
  0x02: '状态 02（疑似：退出 / 断电）',
  0x03: '状态 03（疑似：握手 / 起始）',
  0x04: '状态 04（疑似：握手完成）',
};

/**
 * 认一行 Raw 是不是 UFCS 的**状态事件记录**（8 字节，不承载协议报文）。
 *
 * 判据取「长度 + 尾标记」两个固定量，不看 opcode —— 未知 opcode 也要认出来
 * （如实报「未知 opcode」比当成坏行丢掉更有用）。
 *
 * @param {Uint8Array} blob
 * @returns {null | {tsMs:number, code:number}}
 */
export function ufcsParseEvent(blob) {
  if (blob.length !== 8 || blob[7] !== UFCS_EVENT_TAIL) return null;
  return {
    tsMs: (blob[0] | (blob[1] << 8) | (blob[2] << 16) | (blob[3] << 24)) >>> 0,
    code: blob[4],
  };
}

/**
 * 按**已知容器布局**解一行 Raw。这是快路径：布局认得出来就用它，认不出来返回 null，
 * 由调用方落回 `ufcsLocateFrames` 的穷举定位。
 *
 * 之所以值得有这条快路径（而不是全靠穷举）：
 *   ① 穷举只输出「切帧结果」，拿不到 `flag`（链路）—— 那是**方向判定的硬依据**，
 *      靠穷举根本恢复不了；早先的实现正是因此把 13048 条报文标成了「方向靠推断」。
 *   ② 有了容器自带的 `len`，可以拿它当**逐帧校验**：帧边界算错立刻能发现，
 *      而不必等 CRC 对不上才知道。
 *
 * @param {Uint8Array} blob
 * @returns {null | {frames:Array<object>, prefixBytes:number, withCrc:boolean,
 *                  line:('D+'|'D-'|null), counter:{x0:number,x1:number}|null,
 *                  lenField:number|null, training:boolean, tsMs:number}}
 */
export function ufcsParseRecord(blob) {
  if (!blob || blob.length < 4 + 4 + 1 + 4) return null;      // 最短的一帧也要 13 字节
  if (blob[8] !== UFCS_TRAINING) return null;

  const prefixBytes = 9;
  const frame = blob.subarray(prefixBytes);
  if (frame.length < 4) return null;

  const flag = blob[7];
  // flag 只在 0/1 上才是「链路」；别的取值说明这不是我们认得的布局，交给穷举。
  if (flag > 1) return null;

  const bodySize = ufcsFrameBodySize(frame, 0);
  if (bodySize < 0) return null;
  const total = bodySize + 1;                                 // 含 CRC
  if (total !== frame.length) return null;                    // 长度对不上 ⇒ 不是这个布局

  const lenField = blob[6];
  if (lenField !== frame.length + 1) return null;             // 容器声明的「线上字节数」校验

  const calc = ufcsCrc8(frame.subarray(0, bodySize));
  const crc = frame[bodySize];
  const hdr = (frame[0] << 8) | frame[1];
  const h = ufcsHeaderInfo(hdr);
  if (!h.addrValid || !h.mtypeValid) return null;

  return {
    frames: [{
      off: prefixBytes,
      total: frame.length,
      bodyEnd: prefixBytes + bodySize,
      hdr,
      calc,
      crc,
      crcOk: crc === calc,
      structScore: ufcsFrameScore(frame, 0, true),
    }],
    prefixBytes,
    withCrc: true,
    line: flag === 0 ? 'D+' : 'D-',
    counter: { x0: blob[4], x1: blob[5] },
    lenField,
    training: true,
    tsMs: (blob[0] | (blob[1] << 8) | (blob[2] << 16) | (blob[3] << 24)) >>> 0,
  };
}

