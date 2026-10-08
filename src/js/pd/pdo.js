/**
 * pdo.js — 电源数据对象（PDO）与请求数据对象（RDO）解析
 *
 * PDO 三个族：Fixed / Variable / Battery（B31-30 = 00/10/01）
 * APDO 三个族：SPR PPS / SPR AVS / EPR AVS（B31-30 = 11，B29-28 再分）
 * RDO 四张表：Fixed&Variable / Battery / PPS / AVS（表随被请求的 PDO 类型走）
 *
 * 依据 USB PD 3.2 Table 6.6…6.22。
 */

import {
  PEAK_CURRENT_DETAILS, FRS_CURRENT,
} from './tables.js';
import { pdField, pdBit, pdNum, pdHex, pdFlag, pdRange } from './format.js';

const V_STEP = 0.05;      // 电压 50 mV
const V_STEP_AVS = 0.1;   // AVS 电压 100 mV
const I_STEP = 0.01;      // 电流 10 mA
const I_STEP_PPS = 0.05;  // PPS/AVS 请求电流 50 mA
const I_STEP_AVS_MAX = 0.01; // SPR AVS 最大电流 10 mA
const P_STEP_BATT = 0.25; // 电池 PDO 功率 250 mW

/** 峰值电流档位（B21-20 / B27-26）→ 详情行 */
function emitPeakCurrent(em, field, mode, range) {
  const info = PEAK_CURRENT_DETAILS[mode] ?? PEAK_CURRENT_DETAILS[0];
  em.detail(`${field} [${range}]`, `${info.code} ${info.summary}`);
  info.steps.forEach((s, i) => em.detail(`${field} 档位 ${i + 1}`, s));
}

/* ══════════════════ PDO ══════════════════ */

/**
 * 从原始位域预判 PDO 类型名 —— 供分组标题用。
 * 必须先于逐字段详情拿到名字，才能让整块 PDO 落在同一个分组里，
 * 所以这里独立算一次，`pdoParse` 的 `name` 就以它为准。
 */
function pdoKindName(pdo, isEpr) {
  const pre = isEpr ? 'EPR_' : '';
  const t1 = pdField(pdo, 31, 30);
  if (t1 === 0) return `${pre}Fixed`;
  if (t1 === 1) return `${pre}Battery`;
  if (t1 === 2) return `${pre}Variable`;
  const t2 = pdField(pdo, 29, 28);
  if (t2 === 0) return 'PPS';
  if (t2 === 1) return 'EPR_AVS';
  if (t2 === 2) return 'SPR_AVS';
  return 'Reserved_APDO';
}

/** 类型名 → 中英对照的分组标题（详情面板里一眼看出这是哪种电源） */
const PDO_KIND_TITLE = {
  Fixed: 'Fixed 固定电源',
  EPR_Fixed: 'EPR_Fixed 扩展固定电源',
  Battery: 'Battery 电池',
  EPR_Battery: 'EPR_Battery 扩展电池',
  Variable: 'Variable 可变电源',
  EPR_Variable: 'EPR_Variable 扩展可变电源',
  PPS: 'PPS 可编程电源',
  EPR_AVS: 'EPR_AVS 扩展可调电压',
  SPR_AVS: 'SPR_AVS 标准可调电压',
  Reserved: 'Reserved 保留',
  Reserved_APDO: 'Reserved_APDO 保留',
};

/**
 * 解析一个 PDO 并写入详情，同时把它登记进状态（供后续 RDO 反查）。
 *
 * @param {object} st   解码器状态（st.pdos / st.pdoMeta）
 * @param {object} em   详情发射器：{ object, detail, note }
 * @param {number} pdo  32bit 原始值
 * @param {object} o    { role:'source'|'sink', position, isEpr, rev, role5v }
 * @returns {{name:string, ref:string, meta:object}}
 */
export function pdoParse(st, em, pdo, o) {
  const legacy = o.revText === '2.0' || o.revText === '1.0' || o.specRevision === '2.0';
  const old3 = o.specRevision === '3.0';
  const role = o.role;
  const pos = o.position;
  const isEpr = !!o.isEpr;
  const roleName = role === 'source' ? 'Source' : 'Sink';
  const t1 = pdField(pdo, 31, 30);

  const apdoType = pdField(pdo, 29, 28);
  const reservedApdo = t1 === 3 && (legacy || old3 && apdoType !== 0 || o.specRevision === '3.1' && apdoType === 2);
  const name = reservedApdo ? 'Reserved_APDO' : pdoKindName(pdo, isEpr);
  em.object(`PDO #${pos} · ${PDO_KIND_TITLE[name] ?? name}（${roleName}）`);
  em.detail('原始值', `0x${pdHex(pdo)}`);
  em.detail('功率范围', isEpr ? 'EPR（扩展功率范围）' : 'SPR（标准功率范围）');
  em.detail('角色', roleName);

  const meta = { raw: pdo >>> 0, type: t1, role, isEpr, kind: 'unknown', position: pos };
  let summary = `[${name}] [raw: 0x${pdHex(pdo)}]`;

  if (t1 === 0) {
    /* ── Fixed Supply PDO（Table 6.8 / 6.9 / 6.10）── */
    const mv = pdField(pdo, 19, 10) * V_STEP;
    const ma = pdField(pdo, 9, 0) * I_STEP;
    em.detail('Supply Type [B31-30]', '00b Fixed Supply PDO');
    em.detail('电压 [B19-10]', `${pdNum(mv)} V`);
    em.detail(role === 'source' ? '最大电流 [B9-0]' : '工作电流 [B9-0]', `${pdNum(ma)} A`);
    summary = `[${name}] ${pdNum(mv)}V ${pdNum(ma)}A (${pdNum(mv * ma)}W)`;

    // 5V PDO 位于第一位时才带 Device Flags（Table 6.8），其余位置的 B29-22 是 Reserved
    const carry5vFlags = pos === 1 && !isEpr;
    if (carry5vFlags) {
      em.detail('Dual-Role Power [B29]', pdFlag(pdBit(pdo, 29), '可通过 PR_Swap 换电源角色', '不可换'));
      em.detail(role === 'source' ? 'USB Suspend Supported [B28]' : 'Higher Capability [B28]',
        role === 'source'
          ? pdFlag(pdBit(pdo, 28), 'Sink 需按 USB 规范挂起/唤醒', '无需遵循挂起规则')
          : pdFlag(pdBit(pdo, 28), 'Sink 需要比 5V PDO 更多的电量', '否'));
      em.detail('Unconstrained Power [B27]', pdFlag(pdBit(pdo, 27),
        role === 'source' ? '电源充足，不受外部功率限制' : '有足够供自身使用的外部电源', '受供电功率限制'));
      em.detail('USB Communications Capable [B26]', pdFlag(pdBit(pdo, 26)));
      em.detail('Dual-Role Data [B25]', pdFlag(pdBit(pdo, 25), '可通过 DR_Swap 换数据角色', '不可换'));
      if (legacy) {
        em.detail('Reserved [B24-22]', pdField(pdo, 24, 22));
      } else if (role === 'source') {
        em.detail('Unchunked Extended Messages [B24]', pdFlag(pdBit(pdo, 24), '支持分块与不分块', '仅支持分块'));
        em.detail(old3 ? 'Reserved [B23]' : 'EPR Capable [B23]', old3 ? pdBit(pdo, 23) : pdFlag(pdBit(pdo, 23), '可进入 EPR 模式', '仅 SPR'));
        em.detail('Reserved [B22]', pdBit(pdo, 22));
      } else {
        em.detail('FRS Current [B24-23]', FRS_CURRENT[pdField(pdo, 24, 23)]);
        em.detail('Reserved [B22-20]', `0x${pdField(pdo, 22, 20).toString(16).toUpperCase()}`);
      }
    } else if (isEpr) {
      em.detail('Reserved [B29-22]', `0x${pdField(pdo, 29, 22).toString(16).toUpperCase()}`);
    } else {
      em.detail('Device Flags [B29-22]', `0x${pdField(pdo, 29, 22).toString(16).toUpperCase()}（非首位 PDO 时为 Reserved）`);
    }
    if (role === 'source') {
      emitPeakCurrent(em, 'Peak Current', pdField(pdo, 21, 20), 'B21-20');
    } else {
      em.detail('Peak Current [B21-20]', 'Reserved（Sink 侧不使用）');
    }
    em.detail('最大功率', `${pdNum(mv * ma)} W`);
    meta.kind = 'fixed';
    Object.assign(meta, { minVoltage: mv, maxVoltage: mv, current: ma, power: mv * ma });
  } else if (t1 === 1) {
    /* ── Battery Supply PDO（Table 6.11）── */
    const minv = pdField(pdo, 19, 10) * V_STEP;
    const maxv = pdField(pdo, 29, 20) * V_STEP;
    const mw = pdField(pdo, 9, 0) * P_STEP_BATT;
    em.detail('Supply Type [B31-30]', '01b Battery PDO');
    em.detail('最高电压 [B29-20]', `${pdNum(maxv)} V`);
    em.detail('最低电压 [B19-10]', `${pdNum(minv)} V`);
    em.detail(role === 'source' ? '最大可用功率 [B9-0]' : '工作功率 [B9-0]', `${pdNum(mw)} W`);
    summary = `[${name}] ${pdNum(minv)}/${pdNum(maxv)}V ${pdNum(mw)}W`;
    meta.kind = 'battery';
    Object.assign(meta, { minVoltage: minv, maxVoltage: maxv, power: mw });
  } else if (t1 === 2) {
    /* ── Variable Supply PDO（Table 6.12）── */
    const minv = pdField(pdo, 19, 10) * V_STEP;
    const maxv = pdField(pdo, 29, 20) * V_STEP;
    const ma = pdField(pdo, 9, 0) * I_STEP;
    em.detail('Supply Type [B31-30]', '10b Variable Supply PDO');
    em.detail('最高电压 [B29-20]', `${pdNum(maxv)} V`);
    em.detail('最低电压 [B19-10]', `${pdNum(minv)} V`);
    em.detail(role === 'source' ? '最大电流 [B9-0]' : '工作电流 [B9-0]', `${pdNum(ma)} A`);
    summary = `[${name}] ${pdNum(minv)}/${pdNum(maxv)}V ${pdNum(ma)}A`;
    meta.kind = 'variable';
    Object.assign(meta, { minVoltage: minv, maxVoltage: maxv, current: ma });
  } else if (reservedApdo) {
    em.detail('Supply Type [B31-30]', legacy ? '11b Reserved（PD 2.0 未定义 APDO）' : `11b Augmented，类型 ${apdoType} 在所选规范中为 Reserved`);
    meta.kind = 'reserved_apdo';
  } else {
    /* ── Augmented PDO（Table 6.13…6.17）── */
    const t2 = pdField(pdo, 29, 28);
    meta.apdoType = t2;
    em.detail('Supply Type [B31-30]', '11b Augmented PDO');
    if (t2 === 0) {
      const minv = pdField(pdo, 15, 8) * V_STEP_AVS;
      const maxv = pdField(pdo, 24, 17) * V_STEP_AVS;
      const ma = pdField(pdo, 6, 0) * I_STEP_PPS;
      const limited = pdBit(pdo, 27);
      em.detail('APDO Type [B29-28]', '00b SPR PPS');
      em.detail(role === 'source' && !old3 ? 'PPS Power Limited [B27]' : 'Reserved [B27]', role === 'source' && !old3 ? pdFlag(limited, '受 PDP 限制', '不受限') : limited);
      em.detail('Reserved [B26-25]', `0x${pdField(pdo, 26, 25).toString(16).toUpperCase()}`);
      em.detail('最高电压 [B24-17]', `${pdNum(maxv)} V`);
      em.detail('Reserved [B16]', pdBit(pdo, 16));
      em.detail('最低电压 [B15-8]', `${pdNum(minv)} V`);
      em.detail('Reserved [B7]', pdBit(pdo, 7));
      em.detail(role === 'source' ? '最大电流 [B6-0]' : '所需电流 [B6-0]', `${pdNum(ma)} A`);
      em.detail('@Vmax 近似功率', `${pdNum(maxv * ma)} W`);
      summary = `[PPS] ${pdNum(minv)}/${pdNum(maxv)}V ${pdNum(ma)}A${role === 'source' && !old3 && limited ? ' [limited]' : ''}`;
      meta.kind = 'pps';
      Object.assign(meta, { minVoltage: minv, maxVoltage: maxv, current: ma, powerLimited: role === 'source' && !old3 && !!limited });
    } else if (t2 === 1) {
      const minv = pdField(pdo, 15, 8) * V_STEP_AVS;
      const maxv = pdField(pdo, 25, 17) * V_STEP_AVS;
      const pdp = pdField(pdo, 7, 0);
      em.detail('APDO Type [B29-28]', '01b EPR AVS（可调电压）');
      if (role === 'source') {
        emitPeakCurrent(em, 'Peak Current', pdField(pdo, 27, 26), 'B27-26');
      } else {
        em.detail('Reserved [B27-26]', `0x${pdField(pdo, 27, 26).toString(16).toUpperCase()}`);
      }
      em.detail('最高电压 [B25-17]', `${pdNum(maxv)} V`);
      em.detail('Reserved [B16]', pdBit(pdo, 16));
      em.detail('最低电压 [B15-8]', `${pdNum(minv)} V`);
      em.detail(role === 'source' ? 'PDP [B7-0]' : 'Maximum Power [B7-0]', `${pdp} W`);
      em.detail('@Vmax 可用电流', `${pdNum(maxv > 0 ? Math.floor(Math.min(5, pdp / maxv) * 20 + 1e-9) / 20 : 0)} A（取 PDP/V 与 5A 中较小值，向下取整到 50mA）`);
      summary = `[EPR_AVS] ${pdNum(minv)}~${pdNum(maxv)}V (${pdp}W)`;
      meta.kind = 'epr_avs';
      Object.assign(meta, { minVoltage: minv, maxVoltage: maxv, power: pdp });
    } else if (t2 === 2) {
      const c15 = pdField(pdo, 19, 10) * I_STEP_AVS_MAX;
      const c20 = pdField(pdo, 9, 0) * I_STEP_AVS_MAX;
      em.detail('APDO Type [B29-28]', `10b SPR AVS（9~${c20 ? 20 : 15}V 可调）`);
      if (role === 'source') {
        emitPeakCurrent(em, 'Peak Current', pdField(pdo, 27, 26), 'B27-26');
        em.detail('Reserved [B25-20]', `0x${pdField(pdo, 25, 20).toString(16).toUpperCase()}`);
      } else {
        em.detail('Reserved [B27-20]', `0x${pdField(pdo, 27, 20).toString(16).toUpperCase()}`);
      }
      em.detail('9V~15V 最大电流 [B19-10]', `${pdNum(c15)} A`);
      em.detail('15V~20V 最大电流 [B9-0]', c20 === 0 ? '0 A（最高只到 15V）' : `${pdNum(c20)} A`);
      summary = `[SPR_AVS] 9~${c20 ? 20 : 15}V  15V:${pdNum(c15)}A${c20 ? `  20V:${pdNum(c20)}A` : ''}`;
      meta.kind = 'spr_avs';
      Object.assign(meta, { minVoltage: 9, maxVoltage: c20 ? 20 : 15, current15: c15, current20: c20 });
    } else {
      em.detail('APDO Type [B29-28]', `${t2.toString(2).padStart(2, '0')}b Reserved`);
      em.detail('原始值', `0x${pdHex(pdo)}`);
      summary = `[Reserved_APDO] [raw: 0x${pdHex(pdo)}]`;
      meta.kind = 'reserved_apdo';
    }
  }

  const ref = `${name} ${summaryShort(summary)}`;
  meta.valid = pdValidatePdo(em, meta);
  if (o.register !== false) {
    st.pdos[role][pos] = ref;
    st.pdoMeta[role][pos] = meta;
  }
  return { name, ref, meta, summary };
}

/** 从概览文本里取一段简短引用（用于 RDO 的「参考 PDO」一栏） */
function summaryShort(s) {
  return s.replace(/^\[[^\]]*\]\s*/, '').replace(/\s*\(.*\)$/, '');
}

/* ══════════════════ RDO ══════════════════ */

/**
 * 解析一个 RDO。表的选择依据「被请求的 PDO 类型」——所以需要先有 Source_Capabilities。
 *
 * @param {object} st 解码器状态
 * @param {object} em 详情发射器
 * @param {number} rdo 32bit 原始值
 * @param {object} o  { isEpr }
 */
export function rdoParse(st, em, rdo, o = {}) {
  const legacy = o.revText === '2.0' || o.revText === '1.0' || o.specRevision === '2.0';
  const latest = o.specRevision === '3.2';
  const pos = pdField(rdo, legacy ? 30 : 31, 28);
  const posValid = pos > 0 && pos <= (o.isEpr ? (latest ? 11 : 13) : 7);
  em.object(`RDO · 请求数据对象${posValid ? `（引用 PDO #${pos}）` : ''}`);
  em.detail('原始值', `0x${pdHex(rdo)}`);

  if (!posValid) {
    em.detail(`Object Position [${pdRange(31, 28)}]`, `${pos} · 无效位置`);
    const s = `(RDO 位置 ${pos} 无效)`;
    em.note(s);
    em.warn?.(`RDO 引用位置 ${pos} 无效`, 'RDO_POSITION');
  }

  // 普通 Request 与 EPR_Request 引用各自最近一次能力表。
  const caps = o.capabilities === undefined ? { pdos: st.pdos.source, pdoMeta: st.pdoMeta.source } : o.capabilities;
  const known = !!o.meta || !!caps && pos in caps.pdos;
  const ref = o.ref ?? (known ? caps?.pdos[pos] : 'Unknown PDO');
  const meta = o.meta ?? (known ? (caps.pdoMeta[pos] ?? { kind: 'unknown' }) : { kind: 'unknown' });
  const kind = meta.kind ?? 'unknown';

  em.detail(`Object Position [${pdRange(31, 28)}]`, String(pos));
  em.detail('引用的 PDO', known ? ref : `未捕获到 Source_Capabilities 的第 ${pos} 个 PDO`);
  if (legacy) em.detail('Reserved [B31]', pdBit(rdo, 31));
  const augmented = ['pps', 'spr_avs', 'epr_avs'].includes(kind);
  const givebackField = latest ? 'Giveback (Deprecated) [B27]'
    : augmented ? (o.specRevision == null ? 'Giveback/Reserved [B27]' : 'Reserved [B27]') : 'Giveback [B27]';
  const givebackBit = !!pdBit(rdo, 27);
  if (latest) {
    em.detail(givebackField, `${Number(givebackBit)}（PD 3.2 已废弃，接收端必须忽略）`);
  } else if (augmented) {
    em.detail(givebackField, `${Number(givebackBit)}${o.specRevision == null ? '（版本未指定；3.0 起该位 Reserved/弃用）' : '（PD 3.1 Reserved）'}`);
  } else {
    em.detail(givebackField, pdFlag(givebackBit, '收到 GotoMin 时降至最小请求值', '使用最大请求值'));
  }
  em.detail('Capability Mismatch [B26]', pdFlag(pdBit(rdo, 26), '能力不匹配', '匹配'));
  em.detail('USB Communications Capable [B25]', pdFlag(pdBit(rdo, 25), '支持 USB 数据通信', '不支持'));
  em.detail('No USB Suspend [B24]', pdFlag(pdBit(rdo, 24), '不遵循 USB 挂起', '遵循 USB 挂起'));
  if (legacy) em.detail('Reserved [B23-20]', pdField(rdo, 23, 20));
  else {
    em.detail('Unchunked Extended Messages [B23]', pdFlag(pdBit(rdo, 23), '支持分块与不分块', '仅支持分块'));
    em.detail(o.specRevision === '3.0' ? 'Reserved [B22]' : 'EPR Capable [B22]', o.specRevision === '3.0' ? pdBit(rdo, 22) : pdFlag(pdBit(rdo, 22), '支持 EPR', '仅 SPR'));
  }

  let s;
  const request = { raw: rdo >>> 0, kind, position: pos, validPosition: posValid, referenceKnown: known,
    eprCapable: !legacy && o.specRevision !== '3.0' && !!pdBit(rdo, 22), pdoRaw: meta.raw ?? null,
    range: pos >= 8 ? 'epr' : 'spr', valid: posValid && meta.valid !== false,
    // Keep the raw value for diagnostics. In PD 3.2 the receiver must ignore
    // this deprecated bit, so it cannot select the older min/max semantics.
    givebackBit, giveback: !latest && !augmented && givebackBit, mismatch: !!pdBit(rdo, 26) };
  if (kind === 'unknown' || kind === 'reserved_apdo') {
    em.detail('请求载荷 [B21-0]', `0x${pdHex(pdField(rdo, 21, 0), 6)}（PDO 类型未知，无法选择电流/功率/电压格式）`);
    s = `(RDO ${pos}: Unknown PDO) 请求格式待能力表确认`;
  } else
  if (kind === 'pps') {
    const ov = pdField(rdo, 20, 9) * 0.02;      // Table 6.21：20mV
    const oa = pdField(rdo, 6, 0) * I_STEP_PPS; // 50mA
    em.detail('Reserved [B21]', pdBit(rdo, 21));
    em.detail('输出电压 [B20-9]', `${pdNum(ov)} V`);
    em.detail('Reserved [B8-7]', `0x${pdField(rdo, 8, 7).toString(16).toUpperCase()}`);
    em.detail('工作电流 [B6-0]', `${pdNum(oa)} A`);
    s = `(RDO ${pos}: ${ref}) 请求 ${pdNum(ov)}V ${pdNum(oa)}A`;
    Object.assign(request, { voltage: ov, current: oa });
  } else if (kind === 'spr_avs' || kind === 'epr_avs') {
    const raw = pdField(rdo, 20, 9);
    const ov = raw * 0.025;                     // Table 6.22：25mV，且 B10-9 必须为 00b
    const oa = pdField(rdo, 6, 0) * I_STEP_PPS;
    em.detail('Reserved [B21]', pdBit(rdo, 21));
    em.detail('输出电压 [B20-9]', `${pdNum(ov)} V`
      + (raw & 0x3 ? `（⚠ B10-9 = ${(raw & 0x3).toString(2).padStart(2, '0')}b，规范要求为 00b）` : '（B10-9 = 00b，步长等效 100mV）'));
    em.detail('Reserved [B8-7]', `0x${pdField(rdo, 8, 7).toString(16).toUpperCase()}`);
    em.detail('工作电流 [B6-0]', `${pdNum(oa)} A`);
    s = `(RDO ${pos}: ${ref}) 请求 ${pdNum(ov)}V ${pdNum(oa)}A`;
    Object.assign(request, { voltage: ov, current: oa });
    if (raw & 3) { em.warn?.('AVS RDO 的 B10-9 必须为 00b', 'RDO_STEP'); request.valid = false; }
  } else if (kind === 'battery') {
    const ow = pdField(rdo, 19, 10) * P_STEP_BATT;
    const mw = pdField(rdo, 9, 0) * P_STEP_BATT;
    em.detail('Reserved [B21-20]', `0x${pdField(rdo, 21, 20).toString(16).toUpperCase()}`);
    em.detail('工作功率 [B19-10]', `${pdNum(ow)} W`);
    em.detail(`${request.giveback ? '最小' : '最大'}工作功率 [B9-0]`, `${pdNum(mw)} W${latest ? '（PD 3.2 已废弃，应与工作功率相同）' : '（PD 3.0/3.1 中有效，PD 3.2 废弃）'}`);
    s = `(RDO ${pos}: ${ref}) 工作 ${pdNum(ow)}W / ${request.giveback ? '最小' : '最大'} ${pdNum(mw)}W`;
    Object.assign(request, { power: ow, limit: mw });
  } else {
    const oa = pdField(rdo, 19, 10) * I_STEP;
    const ma = pdField(rdo, 9, 0) * I_STEP;
    em.detail('Reserved [B21-20]', `0x${pdField(rdo, 21, 20).toString(16).toUpperCase()}`);
    em.detail('工作电流 [B19-10]', `${pdNum(oa)} A`);
    em.detail(`${request.giveback ? '最小' : '最大'}工作电流 [B9-0]`, `${pdNum(ma)} A${latest ? '（PD 3.2 已废弃，应与工作电流相同）' : '（PD 3.0/3.1 中有效，PD 3.2 废弃）'}`);
    s = `(RDO ${pos}: ${ref}) 工作 ${pdNum(oa)}A / ${request.giveback ? '最小' : '最大'} ${pdNum(ma)}A`;
    Object.assign(request, { current: oa, limit: ma });
  }

  request.valid = pdValidateRequest(em, request, meta, latest) && request.valid;

  em.note(s);
  return { summary: s, ref, ...request };
}

function pdValidatePdo(em, m) {
  let valid = m.kind !== 'reserved_apdo';
  const bad = text => { valid = false; em.warn?.(`PDO #${m.position}: ${text}`, 'PDO_RANGE'); };
  if (m.minVoltage > m.maxVoltage) bad('最低电压大于最高电压');
  if (m.current > 5 || m.current15 > 5 || m.current20 > 5) bad('电流超过 5A');
  if (m.position === 1 && (m.kind !== 'fixed' || m.minVoltage !== 5)) bad('首个 PDO 必须为 5V Fixed');
  if (m.kind === 'battery' && m.power > 100) bad('Battery PDO 功率超过 100W');
  if (m.kind === 'fixed' && m.maxVoltage > (m.isEpr ? 48 : 20)) bad('固定电压超出功率范围');
  if (m.isEpr && m.kind === 'fixed' && m.maxVoltage <= 20) bad('EPR Fixed 电压必须大于 20V');
  if (m.role === 'source' && m.isEpr && m.kind === 'fixed' && ![28, 36, 48].includes(m.maxVoltage)) bad('EPR Source Fixed 电压必须为 28/36/48V');
  if (m.isEpr && !['fixed', 'epr_avs'].includes(m.kind)) bad('EPR 槽位只能包含 Fixed 或 EPR AVS');
  if (!m.isEpr && m.kind === 'epr_avs') bad('EPR AVS 必须从位置 8 起');
  if (m.kind === 'pps' && (m.minVoltage < 3.3 || m.maxVoltage > 21)) bad('PPS 电压超出 3.3~21V');
  if (m.kind === 'epr_avs' && (m.minVoltage < 15 || m.maxVoltage > 48 || m.power > 240)) bad('EPR AVS 电压或 PDP 超出范围');
  if (m.kind === 'epr_avs' && m.role === 'source' && (m.minVoltage !== 15 || ![28, 36, 48].includes(m.maxVoltage))) bad('EPR Source AVS 必须从 15V 起，最高电压为 28/36/48V');
  return valid;
}

function pdValidateRequest(em, r, m, latest) {
  let valid = true;
  const bad = text => { valid = false; em.warn?.(text, 'RDO_RANGE'); };
  // 编码单位换算产生的浮点尾差不能把 3.55A 等合法边界误判为超限。
  const epsilon = 1e-9;
  if (r.voltage !== undefined && (r.voltage < m.minVoltage - epsilon || r.voltage > m.maxVoltage + epsilon)) bad('请求电压超出所引用 PDO 的范围');
  const currentLimit = m.kind === 'spr_avs' ? (r.voltage > 15 ? m.current20 : m.current15)
    : m.kind === 'epr_avs' && r.voltage > 0 ? Math.floor(Math.min(5, m.power / r.voltage) * 20 + 1e-9) / 20 : m.current;
  if (r.current > currentLimit + epsilon) bad('请求电流超过所引用 PDO 的最大电流');
  if (r.power > m.power + epsilon) bad('请求功率超过所引用 PDO 的最大功率');
  if (latest && r.limit !== undefined && Math.abs(r.limit - (r.current ?? r.power)) > epsilon) bad('PD 3.2 的废弃最大请求域必须等于工作请求值');
  if (!latest && r.limit !== undefined) {
    const operating = r.current ?? r.power;
    if (r.giveback ? r.limit > operating + epsilon : r.limit < operating - epsilon) bad('最小/最大请求值与工作请求值的关系无效');
    if (!r.giveback && !r.mismatch && r.limit > (m.kind === 'battery' ? m.power : m.current) + epsilon) bad('未置 Capability Mismatch 时最大请求值不能超出 PDO');
  }
  return valid;
}

/** 供外部（如 EPR_Request 的「被请求 PDO 副本」）复用的位置查询 */
export function lookupPdo(st, role, pos) {
  const hit = pos in st.pdos[role];
  return {
    ref: hit ? st.pdos[role][pos] : 'Unknown PDO',
    meta: hit ? (st.pdoMeta[role][pos] ?? { kind: 'unknown' }) : { kind: 'unknown' },
    known: hit,
  };
}
