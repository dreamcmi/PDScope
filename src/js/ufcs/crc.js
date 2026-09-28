/**
 * crc.js — UFCS 协议层 CRC-8
 *
 * 依据 T/CCSA 393—2024 / T/TAF 083—2024 附录 A（规范性）：
 *   多项式 X^8 + X^5 + X^3 + 1 → 0x29，初值 0x00，
 *   逐字节异或后左移 8 次（MSB 优先，不反射，结果不取反）。
 *
 * 覆盖范围：**消息头 + 消息主体**（不含 CRC 自身，也不含物理层的 Training / 起止位）。
 *
 * 参考代码（规范附录 A，C 版）逐行等价：
 *     rCRC ^= *pData++;
 *     for (i = 8; i > 0; --i)
 *         rCRC = (rCRC & 0x80) ? (rCRC << 1) ^ 0x29 : (rCRC << 1);
 */

/** CRC-8 多项式（X^8 + X^5 + X^3 + 1） */
export const UFCS_CRC8_POLY = 0x29;

/**
 * @param {ArrayLike<number>} bytes 消息头 + 消息主体
 * @param {number} [len] 只算前 len 字节（默认整段）
 * @returns {number} 0…255
 */
export function ufcsCrc8(bytes, len = bytes.length) {
  let c = 0;
  for (let i = 0; i < len; i++) {
    c ^= bytes[i] & 0xFF;
    for (let b = 0; b < 8; b++) {
      c = (c & 0x80) ? (((c << 1) ^ UFCS_CRC8_POLY) & 0xFF) : ((c << 1) & 0xFF);
    }
  }
  return c;
}
