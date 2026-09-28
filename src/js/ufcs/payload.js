/**
 * payload.js — UFCS 各类消息的载荷逐字段解析
 *
 * 规范第 8 章把消息分成三类，本文件负责其中「消息主体」那一层的语义：
 *   • 控制消息（8.2.3）   主体只有 1 字节命令，无载荷 —— 由 decoder 直接判定，不进来；
 *   • 数据消息（8.2.4）   命令(1) + 数据长度(1) + 数据(N)
 *   • 自定义消息（8.2.5） 厂家识别码(2) + 数据长度(1) + 数据(N)
 *
 * 所有多字节字段按规范「先发送高字节」的约定解读，位域定位见 format.js#ufcsBits。
 *
 * 每个解析器都往 `em` 里发两种东西：
 *   em.object(标题)   开一个新的详情分组（界面按它切块、上色）
 *   em.detail(k, v)   一行字段
 *   em.note(text)     追加到表格「解析详情」列的一句话摘要
 * 返回值为本条消息的摘要文本（decoder 会再补一句）。
 */

import {
  UFCS_CURRENT_STEP, UFCS_VOLTAGE_STEP, UFCS_REFUSE_REASON,
  UFCS_EXT_STATUS_TYPE, UFCS_ERROR_BITS, UFCS_DEV_ADDR, UFCS_MSG_TYPE,
} from './tables.js';
import {
  ufcsBits, ufcsBit, ufcsRange, ufcsHex, ufcsNum, ufcsFlag, ufcsReserved,
  ufcsVolt, ufcsAmp, ufcsTemp, ufcsHexNum,
} from './format.js';

/* ────────────────────────── 小工具 ────────────────────────── */

/** 一段数据按固定长度切成若干项；长度不整除时只解析整项并报出余数 */
function chunk(bytes, unit) {
  const items = [];
  const n = Math.floor(bytes.length / unit);
  for (let i = 0; i < n; i++) items.push(bytes.subarray(i * unit, (i + 1) * unit));
  return { items, rest: bytes.length % unit };
}

/** 长度校验：不符就记一条告警，但照样按实际长度尽力解析（不丢信息） */
function checkLen(em, warns, actual, expect) {
  if (actual === expect) return true;
  warns.push({ long: `数据长度不符：规范要求 ${expect} 字节，实际 ${actual} 字节`, short: 'LEN' });
  em.detail('⚠ 长度异常', `规范要求 ${expect} 字节，实际 ${actual} 字节`);
  return false;
}

/* ────────────────────────── 输出模式（表 16）────────────────────────── */

/** 一种输出模式 = 8 字节（bit63…0），见规范表 16 */
function outputMode(em, m, i) {
  const modeNo = ufcsBits(m, 63, 60);
  const curStep = ufcsBits(m, 59, 57);
  const voltStep = ufcsBit(m, 56);
  const maxV = ufcsBits(m, 55, 40);
  const minV = ufcsBits(m, 39, 24);
  const maxI = ufcsBits(m, 23, 8);
  const minI = ufcsBits(m, 7, 0);

  em.object(`输出模式 #${i + 1}`);
  em.detail(`输出模式编号 [${ufcsRange(63, 60)}]`, `${modeNo}（规范要求 1…7，且与顺序一致）`);
  em.detail(`电流调节步进 [${ufcsRange(59, 57)}]`, `${curStep} · ${UFCS_CURRENT_STEP[curStep] ?? '保留值'}`);
  em.detail('电压调节步进 [B56]', `${voltStep} · ${UFCS_VOLTAGE_STEP[voltStep]}`);
  em.detail(`最大输出电压 [${ufcsRange(55, 40)}]`, `${maxV} × 10mV = ${ufcsVolt(maxV)}`);
  em.detail(`最小输出电压 [${ufcsRange(39, 24)}]`, `${minV} × 10mV = ${ufcsVolt(minV)}`);
  em.detail(`最大输出电流 [${ufcsRange(23, 8)}]`, `${maxI} × 10mA = ${ufcsAmp(maxI)}`);
  em.detail(`最小输出电流 [${ufcsRange(7, 0)}]`, `${minI} × 10mA = ${ufcsAmp(minI)}`);
  return `模式${modeNo}: ${ufcsVolt(minV)}–${ufcsVolt(maxV)} / ${ufcsAmp(minI)}–${ufcsAmp(maxI)}`
    + `（步进 ${UFCS_VOLTAGE_STEP[voltStep] ?? '?'}/${UFCS_CURRENT_STEP[curStep] ?? '?'}）`;
}

/* ────────────────────────── 各命令解析器 ────────────────────────── */

/**
 * 数据消息载荷解析。
 * @param {object} em 详情发射器
 * @param {number} cmd 命令编号
 * @param {Uint8Array} data 数据区
 * @param {Array} warns 告警收集器
 * @param {object} ctx { name, h, dataLen }
 * @returns {string} 摘要
 */
export function ufcsDataPayload(em, cmd, data, warns, ctx) {
  switch (cmd) {
    case 0x01: return payloadOutputCapabilities(em, data, warns);
    case 0x02: return payloadRequest(em, data, warns);
    case 0x03: return payloadSourceInfo(em, data, warns);
    case 0x04: return payloadSinkInfo(em, data, warns);
    case 0x05: return payloadCableInfo(em, data, warns);
    case 0x06: return payloadDeviceInfo(em, data, warns);
    case 0x07: return payloadErrorInfo(em, data, warns);
    case 0x08: return payloadConfigWatchdog(em, data, warns);
    case 0x09: return payloadRefuse(em, data, warns);
    case 0x0A: return payloadVerifyRequest(em, data, warns);
    case 0x0B: return payloadVerifyResponse(em, data, warns);
    case 0x0C: return payloadPowerChange(em, data, warns);
    case 0x0D: return payloadSinkInfoExtended(em, data, warns);
    case 0xFF: return payloadTestRequest(em, data, warns);
    default: return payloadUnknown(em, data, ctx);
  }
}

/** 8.2.4.1 Output_Capabilities */
function payloadOutputCapabilities(em, d, warns) {
  const { items, rest } = chunk(d, 8);
  if (!items.length) { em.detail('数据', `0x${ufcsHex(d)}`); return '数据长度为 0，无法解析输出模式'; }
  if (rest) checkLen(em, warns, d.length, items.length * 8);
  if (items.length > 7) warns.push({ long: `输出模式最多 7 种，实际 ${items.length} 种`, short: 'MODE' });
  const parts = items.map((m, i) => outputMode(em, m, i));
  const s = `${items.length} 种输出模式 · ${parts[0]}${items.length > 1 ? ' …' : ''}`;
  em.note(s);
  return s;
}

/** 8.2.4.2 Request */
function payloadRequest(em, d, warns) {
  checkLen(em, warns, d.length, 8);
  const modeNo = ufcsBits(d, 63, 60);
  const volt = ufcsBits(d, 31, 16);
  const cur = ufcsBits(d, 15, 0);
  em.object('请求数据（Request）');
  em.detail(`输出模式编号 [${ufcsRange(63, 60)}]`, `${modeNo}（引用 Output_Capabilities 中的第几个输出模式）`);
  em.detail(`保留 [${ufcsRange(59, 32)}]`, ufcsReserved(d, 59, 32));
  em.detail(`请求输出电压 [${ufcsRange(31, 16)}]`, `${volt} × 10mV = ${ufcsVolt(volt)}`);
  em.detail(`请求输出电流 [${ufcsRange(15, 0)}]`, `${cur} × 10mA = ${ufcsAmp(cur)}`);
  const s = `请求模式 ${modeNo}：${ufcsVolt(volt)} / ${ufcsAmp(cur)}`;
  em.note(s);
  return s;
}

/** 8.2.4.3 Source_Information */
function payloadSourceInfo(em, d, warns) {
  checkLen(em, warns, d.length, 8);
  const period = ufcsBits(d, 51, 48);
  const tIn = ufcsBits(d, 47, 40);
  const tOut = ufcsBits(d, 39, 32);
  const volt = ufcsBits(d, 31, 16);
  const cur = ufcsBits(d, 15, 0);
  em.object('状态信息（Source_Information）');
  em.detail(`保留 [${ufcsRange(63, 52)}]`, ufcsReserved(d, 63, 52));
  em.detail(`Sink_Info_Extended 最小周期 [${ufcsRange(51, 48)}]`,
    period === 0 ? '0000b：不支持充电设备主动上报 Sink_Information_Extended' : `${period} × 100ms = ${period * 100} ms`);
  em.detail(`内部温度 [${ufcsRange(47, 40)}]`, `${tIn} → ${ufcsTemp(tIn)}`);
  em.detail(`输出口温度 [${ufcsRange(39, 32)}]`, `${tOut} → ${ufcsTemp(tOut)}`);
  em.detail(`当前输出电压 [${ufcsRange(31, 16)}]`, `${volt} × 10mV = ${ufcsVolt(volt)}`);
  em.detail(`当前输出电流 [${ufcsRange(15, 0)}]`, `${cur} × 10mA = ${ufcsAmp(cur)}`);
  const s = `输出 ${ufcsVolt(volt)} / ${ufcsAmp(cur)} · 内部 ${ufcsTemp(tIn)} · 接口 ${ufcsTemp(tOut)}`;
  em.note(s);
  return s;
}

/** 8.2.4.4 Sink_Information */
function payloadSinkInfo(em, d, warns) {
  checkLen(em, warns, d.length, 8);
  const tBat = ufcsBits(d, 47, 40);
  const tIn = ufcsBits(d, 39, 32);
  const volt = ufcsBits(d, 31, 16);
  const cur = ufcsBits(d, 15, 0);
  em.object('状态信息（Sink_Information）');
  em.detail(`保留 [${ufcsRange(63, 48)}]`, ufcsReserved(d, 63, 48));
  em.detail(`电池温度 [${ufcsRange(47, 40)}]`, `${tBat} → ${ufcsTemp(tBat)}`);
  em.detail(`输入接口温度 [${ufcsRange(39, 32)}]`, `${tIn} → ${ufcsTemp(tIn)}`);
  em.detail(`当前充电电压 [${ufcsRange(31, 16)}]`, `${volt} × 10mV = ${ufcsVolt(volt)}（进入充电 IC 之前）`);
  em.detail(`当前充电电流 [${ufcsRange(15, 0)}]`, `${cur} × 10mA = ${ufcsAmp(cur)}（进入充电 IC 之前）`);
  const s = `充电 ${ufcsVolt(volt)} / ${ufcsAmp(cur)} · 电池 ${ufcsTemp(tBat)} · 接口 ${ufcsTemp(tIn)}`;
  em.note(s);
  return s;
}

/** 8.2.4.5 Cable_Information */
function payloadCableInfo(em, d, warns) {
  checkLen(em, warns, d.length, 10);
  const vid = ufcsBits(d, 79, 64);
  const custom = ufcsBits(d, 63, 48);
  const imp = ufcsBits(d, 47, 32);
  const maxV = ufcsBits(d, 31, 16);
  const maxI = ufcsBits(d, 15, 0);
  em.object('线缆信息（Cable_Information）');
  em.detail(`厂家识别码 [${ufcsRange(79, 64)}]`, `${ufcsHexNum(vid)}`);
  em.detail(`厂家自定义识别码 [${ufcsRange(63, 48)}]`, `${ufcsHexNum(custom)}`);
  em.detail(`线缆阻抗 [${ufcsRange(47, 32)}]`, `${imp} mΩ`);
  em.detail(`最大承载电压 [${ufcsRange(31, 16)}]`, `${maxV} × 10mV = ${ufcsVolt(maxV)}`);
  em.detail(`最大承载电流 [${ufcsRange(15, 0)}]`, `${maxI} × 10mA = ${ufcsAmp(maxI)}`);
  const s = `线缆承载 ${ufcsVolt(maxV)} / ${ufcsAmp(maxI)} · 阻抗 ${imp} mΩ · VID ${ufcsHexNum(vid)}`;
  em.note(s);
  return s;
}

/** 8.2.4.6 Device_Information */
function payloadDeviceInfo(em, d, warns) {
  checkLen(em, warns, d.length, 8);
  const vid = ufcsBits(d, 63, 48);
  const custom = ufcsBits(d, 47, 32);
  const hw = ufcsBits(d, 31, 16);
  const sw = ufcsBits(d, 15, 0);
  em.object('设备信息（Device_Information）');
  em.detail(`厂家识别码 [${ufcsRange(63, 48)}]`, ufcsHexNum(vid));
  em.detail(`厂家自定义识别码 [${ufcsRange(47, 32)}]`, ufcsHexNum(custom));
  em.detail(`设备硬件版本号 [${ufcsRange(31, 16)}]`, `0x${hw.toString(16).toUpperCase().padStart(4, '0')}（厂家自定义格式，0 = 未填写）`);
  em.detail(`设备软件版本号 [${ufcsRange(15, 0)}]`, `0x${sw.toString(16).toUpperCase().padStart(4, '0')}（厂家自定义格式，0 = 未填写）`);
  const s = `VID ${ufcsHexNum(vid)} · HW 0x${hw.toString(16).toUpperCase().padStart(4, '0')} / SW 0x${sw.toString(16).toUpperCase().padStart(4, '0')}`;
  em.note(s);
  return s;
}

/** 8.2.4.7 Error_Information */
function payloadErrorInfo(em, d, warns) {
  checkLen(em, warns, d.length, 4);
  em.object('异常信息（Error_Information）');
  const fired = [];
  for (const e of UFCS_ERROR_BITS) {
    const on = ufcsBit(d, e.bit);
    em.detail(`${e.name} [B${e.bit}]`, ufcsFlag(on, e.text, '正常'));
    if (on) fired.push(e.name);
  }
  em.detail(`保留 [${ufcsRange(31, 9)}]`, ufcsReserved(d, 31, 9));
  em.detail(`保留 [${ufcsRange(5, 0)}]`, ufcsReserved(d, 5, 0));
  const s = fired.length ? `异常：${fired.join('、')}` : '无异常（D+/D-/CC 均正常）';
  em.note(s);
  return s;
}

/** 8.2.4.8 Config_Watchdog */
function payloadConfigWatchdog(em, d, warns) {
  checkLen(em, warns, d.length, 2);
  const ms = ufcsBits(d, 15, 0);
  em.object('配置信息（Config_Watchdog）');
  em.detail(`看门狗溢出时间 [${ufcsRange(15, 0)}]`, ms === 0 ? '0 → 关闭看门狗功能' : `${ms} ms`);
  const s = ms === 0 ? '关闭看门狗' : `看门狗 ${ms} ms`;
  em.note(s);
  return s;
}

/** 8.2.4.9 Refuse */
function payloadRefuse(em, d, warns) {
  checkLen(em, warns, d.length, 4);
  const msgNo = ufcsBits(d, 27, 24);
  const mtype = ufcsBits(d, 18, 16);
  const cmd = ufcsBits(d, 15, 8);
  const reason = ufcsBits(d, 7, 0);
  em.object('反馈信息（Refuse）');
  em.detail(`保留 [${ufcsRange(31, 28)}]`, ufcsReserved(d, 31, 28));
  em.detail(`被拒消息的消息编号 [${ufcsRange(27, 24)}]`, String(msgNo));
  em.detail(`保留 [${ufcsRange(23, 19)}]`, ufcsReserved(d, 23, 19));
  em.detail(`被拒消息的消息类型 [${ufcsRange(18, 16)}]`, `${mtype} · ${UFCS_MSG_TYPE[mtype] ?? '保留值'}`);
  em.detail(`被拒消息的命令编号 [${ufcsRange(15, 8)}]`, `0x${cmd.toString(16).toUpperCase().padStart(2, '0')}`);
  em.detail(`拒绝原因 [${ufcsRange(7, 0)}]`, `0x${reason.toString(16).toUpperCase().padStart(2, '0')} · ${UFCS_REFUSE_REASON[reason] ?? '保留值'}`);
  const s = `拒绝 0x${cmd.toString(16).toUpperCase().padStart(2, '0')}（消息类型 ${mtype}）：${UFCS_REFUSE_REASON[reason] ?? `原因码 0x${reason.toString(16).toUpperCase()}`}`;
  em.note(s);
  return s;
}

/** 8.2.4.10 Verify_Request */
function payloadVerifyRequest(em, d, warns) {
  checkLen(em, warns, d.length, 17);
  const key = d[0];
  const rand = d.subarray(1, 17);
  em.object('鉴权请求（Verify_Request）');
  em.detail('密钥编号 [B0]', `0x${(key ?? 0).toString(16).toUpperCase().padStart(2, '0')}`);
  em.detail(`随机数据 [16 字节]`, `0x${ufcsHex(rand)}`);
  const s = `密钥编号 0x${(key ?? 0).toString(16).toUpperCase().padStart(2, '0')} · 随机数 0x${ufcsHex(rand).slice(0, 8)}…`;
  em.note(s);
  return s;
}

/** 8.2.4.11 Verify_Response */
function payloadVerifyResponse(em, d, warns) {
  checkLen(em, warns, d.length, 48);
  const enc = d.subarray(0, 32);
  const rand = d.subarray(32, 48);
  em.object('鉴权应答（Verify_Response）');
  em.detail(`加密数据 [32 字节]`, `0x${ufcsHex(enc)}`);
  em.detail(`随机数据 [16 字节]`, `0x${ufcsHex(rand)}`);
  const s = `加密数据 0x${ufcsHex(enc).slice(0, 8)}… · 随机数 0x${ufcsHex(rand).slice(0, 8)}…`;
  em.note(s);
  return s;
}

/** 8.2.4.12 Power_Change */
function payloadPowerChange(em, d, warns) {
  const { items, rest } = chunk(d, 3);
  if (!items.length) { em.detail('数据', `0x${ufcsHex(d)}`); return '数据长度为 0'; }
  if (rest) checkLen(em, warns, d.length, items.length * 3);
  if (items.length > 7) warns.push({ long: `Power_Change 最多 7 种输出模式，实际 ${items.length}`, short: 'MODE' });
  const parts = [];
  items.forEach((m, i) => {
    const modeNo = ufcsBits(m, 23, 20);
    const fast = ufcsBit(m, 19);
    const maxI = ufcsBits(m, 15, 0);
    em.object(`输出模式 #${i + 1}`);
    em.detail(`输出模式编号 [${ufcsRange(23, 20)}]`, String(modeNo));
    em.detail('快速调整输出功率 [B19]', ufcsFlag(fast, '要求立即一次性降到该电流', '可在 1 秒内逐步调整'));
    em.detail(`保留 [${ufcsRange(18, 16)}]`, ufcsReserved(m, 18, 16));
    em.detail(`最大输出电流 [${ufcsRange(15, 0)}]`, `${maxI} × 10mA = ${ufcsAmp(maxI)}`);
    parts.push(`模式${modeNo}→${ufcsAmp(maxI)}`);
  });
  const s = `最大输出电流变更：${parts.join('、')}`;
  em.note(s);
  return s;
}

/** 8.2.4.13 Sink_Information_Extended */
function payloadSinkInfoExtended(em, d, warns) {
  const { items, rest } = chunk(d, 3);
  if (!items.length) { em.detail('数据', `0x${ufcsHex(d)}`); return '数据长度为 0'; }
  if (rest) checkLen(em, warns, d.length, items.length * 3);
  if (items.length > 15) warns.push({ long: `状态信息最多 15 项，实际 ${items.length}`, short: 'ITEM' });
  const parts = [];
  const seen = new Set();
  items.forEach((m, i) => {
    const type = ufcsBits(m, 23, 20);
    const val = ufcsBits(m, 15, 0);
    em.object(`状态信息 #${i + 1}`);
    em.detail(`状态信息类型 [${ufcsRange(23, 20)}]`, `${type.toString(2).padStart(4, '0')}b · ${UFCS_EXT_STATUS_TYPE[type] ?? '保留值'}`);
    em.detail(`保留 [${ufcsRange(19, 16)}]`, ufcsReserved(m, 19, 16));
    let text;
    if (type === 0b0001) text = `${ufcsNum(val / 100)} %（${val} × 0.01%）`;
    else if (type === 0b0010) text = `${val} W`;
    else text = `原始值 ${val}`;
    em.detail(`状态数据 [${ufcsRange(15, 0)}]`, text);
    if (seen.has(type) && (type === 1 || type === 2)) {
      warns.push({ long: '同一条消息里出现两个及以上同类型状态信息（规范不允许）', short: 'DUP' });
    }
    seen.add(type);
    parts.push(`${UFCS_EXT_STATUS_TYPE[type] ?? `类型${type}`}=${text}`);
  });
  const s = parts.join('、');
  em.note(s);
  return s;
}

/** 8.2.4.14 Test_Request */
function payloadTestRequest(em, d, warns) {
  checkLen(em, warns, d.length, 2);
  const en = ufcsBit(d, 15);
  const vacc = ufcsBit(d, 14);
  const addr = ufcsBits(d, 13, 11);
  const mtype = ufcsBits(d, 10, 8);
  const cmd = ufcsBits(d, 7, 0);
  em.object('测试内容（Test_Request）');
  em.detail('使能测试模式 [B15]', ufcsFlag(en, '被测设备工作在测试模式', '正常模式'));
  em.detail('电压精度测试模式 [B14]', ufcsFlag(vacc, '输出电流可比设置值偏大 10%', '关闭'));
  em.detail(`设备地址 [${ufcsRange(13, 11)}]`, `${addr.toString(2).padStart(3, '0')}b · ${UFCS_DEV_ADDR[addr] ?? (addr === 0 ? '未指定' : '保留')}`);
  em.detail(`消息类型 [${ufcsRange(10, 8)}]`, `${mtype} · ${UFCS_MSG_TYPE[mtype] ?? '保留值'}`);
  em.detail(`命令编号 [${ufcsRange(7, 0)}]`, `0x${cmd.toString(16).toUpperCase().padStart(2, '0')}`);
  const onlyEnable = (addr === 0b111 && mtype === 0b111 && cmd === 0xFF);
  const s = onlyEnable
    ? `仅${en ? '使能' : '关闭'}测试模式${vacc ? ' + 电压精度测试' : ''}（未命令发送具体消息）`
    : `命令 ${UFCS_DEV_ADDR[addr] ?? '地址' + addr} 发送 类型${mtype}/命令0x${cmd.toString(16).toUpperCase()}`;
  em.note(s);
  return s;
}

/** 规范未定义的命令编号：如实列出原始数据，不硬套结构 */
function payloadUnknown(em, d, ctx) {
  em.object(`未知命令 0x${ctx.cmd.toString(16).toUpperCase()} 的数据`);
  em.detail('原始数据', `0x${ufcsHex(d)}`);
  const s = `未定义的数据命令 0x${ctx.cmd.toString(16).toUpperCase()}（${d.length} 字节，按原始字节列出）`;
  em.note(s);
  return s;
}

/* ────────────────────────── 自定义消息 ────────────────────────── */

/** 8.2.5 厂家自定义消息：厂家识别码(2) + 数据长度(1) + 数据(N)，内容由厂家定义 */
export function ufcsCustomPayload(em, vid, data) {
  em.object('厂家自定义消息');
  em.detail('厂家识别码 [2 字节]', ufcsHexNum(vid));
  em.detail('数据长度', `${data.length} 字节`);
  em.detail('数据', data.length ? `0x${ufcsHex(data)}` : '（空）');
  const s = `厂家自定义（识别码 ${ufcsHexNum(vid)}，${data.length} 字节数据）`;
  em.note(s);
  return s;
}

/** 逐字节列出（自定义消息 / 未知命令的诊断用，最多 48 项以免详情页被淹没） */
export function ufcsDumpBytes(em, data) {
  if (!data.length) return;
  em.object('数据字节');
  const n = Math.min(data.length, 48);
  for (let i = 0; i < n; i++) {
    em.detail(`byte[${i}]`, `0x${data[i].toString(16).toUpperCase().padStart(2, '0')} · ${data[i]}`);
  }
  if (data.length > n) em.detail('…', `另有 ${data.length - n} 字节（见上方整段 hex）`);
}
