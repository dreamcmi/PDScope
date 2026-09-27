/**
 * format.js — 位域取值与文本格式化的小工具（PD 库共用）
 *
 * 所有顶层名字都带 `pd` 前缀：单文件打包器会把整个库拍平进同一个作用域，
 * 重名会互相覆盖，前缀是这里的一道保险。
 */

/** 位域：[msb..lsb] → 无符号整数 */
export const pdField = (v, msb, lsb) => Math.floor((v >>> lsb) & ((1 << (msb - lsb + 1)) - 1));

/** 位域：单个比特 → 0/1 */
export const pdBit = (v, i) => (v >>> i) & 1;

/** 位域名：`B31-24` / `B5`（用于详情页字段标题） */
export const pdRange = (msb, lsb) => (msb === lsb ? `B${msb}` : `B${msb}-${lsb}`);

/** 位域二进制串：`0b010` */
export const pdBin = (v, msb, lsb) => {
  const n = msb - lsb + 1;
  return '0b' + pdField(v, msb, lsb).toString(2).padStart(n, '0');
};

/** 32/16 位十六进制（大写补零） */
export const pdHex = (v, digits = 8) => (v >>> 0).toString(16).toUpperCase().padStart(digits, '0');

/** 数字 → 字符串（整数不带小数点，浮点最多 3 位、去掉多余的 0） */
export function pdNum(v) {
  if (!Number.isFinite(v)) return String(v);
  if (Number.isInteger(v)) return String(v);
  return String(Math.round(v * 1000) / 1000);
}

/** 布尔位 → `1 (Supported)` / `0 (Not supported)` 风格的文本 */
export const pdFlag = (on, t = 'Yes', f = 'No') => (on ? `1 (${t})` : `0 (${f})`);

/** Reserved 字段：值非 0 时提示（规范要求接收端忽略，但非 0 往往意味着版本差异） */
export const pdReserved = (v, msb, lsb) => {
  const raw = pdField(v, msb, lsb);
  return raw === 0 ? `0（未使用）` : `0x${raw.toString(16).toUpperCase()} ⚠ 规范要求此域为 0`;
};

/** 查表，未命中给默认文案 */
export const pdLookup = (table, key, fallback = 'Reserved') => {
  const v = table[key];
  return v === undefined ? `${fallback} (${key})` : v;
};

/** 32bit → 4 字节（LSB 在前，与线上传输顺序一致） */
export const pdBytes4 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];

/** 字节数组 → 32bit（LSB 在前，最多 4 字节） */
export const pdBytesToU32 = (bytes) => {
  let v = 0;
  for (let i = 0; i < Math.min(bytes.length, 4); i++) v |= (bytes[i] & 0xFF) << (8 * i);
  return v >>> 0;
};

/** 字节数组 → 可打印 ASCII（不可打印位用 `·`，遇 0 截断） */
export function pdAscii(bytes) {
  let s = '';
  for (const b of bytes) {
    if (b === 0) break;
    s += (b >= 0x20 && b <= 0x7E) ? String.fromCharCode(b) : '·';
  }
  return s.trim();
}

/** 两个 8bit 字符（Alpha-2 国家码 / 通用 ASCII 对）→ 字符串 */
export const pdCharPair = (lo, hi) => {
  if (!lo && !hi) return '';
  const c = (v) => (v >= 0x20 && v <= 0x7E ? String.fromCharCode(v) : '·');
  return c(lo) + c(hi);
};

/** 百分比 / 电压 / 电流 的带单位文本 */
export const pdVolt = (v) => `${pdNum(v)} V`;
export const pdAmp = (v) => `${pdNum(v)} A`;
export const pdWatt = (v) => `${pdNum(v)} W`;
