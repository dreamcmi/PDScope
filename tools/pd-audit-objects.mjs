/**
 * Independent USB PD object vectors used by the four-revision object audit.
 * Run with: C:/Language/NodeJS/node.exe tools/pd-audit-objects.mjs
 * These vectors encode normative PDO/RDO and data-block fields directly; they
 * do not reuse the existing compliance fixture or test harness.
 */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { pdoParse, rdoParse } from '../src/js/pd/pdo.js';
import {
  alertParse, bistParse, countryCodeParse, enterUsbParse, revisionParse,
  sourceInfoParse,
} from '../src/js/pd/data.js';
import { extendedParse } from '../src/js/pd/extended.js';

function emitter() {
  const out = { objects: [], details: [], notes: [], warnings: [] };
  return {
    out,
    object: value => out.objects.push(value),
    detail: (key, value) => out.details.push({ key, value: String(value) }),
    note: value => out.notes.push(String(value)),
    warn: (message, code) => out.warnings.push({ message: String(message), code }),
  };
}

function state() {
  return { pdos: { source: {}, sink: {} }, pdoMeta: { source: {}, sink: {} } };
}

function word(fields) {
  let value = 0;
  for (const [msb, lsb, field] of fields) {
    const mask = (2 ** (msb - lsb + 1) - 1) >>> 0;
    value = (value | (((field >>> 0) & mask) << lsb)) >>> 0;
  }
  return value >>> 0;
}

function pdoVector(raw, { revision, role = 'source', position = 2, isEpr = false }) {
  const em = emitter();
  const result = pdoParse(state(), em, raw, {
    role, position, isEpr, revText: revision, specRevision: revision,
  });
  return { ...result, out: em.out };
}

function rdoVector(raw, { revision, kind = 'fixed', meta = {} , isEpr = false }) {
  const em = emitter();
  const result = rdoParse(state(), em, raw, {
    revText: revision, specRevision: revision, isEpr,
    meta: { kind, minVoltage: 5, maxVoltage: 5, current: 3, power: 15, valid: true, ...meta },
    ref: 'fixture PDO',
  });
  return { ...result, out: em.out };
}

function extendedVector(type, bytes, { revision = '3.2', link = 'sop', role = 'SRC' } = {}) {
  const em = emitter();
  const bk = { bytes, off: 0, dataSize: bytes.length, chunked: false, chunkNum: 0 };
  const summary = extendedParse(state(), em, type, bk, { specRevision: revision, link, role });
  return { summary, out: em.out };
}

function getDetail(out, key) {
  return out.details.find(d => d.key === key)?.value;
}

let checks = 0;
const passed = [];
function check(name, fn) {
  fn();
  checks++;
  passed.push(name);
  console.log(`✓ ${name}`);
}

const fixed5v = word([[19, 10, 100], [9, 0, 300]]);
check('Fixed PDO keeps the 50mV/10mA units in all four revisions', () => {
  for (const revision of ['2.0', '3.0', '3.1', '3.2']) {
    const parsed = pdoVector(fixed5v, { revision, position: 1 });
    assert.equal(parsed.meta.kind, 'fixed');
    assert.equal(parsed.meta.minVoltage, 5);
    assert.equal(parsed.meta.current, 3);
    assert.equal(parsed.meta.power, 15);
    assert.equal(parsed.meta.valid, true);
  }
});

check('Fixed Source PDO revision fields are split correctly at B24 and B23', () => {
  const v20 = pdoVector((fixed5v | (1 << 24) | (1 << 23)) >>> 0, { revision: '2.0', position: 1 });
  assert.equal(getDetail(v20.out, 'Reserved [B24-22]'), '6');
  const v30 = pdoVector((fixed5v | (1 << 24) | (1 << 23)) >>> 0, { revision: '3.0', position: 1 });
  assert.match(getDetail(v30.out, 'Unchunked Extended Messages [B24]'), /1/);
  assert.equal(getDetail(v30.out, 'Reserved [B23]'), '1');
  for (const revision of ['3.1', '3.2']) {
    const parsed = pdoVector((fixed5v | (1 << 23)) >>> 0, { revision, position: 1 });
    assert.match(getDetail(parsed.out, 'EPR Capable [B23]'), /1/);
  }
});

check('Battery PDO scales voltage by 50mV and power by 250mW', () => {
  const raw = word([[31, 30, 1], [29, 20, 200], [19, 10, 100], [9, 0, 60]]);
  const parsed = pdoVector(raw, { revision: '3.2' });
  assert.equal(parsed.meta.kind, 'battery');
  assert.equal(parsed.meta.minVoltage, 5);
  assert.equal(parsed.meta.maxVoltage, 10);
  assert.equal(parsed.meta.power, 15);
});

check('Variable PDO scales voltage by 50mV and current by 10mA', () => {
  const raw = word([[31, 30, 2], [29, 20, 200], [19, 10, 100], [9, 0, 250]]);
  const parsed = pdoVector(raw, { revision: '3.2' });
  assert.equal(parsed.meta.kind, 'variable');
  assert.equal(parsed.meta.minVoltage, 5);
  assert.equal(parsed.meta.maxVoltage, 10);
  assert.equal(parsed.meta.current, 2.5);
});

check('PPS PDO uses 100mV voltage and 50mA current increments from PD 3.0', () => {
  const raw = word([[31, 30, 3], [29, 28, 0], [24, 17, 110], [15, 8, 33], [6, 0, 60]]);
  for (const revision of ['3.0', '3.1', '3.2']) {
    const parsed = pdoVector(raw, { revision });
    assert.equal(parsed.meta.kind, 'pps');
    assert.ok(Math.abs(parsed.meta.minVoltage - 3.3) < 1e-9);
    assert.equal(parsed.meta.maxVoltage, 11);
    assert.equal(parsed.meta.current, 3);
  }
});

check('PPS Power Limited is Reserved in 3.0 and defined for Source in 3.1/3.2', () => {
  const raw = word([[31, 30, 3], [29, 28, 0], [27, 27, 1], [24, 17, 110], [15, 8, 33], [6, 0, 60]]);
  const v30 = pdoVector(raw, { revision: '3.0' });
  assert.equal(getDetail(v30.out, 'Reserved [B27]'), '1');
  for (const revision of ['3.1', '3.2']) {
    const parsed = pdoVector(raw, { revision });
    assert.match(getDetail(parsed.out, 'PPS Power Limited [B27]'), /1/);
    assert.equal(parsed.meta.powerLimited, true);
  }
});

check('EPR AVS PDO uses 100mV bounds and one-byte PDP in PD 3.1/3.2', () => {
  const raw = word([[31, 30, 3], [29, 28, 1], [25, 17, 280], [15, 8, 150], [7, 0, 140]]);
  for (const revision of ['3.1', '3.2']) {
    const parsed = pdoVector(raw, { revision, position: 8, isEpr: true });
    assert.equal(parsed.meta.kind, 'epr_avs');
    assert.equal(parsed.meta.minVoltage, 15);
    assert.equal(parsed.meta.maxVoltage, 28);
    assert.equal(parsed.meta.power, 140);
    assert.equal(parsed.meta.valid, true);
  }
});

check('SPR AVS is Reserved in 3.1 and decoded with 10mA segment currents in 3.2', () => {
  const raw = word([[31, 30, 3], [29, 28, 2], [19, 10, 300], [9, 0, 0]]);
  const v31 = pdoVector(raw, { revision: '3.1' });
  assert.equal(v31.meta.kind, 'reserved_apdo');
  assert.equal(v31.meta.valid, false);
  const v32 = pdoVector(raw, { revision: '3.2' });
  assert.equal(v32.meta.kind, 'spr_avs');
  assert.equal(v32.meta.current15, 3);
  assert.equal(v32.meta.current20, 0);
});

check('PD 2.0 RDO uses B30:28 position and 10mA current units', () => {
  const raw = word([[30, 28, 1], [19, 10, 50], [9, 0, 100]]);
  const parsed = rdoVector(raw, { revision: '2.0' });
  assert.equal(parsed.position, 1);
  assert.equal(parsed.current, 0.5);
  assert.equal(parsed.limit, 1);
  assert.equal(parsed.valid, true);
});

check('GiveBack still selects minimum operating current in PD 3.1', () => {
  const raw = word([[31, 28, 1], [27, 27, 1], [19, 10, 10], [9, 0, 5]]);
  const parsed = rdoVector(raw, { revision: '3.1' });
  assert.equal(parsed.givebackBit, true);
  assert.equal(parsed.giveback, true);
  assert.equal(parsed.limit, 0.05);
  assert.equal(parsed.valid, true);
  assert.ok(parsed.out.details.some(d => d.key === '最小工作电流 [B9-0]'));
});

check('PD 3.2 ignores GiveBack B27 and interprets the deprecated limit as maximum', () => {
  const raw = word([[31, 28, 1], [27, 27, 1], [19, 10, 10], [9, 0, 10]]);
  const parsed = rdoVector(raw, { revision: '3.2' });
  assert.equal(parsed.givebackBit, true);
  assert.equal(parsed.giveback, false);
  assert.equal(parsed.limit, 0.1);
  assert.equal(parsed.valid, true);
  assert.ok(parsed.out.details.some(d => d.key === '最大工作电流 [B9-0]'));
  assert.equal(parsed.out.warnings.length, 0);
});

check('PD 3.2 deprecated GiveBack does not change Battery RDO minimum/maximum meaning', () => {
  const raw = word([[31, 28, 2], [27, 27, 1], [19, 10, 20], [9, 0, 20]]);
  const parsed = rdoVector(raw, { revision: '3.2', kind: 'battery', meta: { power: 5 } });
  assert.equal(parsed.giveback, false);
  assert.equal(parsed.power, 5);
  assert.equal(parsed.limit, 5);
  assert.ok(parsed.out.details.some(d => d.key === '最大工作功率 [B9-0]'));
  assert.equal(parsed.valid, true);
});

check('PPS and AVS RDO preserve their distinct voltage increments', () => {
  const ppsRaw = word([[31, 28, 2], [20, 9, 550], [6, 0, 40]]);
  const pps = rdoVector(ppsRaw, { revision: '3.2', kind: 'pps', meta: { minVoltage: 3.3, maxVoltage: 21, current: 3 } });
  assert.equal(pps.voltage, 11);
  assert.equal(pps.current, 2);

  const avsRaw = word([[31, 28, 8], [20, 9, 1120], [6, 0, 100]]);
  const avs = rdoVector(avsRaw, { revision: '3.2', kind: 'epr_avs', isEpr: true, meta: { minVoltage: 15, maxVoltage: 48, power: 140 } });
  assert.equal(avs.voltage, 28);
  assert.equal(avs.current, 5);
  assert.equal(avs.valid, true);

  const badStep = rdoVector(word([[31, 28, 8], [20, 9, 1121], [6, 0, 100]]), {
    revision: '3.2', kind: 'epr_avs', isEpr: true, meta: { minVoltage: 15, maxVoltage: 48, power: 140 },
  });
  assert.equal(badStep.valid, false);
  assert.ok(badStep.out.warnings.some(w => w.code === 'RDO_STEP'));
});

check('RDO encodes PD 3.1 positions 12/13 and rejects positions above 11 in PD 3.2', () => {
  const at13 = rdoVector(word([[31, 28, 13], [19, 10, 10], [9, 0, 10]]), { revision: '3.1', isEpr: true });
  assert.equal(at13.position, 13);
  assert.equal(at13.validPosition, true);
  const at12Latest = rdoVector(word([[31, 28, 12], [19, 10, 10], [9, 0, 10]]), { revision: '3.2', isEpr: true });
  assert.equal(at12Latest.validPosition, false);
});

check('BIST mode 0 is the PD 2.0 receiver test and PD 3.x mode 5 is carrier mode', () => {
  const legacy = emitter();
  bistParse(legacy, 0, 0, { revText: '2.0' });
  assert.match(getDetail(legacy.out, 'BIST Test Mode [B31-28]'), /BIST Receiver Mode/);
  const modern = emitter();
  bistParse(modern, (5 << 28) >>> 0, 0, { revText: '3.0' });
  assert.match(getDetail(modern.out, 'BIST Test Mode [B31-28]'), /BIST Carrier Mode/);
});

check('Alert extended-event type 5 is Reserved in 3.1 and defined in 3.2', () => {
  const v31 = emitter();
  alertParse(v31, 0x80000005, 0, { specRevision: '3.1', role: 'SRC' });
  assert.match(getDetail(v31.out, 'Extended Alert Event Type [B3-0]'), /Reserved（PD 3.1）/);
  assert.match(v31.out.notes.join(' '), /保留值 5/);
  const v32 = emitter();
  alertParse(v32, 0x80000005, 0, { specRevision: '3.2', role: 'SRC' });
  assert.match(getDetail(v32.out, 'Extended Alert Event Type [B3-0]'), /Source is about to reduce Source Capabilities/);
});

check('Enter_USB 3.1 reserves mode 3 and speed 4; 3.2 maps them to USB4/Gen4', () => {
  const raw = word([[30, 28, 3], [23, 21, 4]]);
  const v31 = emitter();
  enterUsbParse(v31, raw, { specRevision: '3.1' });
  assert.match(getDetail(v31.out, 'USB Mode [B30-28]'), /Reserved/);
  assert.match(getDetail(v31.out, 'Cable Speed [B23-21]'), /Reserved/);
  const v32 = emitter();
  enterUsbParse(v32, raw, { specRevision: '3.2' });
  assert.match(getDetail(v32.out, 'USB Mode [B30-28]'), /USB4（其他取值按 USB4 处理）/);
  assert.match(getDetail(v32.out, 'Cable Speed [B23-21]'), /USB4 Gen4/);
});

check('Source_Info uses 1W SIDO1 and 0.5W SIDO2 fields only in the 3.2 shape', () => {
  const sido1 = emitter();
  sourceInfoParse(sido1, word([[23, 16, 100], [15, 8, 80], [7, 0, 70]]), 0, { specRevision: '3.1' });
  assert.match(getDetail(sido1.out, 'Port Maximum PDP [B23-16]'), /100 W/);
  const extra31 = emitter();
  sourceInfoParse(extra31, 0, 1, { specRevision: '3.1' });
  assert.ok(extra31.out.warnings.some(w => w.code === 'SOURCE_INFO'));
  const sido2 = emitter();
  sourceInfoParse(sido2, word([[17, 9, 40], [8, 0, 30]]), 1, { specRevision: '3.2' });
  assert.match(getDetail(sido2.out, 'Port Maximum PDP [B17-9]'), /20 W/);
  assert.match(getDetail(sido2.out, 'Port Guaranteed PDP [B8-0]'), /15 W/);
});

check('Country Code object preserves the normative high-byte character order', () => {
  const em = emitter();
  const summary = countryCodeParse(em, 0x434e0000);
  assert.equal(summary, '国家码 CN');
});

check('Revision message decodes all four nibbles from the RMDO', () => {
  const em = emitter();
  revisionParse(em, 0x32120000);
  assert.match(em.out.notes.join(' '), /Revision 3\.2 Version 1\.2/);
});

check('Extended Source Capabilities adds EPR PDP at byte 24 in PD 3.1/3.2', () => {
  const v30Bytes = new Array(24).fill(0);
  const v30 = extendedVector(1, v30Bytes, { revision: '3.0' });
  assert.equal(v30.out.details.some(d => d.key === 'EPR Source PDP Rating [Byte24]'), false);
  for (const revision of ['3.1', '3.2']) {
    const bytes = new Array(25).fill(0);
    bytes[24] = 240;
    const parsed = extendedVector(1, bytes, { revision });
    assert.match(getDetail(parsed.out, 'EPR Source PDP Rating [Byte24]'), /240 W/);
  }
});

check('PPS Status converts output voltage by 20mV and current by 50mA', () => {
  const parsed = extendedVector(12, [0xf4, 0x01, 50, 8], { revision: '3.2' });
  assert.equal(getDetail(parsed.out, 'Output Voltage [Byte1-0]'), '10 V');
  assert.equal(getDetail(parsed.out, 'Output Current [Byte2]'), '2.5 A');
  assert.match(getDetail(parsed.out, 'Real Time Flags [Byte3]'), /Current Limit/);
});

check('3.0 SOP Status has a 5-byte base; 3.1/3.2 include the 7-byte status tail', () => {
  const old = extendedVector(2, new Array(5).fill(0), { revision: '3.0' });
  assert.equal(old.out.details.some(d => d.key === 'Power State Change [Byte6]'), false);
  for (const revision of ['3.1', '3.2']) {
    const parsed = extendedVector(2, new Array(7).fill(0), { revision });
    assert.ok(parsed.out.details.some(d => d.key === 'Power State Change [Byte6]'));
  }
});

check('Cable Status 2-byte thermal layout is reserved for PD 3.1/3.2', () => {
  const v30 = extendedVector(2, [25, 1], { revision: '3.0', link: 'cable' });
  assert.ok(v30.out.warnings.some(w => w.code === 'EXT_REVISION'));
  assert.equal(v30.out.details.some(d => d.key === 'Flags [Byte1]'), false);
  assert.equal(v30.out.details.some(d => d.key === 'Byte 0~1'), true);
  for (const revision of ['3.1', '3.2']) {
    const parsed = extendedVector(2, [25, 1], { revision, link: 'cable' });
    assert.equal(getDetail(parsed.out, 'Flags [Byte1]'), '已进入热关断 Thermal Shutdown —— 置位后保持，只有 Hard Reset 或线缆断电才清除（Cable Reset 无效）');
    assert.equal(parsed.out.warnings.some(w => w.code === 'EXT_REVISION'), false);
  }
});

check('PD 3.1 EPR capability message has a direct 11-object structural limit despite a conflicting Chapter 10 sentence', () => {
  const bytes = [0x2c, 0x91, 0x01, 0x00, ...new Array(48).fill(0)];
  const parsed = extendedVector(17, bytes, { revision: '3.1' });
  assert.ok(parsed.out.warnings.some(w => /最多 11 个/.test(w.message)));
});

check('PD 3.2 EPR capability message remains limited to 11 PDOs', () => {
  const bytes = [0x2c, 0x91, 0x01, 0x00, ...new Array(40).fill(0)];
  const parsed = extendedVector(17, bytes, { revision: '3.2' });
  assert.equal(parsed.out.warnings.some(w => /最多 11 个/.test(w.message)), false);
});

check('Security and Firmware Update bodies remain raw because USB PD delegates their internal schemas', () => {
  const security = extendedVector(8, [1, 2, 3, 4], { revision: '3.2' });
  assert.match(security.out.details.map(d => d.value).join(' '), /USB PD 规范不定义其内部格式/);
  const firmware = extendedVector(10, [1, 2, 3, 4], { revision: '3.2' });
  assert.match(firmware.out.details.map(d => d.value).join(' '), /USB PD 规范不定义其内部格式/);
});

console.log(`\n${checks} independent PD object vector groups passed.`);
writeFileSync(new URL('../artifacts/pd-spec-audit/objects-audit-results.json', import.meta.url), `${JSON.stringify({
  test: 'tools/pd-audit-objects.mjs',
  result: 'passed',
  vectorGroups: checks,
  groups: passed,
}, null, 2)}\n`, 'utf8');
console.log('Machine-readable results: artifacts/pd-spec-audit/objects-audit-results.json');
