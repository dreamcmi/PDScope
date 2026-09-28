/**
 * format.js — UFCS 载荷的位域取值与文本格式化
 *
 * 与 PD 侧最大的不同：UFCS 的**多字节字段是高字节在前**（规范反复强调
 * 「发送的时候，先发送高字节」，见 8.2.2 / 8.2.4.1 / 8.2.4.2 …）。
 * 也就是载荷字节数组本身就是一份「大端位串」，payload[0] 是最高字节。
 *
 * 于是「取 bit msb…lsb」的定位是：
 *     字节下标 = n - 1 - (bit >> 3)      （n = 载荷字节数）
 *     位  下标 = bit & 7
 * 例如 8 字节的 Request：bit63…60 落在 payload[0] 的高 4 位，
 * bit15…0 落在 payload[6..7]。下面 ufcsBits() 就按这个做，逐位累加，
 * 只处理 ≤32 bit 的字段（本规范最大的单字段是 16 bit），不触碰 JS 的 32 位整数边界。
 *
 * 所有顶层名字都带 `ufcs` / `UFCS` 前缀 —— 单文件打包器会把整个库拍平进一个作用域，
 * 重名会互相覆盖（详见 tools/build-standalone.mjs 的跨模块重名检测）。
 */

/** 位域：[msb..lsb] → 无符号整数（载荷按大端位串解读） */
export function ufcsBits(bytes, msb, lsb) {
  const n = bytes.length;
  let v = 0;
  for (let b = lsb; b <= msb; b++) {
    const byteIdx = n - 1 - (b >> 3);
    if (byteIdx < 0 || byteIdx >= n) continue;
    if ((bytes[byteIdx] >> (b & 7)) & 1) v += 2 ** (b - lsb);
  }
  return v;
}

/** 单个比特 */
export const ufcsBit = (bytes, i) => ufcsBits(bytes, i, i);

/** 位域名：`B31-16` / `B8`（详情页字段标题） */
export const ufcsRange = (msb, lsb) => (msb === lsb ? `B${msb}` : `B${msb}-${lsb}`);

/** 整个载荷 → 十六进制串（按线上顺序，高字节在前） */
export function ufcsHex(bytes) {
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0').toUpperCase();
  return s;
}

/** 大端读 16 位（越界返回 0） */
export const ufcsU16BE = (bytes, off = 0) => ((bytes[off] ?? 0) << 8) | (bytes[off + 1] ?? 0);

/** 数字 → 文本（整数不带小数点，浮点最多 3 位） */
export function ufcsNum(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}

/** 布尔位 → `1 (…)/0 (…)` */
export const ufcsFlag = (on, t = '是', f = '否') => (on ? `1 (${t})` : `0 (${f})`);

/** 保留域：非 0 时提示（规范要求接收端忽略，但非 0 常意味着版本差异） */
export function ufcsReserved(bytes, msb, lsb) {
  const raw = ufcsBits(bytes, msb, lsb);
  return raw === 0 ? '0（未使用）' : `0x${raw.toString(16).toUpperCase()} ⚠ 规范要求此域为 0`;
}

/** 电压：单位 10 mV */
export const ufcsVolt = (v10mv) => `${ufcsNum(v10mv / 100)} V`;
/** 电流：单位 10 mA */
export const ufcsAmp = (v10ma) => `${ufcsNum(v10ma / 100)} A`;
/** 温度：值 - 50（0 表示无数据） */
export const ufcsTemp = (raw) => (raw === 0 ? '无数据（00h）' : `${raw - 50} °C`);
/** 十六进制定长 */
export const ufcsHexNum = (v, digits = 4) => '0x' + v.toString(16).toUpperCase().padStart(digits, '0');

/** 字节数组 → 可打印 ASCII（不可打印位用 `·`，遇 0 截断） */
export function ufcsAscii(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    s += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '·';
  }
  return s;
}

/** 字节数组 → 空格分隔的 hex（界面「数据」列用） */
export function ufcsHexSpaced(bytes) {
  const out = [];
  for (const b of bytes) out.push(b.toString(16).padStart(2, '0').toUpperCase());
  return out.join(' ');
}
