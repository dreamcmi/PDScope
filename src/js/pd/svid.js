/**
 * svid.js — Standard/Vendor ID 名称表
 *
 * SVID 出现在两处：
 *   • VDM Header 的 B31-16 —— 结构化 VDM 的 Standard ID，或非结构化 VDM 的厂商 ID
 *   • Discover Identity 的 ID Header VDO / Product VDO —— 厂商 ID（VID）
 *
 * 规范只定义了 0xFF00（PD SID）与 0xFF01（DPTC SID）两个标准 ID；
 * 0xFF02…0xFFFE 由 USB-IF 保留，0x0000 是列表结束符。
 * 厂商 ID 由 USB-IF 分配，本质上是「厂商自己的编号」，所以下面这张厂商表只是
 * 常见的便利对照，**不完整也不权威** —— 查不到就老实显示原始 ID。
 */

/** 标准 ID（PD 3.2 Table 6.33 明确列出的两个） */
export const STANDARD_SVID = {
  0x0000: 'None / 列表结束符',
  0xFF00: 'USB-IF PD SID（Power Delivery 规范自身）',
  0xFF01: 'DPTC SID（DisplayPort Alt Mode）',
};

/** 常见厂商 ID（USB-IF VID 分配，非穷举） */
export const VENDOR_VID = {
  0x03F0: 'HP, Inc.',
  0x0451: 'Texas Instruments',
  0x046D: 'Logitech, Inc.',
  0x0483: 'STMicroelectronics',
  0x04B4: 'Cypress Semiconductor (Infineon)',
  0x04D8: 'Microchip Technology',
  0x04E8: 'Samsung Electronics',
  0x05AC: 'Apple, Inc.',
  0x05E3: 'Genesys Logic, Inc.',
  0x0B05: 'ASUSTek Computer Inc.',
  0x0B95: 'ASIX Electronics Corp.',
  0x0BB4: 'HTC Corporation',
  0x0BDA: 'Realtek Semiconductor Corp.',
  0x0955: 'NVIDIA Corp.',
  0x12D1: 'Huawei Technologies',
  0x174C: 'ASMedia Technology Inc.',
  0x17EF: 'Lenovo',
  0x18D1: 'Google Inc.',
  0x1A86: 'QinHeng Electronics (WCH)',
  0x1D6B: 'Linux Foundation',
  0x2109: 'VIA Labs, Inc.',
  0x2717: 'Xiaomi Inc.',
  0x2E8A: 'Raspberry Pi (Trading) Ltd.',
  0x413C: 'Dell Inc.',
  0x8087: 'Intel Corporation',
};

/** SVID → 名称（未知名返回 null） */
export function svidName(svid) {
  const v = svid & 0xFFFF;
  if (STANDARD_SVID[v] !== undefined) return STANDARD_SVID[v];
  if (VENDOR_VID[v] !== undefined) return `${VENDOR_VID[v]}（厂商 ID）`;
  return null;
}

/** SVID → 简短标签（附带十六进制原值，界面上一眼双向对照） */
export function svidText(svid) {
  const v = svid & 0xFFFF;
  const name = svidName(v);
  const hex = `0x${v.toString(16).toUpperCase().padStart(4, '0')}`;
  return name ? `${hex} · ${name}` : `${hex} · 未登记的 SVID`;
}

/** 该 SVID 是否为本规范定义的标准 ID */
export const isStandardSvid = (svid) => (svid & 0xFFFF) === 0xFF00 || (svid & 0xFFFF) === 0xFF01;

/** 0xFF00 的重命名常量（PD 规范自身） */
export const SVID_PD = 0xFF00;
export const SVID_DPTC = 0xFF01;
