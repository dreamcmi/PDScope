/**
 * vdm.js — Vendor Defined Message（VDM）解析
 *
 * 覆盖：
 *   • VDM Header（结构化 / 非结构化两种形态，PD 3.2 Table 6.32 / 6.33）
 *   • Discover Identity：ID Header VDO / Cert Stat VDO / Product VDO，
 *     以及按产品类型分派的 UFP VDO、DFP VDO、无源线缆 VDO、有源线缆 VDO1&2、VPD VDO，
 *     另含 PD 3.0/2.0 的旧 AMA VDO（Table 6.34…6.45、旧版 6-30/6-37）
 *   • Discover SVIDs：VDO 里两两成对的 SVID 列表（Table 6.46）
 *   • Discover Modes / Enter Mode / Exit Mode / Attention：对象位置与 SVID 自定义 VDO
 *   • 命令 16…31 的 SVID 自定义命令、非结构化 VDM 的厂商私有载荷
 *
 * 依据 USB PD 3.2 Chapter 6.4.12 与 Chapter 8，旧版字段取自 PD 3.0 / 2.0 原文。
 */

import {
  VDM_CMDS, VDM_ACK, VDM_CMD_SVID_MIN, VDM_VER_MAJOR, VDM_VER_MINOR,
  PRODUCT_TYPE_UFP, PRODUCT_TYPE_CABLE, PRODUCT_TYPE_DFP, PRODUCT_TYPE_VDO_KIND,
  CONNECTOR_TYPE, UFP_VDO_VERSION, DFP_VDO_VERSION, UFP_USB2, USB_HIGHEST_SPEED, USB_HIGHEST_SPEED_V30, VCONN_POWER,
  CABLE_CONNECTOR, CABLE_TERMINATION_PASSIVE, CABLE_TERMINATION_ACTIVE,
  CABLE_LATENCY_PASSIVE, CABLE_LATENCY_ACTIVE,
  CABLE_VBUS_VOLTAGE_V30, CABLE_VBUS_VOLTAGE_V31, CABLE_VBUS_CURRENT, CABLE_VBUS_CURRENT_ACTIVE,
  U3_CLD_POWER, VPD_VBUS_VOLTAGE, AMA_SUPERSPEED_V30,
} from './tables.js';
import { svidText, svidName, SVID_PD } from './svid.js';
import { pdField, pdBit, pdNum, pdHex, pdFlag, pdRange, pdAscii } from './format.js';

/** 标准 VDM 命令名（含 SVID 自定义命令的写法） */
export function vdmCommandName(cmd) {
  return VDM_CMDS[cmd] ?? (cmd >= VDM_CMD_SVID_MIN ? `SVID 自定义命令 ${cmd}` : `无效命令 ${cmd}`);
}

/** 是否 3.x（报文头只能表示到「3.x」，无法再细分 3.0 / 3.1 / 3.2） */
function is3x(ctx) { return ctx.revText === '3.x'; }

/**
 * 非 ACK 响应的一句话说明。
 * 请求（REQ）不必重复——报文头一行里已经写明「REQ xxx」，摘要再写一遍只是噪声。
 */
function pushNonAckFact(facts, ack, vdos, cmdName) {
  if (ack === 'REQ') return;
  const extra = vdos.length ? '，且不应携带数据对象' : '';
  if (ack === 'NAK') facts.push(`对端未实现/拒绝 ${cmdName}${extra}`);
  else facts.push(`⚠ ${ack} 不是 ${cmdName} 的合法响应（规范只允许 ACK/NAK）${extra}`);
}

/**
 * 线缆 VDO 的 USB Highest Speed（B2..0）。
 * 按现行规范（PD 3.1+）解码；PD 3.0 时 011b 及以上还是保留值，取值到 3 以上时补一句说明。
 */
function cableSpeedText(spd) {
  const b = spd.toString(2).padStart(3, '0') + 'b';
  const t = USB_HIGHEST_SPEED[spd];
  if (!t) return `${b} · 无效取值（不得使用）`;
  return spd >= 3 ? `${b} · ${t}（PD 3.0 时该编码为保留值）` : `${b} · ${t}`;
}

/**
 * 线缆 VDO 的「Maximum VBUS Voltage」（B10..9）。
 * 只有 01b / 10b 这两个码在 PD 3.0 与 3.1+ 之间含义不同（3.0 是 30V/40V，3.1 起废弃改按 20V），
 * 所以只在用到这两个码时补一句旧含义，其余码不啰嗦。
 */
function vmaxNote(code, ctx) {
  if (code !== 1 && code !== 2) return '';
  return is3x(ctx) ? '（PD 3.0 下这两个码是 30 V / 40 V）' : '（PD 3.1 起已废弃，接收端按 20 V 处理）';
}

/* ══════════════════ VDM 主体 ══════════════════ */

/**
 * 解析一条完整的 VDM（含 VDM Header 在内的全部数据对象）。
 *
 * @param {object} st  解码器状态（st.svidList / st.identity 用于跨包关联）
 * @param {object} em  详情发射器
 * @param {number[]} vdos 数据对象数组，dataObjects[0] 是 VDM Header
 * @param {object} ctx { rev, revText, sop, link, role }
 */
export function vdmParse(st, em, vdos, ctx) {
  const head = vdos[0] >>> 0;
  const svid = pdField(head, 31, 16);
  const structured = pdBit(head, 15) === 1;
  const extra = vdos.slice(1);
  const facts = [];

  em.object('VDO #1 · VDM Header');
  em.detail('SVID [B31-16]', svidText(svid));
  em.detail('VDM Type [B15]', pdFlag(structured, 'Structured VDM（结构化）', 'Unstructured VDM（厂商私有）'));

  if (!structured) {
    const payload = pdField(head, 14, 0);
    em.detail('Available for Vendor Use [B14-0]', `0x${payload.toString(16).toUpperCase().padStart(4, '0')}`);
    const vendor = svidName(svid);
    const s = `厂商私有 VDM · SVID 0x${svid.toString(16).toUpperCase().padStart(4, '0')}`
      + (vendor ? ` (${vendor.replace('（厂商 ID）', '')})` : '') + ` · 私有载荷 0x${payload.toString(16).toUpperCase()}`;
    extra.forEach((v, i) => {
      em.object(`VDO #${i + 2} · 厂商私有数据`);
      em.detail('原始值', `0x${pdHex(v)}`);
    });
    em.note(s);
    return { summary: s, svid, structured: false };
  }

  /* ── 结构化 VDM Header ── */
  const verMajor = pdField(head, 14, 13);
  const verMinor = pdField(head, 12, 11);
  const objPos = pdField(head, 10, 8);
  const cmdType = pdField(head, 7, 6);
  const cmd = pdField(head, 4, 0);
  const cmdName = vdmCommandName(cmd);
  const ack = VDM_ACK[cmdType];

  em.detail('Structured VDM Version (Major) [B14-13]', `${VDM_VER_MAJOR[verMajor] ?? '无效'} · ${verMajor.toString(2).padStart(2, '0')}b`);
  em.detail('Structured VDM Version (Minor) [B12-11]', cmd <= 15
    ? `${VDM_VER_MINOR[verMinor] ?? '无效取值（不得使用）'} · ${verMinor.toString(2).padStart(2, '0')}b`
    : `由 SVID 定义 · ${verMinor.toString(2).padStart(2, '0')}b`);
  em.detail('Object Position [B10-8]', `${objPos}`
    + (cmd === 4 || cmd === 5 ? `（指向 Discover Modes 列表里的第 ${objPos} 个 Mode）`
      : (objPos ? '（本命令下应为 0，接收端应忽略）' : '（本命令下应为 000b）')));
  em.detail('Command Type [B7-6]', `${ack} · ${cmdType.toString(2).padStart(2, '0')}b`);
  em.detail('Reserved [B5]', pdBit(head, 5));
  em.detail('Command [B4-0]', `${cmd} · ${cmdName}`);

  /* ── 按命令分派 ── */
  switch (cmd) {
    case 1: decodeDiscoverIdentity(st, em, extra, ctx, ack, facts); break;
    case 2: decodeDiscoverSvids(st, em, extra, ctx, ack, facts); break;
    case 3: decodeDiscoverModes(st, em, extra, ctx, ack, svid, facts); break;
    case 4: decodeEnterExitMode(em, extra, ctx, ack, 'Enter Mode', facts); break;
    case 5: decodeEnterExitMode(em, extra, ctx, ack, 'Exit Mode', facts); break;
    case 6: decodeAttention(em, extra, ctx, svid, facts); break;
    default:
      if (cmd === 0) {
        em.note('命令 0 无效，接收端应回 NAK');
      } else if (cmd > 6 && cmd < VDM_CMD_SVID_MIN) {
        em.note(`命令 ${cmd} 无效（规范只定义 1…6 与 16…31），接收端应回 NAK`);
      } else {
        em.note(`SVID 自定义命令 ${cmd}`);
      }
      extra.forEach((v, i) => {
        em.object(`VDO #${i + 2} · SVID 自定义数据`);
        em.detail('原始值', `0x${pdHex(v)}`);
      });
  }

  const head4 = `${ack} ${cmdName}`;
  // 多个子解析器可能推入同一条事实（如产品类型短名与「无源线缆」），去重后拼接
  const uniq = [...new Set(facts.filter(Boolean))];
  const summary = uniq.length ? `${head4} · ${uniq.join(' · ')}` : head4;
  em.note(summary);
  st.lastVdm = { svid, cmd, cmdType, objPos };
  return { summary, svid, structured: true, command: cmd, commandType: cmdType, objPos };
}

/* ══════════════════ Discover Identity ══════════════════ */

function decodeDiscoverIdentity(st, em, vdos, ctx, ack, facts) {
  if (ack !== 'ACK') {
    if (vdos.length) {
      em.object(`VDO #2 · ${ack} 不应携带数据对象`);
      em.detail('原始值', `0x${pdHex(vdos[0])}`);
    }
    if (ack === 'REQ') {
      // 请求本身没什么可展开的：头部已写明「REQ Discover Identity」，摘要不再重复
      em.detail('说明', 'Discover Identity 的请求方只发 VDM Header，不带数据对象');
      return;
    }
    pushNonAckFact(facts, ack, vdos, 'Discover Identity');
    if (ack === 'NAK') {
      em.detail('说明', '对端未实现 Discover Identity，故无数据对象');
    } else {
      em.detail('说明', 'BUSY 不是 Discover Identity 的合法响应（规范只允许 ACK/NAK）');
    }
    return;
  }
  if (!vdos.length) {
    facts.push('ACK 响应缺少数据对象（规范要求 4~7 个）');
    em.note('⚠ Discover Identity ACK 未携带 VDO');
    return;
  }

  const idHeader = vdos[0] >>> 0;
  em.object('VDO #2 · ID Header VDO');
  const info = idHeaderVdo(em, idHeader, ctx);

  if (vdos[1] !== undefined) {
    em.object('VDO #3 · Cert Stat VDO');
    certStatVdo(em, vdos[1] >>> 0);
  }
  if (vdos[2] !== undefined) {
    em.object('VDO #4 · Product VDO');
    productVdo(em, vdos[2] >>> 0);
  }

  const rest = vdos.slice(3);
  const kind = info.vdoKind;

  if (!rest.length) {
    em.object('无 Product Type VDO');
    em.detail('说明', `ID Header VDO 声明的产品类型为「${info.productTypeText}」，该类型不返回 Product Type VDO`);
  } else if (ctx.link === 'cable') {
    if (kind === 'activeCable') {
      em.object('VDO #5 · Active Cable VDO1');
      activeCableVdo1(em, rest[0] >>> 0, ctx, facts);
      if (rest[1] !== undefined) {
        em.object('VDO #6 · Active Cable VDO2');
        activeCableVdo2(em, rest[1] >>> 0, facts);
      } else {
        em.note('⚠ 有源线缆缺少 Active Cable VDO2');
      }
    } else if (kind === 'vpd') {
      em.object('VDO #5 · VPD VDO');
      vpdVdo(em, rest[0] >>> 0, facts);
    } else {
      em.object('VDO #5 · Passive Cable VDO');
      passiveCableVdo(em, rest[0] >>> 0, ctx, facts);
    }
  } else if (rest.length >= 3) {
    em.object('VDO #5 · UFP VDO');
    ufpVdo(em, rest[0] >>> 0, facts);
    em.object('VDO #6 · Padding');
    em.detail('值', `0x${pdHex(rest[1] >>> 0)}${rest[1] === 0 ? '（全 0，符合规范的 DRD 格式）' : ' ⚠ 规范要求此对象为全 0'}`);
    em.object('VDO #7 · DFP VDO');
    dfpVdo(em, rest[2] >>> 0, facts);
  } else if (kind === 'dfp') {
    em.object('VDO #5 · DFP VDO');
    dfpVdo(em, rest[0] >>> 0, facts);
  } else if (kind === 'ama') {
    em.object('VDO #5 · AMA VDO（已废弃）');
    amaVdo(em, rest[0] >>> 0, ctx, facts);
  } else {
    em.object('VDO #5 · UFP VDO');
    ufpVdo(em, rest[0] >>> 0, facts);
  }

  facts.unshift(...identityFacts(info));
  st.identity = { ...info, certStat: vdos[1], product: vdos[2] };
}

/** ID Header VDO（PD 3.2 Table 6.34）—— 链路不同，B29-27 的含义不同 */
function idHeaderVdo(em, v, ctx) {
  const cable = ctx.link === 'cable';
  const ptUfp = pdField(v, 29, 27);
  const ptDfp = pdField(v, 25, 23);
  const conn = pdField(v, 22, 21);
  const vid = pdField(v, 15, 0);

  em.detail('USB Host 能力 [B31]', pdFlag(pdBit(v, 31), '可枚举 USB 设备', '不可作 USB Host'));
  em.detail('USB Device 能力 [B30]', pdFlag(pdBit(v, 30), '可被枚举为 USB 设备', '不可作 USB 设备'));

  let productTypeText, vdoKind = null;
  if (cable) {
    productTypeText = PRODUCT_TYPE_CABLE[ptUfp];
    vdoKind = PRODUCT_TYPE_VDO_KIND.cable[ptUfp] ?? null;
    em.detail(`Product Type (Cable Plug/VPD) [${pdRange(29, 27)}]`, `${ptUfp.toString(2).padStart(3, '0')}b · ${productTypeText}`);
  } else {
    productTypeText = PRODUCT_TYPE_UFP[ptUfp];
    vdoKind = PRODUCT_TYPE_VDO_KIND.ufp[ptUfp] ?? null;
    em.detail(`Product Type (UFP) [${pdRange(29, 27)}]`, `${ptUfp.toString(2).padStart(3, '0')}b · ${productTypeText}`);
  }
  em.detail('Modal Operation Supported [B26]', pdFlag(pdBit(v, 26),
    '支持 Alternate Mode（会响应 Discover SVIDs/Modes）', '不支持 Alternate Mode'));
  if (cable) {
    em.detail(`Product Type (DFP) [${pdRange(25, 23)}]`, `Reserved（SOP' 链路不使用）· 0x${ptDfp.toString(16).toUpperCase()}`);
  } else {
    em.detail(`Product Type (DFP) [${pdRange(25, 23)}]`, `${ptDfp.toString(2).padStart(3, '0')}b · ${PRODUCT_TYPE_DFP[ptDfp]}`);
  }
  em.detail(`Connector Type [${pdRange(22, 21)}]`, `${conn.toString(2).padStart(2, '0')}b · ${CONNECTOR_TYPE[conn]}`);
  em.detail(`Reserved [${pdRange(20, 16)}]`, `0x${pdField(v, 20, 16).toString(16).toUpperCase()}`);
  em.detail(`USB Vendor ID [${pdRange(15, 0)}]`, `0x${pdHex(vid, 4)}`
    + (svidName(vid) ? ` · ${svidName(vid).replace('（厂商 ID）', '')}` : ''));

  return { ptUfp, ptDfp, conn, vid, productTypeText, vdoKind, cable, host: pdBit(v, 31), device: pdBit(v, 30), modal: pdBit(v, 26) };
}

function certStatVdo(em, v) {
  em.detail('XID [B31-0]', pdHex(v) + (v === 0 ? '（厂商未申请 XID）' : ''));
  return v;
}

function productVdo(em, v) {
  const pid = pdField(v, 31, 16), bcd = pdField(v, 15, 0);
  em.detail('USB Product ID [B31-16]', `0x${pdHex(pid, 4)}`);
  em.detail('bcdDevice [B15-0]', `0x${pdHex(bcd, 4)}`);
  return { pid, bcd };
}

function ufpVdo(em, v, facts) {
  const ver = pdField(v, 31, 29);
  em.detail(`UFP VDO Version [${pdRange(31, 29)}]`, `${UFP_VDO_VERSION[ver] ?? '无效取值（不得使用）'} · ${ver.toString(2).padStart(3, '0')}b`);
  em.detail('Reserved [B28]', pdBit(v, 28));
  const usb4 = pdBit(v, 27), usb32 = pdBit(v, 26);
  const usb2 = pdField(v, 25, 24);
  em.detail('USB4 Device 能力 [B27]', pdFlag(usb4, 'USB4 capable', '否'));
  em.detail('USB 3.2 Device 能力 [B26]', pdFlag(usb32, 'USB 3.2 capable', '否'));
  em.detail(`USB 2.0 Device 能力 [${pdRange(25, 24)}]`, `${usb2.toString(2).padStart(2, '0')}b · ${UFP_USB2[usb2]}`);
  em.detail(`Connector Type (Legacy) [${pdRange(23, 22)}]`, '00b（已废弃，连接器类型看 ID Header VDO）');
  em.detail(`Reserved [${pdRange(21, 11)}]`, `0x${pdField(v, 21, 11).toString(16).toUpperCase()}`);
  const vconnReq = pdBit(v, 7), vbusReq = pdBit(v, 6);
  em.detail(`VCONN Power [${pdRange(10, 8)}]`, vconnReq
    ? `${VCONN_POWER[pdField(v, 10, 8)]}`
    : `Reserved（未要求 VCONN）· 0x${pdField(v, 10, 8).toString(16).toUpperCase()}`);
  em.detail('VCONN Required [B7]', pdFlag(vconnReq, '需要 VCONN 才能工作', '不需要'));
  em.detail('VBUS Required [B6]', pdBit(v, 6) ? '1（不需要 VBUS）' : '0（需要 VBUS）');
  em.detail('No Signal Reconfig Alt Mode [B5]', pdFlag(pdBit(v, 5), '支持不改动信号的 Alt Mode', '否'));
  em.detail('Non-TBT3 Signal Reconfig Alt Mode [B4]', pdFlag(pdBit(v, 4), '支持改动信号的 Alt Mode（TBT3 除外）', '否'));
  em.detail('TBT3 Alt Mode [B3]', pdFlag(pdBit(v, 3), '支持 Thunderbolt 3 Alt Mode', '否'));
  const spd = pdField(v, 2, 0);
  em.detail(`USB Highest Speed [${pdRange(2, 0)}]`, `${spd.toString(2).padStart(3, '0')}b · ${USB_HIGHEST_SPEED[spd] ?? '无效取值（不得使用）'}`);

  const caps = [usb4 ? 'USB4' : null, usb32 ? 'USB3.2' : null, usb2 === 2 ? 'USB2' : null].filter(Boolean);
  if (caps.length) facts.push(`UFP ${caps.join('/')}`);
  if (spd in USB_HIGHEST_SPEED) facts.push(`最高速率 ${USB_HIGHEST_SPEED[spd]}`);
  if (pdBit(v, 26) || pdBit(v, 3) || pdBit(v, 5) || pdBit(v, 4)) facts.push('支持 Alt Mode');
  return v;
}

function dfpVdo(em, v, facts) {
  const ver = pdField(v, 31, 29);
  em.detail(`DFP VDO Version [${pdRange(31, 29)}]`, `${DFP_VDO_VERSION[ver] ?? '无效取值（不得使用）'} · ${ver.toString(2).padStart(3, '0')}b`);
  em.detail(`Reserved [${pdRange(28, 27)}]`, `0x${pdField(v, 28, 27).toString(16).toUpperCase()}`);
  const usb4 = pdBit(v, 26), usb32 = pdBit(v, 25), usb2 = pdBit(v, 24);
  em.detail('USB4 Host 能力 [B26]', pdFlag(usb4, 'Host 支持 USB4', '否'));
  em.detail('USB 3.2 Host 能力 [B25]', pdFlag(usb32, 'Host 支持 USB 3.2', '否（Power Brick / Hub 应为 0）'));
  em.detail('USB 2.0 Host 能力 [B24]', pdFlag(usb2, 'Host 支持 USB 2.0', '否（Power Brick / Hub 应为 0）'));
  em.detail(`Connector Type (Legacy) [${pdRange(23, 22)}]`, '00b（已废弃）');
  em.detail(`Reserved [${pdRange(21, 5)}]`, `0x${pdField(v, 21, 5).toString(16).toUpperCase()}`);
  em.detail(`Port Number [${pdRange(4, 0)}]`, `${pdField(v, 4, 0)}（设备内 DFP 端口编号）`);
  const caps = [usb4 ? 'USB4' : null, usb32 ? 'USB3.2' : null, usb2 ? 'USB2' : null].filter(Boolean);
  if (caps.length) facts.push(`DFP ${caps.join('/')}`);
  return v;
}

/**
 * 无源线缆 VDO（PD 3.2 Table 6.42）。
 * B17 / B10..9 / B2..0 三处字段的含义在 PD 3.0 与 3.1+ 之间有差异，
 * 而报文头只能标到「3.x」，故一律按现行规范解码，并在有歧义处补一句 3.0 的旧含义。
 */
function passiveCableVdo(em, v, ctx, facts) {
  const hw = pdField(v, 31, 28), fw = pdField(v, 27, 24);
  const vdoVer = pdField(v, 23, 21);
  em.detail(`Hardware Version [${pdRange(31, 28)}]`, `0x${hw.toString(16).toUpperCase()}（厂商自定义）`);
  em.detail(`Firmware Version [${pdRange(27, 24)}]`, `0x${fw.toString(16).toUpperCase()}（厂商自定义）`);
  em.detail(`VDO Version [${pdRange(23, 21)}]`, vdoVer === 0 ? 'Version 1.0' : `${vdoVer.toString(2).padStart(3, '0')}b · 无效取值（不得使用）`);
  em.detail('Reserved [B20]', pdBit(v, 20));
  const conn = pdField(v, 19, 18);
  em.detail(`USB Type-C plug to USB Type-C/Captive [${pdRange(19, 18)}]`,
    `${conn.toString(2).padStart(2, '0')}b · ${CABLE_CONNECTOR[conn]}`);
  const epr = pdBit(v, 17);
  em.detail('EPR Capable [B17]', pdFlag(epr, '线缆支持 48V/5A 的 EPR 运行', '不支持 EPR'));
  if (is3x(ctx)) {
    // 报文头只能标到 3.x，无法区分 3.0 与 3.1，所以这句对所有 3.x 包都成立
    em.detail('说明', 'B17「EPR Capable」是 PD 3.1 才定义的字段，PD 3.0 里该位为 Reserved'
      + '（报文头只标到 3.x，无法区分 3.0 / 3.1）');
  }
  const lat = pdField(v, 16, 13);
  em.detail(`Cable Latency [${pdRange(16, 13)}]`, `${CABLE_LATENCY_PASSIVE[lat]}`);
  const term = pdField(v, 12, 11);
  em.detail(`Cable Termination Type [${pdRange(12, 11)}]`, CABLE_TERMINATION_PASSIVE[term]);
  const vmaxCode = pdField(v, 10, 9);
  const vmaxTable = is3x(ctx) ? CABLE_VBUS_VOLTAGE_V31 : CABLE_VBUS_VOLTAGE_V30;
  em.detail(`Maximum VBUS Voltage [${pdRange(10, 9)}]`,
    `${vmaxCode.toString(2).padStart(2, '0')}b · ${vmaxTable[vmaxCode]}${vmaxNote(vmaxCode, ctx)}`);
  em.detail(`Reserved [${pdRange(8, 7)}]`, `0x${pdField(v, 8, 7).toString(16).toUpperCase()}`);
  const cur = pdField(v, 6, 5);
  em.detail(`VBUS Current Handling [${pdRange(6, 5)}]`, CABLE_VBUS_CURRENT[cur]);
  em.detail(`Reserved [${pdRange(4, 3)}]`, `0x${pdField(v, 4, 3).toString(16).toUpperCase()}`);
  const spd = pdField(v, 2, 0);
  em.detail(`USB Highest Speed [${pdRange(2, 0)}]`, cableSpeedText(spd));

  facts.push('无源线缆');
  facts.push(`${vmaxTable[vmaxCode]} / ${CABLE_VBUS_CURRENT[cur].replace(/（.*）/, '')}`);
  if (epr) facts.push('EPR');
  facts.push(CABLE_LATENCY_PASSIVE[lat]);
  return v;
}

function activeCableVdo1(em, v, ctx, facts) {
  const hw = pdField(v, 31, 28), fw = pdField(v, 27, 24), vdoVer = pdField(v, 23, 21);
  em.detail(`Hardware Version [${pdRange(31, 28)}]`, `0x${hw.toString(16).toUpperCase()}`);
  em.detail(`Firmware Version [${pdRange(27, 24)}]`, `0x${fw.toString(16).toUpperCase()}`);
  em.detail(`VDO Version [${pdRange(23, 21)}]`, ({
    0: 'Version 1.0（已废弃）', 1: '无效取值（不得使用）', 2: 'Version 1.2（已废弃）', 3: 'Version 1.3',
  })[vdoVer] ?? '无效取值（不得使用）');
  em.detail('Reserved [B20]', pdBit(v, 20));
  const conn = pdField(v, 19, 18);
  em.detail(`USB Type-C plug to USB Type-C/Captive [${pdRange(19, 18)}]`,
    `${conn.toString(2).padStart(2, '0')}b · ${CABLE_CONNECTOR[conn]}`);
  const epr = pdBit(v, 17);
  em.detail('EPR Capable [B17]', pdFlag(epr, '线缆支持 48V/5A 的 EPR 运行', '不支持 EPR'));
  if (is3x(ctx)) {
    em.detail('说明', 'B17「EPR Capable」是 PD 3.1 才定义的字段，PD 3.0 里该位为 Reserved'
      + '（报文头只标到 3.x，无法区分 3.0 / 3.1）');
  }
  const lat = pdField(v, 16, 13);
  em.detail(`Cable Latency [${pdRange(16, 13)}]`, CABLE_LATENCY_ACTIVE[lat]);
  em.detail(`Cable Termination Type [${pdRange(12, 11)}]`, CABLE_TERMINATION_ACTIVE[pdField(v, 12, 11)]);
  const vmaxCode = pdField(v, 10, 9);
  const vmaxTable = is3x(ctx) ? CABLE_VBUS_VOLTAGE_V31 : CABLE_VBUS_VOLTAGE_V30;
  em.detail(`Maximum VBUS Voltage [${pdRange(10, 9)}]`,
    `${vmaxCode.toString(2).padStart(2, '0')}b · ${vmaxTable[vmaxCode]}${vmaxNote(vmaxCode, ctx)}`);
  em.detail('SBU Supported [B8]', pdBit(v, 8) ? '1（不支持 SBU）' : '0（支持 SBU）');
  em.detail('SBU Type [B7]', pdBit(v, 7) ? '1（SBU 为有源/数字化）' : '0（SBU 为无源）');
  const cur = pdField(v, 6, 5);
  em.detail(`VBUS Current Handling [${pdRange(6, 5)}]`, CABLE_VBUS_CURRENT_ACTIVE[cur]);
  em.detail('VBUS Through Cable [B4]', pdFlag(pdBit(v, 4), '线缆内有 VBUS 导线', '无 VBUS 导线'));
  em.detail('SOP\'\' Controller Present [B3]', pdFlag(pdBit(v, 3), '支持 SOP\'\' 通信', '仅 SOP\''));
  const spd = pdField(v, 2, 0);
  em.detail(`USB Highest Speed [${pdRange(2, 0)}]`, cableSpeedText(spd));

  facts.push('有源线缆');
  facts.push(`${vmaxTable[vmaxCode]} / ${CABLE_VBUS_CURRENT_ACTIVE[cur]}`);
  facts.push(CABLE_LATENCY_ACTIVE[lat]);
  return v;
}

function activeCableVdo2(em, v, facts) {
  em.detail(`Maximum Operating Temperature [${pdRange(31, 24)}]`, `${pdField(v, 31, 24)} °C（插头内最高工作温度）`);
  em.detail(`Shutdown Temperature [${pdRange(23, 16)}]`, `${pdField(v, 23, 16)} °C（超过即关断有源器件）`);
  em.detail('Reserved [B15]', pdBit(v, 15));
  em.detail(`U3/CLd Power [${pdRange(14, 12)}]`, `${U3_CLD_POWER[pdField(v, 14, 12)]}（U3/CLd 状态下的自身功耗）`);
  em.detail('U3 to U0 transition [B11]', pdBit(v, 11) ? '1（经 U3S 过渡）' : '0（U3 直通 U0）');
  em.detail('Physical Connection [B10]', pdBit(v, 10) ? '1（光连接）' : '0（铜连接）');
  em.detail('Active Element [B9]', pdBit(v, 9) ? '1（Active Re-timer）' : '0（Active Re-driver）');
  em.detail('USB4 Supported [B8]', pdBit(v, 8) ? '1（不支持 USB4）' : '0（支持 USB4）');
  em.detail(`USB 2.0 Hub Hops Consumed [${pdRange(7, 6)}]`, String(pdField(v, 7, 6)));
  em.detail('USB 2.0 Supported [B5]', pdBit(v, 5) ? '1（不支持 USB2）' : '0（支持 USB2）');
  em.detail('USB 3.2 Supported [B4]', pdBit(v, 4) ? '1（不支持 USB3 SuperSpeed）' : '0（支持 USB3 SuperSpeed）');
  em.detail('USB Lanes Supported [B3]', pdBit(v, 3) ? '1（两条 lane）' : '0（一条 lane）');
  em.detail('Optically Isolated Active Cable [B2]', pdFlag(pdBit(v, 2)));
  em.detail('[USB4] Asymmetric Mode [B1]', pdFlag(pdBit(v, 1)));
  em.detail('USB Gen [B0]', pdBit(v, 0) ? '1（Gen2 及以上）' : '0（Gen1，仅 USB3 线缆）');
  facts.push(`最高工作温度 ${pdField(v, 31, 24)}°C`);
  return v;
}

function vpdVdo(em, v, facts) {
  const hw = pdField(v, 31, 28), fw = pdField(v, 27, 24), vdoVer = pdField(v, 23, 21);
  em.detail(`HW Version [${pdRange(31, 28)}]`, `0x${hw.toString(16).toUpperCase()}`);
  em.detail(`Firmware Version [${pdRange(27, 24)}]`, `0x${fw.toString(16).toUpperCase()}`);
  em.detail(`VDO Version [${pdRange(23, 21)}]`, vdoVer === 0 ? 'Version 1.0' : '无效取值（不得使用）');
  em.detail(`Reserved [${pdRange(20, 17)}]`, `0x${pdField(v, 20, 17).toString(16).toUpperCase()}`);
  const ct = pdBit(v, 0);
  em.detail(`Maximum VBUS Voltage [${pdRange(16, 15)}]`, VPD_VBUS_VOLTAGE[pdField(v, 16, 15)]);
  em.detail('Charge Through Current Support [B14]', ct
    ? (pdBit(v, 14) ? '1（5 A）' : '0（3 A）')
    : `${pdBit(v, 14)}（未开启 Charge Through，此域 Reserved）`);
  em.detail('Reserved [B13]', pdBit(v, 13));
  const vbusImp = pdField(v, 12, 7), gndImp = pdField(v, 6, 1);
  em.detail(`VBUS Impedance [${pdRange(12, 7)}]`, ct ? `${vbusImp * 2} mΩ（2mΩ 步长）` : 'Reserved（未开启 Charge Through）');
  em.detail(`Ground Impedance [${pdRange(6, 1)}]`, ct ? `${gndImp} mΩ（1mΩ 步长）` : 'Reserved（未开启 Charge Through）');
  em.detail('Charge Through Support [B0]', pdFlag(ct, '支持 Charge Through（可为下游供电）', '不支持'));
  facts.push(`VPD${ct ? ' 支持 Charge Through' : ''}`);
  return v;
}

/** 旧版 AMA VDO（PD 3.0 Table 6-37 / PD 2.0 Table 6-30） */
function amaVdo(em, v, ctx, facts) {
  em.detail('说明', 'AMA（Alternate Mode Adapter）产品类型已被 PD 3.1 废弃，新设计应改用 UFP VDO');
  em.detail(`HW Version [${pdRange(31, 28)}]`, `0x${pdField(v, 31, 28).toString(16).toUpperCase()}`);
  em.detail(`Firmware Version [${pdRange(27, 24)}]`, `0x${pdField(v, 27, 24).toString(16).toUpperCase()}`);
  if (!(ctx.revText === '2.0' || ctx.revText === '1.0')) {
    // 3.x（含 3.0）：有 VDO Version 字段，B20…8 保留
    em.detail(`VDO Version [${pdRange(23, 21)}]`, pdField(v, 23, 21) === 0 ? 'Version 1.0' : '保留值（不得使用）');
    em.detail(`Reserved [${pdRange(20, 8)}]`, `0x${pdField(v, 20, 8).toString(16).toUpperCase()}`);
  } else {
    // PD 2.0：B23…12 保留，B11…8 是四路 SuperSpeed 方向性
    em.detail(`Reserved [${pdRange(23, 12)}]`, `0x${pdField(v, 23, 12).toString(16).toUpperCase()}`);
    em.detail('SSTX1 Directionality [B11]', pdBit(v, 11) ? '1（可配置）' : '0（固定）');
    em.detail('SSTX2 Directionality [B10]', pdBit(v, 10) ? '1（可配置）' : '0（固定）');
    em.detail('SSRX1 Directionality [B9]', pdBit(v, 9) ? '1（可配置）' : '0（固定）');
    em.detail('SSRX2 Directionality [B8]', pdBit(v, 8) ? '1（可配置）' : '0（固定）');
  }
  em.detail(`VCONN power [${pdRange(7, 5)}]`, pdBit(v, 4) ? VCONN_POWER[pdField(v, 7, 5)] : 'Reserved（未要求 VCONN）');
  em.detail('VCONN required [B4]', pdFlag(pdBit(v, 4)));
  em.detail('VBUS required [B3]', pdBit(v, 3) ? '1（不需要 VBUS）' : '0（需要 VBUS）');
  em.detail(`USB SuperSpeed Signaling Support [${pdRange(2, 0)}]`, AMA_SUPERSPEED_V30[pdField(v, 2, 0)]);
  facts.push('AMA（已废弃形态）');
  return v;
}

/** 产品类型的中文短名（仅供一句话摘要；带规范原文的完整名称在详情各字段里） */
const PT_SHORT = {
  cable: { 0: '非线缆插头', 3: '无源线缆', 4: '有源线缆', 6: 'VPD（VCONN 供电设备）' },
  ufp: { 0: '非 UFP', 1: 'PDUSB Hub', 2: 'PDUSB 外设', 3: 'PSD（电源设备）', 5: 'AMA（已废弃）' },
  dfp: { 0: '非 DFP', 1: 'PDUSB Hub', 2: 'PDUSB Host', 3: 'Power Brick' },
};

/**
 * ID Header 的关键信息 → 若干条独立事实。
 * 拆成多条而不是一句话，是为了让 Product Type VDO 自己也推入的「无源线缆」等
 * 事实能与这里的重复项合并（摘要处按整条去重），摘要不会出现两遍同样的内容。
 */
function identityFacts(info) {
  const out = [];
  if (info.cable) {
    if (info.ptUfp) out.push(PT_SHORT.cable[info.ptUfp] ?? `保留产品类型 ${info.ptUfp}`);
  } else {
    // 端口侧 UFP / DFP 各有一个产品类型字段；为 0 表示「不是该角色」，不必写出来
    const u = info.ptUfp ? (PT_SHORT.ufp[info.ptUfp] ?? `保留产品类型 ${info.ptUfp}`) : null;
    const d = info.ptDfp ? (PT_SHORT.dfp[info.ptDfp] ?? `保留产品类型 ${info.ptDfp}`) : null;
    if (u && d && u !== d) out.push(`${u} / ${d}`);
    else if (u) out.push(u);
    else if (d) out.push(d);
  }
  if (info.vid) {
    const vn = svidName(info.vid);
    out.push(`VID 0x${pdHex(info.vid, 4)}${vn ? `（${vn.replace('（厂商 ID）', '')}）` : ''}`);
  }
  return out;
}

/* ══════════════════ Discover SVIDs ══════════════════ */

function decodeDiscoverSvids(st, em, vdos, ctx, ack, facts) {
  if (ack !== 'ACK') {
    pushNonAckFact(facts, ack, vdos, 'Discover SVIDs');
    return;
  }
  if (!vdos.length) {
    em.note('⚠ Discover SVIDs ACK 未携带 VDO');
    return;
  }
  const list = [];
  vdos.forEach((v, i) => {
    const a = pdField(v, 31, 16), b = pdField(v, 15, 0);
    em.object(`VDO #${i + 2} · Responder VDO（两个 SVID）`);
    em.detail('SVID n [B31-16]', a === 0 ? '0x0000（列表结束）' : svidText(a));
    em.detail('SVID n+1 [B15-0]', b === 0 ? '0x0000（列表结束）' : svidText(b));
    if (a) list.push(a);
    if (b) list.push(b);
  });
  st.svidList = list.slice();
  facts.push(list.length ? `SVID: ${list.map((s) => `0x${pdHex(s, 4)}`).join(', ')}` : '无 SVID');
  return list;
}

/* ══════════════════ Discover Modes ══════════════════ */

function decodeDiscoverModes(st, em, vdos, ctx, ack, svid, facts) {
  if (ack !== 'ACK') {
    pushNonAckFact(facts, ack, vdos, 'Discover Modes');
    return;
  }
  if (!vdos.length) {
    em.note('⚠ Discover Modes ACK 未携带 VDO');
    return;
  }
  const name = svidName(svid);
  vdos.forEach((v, i) => {
    em.object(`VDO #${i + 2} · Mode VDO #${i + 1}`);
    em.detail('对象位置', `${i + 1}（Enter/Exit Mode 用该值引用本 Mode）`);
    em.detail('原始值', `0x${pdHex(v)}`);
    if (svid === SVID_PD) {
      em.detail('说明', 'PD SID（0xFF00）下不应出现 Mode VDO');
    } else {
      em.detail('说明', `Mode VDO 的内容由 SVID ${name ?? `0x${pdHex(svid, 4)}`} 的标准/厂商定义，本工具按原始值展示`);
    }
  });
  facts.push(`SVID 0x${pdHex(svid, 4)} 的 ${vdos.length} 个 Mode VDO`);
  return vdos.length;
}

/* ══════════════════ Enter / Exit Mode ══════════════════ */

function decodeEnterExitMode(em, vdos, ctx, ack, label, facts) {
  if (vdos.length) {
    em.object(`VDO #2 · ${label} 携带的 SVID 自定义数据`);
    em.detail('原始值', `0x${pdHex(vdos[0])}`);
    em.detail('说明', 'Enter Mode 请求最多带 1 个 VDO，内容由 Alternate Mode 定义；ACK/NAK 不带 VDO');
  }
  if (ack === 'BUSY') facts.push('⚠ BUSY 不是 Enter/Exit Mode 的合法响应（规范只允许 ACK/NAK）');
  return null;
}

/* ══════════════════ Attention ══════════════════ */

function decodeAttention(em, vdos, ctx, svid, facts) {
  if (vdos.length) {
    em.object('VDO #2 · Attention 携带的 SVID 自定义数据');
    em.detail('原始值', `0x${pdHex(vdos[0])}`);
    em.detail('说明', 'Attention 最多带 1 个 VDO，内容由 Alternate Mode 定义');
  }
  em.detail('响应要求', 'Attention 不需要响应（GoodCRC 之外无应答）');
  return null;
}
