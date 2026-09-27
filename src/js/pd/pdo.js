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
  const role = o.role;
  const pos = o.position;
  const isEpr = !!o.isEpr;
  const roleName = role === 'source' ? 'Source' : 'Sink';
  const t1 = pdField(pdo, 31, 30);

  const name = pdoKindName(pdo, isEpr);
  em.object(`PDO #${pos} · ${PDO_KIND_TITLE[name] ?? name}（${roleName}）`);
  em.detail('原始值', `0x${pdHex(pdo)}`);
  em.detail('功率范围', isEpr ? 'EPR（扩展功率范围）' : 'SPR（标准功率范围）');
  em.detail('角色', roleName);

  const meta = { type: t1, role, isEpr, kind: 'unknown', position: pos };
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
        role === 'source' ? '外部电源充足，可全力供电' : '外部电源不足，受自身功耗限制'));
      em.detail('USB Communications Capable [B26]', pdFlag(pdBit(pdo, 26)));
      em.detail('Dual-Role Data [B25]', pdFlag(pdBit(pdo, 25), '可通过 DR_Swap 换数据角色', '不可换'));
      if (role === 'source') {
        em.detail('Unchunked Extended Messages [B24]', pdFlag(pdBit(pdo, 24), '支持分块与不分块', '仅支持分块'));
        em.detail('EPR Capable [B23]', pdFlag(pdBit(pdo, 23), '可进入 EPR 模式', '仅 SPR'));
        em.detail('Reserved [B22]', pdBit(pdo, 22));
      } else {
        em.detail('FRS Current [B24-23]', FRS_CURRENT[pdField(pdo, 24, 23)]);
        em.detail('Reserved [B22-20]', `0x${pdField(pdo, 22, 20).toString(16).toUpperCase()}`);
      }
    } else if (isEpr) {
      em.detail('Reserved [B29-23]', `0x${pdField(pdo, 29, 23).toString(16).toUpperCase()}`);
    } else {
      em.detail('Device Flags [B29-22]', `0x${pdField(pdo, 29, 22).toString(16).toUpperCase()}（非首位 PDO 时为 Reserved）`);
    }
    if (role === 'source' || carry5vFlags) {
      emitPeakCurrent(em, 'Peak Current', pdField(pdo, 21, 20), 'B21-20');
    } else {
      em.detail('Peak Current [B21-20]', 'Reserved（Sink 侧不使用）');
    }
    em.detail('最大功率', `${pdNum(mv * ma)} W`);
    meta.kind = 'fixed';
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
      em.detail('PPS Power Limited [B27]', pdFlag(limited, '电流上限由 PPS Power Limited 决定', '不受限'));
      em.detail('Reserved [B26-25]', `0x${pdField(pdo, 26, 25).toString(16).toUpperCase()}`);
      em.detail('最高电压 [B24-17]', `${pdNum(maxv)} V`);
      em.detail('Reserved [B16]', pdBit(pdo, 16));
      em.detail('最低电压 [B15-8]', `${pdNum(minv)} V`);
      em.detail('Reserved [B7]', pdBit(pdo, 7));
      em.detail(role === 'source' ? '最大电流 [B6-0]' : '所需电流 [B6-0]', `${pdNum(ma)} A`);
      em.detail('@Vmax 近似功率', `${pdNum(maxv * ma)} W`);
      summary = `[PPS] ${pdNum(minv)}/${pdNum(maxv)}V ${pdNum(ma)}A${limited ? ' [limited]' : ''}`;
      meta.kind = 'pps';
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
      em.detail('PDP [B7-0]', `${pdp} W`);
      em.detail('@Vmax 近似电流', `${pdNum(maxv > 0 ? pdp / maxv : 0)} A`);
      summary = `[EPR_AVS] ${pdNum(minv)}~${pdNum(maxv)}V (${pdp}W)`;
      meta.kind = 'epr_avs';
    } else if (t2 === 2) {
      const c15 = pdField(pdo, 19, 10) * I_STEP_AVS_MAX;
      const c20 = pdField(pdo, 9, 0) * I_STEP_AVS_MAX;
      em.detail('APDO Type [B29-28]', '10b SPR AVS（9~20V 可调）');
      if (role === 'source') {
        emitPeakCurrent(em, 'Peak Current', pdField(pdo, 27, 26), 'B27-26');
        em.detail('Reserved [B25-20]', `0x${pdField(pdo, 25, 20).toString(16).toUpperCase()}`);
      } else {
        em.detail('Reserved [B27-20]', `0x${pdField(pdo, 27, 20).toString(16).toUpperCase()}`);
      }
      em.detail('9V~15V 最大电流 [B19-10]', `${pdNum(c15)} A`);
      em.detail('15V~20V 最大电流 [B9-0]', c20 === 0 ? '0 A（最高只到 15V）' : `${pdNum(c20)} A`);
      summary = `[SPR_AVS] 9~20V  15V:${pdNum(c15)}A  20V:${pdNum(c20)}A`;
      meta.kind = 'spr_avs';
    } else {
      em.detail('APDO Type [B29-28]', `1${t2.toString(2).padStart(2, '0')}b Reserved`);
      em.detail('原始值', `0x${pdHex(pdo)}`);
      summary = `[Reserved_APDO] [raw: 0x${pdHex(pdo)}]`;
      meta.kind = 'reserved_apdo';
    }
  }

  const ref = `${name} ${summaryShort(summary)}`;
  st.pdos[role][pos] = ref;
  st.pdoMeta[role][pos] = meta;
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
  const pos = pdField(rdo, 31, 28);
  const posValid = pos !== 0 && pos < 0x0E;
  em.object(`RDO · 请求数据对象${posValid ? `（引用 PDO #${pos}）` : ''}`);
  em.detail('原始值', `0x${pdHex(rdo)}`);

  if (!posValid) {
    em.detail(`Object Position [${pdRange(31, 28)}]`, `${pos} · 无效位置`);
    const s = `(RDO 位置 ${pos} 无效)`;
    em.note(s);
    return { summary: s };
  }

  const known = pos in st.pdos.source;
  const ref = known ? st.pdos.source[pos] : 'Unknown PDO';
  const meta = known ? (st.pdoMeta.source[pos] ?? { kind: 'unknown' }) : { kind: 'unknown' };
  const kind = meta.kind ?? 'unknown';

  em.detail(`Object Position [${pdRange(31, 28)}]`, String(pos));
  em.detail('引用的 PDO', known ? ref : `未捕获到 Source_Capabilities 的第 ${pos} 个 PDO`);
  em.detail('Giveback [B27]', pdFlag(pdBit(rdo, 27), '已置位（该位已废弃）', '未置位'));
  em.detail('Capability Mismatch [B26]', pdFlag(pdBit(rdo, 26), '能力不匹配', '匹配'));
  em.detail('USB Communications Cable [B25]', pdFlag(pdBit(rdo, 25), '是通信线缆', '否'));
  em.detail('No USB Suspend [B24]', pdFlag(pdBit(rdo, 24), '不遵循 USB 挂起', '遵循 USB 挂起'));
  em.detail('Unchunked Extended Messages [B23]', pdFlag(pdBit(rdo, 23), '支持分块与不分块', '仅支持分块'));
  em.detail('EPR Capable [B22]', pdFlag(pdBit(rdo, 22), '申请进入 EPR', '仅 SPR'));

  let s;
  if (kind === 'pps') {
    const ov = pdField(rdo, 20, 9) * 0.02;      // Table 6.21：20mV
    const oa = pdField(rdo, 6, 0) * I_STEP_PPS; // 50mA
    em.detail('Reserved [B21]', pdBit(rdo, 21));
    em.detail('输出电压 [B20-9]', `${pdNum(ov)} V`);
    em.detail('Reserved [B8-7]', `0x${pdField(rdo, 8, 7).toString(16).toUpperCase()}`);
    em.detail('工作电流 [B6-0]', `${pdNum(oa)} A`);
    s = `(RDO ${pos}: ${ref}) 请求 ${pdNum(ov)}V ${pdNum(oa)}A`;
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
  } else if (kind === 'battery') {
    const ow = pdField(rdo, 19, 10) * P_STEP_BATT;
    const mw = pdField(rdo, 9, 0) * P_STEP_BATT;
    em.detail('Reserved [B21-20]', `0x${pdField(rdo, 21, 20).toString(16).toUpperCase()}`);
    em.detail('工作功率 [B19-10]', `${pdNum(ow)} W`);
    em.detail('最大工作功率 [B9-0]', `${pdNum(mw)} W（已废弃，应与工作功率相同）`);
    s = `(RDO ${pos}: ${ref}) 工作 ${pdNum(ow)}W / 最大 ${pdNum(mw)}W`;
  } else {
    const oa = pdField(rdo, 19, 10) * I_STEP;
    const ma = pdField(rdo, 9, 0) * I_STEP;
    em.detail('Reserved [B21-20]', `0x${pdField(rdo, 21, 20).toString(16).toUpperCase()}`);
    em.detail('工作电流 [B19-10]', `${pdNum(oa)} A`);
    em.detail('最大工作电流 [B9-0]', `${pdNum(ma)} A（已废弃，应与工作电流相同）`);
    s = `(RDO ${pos}: ${ref}) 工作 ${pdNum(oa)}A / 最大 ${pdNum(ma)}A`;
  }

  em.note(s);
  return { summary: s, ref, kind, position: pos };
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
