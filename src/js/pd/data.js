/**
 * data.js — 数据消息里除 PDO/RDO/VDM 之外的固定格式对象
 *
 *   BIST(BDO) / Battery_Status(BSDO) / Alert(ADO) / Enter_USB(EUDO)
 *   Source_Info(SIDO1/SIDO2) / Revision(RMDO) / EPR_Mode(EPRMDO) / Country_Code(CCDO)
 *
 * 依据 USB PD 3.2 Table 6.23…6.31；BIST 另按 PD 2.0 Table 6-x 区分旧值。
 */

import {
  BIST_MODES_V3, BIST_MODES_V2, CHARGE_STATE,
  USB_MODE, USB_MODE_UNKNOWN, USB_SPEED, USB_SPEED_UNKNOWN, CABLE_TYPE, CABLE_CURRENT_EUDO,
  EXT_ALERT_EVENT, EPR_MODE_ACTION, EPR_MODE_DATA, ALERT_BITS, revTextNum,
} from './tables.js';
import { pdField, pdBit, pdNum, pdHex, pdFlag, pdRange, pdCharPair, pdAscii } from './format.js';

/** 版本比较：'3.x'（3.0/3.1/3.2 共用该编码）按 3.0 参与比较 */
const atLeast = (revText, target) => revTextNum(revText) >= target;

/* ══════════════════ BIST ══════════════════ */

export function bistParse(em, data, idx, ctx) {
  const mode = pdField(data, 31, 28);
  const legacy = atLeast(ctx.revText, 3.0) ? null : (BIST_MODES_V2[mode] ?? null);
  const modern = atLeast(ctx.revText, 3.0) ? (BIST_MODES_V3[mode] ?? null) : null;
  em.object(`BIST 数据对象 #${idx + 1}`);
  em.detail(`BIST Test Mode [${pdRange(31, 28)}]`, `0x${mode.toString(16).toUpperCase()} · ${modern ?? legacy ?? '无效取值（接收端应忽略本条报文）'}`);
  if (modern && legacy) em.detail('PD 2.0 旧值', `${legacy}（同一数值在旧版规范里含义不同）`);
  if (legacy && mode === 2) {
    em.detail('Reserved [B27-16]', pdField(data, 27, 16));
    em.detail('BIST Error Counter [B15-0]', pdField(data, 15, 0));
  } else em.detail(`Reserved [${pdRange(27, 0)}]`, `0x${pdHex(data).slice(1)}`);

  if (idx > 0) {
    em.note('非法：BIST 只应有 1 个数据对象');
    return 'BIST 数据对象数量非法';
  }
  const name = modern ?? legacy ?? `未知模式 ${mode}`;
  em.note(`模式 ${name}`);
  return `模式 ${name}`;
}

/* ══════════════════ Battery_Status（BSDO）══════════════════ */

export function batteryStatusParse(em, data) {
  const cap = pdField(data, 31, 16);
  const status = pdField(data, 11, 10);
  const present = pdBit(data, 9);
  const invalidRef = pdBit(data, 8);
  const capText = cap === 0xFFFF ? '未知 (FFFFh)' : `${pdNum(cap * 0.1)} Wh`;

  em.detail(`电池当前容量 [${pdRange(31, 16)}]`, capText);
  em.detail(`Reserved [${pdRange(15, 12)}]`, `0x${pdField(data, 15, 12).toString(16).toUpperCase()}`);
  em.detail(`充电状态 [${pdRange(11, 10)}]`,
    present ? (CHARGE_STATE[status] ?? 'Invalid') : `Reserved（电池不存在）`);
  em.detail(`Battery Present [B9]`, pdFlag(present, '电池在位', '电池不在位'));
  em.detail(`Invalid Battery Reference [B8]`, pdFlag(invalidRef,
    '引用的电池不存在', '引用有效'));
  em.detail(`Reserved [${pdRange(7, 0)}]`, `0x${pdField(data, 7, 0).toString(16).padStart(2, '0').toUpperCase()}`);

  const s = `容量 ${capText} · ${present ? (CHARGE_STATE[status] ?? 'Invalid') : '电池不在位'}`
    + (invalidRef ? ' · 电池引用无效' : '');
  em.note(s);
  return s;
}

/* ══════════════════ Alert（ADO）══════════════════ */

export function alertParse(em, data, idx, ctx = {}) {
  const flags = pdField(data, 31, 24);
  em.object(`Alert 数据对象 #${idx + 1}（ADO）`);
  em.detail(`Type of Alert [${pdRange(31, 24)}]`, `0x${flags.toString(16).padStart(2, '0').toUpperCase()} = `
    + (flags ? '' : '无告警位'));

  const fired = [];
  for (const { bit, name } of ALERT_BITS) {
    if (bit === 24) { em.detail('Reserved [B24]', pdBit(data, 24)); continue; }
    const on = pdBit(data, bit);
    if (bit === 31 && ctx.specRevision === '3.0') { em.detail('Reserved [B31]', on); continue; }
    if (bit === 26 && ctx.role === 'SNK') {
      em.detail('Reserved (Sink OCP) [B26]', on);
      continue;
    }
    em.detail(`${name} [B${bit}]`, pdFlag(on));
    if (on) fired.push(name);
  }
  const fixed = pdField(data, 23, 20);
  const hot = pdField(data, 19, 16);
  const statusChange = pdBit(data, 25);
  em.detail(`Fixed Batteries [${pdRange(23, 20)}]`, statusChange
    ? (fixed ? `0b${fixed.toString(2).padStart(4, '0')} → 电池 ${batteryList(fixed, 0)}` : '无')
    : `0x${fixed.toString(16).toUpperCase()}（未置 Battery Status Change，此域 Reserved）`);
  em.detail(`Hot Swappable Batteries [${pdRange(19, 16)}]`, statusChange
    ? (hot ? `0b${hot.toString(2).padStart(4, '0')} → 电池 ${batteryList(hot, 4)}` : '无')
    : `0x${hot.toString(16).toUpperCase()}（未置 Battery Status Change，此域 Reserved）`);
  em.detail(`Reserved [${pdRange(15, 4)}]`, `0x${pdField(data, 15, 4).toString(16).toUpperCase()}`);

  const extType = pdField(data, 3, 0);
  const extendedAlert = ctx.specRevision !== '3.0' && pdBit(data, 31);
  const alertEventName = ctx.specRevision === '3.1' && extType > 4
    ? undefined : EXT_ALERT_EVENT[extType];
  em.detail(ctx.specRevision === '3.0' ? 'Reserved [B3-0]' : `Extended Alert Event Type [${pdRange(3, 0)}]`, extendedAlert
    ? `${extType} · ${alertEventName ?? (ctx.specRevision === '3.1' ? 'Reserved（PD 3.1）' : '自定义/保留事件')}`
    : `0x${extType.toString(16).toUpperCase()}（未置 Extended Alert Event）`);

  let s = fired.length ? `告警：${fired.join('、')}` : '无告警位';
  if (extendedAlert) s += ` · 扩展事件：${alertEventName ?? `保留值 ${extType}`}`;
  if (statusChange && (fixed || hot)) {
    s += ` · 电池 ${batteryList(fixed, 0).concat(batteryList(hot, 4)).join('/')}`;
  }
  em.note(s);
  return s;
}

/** 位图 → 电池编号列表（前 4 位是固定电池 0-3，后 4 位是热插拔电池 4-7） */
function batteryList(mask, base) {
  const out = [];
  for (let i = 0; i < 4; i++) if (mask & (1 << i)) out.push(String(base + i));
  return out;
}

/* ══════════════════ Enter_USB（EUDO）══════════════════ */

export function enterUsbParse(em, data, ctx = {}) {
  const mode = pdField(data, 30, 28);
  const speed = pdField(data, 23, 21);
  const ctype = pdField(data, 20, 19);
  const ccur = pdField(data, 18, 17);
  const old = ctx.specRevision === '3.1';
  const modeText = mode <= 2 ? USB_MODE[mode] : old ? 'Reserved（PD 3.1 v1.4）' : USB_MODE_UNKNOWN;
  const speedText = old && speed >= 4 ? 'Reserved（PD 3.1 v1.4）' : speed <= 4 ? USB_SPEED[speed] : USB_SPEED_UNKNOWN;

  em.detail(`Reserved [B31]`, pdBit(data, 31));
  em.detail(`USB Mode [${pdRange(30, 28)}]`, `${mode} · ${modeText}`);
  em.detail(`Reserved [B27]`, pdBit(data, 27));
  em.detail('USB4 DRD [B26]', pdFlag(pdBit(data, 26), 'Host DFP 可作 USB4 Device', '否'));
  em.detail('USB3 DRD [B25]', pdFlag(pdBit(data, 25), 'Host DFP 可作 USB3 Device', '否'));
  em.detail(`Reserved [B24]`, pdBit(data, 24));
  em.detail(`Cable Speed [${pdRange(23, 21)}]`, `${speed} · ${speedText}`);
  em.detail(`Cable Type [${pdRange(20, 19)}]`, ctype === 3 ? CABLE_TYPE[3] : `${ctype} · ${CABLE_TYPE[ctype]}`);
  em.detail(`Cable Current [${pdRange(18, 17)}]`, `${ccur} · ${CABLE_CURRENT_EUDO[ccur]}`);
  em.detail('PCIe Support [B16]', pdFlag(pdBit(data, 16), 'USB4 PCIe 隧道支持', '不支持'));
  em.detail('DP Support [B15]', pdFlag(pdBit(data, 15), 'USB4 DP 隧道支持', '不支持'));
  em.detail('TBT Support [B14]', pdFlag(pdBit(data, 14), '支持 Thunderbolt', '不支持'));
  em.detail('Host Present [B13]', pdFlag(pdBit(data, 13), 'USB 树顶存在 Host', '无 Host'));
  em.detail(`Reserved [${pdRange(12, 0)}]`, `0x${pdField(data, 12, 0).toString(16).toUpperCase()}`);
  if (ctx.link === 'cable') em.detail('接收端规则', '线缆插头忽略 USB4/USB3 DRD、Cable Current、PCIe/DP/TBT Support、Host Present 字段');

  const s = `${modeText} · 线缆 ${ctype === 3 ? CABLE_TYPE[3] : CABLE_TYPE[ctype]} ${speedText}`;
  em.note(s);
  return s;
}

/* ══════════════════ Source_Info（SIDO1 / SIDO2）══════════════════ */

export function sourceInfoParse(em, data, idx, ctx = {}) {
  if (ctx.specRevision === '3.1' && idx > 0) {
    em.object(`Source_Info 数据对象 #${idx + 1}（PD 3.1 未定义 SIDO2）`);
    em.detail('原始值', `0x${pdHex(data)}`);
    em.warn?.('PD 3.1 Source_Info 消息必须恰好包含一个 SIDO', 'SOURCE_INFO');
    return 'PD 3.1 未定义的 Source_Info 数据对象';
  }
  if (idx === 0) {
    /* SIDO1：1W 步长 */
    const portType = pdBit(data, 31);
    const reserved = pdField(data, 30, 24);
    if (reserved) em.warn?.('SIDO1 的 Reserved [B30-24] 非零', 'RESERVED');
    em.object('Source_Info 数据对象 #1（SIDO1）');
    em.detail('Port Type [B31]', pdFlag(portType, 'Guaranteed Capability Port（供电能力固定）', 'Managed Capability Port（可动态调整）'));
    em.detail(`Reserved [${pdRange(30, 24)}]`, `0x${reserved.toString(16).toUpperCase()}`);
    em.detail(`Port Maximum PDP [${pdRange(23, 16)}]`, `${pdField(data, 23, 16)} W（1W 步长，端口最大能提供的功率）`);
    em.detail(`Port Present PDP [${pdRange(15, 8)}]`, `${pdField(data, 15, 8)} W（当前实际可提供，已扣除线缆/温度等限制）`);
    em.detail(`Port Reported PDP [${pdRange(7, 0)}]`, `${pdField(data, 7, 0)} W（Source_Capabilities 里报出的功率）`);
    const s = `最大 ${pdField(data, 23, 16)}W 当前 ${pdField(data, 15, 8)}W 报出 ${pdField(data, 7, 0)}W`;
    em.note(s);
    return s;
  }
  if (idx === 1) {
    /* SIDO2：0.5W 步长，带 DPS 位 */
    const portType = pdBit(data, 31);
    const dps = pdBit(data, 30);
    const reserved = pdField(data, 29, 18);
    const maxPdp = pdField(data, 17, 9) * 0.5;
    const guaranteedPdp = pdField(data, 8, 0) * 0.5;
    if (dps && portType) em.warn?.('DPS Port 的 Port Type 必须为 Managed (0b)', 'SOURCE_INFO');
    if (reserved) em.warn?.('SIDO2 的 Reserved [B29-18] 非零', 'RESERVED');
    if (guaranteedPdp > maxPdp) em.warn?.('SIDO2 Port Guaranteed PDP 超过 Port Maximum PDP', 'SOURCE_INFO');
    em.object('Source_Info 数据对象 #2（SIDO2）');
    em.detail('Port Type [B31]', pdFlag(portType, 'Guaranteed Capability Port', 'Managed Capability Port'));
    em.detail('DPS Port [B30]', pdFlag(dps, '动态电源（DPS），Port Type 应为 0b', '非 DPS'));
    em.detail(`Reserved [${pdRange(29, 18)}]`, `0x${reserved.toString(16).toUpperCase()}`);
    em.detail(`Port Maximum PDP [${pdRange(17, 9)}]`, `${pdNum(maxPdp)} W（0.5W 步长）`);
    em.detail(`Port Guaranteed PDP [${pdRange(8, 0)}]`, `${pdNum(guaranteedPdp)} W（保证始终能提供的功率）`);
    const s = `最大 ${pdNum(maxPdp)}W 保证 ${pdNum(guaranteedPdp)}W${dps ? ' · DPS' : ''}`;
    em.note(s);
    return s;
  }
  em.object(`Source_Info 数据对象 #${idx + 1}`);
  em.detail('原始值', `0x${pdHex(data)}`);
  return `Source_Info 数据对象 #${idx + 1}（规范只定义 2 个）`;
}

/* ══════════════════ Revision（RMDO）══════════════════ */

export function revisionParse(em, data) {
  const rm = pdField(data, 31, 28), rn = pdField(data, 27, 24);
  const vm = pdField(data, 23, 20), vn = pdField(data, 19, 16);
  em.detail(`Revision Major [${pdRange(31, 28)}]`, String(rm));
  em.detail(`Revision Minor [${pdRange(27, 24)}]`, String(rn));
  em.detail(`Version Major [${pdRange(23, 20)}]`, String(vm));
  em.detail(`Version Minor [${pdRange(19, 16)}]`, String(vn));
  em.detail(`Reserved [${pdRange(15, 0)}]`, `0x${pdField(data, 15, 0).toString(16).padStart(4, '0').toUpperCase()}`);
  const s = `本端口支持的规范版本：Revision ${rm}.${rn} Version ${vm}.${vn}`;
  em.note(s);
  return s;
}

/* ══════════════════ EPR_Mode（EPRMDO）══════════════════ */

export function eprModeParse(em, data, idx, ctx = {}) {
  const action = pdField(data, 31, 24);
  const d = pdField(data, 23, 16);
  const actionText = EPR_MODE_ACTION[action] ?? '无效取值（接收端应忽略本条）';
  if (!EPR_MODE_ACTION[action]) em.warn?.('EPR_Mode Action 无效', 'EPR_FIELD');
  if ((action === 1 && ctx.role === 'SRC') || ([2, 3, 4].includes(action) && ctx.role === 'SNK')) em.warn?.('EPR_Mode Action 与发送方电源角色不符', 'ROLE');
  if (pdField(data, 15, 0) || (action !== 1 && action !== 4 && d)) em.warn?.('EPR_Mode 的保留位非零', 'RESERVED');
  // Table 6.28 的 Enter Data 为 00h..FFh；PDP 与已捕获 SKEDB 的一致性由会话层检查。
  if (action === 4 && d > 5) em.warn?.('EPR_Mode 失败原因码无效，接收端忽略该字段', 'EPR_FIELD');
  em.object(`EPR_Mode 数据对象 #${idx + 1}（EPRMDO）`);
  em.detail(`Action [${pdRange(31, 24)}]`, `0x${action.toString(16).padStart(2, '0').toUpperCase()} · ${actionText}`);
  let dText = `0x${d.toString(16).padStart(2, '0').toUpperCase()}`;
  if (action === 1) dText += ` · EPR Sink Operational PDP = ${d} W`;
  else if (action === 4) dText += ` · ${EPR_MODE_DATA[d] ?? `无效原因码 ${d}`}`;
  else dText += '（该 Action 下本域 Reserved）';
  em.detail(`Data [${pdRange(23, 16)}]`, dText);
  em.detail(`Reserved [${pdRange(15, 0)}]`, `0x${pdField(data, 15, 0).toString(16).padStart(4, '0').toUpperCase()}`);
  const s = actionText + (action === 4 ? ` · ${EPR_MODE_DATA[d] ?? `原因码 ${d}`}` : (action === 1 ? ` · PDP ${d}W` : ''));
  em.note(s);
  return s;
}

/* ══════════════════ Country_Code（CCDO）══════════════════ */

export function countryCodeParse(em, data) {
  const first = pdField(data, 31, 24), second = pdField(data, 23, 16);
  const code = pdCharPair(first, second);
  em.object('Country Code 数据对象（CCDO）');
  em.detail(`First Character [${pdRange(31, 24)}]`, `0x${first.toString(16).padStart(2, '0').toUpperCase()} · ${String.fromCharCode(first)}`);
  em.detail(`Second Character [${pdRange(23, 16)}]`, `0x${second.toString(16).padStart(2, '0').toUpperCase()} · ${String.fromCharCode(second)}`);
  em.detail(`Reserved [${pdRange(15, 0)}]`, `0x${pdField(data, 15, 0).toString(16).padStart(4, '0').toUpperCase()}`);
  const s = `国家码 ${code}`;
  em.note(s);
  return s;
}

/* ══════════════════ Manufacturer_Info 字符串 ══════════════════ */

/** Manufacturer_Info 的 N…4 字节（0..21 字符，NUL 结尾） */
export function manufacturerString(em, bytes) {
  const text = pdAscii(bytes);
  em.detail('Manufacturer String', text ? `"${text}"` : '（空）');
  em.note(text ? `厂商串 "${text}"` : '厂商串为空');
  return text;
}
