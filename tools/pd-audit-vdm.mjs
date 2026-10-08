import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { vdmParse } from '../src/js/pd/vdm.js';
import { isStandardSvid, svidName, svidText } from '../src/js/pd/svid.js';

const results = [];
const failures = [];

function check(name, fn) {
  try {
    fn();
    results.push({ name, pass: true });
  } catch (error) {
    failures.push({ name, pass: false, error: error?.stack ?? String(error) });
  }
}

function header({ svid = 0xFF00, structured = true, major = 1, minor = 0, pos = 0, type = 0, cmd = 1, payload = 0 } = {}) {
  return ((svid << 16) | (structured ? 1 << 15 : 0) | (major << 13) | (minor << 11)
    | (pos << 8) | (type << 6) | (payload << 0) | cmd) >>> 0;
}

function ctx(specRevision = '3.2', { sop = 'SOP', dataRole = 1, role = 'SRC' } = {}) {
  return { specRevision, revText: specRevision === '2.0' ? '2.0' : '3.x', sop,
    sopName: sop, link: sop === 'SOP' ? 'port' : 'cable', role, dataRole };
}

function run(vdos, context = ctx(), state = {}) {
  const details = [], warnings = [], notes = [], objects = [];
  const em = {
    object: (name) => objects.push(name),
    detail: (key, value) => details.push({ key: String(key), value: String(value) }),
    note: (value) => notes.push(String(value)),
    warn: (text, code = 'FIELD') => warnings.push({ text: String(text), code }),
  };
  const st = { modes: {}, activeModes: {}, ...state };
  const result = vdmParse(st, em, vdos, context);
  return { result, st, details, warnings, notes, objects };
}

function identityHeader({ ufp = 0, dfp = 0, vid = 0x1234 } = {}) {
  return ((ufp << 27) | (1 << 26) | (dfp << 23) | (2 << 21) | vid) >>> 0;
}

function identityReply(specRevision, id, productTypeVdos = []) {
  const major = specRevision === '2.0' ? 0 : 1;
  return run([header({ major, type: 1, cmd: 1 }), id, 0, 0, ...productTypeVdos], ctx(specRevision));
}

// Normative SVDM encodings from PD 2.0 Table 6-19 / §6.4.4.2.3,
// PD 3.0 Table 6-25 / §6.4.4.2.3, PD 3.1 Table 6-29 / §6.4.4.2.3,
// and PD 3.2 Table 6.33 / §6.4.12.2.1.
check('PD 2.0 V1.0 Major=00 request', () => {
  const r = run([header({ major: 0, cmd: 1 })], ctx('2.0'));
  assert.equal(r.warnings.length, 0);
  assert.match(r.details.find((d) => d.key.includes('Minor'))?.value ?? '', /Reserved/);
});

check('Major legality follows each selected PD revision', () => {
  const pd2Higher = run([header({ major: 1, cmd: 1 })], ctx('2.0'));
  assert.ok(pd2Higher.warnings.some((w) => /PD 2\.0/.test(w.text)));
  const pd30Legacy = run([header({ major: 0, cmd: 1 })], ctx('3.0'));
  assert.ok(pd30Legacy.warnings.some((w) => /Major=00b/.test(w.text)));
  const pd32Legacy = run([header({ major: 0, cmd: 1 })], ctx('3.2'));
  assert.equal(pd32Legacy.warnings.length, 0);
  assert.match(pd32Legacy.details.find((d) => d.key.includes('Major'))?.value ?? '', /Deprecated/);
});

check('SVID-defined command owns the Minor bits', () => {
  const r = run([header({ svid: 0x1234, major: 0, minor: 1, cmd: 16 })], ctx('3.2'));
  assert.equal(r.warnings.length, 0);
  assert.match(r.details.find((d) => d.key.includes('Minor'))?.value ?? '', /由 SVID 定义/);
});

check('PD 2.0 SOP B5 still provides data-role evidence', () => {
  const ufpAttention = run([header({ major: 0, cmd: 6, pos: 1 })], ctx('2.0', { dataRole: 0, role: 'SNK' }));
  assert.equal(ufpAttention.warnings.length, 0);
  const dfpAttention = run([header({ major: 0, cmd: 6, pos: 1 })], ctx('2.0', { dataRole: 1, role: 'SRC' }));
  assert.ok(dfpAttention.warnings.some((w) => w.code === 'ROLE'));
});

check('PD 3.0 V2.0 Major=01 Minor reserved', () => {
  const r = run([header({ major: 1, minor: 0, cmd: 1 })], ctx('3.0', { dataRole: 0, role: 'SNK' }));
  assert.equal(r.warnings.length, 0);
  assert.match(r.details.find((d) => d.key.includes('Minor'))?.value ?? '', /Reserved/);
});

check('PD 3.1 V2.0 Major=01 Minor reserved', () => {
  const r = run([header({ major: 1, minor: 0, cmd: 1 })], ctx('3.1', { dataRole: 0, role: 'SNK' }));
  assert.equal(r.warnings.length, 0);
  assert.match(r.details.find((d) => d.key.includes('Minor'))?.value ?? '', /Reserved/);
});

check('PD 3.2 V2.0 and V2.1 Minor encodings', () => {
  for (const [minor, expected] of [[0, 'Version 2.0'], [1, 'Version 2.1']]) {
    const r = run([header({ major: 1, minor, cmd: 1 })], ctx('3.2'));
    assert.equal(r.warnings.length, 0);
    assert.match(r.details.find((d) => d.key.includes('Minor'))?.value ?? '', new RegExp(expected));
  }
});

check('unknown 3.x preserves the 3.0/3.1 versus 3.2 Minor ambiguity', () => {
  const r = run([header({ major: 1, minor: 0, cmd: 1 })], { ...ctx('3.2'), specRevision: null });
  assert.match(r.details.find((d) => d.key.includes('Minor'))?.value ?? '', /PD 3\.0\/3\.1: Reserved/);
  assert.ok(r.details.some((d) => d.key === '版本歧义'));
});

check('PD 3.1 rejects a nonzero standard-command Minor', () => {
  const r = run([header({ major: 1, minor: 1, cmd: 1 })], ctx('3.1'));
  assert.ok(r.warnings.some((w) => /Minor/.test(w.text)));
});

// Standard command limits from Table 6-20 (PD 2.0), Table 6-26 (PD 3.0),
// Table 6-30 (PD 3.1), Table 6.32 (PD 3.2), plus §6.4.12.5-8.
check('Discover Modes is not sent on SOP\'\' and Enter/Exit cannot return BUSY', () => {
  const wrongLink = run([header({ svid: 0x1234, cmd: 3 })], ctx('3.2', { sop: "SOP''", role: 'SRC' }));
  assert.ok(wrongLink.warnings.some((w) => w.code === 'SOP'));
  const busy = run([header({ svid: 0x1234, cmd: 4, type: 3, pos: 1 })], ctx('3.2', { dataRole: 0, role: 'SNK' }));
  assert.ok(busy.warnings.some((w) => /不能返回 BUSY/.test(w.text)));
});

check('known Discover Modes count constrains Object Position', () => {
  const state = { modes: { 4660: [0x1] } };
  const r = run([header({ svid: 0x1234, cmd: 4, pos: 2 })], ctx('3.2'), state);
  assert.ok(r.warnings.some((w) => /超过已捕获 Discover Modes ACK/.test(w.text)));
});

check('Discover SVIDs terminator forbids following nonzero entries', () => {
  const r = run([header({ cmd: 2, type: 1 }), 0x00001234], ctx('3.2', { dataRole: 0, role: 'SNK' }));
  assert.ok(r.warnings.some((w) => /终止符/.test(w.text)));
});

check('Exit Mode position 7 clears all active modes in the supplied SVDM state', () => {
  const state = { activeModes: { '4660:1': true, '22136:2': true } };
  const r = run([header({ svid: 0x1234, cmd: 5, type: 1, pos: 7 })], ctx('3.2', { dataRole: 0, role: 'SNK' }), state);
  assert.deepEqual(r.st.activeModes, {});
});

check('Unstructured VDM requires a nonzero nonstandard VID and accepts unknown values', () => {
  const bad = run([header({ svid: 0xFF00, structured: false, payload: 0x1234 })], ctx('3.2'));
  assert.ok(bad.warnings.some((w) => /厂商 VID/.test(w.text)));
  const good = run([header({ svid: 0x1234, structured: false, payload: 0x1234 })], ctx('3.2'));
  assert.equal(good.warnings.length, 0);
  const ufp = run([header({ svid: 0x1234, structured: false })], ctx('3.2', { dataRole: 0, role: 'SNK' }));
  assert.ok(ufp.warnings.some((w) => w.code === 'ROLE'));
});

// Identity Product Type differences: PD 3.0 Table 6-29/6-32 and Table 6-37 AMA VDO;
// PD 3.1 Tables 6-33..6-44; PD 3.2 Tables 6.34..6.45 and §6.4.12.3.10.
check('PD 3.0 DFP AMC code 100b uses the legacy AMA VDO', () => {
  const r = identityReply('3.0', identityHeader({ dfp: 4 }), [0]);
  assert.ok(r.details.some((d) => d.key === 'VDO Version [B23-21]'));
  assert.ok(r.details.some((d) => d.key.startsWith('Product Type (DFP)') && /AMC/.test(d.value)));
});

check('PD 3.1 reserves old AMA/AMC product codes', () => {
  const ufp = identityReply('3.1', identityHeader({ ufp: 5 }), [0]);
  assert.ok(ufp.details.some((d) => d.key.startsWith('Product Type (UFP)') && /Reserved/.test(d.value)));
  assert.ok(!ufp.objects.some((o) => /AMA VDO/.test(o)));
  const dfp = identityReply('3.1', identityHeader({ dfp: 4 }), [0]);
  assert.ok(dfp.details.some((d) => d.key.startsWith('Product Type (DFP)') && /Reserved/.test(d.value)));
  assert.ok(!dfp.objects.some((o) => /DFP VDO/.test(o)));
});

check('PD 3.2 keeps AMA/AMC only as deprecated legacy identity formats', () => {
  const ufp = identityReply('3.2', identityHeader({ ufp: 5 }), [0]);
  assert.ok(ufp.objects.some((o) => /AMA VDO/.test(o)));
  const dfp = identityReply('3.2', identityHeader({ dfp: 4 }), [0]);
  assert.ok(dfp.objects.some((o) => /AMA VDO/.test(o)));
});

check('DPTC is a PD-standard SVID only in the PD 3.2 table', () => {
  assert.equal(isStandardSvid(0xFF01, { specRevision: '3.1' }), false);
  assert.equal(isStandardSvid(0xFF01, { specRevision: '3.2' }), true);
  assert.equal(svidName(0xFF01, { specRevision: '3.1' }), null);
  assert.match(svidText(0xFF01, { specRevision: '3.2' }), /DPTC SID/);
});

const report = { suite: 'pd-audit-vdm', generatedAt: new Date().toISOString(),
  passed: results.length, failed: failures.length, results: [...results, ...failures] };
const resultPath = resolve(dirname(fileURLToPath(import.meta.url)), '../artifacts/pd-spec-audit/vdm-audit-results.json');
await mkdir(dirname(resultPath), { recursive: true });
await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({ ...report, results: results.map(({ name }) => name), failures }, null, 2)}\n`);
if (failures.length) process.exitCode = 1;
