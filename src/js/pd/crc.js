/**
 * crc.js — USB PD 报文尾部用的 CRC-32（与 zlib 同多项式 0xEDB88320，反射算法）
 *
 * 计算范围：Message Header（2 字节，小端）+ 全部 Data Object（各 4 字节，小端）。
 * 扩展消息则是 Message Header + Extended Message Header + 数据块（不足部分补 0）。
 *
 * 本文件是 `src/js/pd/` 独立 PD 解析库的一部分，零依赖。
 */

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/**
 * @param {ArrayLike<number>} bytes
 * @returns {number} 32bit 无符号
 */
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}
