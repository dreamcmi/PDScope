/**
 * index.js — `src/js/pd/` 独立 USB PD 解析库的聚合入口
 *
 * 用法（浏览器 / Node 通用）：
 *   import { PdDecoder } from './js/pd/index.js';
 *   const pd = new PdDecoder({ sampleRate: 2_500_000 });
 *   const pkt = pd.decode(bmcRawPacket, channel);
 *
 * 设计约定：
 *   • 只依赖本目录内的模块，零外部依赖，禁止引入 Node 专有 API；
 *   • 为便于「单文件打包」（把 ES Module 拍平进一个 IIFE 作用域），
 *     所有本库的工具函数统一带 `pd` 前缀，避免与宿主工程顶层重名互相覆盖。
 *
 * 目录结构：
 *   symbols.js   4B5B / K-code / SOP 有序集
 *   crc.js       CRC-32
 *   format.js    位域取值与格式化（pd* 前缀）
 *   tables.js    协议常量表（消息类型、VDO 字段取值、EPR…）
 *   svid.js      Standard/Vendor SVID 名称
 *   pdo.js       PDO / RDO
 *   data.js      BIST / Battery_Status / Alert / Enter_USB / Source_Info / Revision / EPR_Mode / Country_Code
 *   vdm.js       VDM（含 Discover Identity 的线缆/端口 VDO —— plug 信令）
 *   extended.js  扩展消息数据块
 *   decoder.js   主解码器 PdDecoder
 */

export { PdDecoder } from './decoder.js';
export { crc32 } from './crc.js';

/* 符号层 */
export {
  DEC4B5B, SYM_NAME, SYM_ERR, SYM_EOP, SOP_ORDERED_SETS, SOP_SEQUENCES,
  START_OF_PACKETS, ORDERED_SET_BY_NAME, ORDERED_SET_BY_KEY, matchOrderedSet, symName,
} from './symbols.js';

/* 常量表 */
export * from './tables.js';

/* 位域工具（pd* 前缀） */
export * from './format.js';

/* SVID */
export * from './svid.js';

/* 解析器（可单独复用） */
export { pdoParse, rdoParse, lookupPdo } from './pdo.js';
export { vdmParse, vdmCommandName } from './vdm.js';
export { extendedParse } from './extended.js';
export {
  bistParse, batteryStatusParse, alertParse, enterUsbParse,
  sourceInfoParse, revisionParse, eprModeParse, countryCodeParse, manufacturerString,
} from './data.js';
