/**
 * extended.js — 扩展消息数据块解析（PD 3.2 Chapter 6.5）
 *
 * 全部按「数据块内的绝对字节号」寻址，与规范表格一一对应（Byte0、Byte1…）。
 * 分块（Chunked）场景下由调用方给出本包覆盖的字节区间 `off`，
 * 字节不在本包内就如实标注，不猜。
 *
 * 覆盖：SCEDB / SDB(SOP 与 SOP' 两种格式) / GBCDB / GBSDB / BCDB /
 *       Manufacturer_Info / Security_* / Firmware_Update_* / PPSSDB /
 *       CIDB / CCDB / SKEDB / ECDB / EPR_*_Capabilities / Vendor_Defined_Extended
 */

import {
  LOAD_STEP, TOUCH_TEMP_SOURCE, TOUCH_TEMP_SINK, TEMP_STATUS, POWER_STATE, STATE_INDICATOR,
  STATUS_EVENT_BITS, POWER_STATUS_BITS, BATTERY_REF_TEXT, EXT_CONTROL_MSG_TYPES,
  VCONN_POWER, USB_HIGHEST_SPEED,
} from './tables.js';
import { svidText } from './svid.js';
import { pdField, pdBit, pdHex, pdNum, pdFlag, pdRange, pdAscii, pdCharPair } from './format.js';
import { pdoParse } from './pdo.js';

/* ── 字节读取（越界返回 null，交由调用方标注“本分块不含该字段”）── */
const b8 = (bk, i) => (i >= bk.off && i < bk.off + bk.bytes.length ? bk.bytes[i - bk.off] : null);
const b16 = (bk, i) => { const a = b8(bk, i), b = b8(bk, i + 1); return a === null || b === null ? null : a | (b << 8); };
const b32 = (bk, i) => { const v = b16(bk, i), w = b16(bk, i + 2); return v === null || w === null ? null : (v | (w << 16)) >>> 0; };

/** 把一段字节读成「可用」文本；不在本包内则给提示 */
const need = (v, text) => (v === null ? '（本分块不含该字段）' : text(v));

/** 按 4 字节对象分组，让详情页的分组标题与数据对象对齐 */
function groupOf(bk, byteIdx) {
  return Math.floor(byteIdx / 4);
}
/** 发一个新分组（同一 4 字节对象只发一次） */
function mkGroup(em, bk, byteIdx) {
  const g = groupOf(bk, byteIdx);
  if (bk._group !== g) {
    bk._group = g;
    em.object(`数据对象 #${g + 1} · Byte ${g * 4}~${g * 4 + 3}`);
  }
}
/** 在某个字节位置写一条字段（自动归到对应的 4 字节对象分组） */
function f(em, bk, byteIdx, key, value) {
  mkGroup(em, bk, byteIdx);
  em.detail(key, value);
}

/* ══════════════════ 入口 ══════════════════ */

/**
 * @param {object} st  解码器状态
 * @param {object} em  详情发射器
 * @param {number} t   扩展消息类型
 * @param {object} bk  { bytes, off, dataSize, chunked, chunkNum, reqChunk }
 * @param {object} ctx { revText, link, sopName }
 * @returns {string} 概览片段
 */
export function extendedParse(st, em, t, bk, ctx) {
  bk._group = -1;
  switch (t) {
    case 1: return scedb(st, em, bk);
    case 2: return statusBlock(em, bk, ctx);
    case 3: return batteryRef(em, bk, 'Get Battery Cap', 'Battery Cap Ref');
    case 4: return batteryRef(em, bk, 'Get Battery Status', 'Battery Status Ref');
    case 5: return bcdb(em, bk);
    case 6: return getManufacturerInfo(em, bk);
    case 7: return manufacturerInfo(em, bk);
    case 8: case 9: return security(em, bk, t === 8 ? 'Security_Request' : 'Security_Response');
    case 10: case 11: return firmware(em, bk, t === 10 ? 'Firmware_Update_Request' : 'Firmware_Update_Response');
    case 12: return ppsStatus(em, bk);
    case 13: return countryInfo(em, bk);
    case 14: return countryCodes(em, bk);
    case 15: return skedb(st, em, bk);
    case 16: return extControl(em, bk);
    case 17: case 18: return eprCaps(st, em, bk, t === 17 ? 'source' : 'sink');
    case 30: return vendorDefinedExtended(em, bk);
    default:
      hexDump(em, bk);
      return `未定义的扩展消息类型 ${t}`;
  }
}

/* ══════════════════ ① Source_Capabilities_Extended（SCEDB）══════════════════ */

function scedb(st, em, bk) {
  const vid = b16(bk, 0), pid = b16(bk, 2), xid = b32(bk, 4);
  f(em, bk, 0, `Vendor ID [Byte1-0]`, need(vid, (v) => `0x${pdHex(v, 4)}`));
  f(em, bk, 2, `Product ID [Byte3-2]`, need(pid, (v) => `0x${pdHex(v, 4)}`));
  f(em, bk, 4, `XID [Byte7-4]`, need(xid, (v) => `0x${pdHex(v)}（应与 Cert Stat VDO 一致）`));
  f(em, bk, 8, `FW Version [Byte8]`, need(b8(bk, 8), (v) => String(v)));
  f(em, bk, 9, `HW Version [Byte9]`, need(b8(bk, 9), (v) => String(v)));

  const vreg = b8(bk, 10);
  f(em, bk, 10, `Voltage Regulation [Byte10]`, need(vreg, (v) =>
    `Load Step ${LOAD_STEP[v & 3]} · IoC ${(v >> 2) & 1 ? '90%' : '25% (default)'}`));
  f(em, bk, 11, `Holdup Time [Byte11]`, need(b8(bk, 11), (v) => (v === 0 ? '不支持该特性 (0)' : `${v} ms（断 AC 后维持稳压的时间）`)));

  const comp = b8(bk, 12);
  f(em, bk, 12, `Compliance [Byte12]`, need(comp, (v) =>
    [v & 1 ? 'LPS' : null, (v >> 1) & 1 ? 'PS1' : null, (v >> 2) & 1 ? 'PS2' : null].filter(Boolean).join(' + ') || '无'));
  const touch = b8(bk, 13);
  f(em, bk, 13, `Touch Current [Byte13]`, need(touch, (v) =>
    [v & 1 ? '低接触电流 EPS' : null, (v >> 1) & 1 ? '有接地脚' : null, (v >> 2) & 1 ? '接地脚接保护地 (PE)' : null].filter(Boolean).join(' + ') || '无'));

  const pc1 = b16(bk, 14), pc2 = b16(bk, 16), pc3 = b16(bk, 18);
  peak(em, bk, 14, 'Peak Current 1', pc1);
  peak(em, bk, 16, 'Peak Current 2', pc2);
  peak(em, bk, 18, 'Peak Current 3', pc3);

  f(em, bk, 20, `Touch Temp [Byte20]`, need(b8(bk, 20), (v) => TOUCH_TEMP_SOURCE[v] ?? '取值无效，按默认处理'));
  const si = b8(bk, 21);
  f(em, bk, 21, `Source Inputs [Byte21]`, need(si, (v) => [
    (v & 1) ? `外部电源在位${(v >> 1) & 1 ? '（不受限）' : '（受限）'}` : '无外部电源',
    (v & 4) ? '有内部电池' : null,
  ].filter(Boolean).join(' · ')));
  const nb = b8(bk, 22);
  f(em, bk, 22, `Number of Batteries/Slots [Byte22]`, need(nb, (v) =>
    `固定电池 ${v & 0xF} 个 · 热插拔电池槽 ${(v >> 4) & 0xF} 个`));
  f(em, bk, 23, `SPR Source PDP Rating [Byte23]`, need(b8(bk, 23), (v) => (v > 100 ? `${v}（>100 视为无效）` : `${v} W`)));
  f(em, bk, 24, `EPR Source PDP Rating [Byte24]`, need(b8(bk, 24), (v) => (v > 240 ? `${v}（>240 视为无效）` : `${v} W`)));

  const parts = [];
  if (vid !== null) parts.push(`VID 0x${pdHex(vid, 4)}`);
  if (b8(bk, 23) !== null) parts.push(`SPR PDP ${b8(bk, 23)}W`);
  if (b8(bk, 24)) parts.push(`EPR PDP ${b8(bk, 24)}W`);
  return parts.join(' · ');
}

function peak(em, bk, byteIdx, name, v) {
  if (v === null) { f(em, bk, byteIdx, `${name} [Byte${byteIdx + 1}-${byteIdx}]`, '（本分块不含该字段）'); return; }
  const overload = Math.min(v & 0x1F, 25) * 10;
  const period = ((v >> 5) & 0x3F) * 20;
  const duty = ((v >> 11) & 0xF) * 5;
  const droop = (v >> 15) & 1;
  f(em, bk, byteIdx, `${name} [Byte${byteIdx + 1}-${byteIdx}]`,
    overload === 0
      ? '未提供峰值能力（全 0）'
      : `过载 ${overload}% · 周期 ${period} ms · 占空比 ${duty}% · 允许 VBUS 跌落 ${droop ? '是（额外 5%）' : '否'}`);
}

/* ══════════════════ ② Status（SDB / SOP' 状态）══════════════════ */

function statusBlock(em, bk, ctx) {
  // 内容由「发给谁」决定：发给 SOP' / SOP'' 时是线缆插头状态（PD 3.2 Table 6.52，仅 2 字节），
  // 发给 SOP 时才是端口伙伴状态（Table 6.51，7 字节）。用链路判定，长度只作兜底。
  if (ctx.link === 'cable' || bk.dataSize <= 2) {
    f(em, bk, 0, 'Internal Temp [Byte0]', need(b8(bk, 0), tempText));
    f(em, bk, 1, 'Flags [Byte1]', need(b8(bk, 1), (v) => {
      if (!(v & 1)) return '正常（未进入热关断）';
      const extra = v & 0xFE ? `（高位 0x${(v & 0xFE).toString(16).toUpperCase()} 为保留位）` : '';
      return `已进入热关断 Thermal Shutdown${extra} —— 置位后保持，只有 Hard Reset 或线缆断电才清除（Cable Reset 无效）`;
    }));
    const tc = b8(bk, 0), fl = b8(bk, 1);
    return [tc === null ? null : `线缆插头温度 ${tempText(tc)}`,
      fl === null ? null : `热关断标记 ${(fl & 1) ? '已置位' : '未置位'}`].filter(Boolean).join(' · ');
  }

  f(em, bk, 0, 'Internal Temp [Byte0]', need(b8(bk, 0), tempText));
  const pi = b8(bk, 1);
  f(em, bk, 1, 'Present Input [Byte1]', need(pi, (v) => {
    const src = ['内部供电', '外部直流 (DC)', '取值无效', '外部交流 (AC)'][(v >> 1) & 3];
    const list = [src, (v & 8) ? '由电池供电' : null, (v & 16) ? '由非电池内部电源供电' : null].filter(Boolean);
    return list.join(' · ');
  }));
  const bi = b8(bk, 2);
  f(em, bk, 2, 'Present Battery Input [Byte2]', need(bi, (v) => {
    if (!(b8(bk, 1) & 8)) return `0x${v.toString(16).toUpperCase().padStart(2, '0')}（Present Input 未置电池供电，此域 Reserved）`;
    const on = [];
    for (let i = 0; i < 8; i++) if (v & (1 << i)) on.push(BATTERY_REF_TEXT(i));
    return on.length ? on.join(' · ') : '无电池供电';
  }));
  const ev = b8(bk, 3);
  f(em, bk, 3, 'Event Flag [Byte3]', need(ev, (v) => {
    const on = STATUS_EVENT_BITS.filter((b) => v & (1 << b.bit)).map((b) => b.name);
    return on.length ? on.join(' · ') : '无事件';
  }));
  const ts = b8(bk, 4);
  f(em, bk, 4, 'Temperature Status [Byte4]', need(ts, (v) => TEMP_STATUS[(v >> 1) & 3]));
  f(em, bk, 5, 'Power Status [Byte5]', need(b8(bk, 5), (v) => {
    if (ctx.link === 'cable') return `0x${v.toString(16).toUpperCase()}`;
    const on = POWER_STATUS_BITS.filter((b) => v & (1 << b.bit)).map((b) => b.name);
    return v === 0 ? '未受限（Sink 恒为 0）' : on.join(' · ');
  }));
  const ps = b8(bk, 6);
  f(em, bk, 6, 'Power State Change [Byte6]', need(ps, (v) =>
    `${POWER_STATE[v & 7] ?? '取值无效，按 0 处理'} · 指示灯 ${STATE_INDICATOR[(v >> 3) & 3] ?? '取值无效'}`));
  f(em, bk, 7, 'Reserved [Byte7]', need(b8(bk, 7), (v) => `0x${v.toString(16).toUpperCase()}`));

  const t = b8(bk, 0);
  const st = b8(bk, 6);
  return [t === null ? null : `内部温度 ${tempText(t)}`, st === null ? null : `电源状态 ${POWER_STATE[st & 7] ?? '—'}`]
    .filter(Boolean).join(' · ');
}

const tempText = (v) => (v === 0 ? '不支持温度检测 (0)' : (v === 1 ? '< 2 °C' : `${v} °C`));

/* ══════════════════ ③④ 取电池能力 / 状态 ══════════════════ */

function batteryRef(em, bk, label, fieldName) {
  const r = b8(bk, 0);
  em.object(`数据对象 #1 · Byte 0~3`);
  em.detail(`${fieldName} [Byte0]`, need(r, (v) => (v < 8 ? `${v} · ${BATTERY_REF_TEXT(v)}` : `${v} · 无效索引（对方应回 Invalid Battery Reference）`)));
  return r === null ? label : `${label} 电池 ${r}`;
}

/* ══════════════════ ⑤ Battery_Capabilities（BCDB）══════════════════ */

function bcdb(em, bk) {
  const vid = b16(bk, 0), pid = b16(bk, 2);
  const design = b16(bk, 4), full = b16(bk, 6);
  const type = b8(bk, 8);
  const capText = (v) => (v === null ? '（本分块不含该字段）'
    : (v === 0 ? '电池不存在 (0000h)' : (v === 0xFFFF ? '未知 (FFFFh)' : `${pdNum(v * 0.1)} Wh`)));
  f(em, bk, 0, 'Vendor ID [Byte1-0]', need(vid, (v) => `0x${pdHex(v, 4)}（电池厂商）`));
  f(em, bk, 2, 'Product ID [Byte3-2]', need(pid, (v) => `0x${pdHex(v, 4)}`));
  f(em, bk, 4, 'Battery Design Capacity [Byte5-4]', capText(design));
  f(em, bk, 6, 'Battery Last Full Charge Capacity [Byte7-6]', capText(full));
  f(em, bk, 8, 'Battery Type [Byte8]', need(type, (v) => pdFlag(v & 1, '无效电池引用', '电池引用有效')));
  return `设计容量 ${capText(design)} · 满充容量 ${capText(full)}`;
}

/* ══════════════════ ⑥⑦ Manufacturer_Info ══════════════════ */

function getManufacturerInfo(em, bk) {
  const target = b8(bk, 0), ref = b8(bk, 1);
  em.object('数据对象 #1 · Byte 0~3');
  em.detail('Manufacturer Info Target [Byte0]', need(target, (v) =>
    (v === 0 ? '0 · Port / Cable Plug' : (v === 1 ? '1 · Battery' : `${v} · 无效取值`))));
  em.detail('Manufacturer Info Ref [Byte1]', need(ref, (v) => {
    if (target !== 1) return `${v}（Target ≠ Battery 时 Reserved）`;
    return v < 8 ? `${v} · ${BATTERY_REF_TEXT(v)}` : `${v} · 无效索引`;
  }));
  return target === null ? 'Get Manufacturer Info' : `Get Manufacturer Info（${target === 1 ? '电池' : '端口/线缆'}）`;
}

function manufacturerInfo(em, bk) {
  const vid = b16(bk, 0), pid = b16(bk, 2);
  const strBytes = [];
  for (let i = 4; i < bk.dataSize; i++) {
    const b = b8(bk, i);
    if (b === null) break;
    strBytes.push(b);
  }
  const text = pdAscii(strBytes);
  f(em, bk, 0, 'Vendor ID [Byte1-0]', need(vid, (v) => `0x${pdHex(v, 4)}`));
  f(em, bk, 2, 'Product ID [Byte3-2]', need(pid, (v) => `0x${pdHex(v, 4)}`));
  f(em, bk, 4, 'Manufacturer String [Byte4…]', strBytes.length ? `"${text}"` : '（本分块不含该字段）');
  return text ? `厂商串 "${text}"` : '厂商串（空）';
}

/* ══════════════════ ⑧⑨⑩⑪ 安全 / 固件 ══════════════════ */

function security(em, bk, label) {
  em.object('数据块');
  em.detail('长度 [Data Size]', `${bk.dataSize} 字节${bk.chunked ? `（分块 ${bk.chunkNum}）` : ''}`);
  hexDump(em, bk);
  em.detail('说明', '内容为 [USBC Auth] 定义的认证数据结构，USB PD 规范不定义其内部格式');
  return `${label}（${bk.dataSize} 字节${bk.chunked ? '，分块' : ''}）`;
}

function firmware(em, bk, label) {
  em.object('数据块');
  em.detail('长度 [Data Size]', `${bk.dataSize} 字节${bk.chunked ? `（分块 ${bk.chunkNum}）` : ''}`);
  hexDump(em, bk);
  em.detail('说明', '内容为 [PDFU] 定义的固件升级数据结构，USB PD 规范不定义其内部格式');
  return `${label}（${bk.dataSize} 字节${bk.chunked ? '，分块' : ''}）`;
}

/** 原始字节转储（每 4 字节一个数据对象，与详情分组对齐） */
function hexDump(em, bk) {
  for (let i = 0; i < bk.bytes.length; i += 4) {
    const abs = bk.off + i;
    mkGroup(em, bk, abs);
    const chunk = bk.bytes.slice(i, i + 4);
    em.detail(`Byte ${abs}~${abs + chunk.length - 1}`, chunk.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' '));
  }
}

/* ══════════════════ ⑫ PPS_Status（PPSSDB）══════════════════ */

function ppsStatus(em, bk) {
  const v = b16(bk, 0), i = b8(bk, 2), fl = b8(bk, 3);
  const vText = v === null ? '（本分块不含该字段）' : (v === 0xFFFF ? '不支持 (FFFFh)' : `${pdNum(v * 0.02)} V`);
  const iText = i === null ? '（本分块不含该字段）' : (i === 0xFF ? '不支持 (FFh)' : `${pdNum(i * 0.05)} A`);
  f(em, bk, 0, 'Output Voltage [Byte1-0]', vText);
  f(em, bk, 2, 'Output Current [Byte2]', iText);
  f(em, bk, 3, 'Real Time Flags [Byte3]', need(fl, (x) =>
    `PTF ${TEMP_STATUS[(x >> 1) & 3]} · OMF ${x & 8 ? 'Current Limit (CL)' : 'Constant Voltage (CV)'}`));
  return `输出 ${vText} / ${iText}`;
}

/* ══════════════════ ⑬⑭ 国家码 ══════════════════ */

function countryInfo(em, bk) {
  const code = b16(bk, 0);
  f(em, bk, 0, 'Country Code [Byte1-0]', need(code, (v) => `"${pdCharPair(v & 0xFF, (v >> 8) & 0xFF)}"`));
  f(em, bk, 2, 'Reserved [Byte3-2]', need(b16(bk, 2), (v) => `0x${pdHex(v, 4)}`));
  const data = [];
  for (let i = 4; i < bk.dataSize; i++) { const b = b8(bk, i); if (b === null) break; data.push(b); }
  f(em, bk, 4, 'Country Specific Data [Byte4…]', data.length ? `"${pdAscii(data)}"` : '（本分块不含该字段）');
  return `国家码 "${pdCharPair((code ?? 0) & 0xFF, ((code ?? 0) >> 8) & 0xFF)}"`;
}

function countryCodes(em, bk) {
  const len = b8(bk, 0);
  f(em, bk, 0, 'Length [Byte0]', need(len, (v) => `${v} 个国家和地区码（有效范围 1~12）`));
  f(em, bk, 1, 'Reserved [Byte1]', need(b8(bk, 1), (v) => `0x${v.toString(16)}`));
  const list = [];
  for (let n = 0; n < 12; n++) {
    const i = 2 + n * 2;
    if (i >= bk.dataSize) break;
    const v = b16(bk, i);
    if (v === null) break;
    const code = pdCharPair(v & 0xFF, (v >> 8) & 0xFF);
    if (code) list.push(code);
    f(em, bk, i, `Country Code ${n + 1} [Byte${i + 1}-${i}]`, `"${code}"`);
  }
  return `共 ${list.length} 个国家和地区码：${list.join(' ')}`;
}

/* ══════════════════ ⑮ Sink_Capabilities_Extended（SKEDB）══════════════════ */

function skedb(st, em, bk) {
  const vid = b16(bk, 0), pid = b16(bk, 2), xid = b32(bk, 4);
  f(em, bk, 0, 'VID [Byte1-0]', need(vid, (v) => `0x${pdHex(v, 4)}`));
  f(em, bk, 2, 'PID [Byte3-2]', need(pid, (v) => `0x${pdHex(v, 4)}`));
  f(em, bk, 4, 'XID [Byte7-4]', need(xid, (v) => `0x${pdHex(v)}（应与 Cert Stat VDO 一致）`));
  f(em, bk, 8, 'FW Version [Byte8]', need(b8(bk, 8), String));
  f(em, bk, 9, 'HW Version [Byte9]', need(b8(bk, 9), String));
  f(em, bk, 10, 'SKEDB Version [Byte10]', need(b8(bk, 10), (v) => (v === 1 ? 'Version 1.0' : `${v} · 无效取值（接收端应忽略本条）`)));
  f(em, bk, 11, 'Load Step [Byte11]', need(b8(bk, 11), (v) => LOAD_STEP[v & 3]));

  const load = b16(bk, 12);
  f(em, bk, 12, 'Sink Load Characteristics [Byte13-12]', need(load, (v) => {
    const ov = Math.min(v & 0x1F, 25) * 10;
    if ((v & 0x1F) === 0) return '未指定过载需求（全 0）';
    return `过载 ${ov}% · 周期 ${((v >> 5) & 0x3F) * 20} ms · 占空比 ${((v >> 11) & 0xF) * 5}%`
      + ` · 允许额外 5% VBUS 跌落 ${(v >> 15) & 1 ? '是' : '否'}`;
  }));
  f(em, bk, 14, 'Compliance [Byte14]', need(b8(bk, 14), (v) =>
    [v & 1 ? 'LPS' : null, (v >> 1) & 1 ? 'PS1' : null, (v >> 2) & 1 ? 'PS2' : null].filter(Boolean).join(' + ') || '无'));
  f(em, bk, 15, 'Touch Temp [Byte15]', need(b8(bk, 15), (v) => TOUCH_TEMP_SINK[v] ?? '取值无效，按默认处理'));
  const binfo = b8(bk, 16);
  f(em, bk, 16, 'Battery Info [Byte16]', need(binfo, (v) => `固定电池 ${v & 0xF} 个 · 热插拔电池槽 ${(v >> 4) & 0xF} 个`));
  const modes = b8(bk, 17);
  f(em, bk, 17, 'Sink Modes [Byte17]', need(modes, (v) =>
    [v & 1 ? '支持 PPS 充电' : null, (v >> 1) & 1 ? '可由 VBUS 供电' : null, (v >> 2) & 1 ? '可由 AC 供电' : null,
      (v >> 3) & 1 ? '可由电池供电' : null, (v >> 4) & 1 ? '电池容量视为无限' : null, (v >> 5) & 1 ? '支持 AVS' : null]
      .filter(Boolean).join(' · ') || '无'));
  const sprs = b8(bk, 18), sprOp = b8(bk, 19), sprMax = b8(bk, 20);
  const eprs = b8(bk, 21), eprOp = b8(bk, 22), eprMax = b8(bk, 23);
  const w = (v) => (v === null ? '（本分块不含该字段）' : (v > 240 ? `${v}（超出有效范围）` : `${v} W`));
  f(em, bk, 18, 'SPR Sink Minimum PDP [Byte18]', w(sprs));
  f(em, bk, 19, 'SPR Sink Operational PDP [Byte19]', w(sprOp));
  f(em, bk, 20, 'SPR Sink Maximum PDP [Byte20]', w(sprMax));
  f(em, bk, 21, 'EPR Sink Minimum PDP [Byte21]', w(eprs));
  f(em, bk, 22, 'EPR Sink Operational PDP [Byte22]', w(eprOp));
  f(em, bk, 23, 'EPR Sink Maximum PDP [Byte23]', w(eprMax));

  return `SPR PDP ${sprs ?? '—'}/${sprOp ?? '—'}/${sprMax ?? '—'} W`
    + (eprMax ? ` · EPR PDP ${eprs ?? '—'}/${eprOp ?? '—'}/${eprMax} W` : '');
}

/* ══════════════════ ⑯ Extended_Control（ECDB）══════════════════ */

function extControl(em, bk) {
  const type = b8(bk, 0), data = b8(bk, 1);
  em.object('数据对象 #1 · Byte 0~3');
  em.detail('Type [Byte0]', need(type, (v) => `${v} · ${EXT_CONTROL_MSG_TYPES[v] ?? '无效，接收端应回 Not_Supported'}`));
  em.detail('Data [Byte1]', need(data, (v) => `0x${v.toString(16).padStart(2, '0').toUpperCase()}（表 6.63 规定为 0）`));
  return type === null ? 'Extended Control' : (EXT_CONTROL_MSG_TYPES[type] ?? `未知扩展控制类型 ${type}`);
}

/* ══════════════════ ⑰⑱ EPR 能力（PDO 列表，4 字节对齐）══════════════════ */

function eprCaps(st, em, bk, role) {
  const slots = pdoSlots(bk);
  const found = [];
  for (const s of slots) {
    em.object(`PDO #${s.index}`);
    if (s.value === null) {
      em.detail('状态', s.note);
      continue;
    }
    em.detail('对象位置', `${s.index}（Enter/Exit Mode 与 EPR_Request 用该位置引用）`);
    if (s.note) em.detail('分块对齐', s.note);
    const objPos = s.index;
    if (objPos <= 7 && s.value === 0) {
      em.detail('填充', 'SPR 槽位未使用，按 0 填充');
      found.push(`#${objPos} SPR 填充`);
      continue;
    }
    const isEpr = isEprPdo(s.value, objPos);
    const r = pdoParse(st, em, s.value, { role, position: objPos, isEpr, revText: '' });
    found.push(`#${objPos} ${r.summary}`);
  }
  return found.join(' · ') || '（无 PDO）';
}

/**
 * EPR 能力里的 PDO 是否为 EPR 档：位置 ≥8 直接判定；
 * 位置 ≤7 时按「固定电压 > 20V」或「AVS 型 APDO」判（与 sigrok/ATK 解码器一致）。
 */
function isEprPdo(pdo, objPos) {
  if (objPos >= 8) return true;
  const supplyType = pdField(pdo, 31, 30);
  if (supplyType === 0) return pdField(pdo, 19, 10) * 0.05 > 20.0;
  if (supplyType === 3) return pdField(pdo, 29, 28) === 1;
  return false;
}

/**
 * 把本分块的字节切成一串「4 字节对齐的 PDO 槽位」。
 * 分块起始若不在 4 字节边界上，会尝试用上一次分块存下的尾巴拼完整（st.extCarry）。
 */
function pdoSlots(bk) {
  const slots = [];
  const lead = bk.off % 4;
  let cur = bk.off;
  const end = bk.off + bk.bytes.length;

  if (lead !== 0) {
    const objIdx = Math.floor(bk.off / 4);
    const have = lead;                                  // 本包从这个对象的第 lead 个字节开始
    const prev = bk._carry;
    if (prev && prev.objIdx === objIdx && prev.bytes.length === have) {
      const full = prev.bytes.concat(bk.bytes.slice(0, 4 - have));
      slots.push({ index: objIdx + 1, value: bytesToU32(full), note: '由上一分块 + 本分块拼接' });
    } else {
      slots.push({ index: objIdx + 1, value: null, note: `跨分块（本包只有该对象的第 ${have}~3 字节）` });
    }
    cur = bk.off + (4 - have);
  }
  while (cur + 4 <= end) {
    slots.push({ index: Math.floor(cur / 4) + 1, value: bytesToU32(bk.bytes.slice(cur - bk.off, cur - bk.off + 4)), note: null });
    cur += 4;
  }
  // 尾部不足 4 字节 → 留给下一个分块
  if (cur < end) {
    bk._tail = { objIdx: Math.floor(cur / 4), bytes: Array.from(bk.bytes.slice(cur - bk.off)) };
  }
  return slots;
}

const bytesToU32 = (arr) => {
  let v = 0;
  for (let i = 0; i < Math.min(arr.length, 4); i++) v |= (arr[i] & 0xFF) << (8 * i);
  return v >>> 0;
};

/* ══════════════════ ㉚ Vendor_Defined_Extended ══════════════════ */

function vendorDefinedExtended(em, bk) {
  const svid = b16(bk, 0), cmd = b16(bk, 2);
  f(em, bk, 0, 'SVID [Byte1-0]', need(svid, (v) => svidText(v)));
  f(em, bk, 2, 'Command Space [Byte3-2]', need(cmd, (v) => `0x${pdHex(v, 4)}（B15 Reserved = ${(v >> 15) & 1}，B14-0 厂商命令 ${v & 0x7FFF}）`));
  const data = [];
  for (let i = 4; i < bk.dataSize; i++) { const b = b8(bk, i); if (b === null) break; data.push(b); }
  f(em, bk, 4, 'Vendor Defined Data [Byte4…]', data.length
    ? `${data.length} 字节 · ${data.slice(0, 16).map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join(' ')}${data.length > 16 ? ' …' : ''}`
    : '（本分块不含该字段）');
  return `厂商扩展消息 SVID 0x${pdHex(svid ?? 0, 4)} · 命令 0x${pdHex(cmd ?? 0, 4)}`;
}
