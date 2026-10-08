/**
 * symbols.js — USB PD 物理层符号表（BMC 4B5B 编码、K-code、有序集）
 *
 * 本文件是 `src/js/pd/` 独立 PD 解析库的一部分：不 import 任何外部模块，
 * 浏览器 / Node 通用，可整目录复制到别的工程直接用。
 *
 * 位序约定：每字节内 bit0 时间最早（LSB 优先）。5 个比特拼一个符号，
 * 因此符号里的 bit0 也是最早收到的位。
 */

// ── K-code（控制符号）─────────────────────────────────────────────────
export const SYM_ERR = 0x10;
export const SYM_SYNC1 = 0x11;
export const SYM_SYNC2 = 0x12;
export const SYM_SYNC3 = 0x13;
export const SYM_RST1 = 0x14;
export const SYM_RST2 = 0x15;
export const SYM_EOP = 0x16;

/**
 * 5bit 原始码 → 4bit 数据 / K-code。
 * 下标 = 5 个采样位上读到的比特（bit0 最先收到），值 = 解码结果；
 * 0x10 = 非法编码（含 00000 / 11111 与未定义码），0x11…0x16 = K-code。
 */
export const DEC4B5B = [
  0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x13, 0x14,
  0x10, 0x01, 0x04, 0x05, 0x10, 0x16, 0x06, 0x07,
  0x10, 0x12, 0x08, 0x09, 0x02, 0x03, 0x0A, 0x0B,
  0x11, 0x15, 0x0C, 0x0D, 0x0E, 0x0F, 0x00, 0x10,
];

/** 符号名：[长名, 短名]，下标同 DEC4B5B 的取值域（0x00…0x16） */
export const SYM_NAME = [
  ['0x0', '0'], ['0x1', '1'], ['0x2', '2'], ['0x3', '3'],
  ['0x4', '4'], ['0x5', '5'], ['0x6', '6'], ['0x7', '7'],
  ['0x8', '8'], ['0x9', '9'], ['0xA', 'A'], ['0xB', 'B'],
  ['0xC', 'C'], ['0xD', 'D'], ['0xE', 'E'], ['0xF', 'F'],
  ['ERROR', 'X'], ['SYNC-1', 'S1'], ['SYNC-2', 'S2'], ['SYNC-3', 'S3'],
  ['RST-1', 'R1'], ['RST-2', 'R2'], ['EOP', '#'],
];

export const symName = (s) => (SYM_NAME[s] ? SYM_NAME[s][1] : '??');

/**
 * 有序集（Ordered Set）：4 个连续 K-code 组成的前导序列，标识这条报文属于哪条链路。
 *
 * `peer` 写的是「这条链路上另一端是谁」——方向判定要靠它：
 *   SOP  = 端口对端口（Port Partner）
 *   SOP' / SOP'' = DFP(VCONN Source) 与线缆 e-Marker（Cable Plug）之间
 */
export const SOP_ORDERED_SETS = [
  { sequence: [SYM_SYNC1, SYM_SYNC1, SYM_SYNC1, SYM_SYNC2], name: 'SOP', short: 'SOP', peer: 'Port Partner', link: 'port' },
  { sequence: [SYM_SYNC1, SYM_SYNC1, SYM_SYNC3, SYM_SYNC3], name: "SOP'", short: "SOP'", peer: 'Cable Plug (near end)', link: 'cable' },
  { sequence: [SYM_SYNC1, SYM_SYNC3, SYM_SYNC1, SYM_SYNC3], name: "SOP''", short: "SOP''", peer: 'Cable Plug (far end)', link: 'cable' },
  { sequence: [SYM_SYNC1, SYM_RST2, SYM_RST2, SYM_SYNC3], name: "SOP' Debug", short: "SOP'D", peer: 'Cable Plug (near end, debug)', link: 'cable' },
  { sequence: [SYM_SYNC1, SYM_RST2, SYM_SYNC3, SYM_SYNC2], name: "SOP'' Debug", short: "SOP''D", peer: 'Cable Plug (far end, debug)', link: 'cable' },
  { sequence: [SYM_RST1, SYM_SYNC1, SYM_RST1, SYM_SYNC3], name: 'Cable Reset', short: 'CRST', peer: 'Cable Plug', link: 'cable' },
  { sequence: [SYM_RST1, SYM_RST1, SYM_RST1, SYM_RST2], name: 'Hard Reset', short: 'HRST', peer: 'Port Partner', link: 'port' },
];

/** 兼容用：纯序列数组 */
export const SOP_SEQUENCES = SOP_ORDERED_SETS.map((s) => s.sequence);

/** 序列（join 后的字符串）→ 有序集对象 */
export const ORDERED_SET_BY_KEY = (() => {
  const m = {};
  for (const s of SOP_ORDERED_SETS) m[s.sequence.join()] = s;
  return m;
})();

/** 序列（join 后的字符串）→ 名称（与旧版保持同形） */
export const START_OF_PACKETS = (() => {
  const m = {};
  for (const s of SOP_ORDERED_SETS) m[s.sequence.join()] = s.name;
  return m;
})();

/** 名称 → 有序集对象 */
export const ORDERED_SET_BY_NAME = (() => {
  const m = {};
  for (const s of SOP_ORDERED_SETS) m[s.name] = s;
  return m;
})();

/** 只用 4 个符号里的「前 k 个」判定有序集（返回 {set, matched, total}） */
export function matchOrderedSet(symbols) {
  let best = null;
  for (const s of SOP_ORDERED_SETS) {
    let same = 0;
    for (let i = 0; i < symbols.length && i < s.sequence.length; i++) {
      if (symbols[i] === s.sequence[i]) same++;
    }
    if (!best || same > best.matched) best = { set: s, matched: same, total: s.sequence.length };
    else if (same === best.matched) best.set = null; // 3/4 匹配有歧义时不可任选一种 SOP
  }
  return best;
}
