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
import { svidText, svidName, isStandardSvid, SVID_PD } from './svid.js';
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
  else if (ack === 'BUSY') facts.push(`对端忙，稍后重试 ${cmdName}${extra}`);
}

/**
 * 线缆 VDO 的 USB Highest Speed（B2..0）。
 * 按现行规范（PD 3.1+）解码；PD 3.0 时 011b 及以上还是保留值，取值到 3 以上时补一句说明。
 */
function cableSpeedText(spd, ctx) {
  const b = spd.toString(2).padStart(3, '0') + 'b';
  if (ctx.specRevision === '3.1' && spd >= 4) return `${b} · Reserved（PD 3.1 v1.4）`;
  const t = USB_HIGHEST_SPEED[spd];
  if (!t) return `${b} · 无效取值（不得使用）`;
  if (ctx.specRevision) return `${b} · ${t}`;
  if (spd === 4) return `${b} · ${t}（PD 3.1 v1.4 中为 Reserved）`;
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
  st.activeModes ??= {}; st.modes ??= {}; st.identities ??= {};
  const head = vdos[0] >>> 0;
  const svid = pdField(head, 31, 16);
  const structured = pdBit(head, 15) === 1;
  const extra = vdos.slice(1);
  const facts = [];

  em.object('VDO #1 · VDM Header');
  em.detail(structured ? 'SVID [B31-16]' : 'Vendor ID (VID) [B31-16]', svidText(svid, ctx));
  em.detail('VDM Type [B15]', pdFlag(structured, 'Structured VDM（结构化）', 'Unstructured VDM（厂商私有）'));

  if (!structured) {
    const payload = pdField(head, 14, 0);
    em.detail('Available for Vendor Use [B14-0]', `0x${payload.toString(16).toUpperCase().padStart(4, '0')}`);
    if (svid === 0 || isStandardSvid(svid, ctx)) {
      em.warn?.('非结构化 VDM 的 B31–16 必须是 USB-IF 分配的厂商 VID，不能使用标准 SVID 或 0x0000', 'VDM_FIELD');
    }
    if (ctx.sop && !['SOP', "SOP'", "SOP''"].includes(ctx.sop)) {
      em.warn?.('非结构化 VDM 仅允许用于 SOP*（SOP/SOP\'/SOP\'\'）链路', 'SOP');
    }
    if (ctx.sop === 'SOP' && ctx.dataRole !== undefined && ctx.dataRole !== null && ctx.dataRole !== 1) {
      em.warn?.('非结构化 VDM 只能由 DFP 发起；当前 SOP 发送方是 UFP', 'ROLE');
    }
    if (ctx.link === 'cable' && ctx.role === 'Plug') {
      em.warn?.('Cable Plug 只能作为非结构化 VDM 响应方，不能发起消息', 'ROLE');
    }
    const vendor = svidName(svid, ctx);
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
  ctx = { ...ctx, vdmVersionMajor: verMajor, vdmVersionMinor: verMinor,
    knownModeCount: st.modes?.[svid]?.length };
  pdValidateVdm(em, head, extra, ctx);

  const minorText = cmd >= 16
    ? `由 SVID 定义 · ${verMinor.toString(2).padStart(2, '0')}b`
    : verMajor === 0 || ['3.0', '3.1'].includes(ctx.specRevision)
      ? `Reserved · ${verMinor.toString(2).padStart(2, '0')}b`
      : !ctx.specRevision && verMajor === 1
      ? `${verMinor.toString(2).padStart(2, '0')}b · PD 3.2: ${VDM_VER_MINOR[verMinor] ?? 'Invalid'}；PD 3.0/3.1: Reserved`
      : `${VDM_VER_MINOR[verMinor] ?? '无效取值（不得使用）'} · ${verMinor.toString(2).padStart(2, '0')}b`;
  let majorText = VDM_VER_MAJOR[verMajor] ?? '无效';
  if (verMajor === 0) {
    if (ctx.specRevision === '2.0') majorText = 'Version 1.0';
    else if (['3.0', '3.1'].includes(ctx.specRevision)) majorText = 'Version 1.0（该 PD 版本 Shall Not be used）';
    else if (ctx.specRevision === '3.2') majorText = 'Version 1.0（Deprecated for new designs）';
    else if (!ctx.specRevision && ctx.revText === '3.x') majorText = 'Version 1.0（PD 3.0/3.1 不得使用；PD 3.2 已弃用）';
  } else if (verMajor === 1 && ctx.specRevision === '2.0') {
    majorText = 'Version 2.x（PD 2.0 Reserved）';
  }
  em.detail('Structured VDM Version (Major) [B14-13]', `${majorText} · ${verMajor.toString(2).padStart(2, '0')}b`);
  em.detail('Structured VDM Version (Minor) [B12-11]', minorText);
  em.detail('Object Position [B10-8]', `${objPos}`
    + (cmd >= 16 ? '（由 SVID 定义）' : cmd === 5 && objPos === 7 ? '（退出全部 Mode）' : cmd >= 4 && cmd <= 6 ? `（指向 Discover Modes 列表里的第 ${objPos} 个 Mode）`
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

  if (cmdType === 1 && cmd === 4) st.activeModes[`${svid}:${objPos}`] = true;
  if (cmdType === 1 && cmd === 5) {
    if (objPos === 7) st.activeModes = {};
    else delete st.activeModes[`${svid}:${objPos}`];
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
      em.detail('说明', '对端忙，Discover Identity 可返回 BUSY；请求方稍后重试');
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

  const legacyLayout = ctx.revText === '2.0' || ctx.revText === '1.0' || ctx.specRevision === '3.0';
  if (!rest.length) {
    em.object('无 Product Type VDO');
    em.detail('说明', `ID Header VDO 声明的产品类型为「${info.productTypeText}」，未捕获 Product Type VDO；早期 PD 2.0/3.0 的 Hub/Peripheral 不返回此 VDO`);
    if (ctx.link === 'cable' && kind) em.warn?.('Discover Identity 缺少必需的线缆/VPD VDO', 'VDM_COUNT');
    else if (kind === 'ama' || !legacyLayout && (kind === 'ufp' || info.dfpVdoKind === 'dfp')) {
      em.warn?.('Discover Identity 缺少所声明产品类型要求的 VDO', 'VDM_COUNT');
    }
  } else if (ctx.link === 'cable') {
    if (kind === 'activeCable') {
      em.object('VDO #5 · Active Cable VDO1');
      const ver = pdField(rest[0], 23, 21);
      if (legacyLayout || ver === 0) pdLegacyCableVdo(em, rest[0] >>> 0, ctx, true, facts);
      else activeCableVdo1(em, rest[0] >>> 0, ctx, facts);
      if (!legacyLayout && ver >= 2 && rest[1] !== undefined) {
        em.object('VDO #6 · Active Cable VDO2');
        activeCableVdo2(em, rest[1] >>> 0, ctx, facts);
      } else if (!legacyLayout && ver >= 2) {
        em.note('⚠ 有源线缆缺少 Active Cable VDO2');
        em.warn?.('有源线缆 VDO Version 1.2/1.3 需要 VDO2', 'VDM_COUNT');
      }
      const expected = !legacyLayout && ver >= 2 ? 2 : 1;
      showUnexpectedIdentityVdos(em, rest, expected, 'Active Cable');
    } else if (kind === 'vpd') {
      em.object('VDO #5 · VPD VDO');
      vpdVdo(em, rest[0] >>> 0, facts);
      showUnexpectedIdentityVdos(em, rest, 1, 'VPD');
    } else if (kind === 'passiveCable') {
      em.object('VDO #5 · Passive Cable VDO');
      if (legacyLayout) pdLegacyCableVdo(em, rest[0] >>> 0, ctx, false, facts);
      else passiveCableVdo(em, rest[0] >>> 0, ctx, facts);
      showUnexpectedIdentityVdos(em, rest, 1, 'Passive Cable');
    } else {
      rest.forEach((v, i) => { em.object(`VDO #${i + 5} · 未知产品类型`); em.detail('原始值', `0x${pdHex(v)}`); });
    }
  } else if (!legacyLayout && info.ptUfp && info.ptDfp
    && ['ufp', 'ama'].includes(info.vdoKind) && info.dfpVdoKind === 'dfp') {
    em.object('VDO #5 · UFP VDO');
    if (info.vdoKind === 'ufp') ufpVdo(em, rest[0] >>> 0, ctx, facts);
    else amaVdo(em, rest[0] >>> 0, ctx, facts);
    em.object('VDO #6 · Padding');
    em.detail('值', rest[1] === undefined ? '缺失' : `0x${pdHex(rest[1])}${rest[1] === 0 ? '（全 0）' : ' ⚠ 必须为全 0'}`);
    if (rest[1] !== undefined && rest[1] !== 0) em.warn?.('DRD Discover Identity 的 Padding Object 必须为全 0', 'VDM_FIELD');
    if (rest[2] !== undefined) { em.object('VDO #7 · DFP VDO'); dfpVdo(em, rest[2] >>> 0, facts); }
    else em.warn?.('DRD 的 DFP VDO 必须位于对象 #7', 'VDM_COUNT');
    if (rest.length > 3) showUnexpectedIdentityVdos(em, rest, 3, 'DRD');
  } else if (info.dfpVdoKind === 'dfp' && !info.ptUfp && !legacyLayout) {
    em.object('VDO #5 · DFP VDO');
    dfpVdo(em, rest[0] >>> 0, facts);
    showUnexpectedIdentityVdos(em, rest, 1, 'DFP');
  } else if (kind === 'ama') {
    em.object(`VDO #5 · AMA VDO${amaDeprecatedText(ctx)}`);
    amaVdo(em, rest[0] >>> 0, ctx, facts);
    showUnexpectedIdentityVdos(em, rest, 1, 'AMA');
  } else if (kind === 'ufp' && !legacyLayout) {
    em.object('VDO #5 · UFP VDO');
    ufpVdo(em, rest[0] >>> 0, ctx, facts);
    showUnexpectedIdentityVdos(em, rest, 1, 'UFP');
  } else {
    rest.forEach((v, i) => { em.object(`VDO #${i + 5} · 产品自定义/保留对象`); em.detail('原始值', `0x${pdHex(v)}`); });
  }

  facts.unshift(...identityFacts(info, ctx));
  st.identity = { ...info, certStat: vdos[1], product: vdos[2] };
  st.identities[ctx.role ?? 'unknown'] = st.identity;
}

/** ID Header VDO（PD 3.2 Table 6.34）—— 链路不同，B29-27 的含义不同 */
function idHeaderVdo(em, v, ctx) {
  const cable = ctx.link === 'cable';
  const ptUfp = pdField(v, 29, 27);
  const pd2 = ctx.revText === '2.0' || ctx.revText === '1.0';
  const old3 = ctx.specRevision === '3.0';
  const ptDfp = pd2 ? 0 : pdField(v, 25, 23);
  const conn = pdField(v, 22, 21);
  const vid = pdField(v, 15, 0);

  em.detail('USB Host 能力 [B31]', pdFlag(pdBit(v, 31), '可枚举 USB 设备', '不可作 USB Host'));
  em.detail('USB Device 能力 [B30]', pdFlag(pdBit(v, 30), '可被枚举为 USB 设备', '不可作 USB 设备'));

  let productTypeText, vdoKind = null, dfpVdoKind = null;
  let dfpProductTypeText = null;
  if (cable) {
    productTypeText = cableProductTypeText(ptUfp, ctx);
    vdoKind = PRODUCT_TYPE_VDO_KIND.cable[ptUfp] ?? null;
    if ((pd2 || old3) && ptUfp === 6) vdoKind = null;
    em.detail(`Product Type (Cable Plug/VPD) [${pdRange(29, 27)}]`, `${ptUfp.toString(2).padStart(3, '0')}b · ${productTypeText}`);
    if ((pd2 || old3) && ptUfp >= 5 || ctx.specRevision === '3.1' && ptUfp === 5) {
      em.warn?.('该 Cable Plug/VPD Product Type 在所选 PD 版本中为 Reserved', 'VDM_FIELD');
    }
  } else {
    productTypeText = ufpProductTypeText(ptUfp, ctx);
    vdoKind = PRODUCT_TYPE_VDO_KIND.ufp[ptUfp] ?? null;
    if ((pd2 || old3) && ptUfp === 3) vdoKind = null;
    if (ctx.specRevision === '3.1' && ptUfp === 5) vdoKind = null;
    em.detail(`Product Type (UFP) [${pdRange(29, 27)}]`, `${ptUfp.toString(2).padStart(3, '0')}b · ${productTypeText}`);
    if ((pd2 || old3) && [3, 4, 6, 7].includes(ptUfp) || ctx.specRevision === '3.1' && ptUfp >= 4 || ctx.specRevision === '3.2' && [4, 6, 7].includes(ptUfp)) {
      em.warn?.('该 UFP Product Type 在所选 PD 版本中为 Reserved/Invalid', 'VDM_FIELD');
    }
  }
  em.detail('Modal Operation Supported [B26]', pdFlag(pdBit(v, 26),
    '支持 Alternate Mode（会响应 Discover SVIDs/Modes）', '不支持 Alternate Mode'));
  if (pd2) {
    em.detail('Reserved [B25-16]', pdField(v, 25, 16));
  } else if (cable) {
    em.detail(`Product Type (DFP) [${pdRange(25, 23)}]`, `Reserved（SOP' 链路不使用）· 0x${ptDfp.toString(16).toUpperCase()}`);
  } else {
    dfpProductTypeText = dfpProductTypeTextForRevision(ptDfp, ctx);
    em.detail(`Product Type (DFP) [${pdRange(25, 23)}]`, `${ptDfp.toString(2).padStart(3, '0')}b · ${dfpProductTypeText}`);
    if (ctx.specRevision === '3.1' && ptDfp === 4 || ctx.specRevision === '3.2' && ptDfp >= 5) {
      em.warn?.('该 DFP Product Type 在所选 PD 版本中为 Reserved/Invalid', 'VDM_FIELD');
    }
  }
  if (!pd2) {
    if (old3) em.detail('Reserved [B22-16]', pdField(v, 22, 16));
    else {
      em.detail(`Connector Type [${pdRange(22, 21)}]`, `${conn.toString(2).padStart(2, '0')}b · ${CONNECTOR_TYPE[conn]}`);
      em.detail(`Reserved [${pdRange(20, 16)}]`, `0x${pdField(v, 20, 16).toString(16).toUpperCase()}`);
    }
  }
  em.detail(`USB Vendor ID [${pdRange(15, 0)}]`, `0x${pdHex(vid, 4)}`
    + (svidName(vid, ctx) ? ` · ${svidName(vid, ctx).replace('（厂商 ID）', '')}` : ''));

  if (!cable) {
    dfpVdoKind = PRODUCT_TYPE_VDO_KIND.dfp[ptDfp] ?? null;
    // AMA/AMC 旧 Product Type 在 PD 2.0/3.0 中复用同一个旧格式 VDO；PD 3.2 保留其弃用标记。
    if (ptDfp === 4 && (old3 || ctx.specRevision === '3.2' || !ctx.specRevision)) dfpVdoKind = 'ama';
    if (ctx.specRevision === '3.1' && ptDfp === 4) dfpVdoKind = null;
    if (vdoKind !== 'ama' && dfpVdoKind === 'ama') vdoKind = 'ama';
  }
  if (!ctx.specRevision && ctx.revText === '3.x' && ptUfp === 3 && !cable) {
    em.detail('版本差异', 'Product Type 011b：PD 3.0 为 Reserved，PD 3.1/3.2 为 PSD');
  }
  if (!ctx.specRevision && ctx.revText === '3.x' && ptUfp === 5) {
    em.detail('版本差异', 'Product Type 101b：PD 3.0 为 AMA、PD 3.1 为 Reserved、PD 3.2 为已弃用 AMA');
  }
  if (!ctx.specRevision && ctx.revText === '3.x' && cable && ptUfp === 6) {
    em.detail('版本差异', 'Product Type 110b：PD 3.0 为 Reserved，PD 3.1/3.2 为 VPD');
  }
  if (!ctx.specRevision && ctx.revText === '3.x' && !cable && ptDfp === 4) {
    em.detail('版本差异', 'DFP Product Type 100b：PD 3.0 为 AMC、PD 3.1 为 Reserved、PD 3.2 为已弃用 AMC');
  }
  if (!ctx.specRevision && ctx.revText === '3.x' && !cable) {
    em.detail('版本差异', `Connector Type B22–21：PD 3.0 为 Reserved，PD 3.1/3.2 为 ${CONNECTOR_TYPE[conn]}`);
  }
  return { ptUfp, ptDfp, conn, vid, productTypeText, dfpProductTypeText, vdoKind, dfpVdoKind, cable,
    host: pdBit(v, 31), device: pdBit(v, 30), modal: pdBit(v, 26) };
}

function ufpProductTypeText(code, ctx) {
  if (ctx.specRevision === '2.0' || ctx.specRevision === '3.0') {
    if ([3, 4, 6, 7].includes(code)) return 'Reserved';
  }
  if (ctx.specRevision === '3.1' && code >= 4) return 'Reserved';
  if (code === 5 && ['2.0', '3.0'].includes(ctx.specRevision)) return 'Alternate Mode Adapter (AMA)';
  if (!ctx.specRevision && ctx.revText === '3.x' && code === 3) return 'Reserved (PD 3.0) / PSD (PD 3.1+)';
  if (!ctx.specRevision && ctx.revText === '3.x' && code === 5) return 'AMA (PD 3.0/3.2; Reserved in PD 3.1)';
  return PRODUCT_TYPE_UFP[code];
}

function cableProductTypeText(code, ctx) {
  if ((ctx.specRevision === '2.0' || ctx.specRevision === '3.0') && code >= 5) return 'Reserved';
  if (!ctx.specRevision && ctx.revText === '3.x' && code === 6) return 'Reserved (PD 3.0) / VPD (PD 3.1+)';
  return PRODUCT_TYPE_CABLE[code];
}

function dfpProductTypeTextForRevision(code, ctx) {
  if (ctx.specRevision === '2.0') return 'Reserved';
  if (ctx.specRevision === '3.0' && code === 4) return 'Alternate Mode Controller (AMC)';
  if (ctx.specRevision === '3.1' && code >= 4) return 'Reserved';
  if (!ctx.specRevision && ctx.revText === '3.x' && code === 4) return 'AMC (PD 3.0/3.2; Reserved in PD 3.1)';
  return PRODUCT_TYPE_DFP[code];
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

function showUnexpectedIdentityVdos(em, vdos, expected, product) {
  if (vdos.length <= expected) return;
  em.warn?.(`${product} Discover Identity ACK 含有多余的 Product Type VDO`, 'VDM_COUNT');
  vdos.slice(expected).forEach((v, i) => {
    em.object(`VDO #${i + expected + 5} · 非预期 ${product} 对象`);
    em.detail('原始值', `0x${pdHex(v)}`);
  });
}

function amaDeprecatedText(ctx) {
  if (['3.1', '3.2'].includes(ctx.specRevision)) return '（已废弃）';
  if (!ctx.specRevision && ctx.revText === '3.x') return '（PD 3.1+ 已废弃）';
  return '';
}

function ufpVdo(em, v, ctx, facts) {
  const ver = pdField(v, 31, 29);
  em.detail(`UFP VDO Version [${pdRange(31, 29)}]`, `${UFP_VDO_VERSION[ver] ?? '无效取值（不得使用）'} · ${ver.toString(2).padStart(3, '0')}b`);
  em.detail('Reserved [B28]', pdBit(v, 28));
  const usb4 = pdBit(v, 27), usb32 = pdBit(v, 26);
  const usb2 = pdField(v, 25, 24);
  em.detail('USB4 Device 能力 [B27]', pdFlag(usb4, 'USB4 capable', '否'));
  em.detail('USB 3.2 Device 能力 [B26]', pdFlag(usb32, 'USB 3.2 capable', '否'));
  const usb2Text = ctx.specRevision === '3.1'
    ? ({ 0: UFP_USB2[0], 1: UFP_USB2[2], 2: UFP_USB2[1], 3: UFP_USB2[3] })[usb2]
    : !ctx.specRevision && (usb2 === 1 || usb2 === 2)
      ? `PD 3.1 v1.4：${usb2 === 1 ? UFP_USB2[2] : UFP_USB2[1]}；PD 3.2 v1.2：${UFP_USB2[usb2]}`
      : UFP_USB2[usb2];
  em.detail(`USB 2.0 Device 能力 [${pdRange(25, 24)}]`, `${usb2.toString(2).padStart(2, '0')}b · ${usb2Text}`);
  em.detail(`Connector Type (Legacy) [${pdRange(23, 22)}]`, `${pdField(v, 23, 22).toString(2).padStart(2, '0')}b（新版已废弃，连接器类型看 ID Header VDO）`);
  em.detail(`Reserved [${pdRange(21, 11)}]`, `0x${pdField(v, 21, 11).toString(16).toUpperCase()}`);
  const vconnReq = pdBit(v, 7), vbusReq = pdBit(v, 6);
  const altMode = pdField(v, 5, 3) !== 0;
  em.detail(`VCONN Power [${pdRange(10, 8)}]`, altMode && vconnReq
    ? `${VCONN_POWER[pdField(v, 10, 8)]}`
    : `Reserved（未要求 VCONN）· 0x${pdField(v, 10, 8).toString(16).toUpperCase()}`);
  em.detail('VCONN Required [B7]', altMode ? pdFlag(vconnReq, '需要 VCONN 才能工作', '不需要') : `${vconnReq}（无 Alt Mode，Reserved）`);
  em.detail('VBUS Required [B6]', altMode ? (vbusReq ? '1（不需要 VBUS）' : '0（需要 VBUS）') : `${vbusReq}（无 Alt Mode，Reserved）`);
  em.detail('No Signal Reconfig Alt Mode [B5]', pdFlag(pdBit(v, 5), '支持不改动信号的 Alt Mode', '否'));
  em.detail('Non-TBT3 Signal Reconfig Alt Mode [B4]', pdFlag(pdBit(v, 4), '支持改动信号的 Alt Mode（TBT3 除外）', '否'));
  em.detail('TBT3 Alt Mode [B3]', pdFlag(pdBit(v, 3), '支持 Thunderbolt 3 Alt Mode', '否'));
  const spd = pdField(v, 2, 0);
  em.detail(`USB Highest Speed [${pdRange(2, 0)}]`, cableSpeedText(spd, ctx));

  const normalUsb2 = ctx.specRevision === '3.1' ? usb2 === 1 : ctx.specRevision === '3.2' && usb2 === 2;
  const caps = [usb4 ? 'USB4' : null, usb32 ? 'USB3.2' : null, normalUsb2 ? 'USB2' : null].filter(Boolean);
  if (caps.length) facts.push(`UFP ${caps.join('/')}`);
  if (spd in USB_HIGHEST_SPEED && !(ctx.specRevision === '3.1' && spd >= 4)) facts.push(`最高速率 ${USB_HIGHEST_SPEED[spd]}`);
  if (pdBit(v, 3) || pdBit(v, 5) || pdBit(v, 4)) facts.push('支持 Alt Mode');
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
  em.detail(`Connector Type (Legacy) [${pdRange(23, 22)}]`, `${pdField(v, 23, 22).toString(2).padStart(2, '0')}b（新版已废弃）`);
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
  em.detail(`USB Highest Speed [${pdRange(2, 0)}]`, cableSpeedText(spd, ctx));

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
  em.detail('SBU Type [B7]', pdBit(v, 8) ? `${pdBit(v, 7)}（未支持 SBU，此域 Reserved）` : pdBit(v, 7) ? '1（SBU 为有源/数字化）' : '0（SBU 为无源）');
  const cur = pdField(v, 6, 5);
  em.detail(`VBUS Current Handling [${pdRange(6, 5)}]`, pdBit(v, 4) ? CABLE_VBUS_CURRENT_ACTIVE[cur] : `${cur}（无 VBUS 导线，此域 Reserved）`);
  em.detail('VBUS Through Cable [B4]', pdFlag(pdBit(v, 4), '线缆内有 VBUS 导线', '无 VBUS 导线'));
  em.detail('SOP\'\' Controller Present [B3]', pdFlag(pdBit(v, 3), '支持 SOP\'\' 通信', '仅 SOP\''));
  const spd = pdField(v, 2, 0);
  em.detail(`USB Highest Speed [${pdRange(2, 0)}]`, cableSpeedText(spd, ctx));

  facts.push('有源线缆');
  facts.push(`${vmaxTable[vmaxCode]}${pdBit(v, 4) ? ' / ' + CABLE_VBUS_CURRENT_ACTIVE[cur] : ' / 无 VBUS 导线'}`);
  facts.push(CABLE_LATENCY_ACTIVE[lat]);
  return v;
}

function activeCableVdo2(em, v, ctx, facts) {
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
  if (ctx.specRevision === '3.1') {
    em.detail('Reserved [B1]', pdBit(v, 1));
    if (pdBit(v, 1)) em.warn?.('PD 3.1 v1.4 Active Cable VDO2 的 B1 为 Reserved', 'RESERVED');
  } else em.detail('[USB4] Asymmetric Mode [B1]', pdFlag(pdBit(v, 1)) + (!ctx.specRevision ? '（PD 3.1 v1.4 中此位为 Reserved）' : ''));
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
  if (ct && (vbusImp < 5 || gndImp < 10)) em.warn?.('Charge Through VPD 的 VBUS/Ground Impedance 必须至少为 10 mΩ', 'VDM_FIELD');
  em.detail(`VBUS Impedance [${pdRange(12, 7)}]`, ct ? `${vbusImp * 2} mΩ（2mΩ 步长）` : 'Reserved（未开启 Charge Through）');
  em.detail(`Ground Impedance [${pdRange(6, 1)}]`, ct ? `${gndImp} mΩ（1mΩ 步长）` : 'Reserved（未开启 Charge Through）');
  em.detail('Charge Through Support [B0]', pdFlag(ct, '支持 Charge Through（可为下游供电）', '不支持'));
  facts.push(`VPD${ct ? ' 支持 Charge Through' : ''}`);
  return v;
}

/** 旧版 AMA VDO（PD 3.0 Table 6-37 / PD 2.0 Table 6-30） */
function amaVdo(em, v, ctx, facts) {
  const amaDeprecated = ['3.1', '3.2'].includes(ctx.specRevision);
  em.detail('说明', amaDeprecated
    ? 'AMA（Alternate Mode Adapter）产品类型已被 PD 3.1 废弃，新设计应改用 UFP VDO'
    : '这是 PD 2.0/3.0 定义的 AMA VDO；PD 3.1 起该产品类型被废弃，新设计应改用 UFP VDO');
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
  em.detail('VBUS required [B3]', pdBit(v, 3) ? '1（需要 VBUS）' : '0（不需要 VBUS）');
  em.detail(`USB SuperSpeed Signaling Support [${pdRange(2, 0)}]`, AMA_SUPERSPEED_V30[pdField(v, 2, 0)]);
  facts.push(amaDeprecated ? 'AMA（已废弃形态）' : 'AMA（PD 2.0/3.0 格式）');
  return v;
}

/**
 * ID Header 的关键信息 → 若干条独立事实。
 * 拆成多条而不是一句话，是为了让 Product Type VDO 自己也推入的「无源线缆」等
 * 事实能与这里的重复项合并（摘要处按整条去重），摘要不会出现两遍同样的内容。
 */
function identityFacts(info, ctx) {
  const out = [];
  if (info.cable) {
    if (info.ptUfp) out.push(info.productTypeText ?? `保留产品类型 ${info.ptUfp}`);
  } else {
    // 端口侧 UFP / DFP 各有一个产品类型字段；为 0 表示「不是该角色」。
    // 用已按所选 PDF 解析的字段文案，避免把 PD 3.0 的 Reserved 误报成 PD 3.2 的 PSD/VPD。
    const u = info.ptUfp ? `UFP ${info.productTypeText ?? `产品类型 ${info.ptUfp}`}` : null;
    const d = info.ptDfp ? `DFP ${info.dfpProductTypeText ?? `产品类型 ${info.ptDfp}`}` : null;
    if (u && d && u !== d) out.push(`${u} / ${d}`);
    else if (u) out.push(u);
    else if (d) out.push(d);
  }
  if (info.vid) {
    const vn = svidName(info.vid, ctx);
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
  let terminated = false, nonzeroAfterTerminator = false;
  vdos.forEach((v, i) => {
    const a = pdField(v, 31, 16), b = pdField(v, 15, 0);
    em.object(`VDO #${i + 2} · Responder VDO（两个 SVID）`);
    em.detail('SVID n [B31-16]', a === 0 ? '0x0000（列表结束）' : svidText(a, ctx));
    em.detail('SVID n+1 [B15-0]', b === 0 ? '0x0000（列表结束）' : svidText(b, ctx));
    for (const svid of [a, b]) {
      if (!svid) terminated = true;
      else if (terminated) nonzeroAfterTerminator = true;
      else list.push(svid);
    }
  });
  if (vdos.length > 6) em.warn?.('Discover SVIDs ACK 每个响应最多包含 6 个 Responder VDO', 'VDM_COUNT');
  if (nonzeroAfterTerminator) em.warn?.('SVID 列表终止符 0x0000 后不应再出现非零 SVID', 'VDM_FIELD');
  st.svidList = [...new Set((st.svidComplete ? [] : st.svidList ?? []).concat(list))];
  st.svidComplete = terminated;
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
  if (vdos.length > 6) em.warn?.('Discover Modes ACK 每个响应最多包含 6 个 Mode VDO', 'VDM_COUNT');
  const name = svidName(svid, ctx);
  st.modes[svid] = vdos.slice();
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
  if (ack === 'BUSY') facts.push('对端忙，稍后重试');
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

function pdValidateVdm(em, head, extra, ctx) {
  const major = pdField(head, 14, 13), minor = pdField(head, 12, 11);
  const pos = pdField(head, 10, 8), type = pdField(head, 7, 6), cmd = pdField(head, 4, 0), svid = head >>> 16;
  const bad = (text, code = 'VDM_FIELD') => em.warn?.(text, code);
  if (major > 1) {
    if (ctx.specRevision === '2.0') bad('PD 2.0 的 SVDM Major=01b…11b 为 Reserved；兼容处理使用接收端支持的最高版本（Version 1.0）');
    else if (ctx.specRevision === '3.2') bad('PD 3.2 的 SVDM Major=10b…11b 无效，接收端按 Major=01b（Version 2.x）处理');
    else if (['3.0', '3.1'].includes(ctx.specRevision)) bad('SVDM Major=10b…11b 为 Reserved；兼容处理使用接收端支持的最高版本');
    else bad('SVDM Major=10b…11b 为 Reserved；PD 3.2 接收端按 Major=01b（Version 2.x）处理');
  }
  if (svid === 0) bad('VDM Header 的 SVID 不能为 0x0000');
  if (cmd === 0 || cmd >= 7 && cmd <= 15) bad(`标准 SVDM 命令 ${cmd} 为保留/无效编码，接收端应回 NAK`);
  if (major === 0 && ['3.0', '3.1'].includes(ctx.specRevision)) bad('PD 3.0/3.1 的 Structured VDM Major=00b（Version 1.0）不得用于新报文');
  if (major > 0 && ctx.specRevision === '2.0') bad('PD 2.0 只定义 Structured VDM Version 1.0（Major=00b）；更高 Major 不得使用');
  if ((major === 0 && minor && cmd < 16) || (major === 1 && cmd < 16
    && (minor > 1 || minor && ['3.0', '3.1'].includes(ctx.specRevision))) || pdBit(head, 5)) {
    bad('SVDM Header 的保留位/Minor 编码无效');
  }
  if (!ctx.specRevision && ctx.revText === '3.x' && major === 0) {
    em.detail('版本歧义', 'Major 00b：PD 3.0/3.1 不得用于新报文；PD 3.2 仍支持旧 Version 1.0（新设计已弃用）');
  }
  if (major === 1 && cmd <= 15 && !ctx.specRevision) {
    em.detail('版本歧义', 'Minor 00b/01b 在 PD 3.0/3.1 中 Reserved；PD 3.2 分别定义为 SVDM Version 2.0/2.1');
  }
  if (cmd < 4 && pos || cmd > 6 && cmd < 16 && pos) bad('该 SVDM 命令的 Object Position 应为 0');
  if (cmd >= 4 && cmd <= 6 && (pos === 0 || pos === 7 && cmd !== 5)) bad('Mode Object Position 应为 1~6，只有 Exit Mode 可用 7');
  if (cmd >= 4 && cmd <= 6 && pos >= 1 && pos <= 6 && ctx.knownModeCount !== undefined && pos > ctx.knownModeCount) {
    bad(`Object Position ${pos} 超过已捕获 Discover Modes ACK 提供的 ${ctx.knownModeCount} 个 Mode`);
  }
  if ((cmd === 1 || cmd === 2) && svid !== SVID_PD) bad('Discover Identity/SVIDs 必须使用 PD SID 0xFF00');
  if (cmd === 6 && type !== 0) bad('Attention 只能是请求，不能是 ACK/NAK/BUSY');
  if ((cmd === 4 || cmd === 5) && type === 3) bad('Enter Mode/Exit Mode 只允许 REQ、ACK 或 NAK，不能返回 BUSY');
  if (cmd === 1 && type === 1 && extra.length < 3) bad('Discover Identity ACK 缺少 ID Header/Cert Stat/Product', 'VDM_COUNT');
  if (cmd >= 1 && cmd <= 3 && (type === 0 || type >= 2) && extra.length) bad('Discovery 请求/NAK/BUSY 不能携带 VDO', 'VDM_COUNT');
  if ((cmd === 2 || cmd === 3) && type === 1 && !extra.length) bad('Discovery ACK 缺少响应 VDO', 'VDM_COUNT');
  if ((cmd === 2 || cmd === 3) && type === 1 && extra.length > 6) bad('Discover SVIDs/Modes ACK 每个响应最多包含 6 个数据 VDO', 'VDM_COUNT');
  if (cmd === 5 && extra.length || cmd === 4 && (extra.length > (type === 0 ? 1 : 0)) || cmd === 6 && extra.length > 1) bad('Mode 命令的数据对象数量无效', 'VDM_COUNT');

  if (ctx.sop) {
    const discoveryWrongSop = [1, 2, 3].includes(cmd) && !['SOP', "SOP'"].includes(ctx.sop);
    const attentionWrongSop = cmd === 6 && ctx.sop !== 'SOP';
    const modeOrVendor = [4, 5].includes(cmd) || cmd >= 16;
    const modeOrVendorWrongSop = modeOrVendor && !['SOP', "SOP'", "SOP''"].includes(ctx.sop);
    if (discoveryWrongSop || attentionWrongSop || modeOrVendorWrongSop) bad(`SVDM 命令 ${cmd} 不允许使用 ${ctx.sop} 链路`, 'SOP');
  }

  // SVDM 1.0 retains the PD 2.0 DFP/UFP initiator rules. SVDM 2.x permits either
  // port to initiate discovery, while Enter/Exit Mode remain DFP-initiated.
  if (ctx.sop === 'SOP' && ctx.dataRole !== undefined && ctx.dataRole !== null) {
    if (major === 0) {
      if (type === 0 && cmd === 6 && ctx.dataRole !== 0) bad('SVDM 1.0 Attention 只能由 UFP 发起', 'ROLE');
      else if (type === 0 && cmd !== 6 && ctx.dataRole !== 1) bad('SVDM 1.0 命令只能由 DFP 发起', 'ROLE');
      else if (type !== 0 && cmd !== 6 && ctx.dataRole !== 0) bad('SVDM 1.0 的响应方只能是 UFP', 'ROLE');
    } else if ([4, 5].includes(cmd)) {
      if (type === 0 && ctx.dataRole !== 1) bad('Enter Mode/Exit Mode 只能由 DFP 发起', 'ROLE');
      if (type !== 0 && ctx.dataRole !== 0) bad('Enter Mode/Exit Mode 的端口响应方必须是 UFP', 'ROLE');
    }
  }
  if (ctx.link === 'cable' && ctx.role === 'Plug' && type === 0) bad('Cable Plug 只能作为结构化 VDM 响应方', 'ROLE');
  if (ctx.link === 'cable' && ['SRC', 'SNK'].includes(ctx.role) && type !== 0) bad('Cable Plug 链路的端口只能发起 VDM，不能作为响应方', 'ROLE');
}

/** PD 2.0 Table 6-28/29 与 PD 3.0 v1.1 Table 6-35/36。 */
function pdLegacyCableVdo(em, v, ctx, active, facts) {
  const pd2 = ctx.revText === '2.0' || ctx.revText === '1.0';
  em.detail('Hardware Version [B31-28]', pdField(v, 31, 28));
  em.detail('Firmware Version [B27-24]', pdField(v, 27, 24));
  em.detail(pd2 ? 'Reserved [B23-20]' : 'VDO Version [B23-21]', pd2 ? pdField(v, 23, 20) : 'Version 1.0');
  if (!pd2) em.detail('Reserved [B20]', pdBit(v, 20));
  em.detail('Connector Type [B19-18]', ['USB Type-A', 'USB Type-B', 'USB Type-C', 'Captive'][pdField(v, 19, 18)]);
  em.detail('Reserved [B17]', pdBit(v, 17));
  em.detail('Cable Latency [B16-13]', (active ? CABLE_LATENCY_ACTIVE : CABLE_LATENCY_PASSIVE)[pdField(v, 16, 13)]);
  em.detail('Cable Termination [B12-11]', (active ? CABLE_TERMINATION_ACTIVE : CABLE_TERMINATION_PASSIVE)[pdField(v, 12, 11)]);
  if (pd2) {
    for (const [bit, name] of [[10, 'SSTX1'], [9, 'SSTX2'], [8, 'SSRX1'], [7, 'SSRX2']]) em.detail(`${name} Directionality [B${bit}]`, `${pdBit(v, bit)}（${active ? '接收端忽略方向性位' : '无源线缆中无实际意义'}）`);
  } else {
    em.detail('Maximum VBUS Voltage [B10-9]', CABLE_VBUS_VOLTAGE_V30[pdField(v, 10, 9)]);
    em.detail('Reserved [B8-7]', pdField(v, 8, 7));
  }
  const current = pdField(v, 6, 5), through = pdBit(v, 4);
  em.detail('VBUS Current Handling [B6-5]', active && !through ? `${current}（无 VBUS 导线，Reserved）` : CABLE_VBUS_CURRENT[current]);
  em.detail('VBUS Through Cable [B4]', active || pd2 ? pdFlag(through) : `${through}（PD 3.0 无源线缆为 Reserved）`);
  em.detail(active ? "SOP'' Controller Present [B3]" : 'Reserved [B3]', pdBit(v, 3));
  em.detail('USB SuperSpeed Signaling [B2-0]', USB_HIGHEST_SPEED_V30[pdField(v, 2, 0)] ?? 'Reserved');
  facts.push(active ? '有源线缆（旧版单 VDO）' : '无源线缆（旧版 VDO）');
}
