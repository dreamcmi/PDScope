import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { BmcDecoder } from '../src/js/core/bmc.js';
import { PdDecoder, crc32, DEC4B5B, SOP_ORDERED_SETS, matchOrderedSet } from '../src/js/pd/index.js';

const tests = [];
function test(name, fn) { tests.push([name, fn]); }
function rawIndex(code) {
  // Table codewords are printed b4..b0; PDScope stores the first wire bit in bit 0.
  return [...code].reverse().reduce((n, bit, i) => n | (Number(bit) << i), 0);
}

const symbols = [
  ['0','11110'], ['1','01001'], ['2','10100'], ['3','10101'],
  ['4','01010'], ['5','01011'], ['6','01110'], ['7','01111'],
  ['8','10010'], ['9','10011'], ['A','10110'], ['B','10111'],
  ['C','11010'], ['D','11011'], ['E','11100'], ['F','11101'],
  ['SYNC1','11000'], ['SYNC2','10001'], ['SYNC3','00110'],
  ['RST1','00111'], ['RST2','11001'], ['EOP','01101'],
];

test('PD 3.2 Table 5.2: all data and K-code 4b5b words decode in wire bit order', () => {
  const logical = new Map(symbols.map(([name]) => [name, name === 'SYNC1' ? 0x11 : name === 'SYNC2' ? 0x12
    : name === 'SYNC3' ? 0x13 : name === 'RST1' ? 0x14 : name === 'RST2' ? 0x15
      : name === 'EOP' ? 0x16 : Number.parseInt(name, 16)]));
  for (const [name, code] of symbols) assert.equal(DEC4B5B[rawIndex(code)], logical.get(name), `${name} ${code}`);
  for (const code of ['00000','00001','00010','00011','00100','00101','01000','01100','10000','11111']) {
    assert.equal(DEC4B5B[rawIndex(code)], 0x10, `reserved ${code}`);
  }
});

test('PD 3.2 Table 5.3: every SOP*, Debug, Hard Reset and Cable Reset ordered set is exact', () => {
  const expected = [
    ['SOP',[0x11,0x11,0x11,0x12]], ["SOP'",[0x11,0x11,0x13,0x13]],
    ['SOP\'\'', [0x11,0x13,0x11,0x13]], ["SOP' Debug",[0x11,0x15,0x15,0x13]],
    ["SOP'' Debug",[0x11,0x15,0x13,0x12]], ['Cable Reset',[0x14,0x11,0x14,0x13]],
    ['Hard Reset',[0x14,0x14,0x14,0x15]],
  ];
  assert.deepEqual(SOP_ORDERED_SETS.map(({ name, sequence }) => [name, sequence]), expected);
  for (const [name, sequence] of expected) assert.equal(matchOrderedSet(sequence).set.name, name);
});

test('PD 3.2 §5.3.1.2 BMC: a literal bit sequence round-trips through edge timing', () => {
  const input = [1,0,1,1,0,0,1,0,1,1,1,0];
  const ui = 4; // 600 kHz half-bit sampling => 4 samples/UI at 2.4 MHz.
  const bmc = new BmcDecoder({ sampleRate: 2_400_000, minEdges: 1 });
  let t = 0;
  bmc.pushEdge(t);
  for (const bit of input) {
    if (bit) { t += ui; bmc.pushEdge(t); t += ui; bmc.pushEdge(t); }
    else { t += 2 * ui; bmc.pushEdge(t); }
  }
  const packet = bmc.pushEdge(t + 4 * ui, true);
  assert.ok(packet);
  assert.deepEqual(packet.bits, input);
  assert.deepEqual(packet.bad, []);
});

test('PD 2.0 Figure 5-4 / Table 5-10 CRC vector: GoodCRC header 41 02 => 46B50D97', () => {
  assert.equal(crc32([0x41, 0x02]), 0x46B50D97);
  const p = new PdDecoder({ sampleRate: 2_500_000, specRevision: '3.2' })
    .decodeWire([0x41, 0x02], { crc: 0x46B50D97 });
  assert.equal(p.crcOk, true);
  assert.equal(p.frameValid, true);
});

function goodCrc(revisionCode, specRevision) {
  const header = (revisionCode << 6) | 0x0001; // GoodCRC, MessageID 0, 16-bit little-endian Header.
  const bytes = [header & 0xFF, header >>> 8];
  return new PdDecoder({ sampleRate: 2_500_000, specRevision }).decodeWire(bytes, { crc: crc32(bytes) });
}

test('PD 3.0/3.1/3.2 GoodCRC revision field is ignored even for 11b and legacy-looking headers', () => {
  for (const profile of ['3.0','3.1','3.2']) {
    for (const rev of [0,1,2,3]) {
      const p = goodCrc(rev, profile);
      assert.equal(p.crcOk, true);
      assert.equal(p.frameValid, true);
      assert.ok(!p.warnings.some(w => w.short === 'REV'), `${profile} rev=${rev}`);
      assert.ok(p.details.some(d => d.key === 'Revision 语义'));
    }
  }
});

test('PD 2.0 does not inherit the later GoodCRC revision exception', () => {
  for (const rev of [2,3]) {
    const p = goodCrc(rev, '2.0');
    assert.equal(p.crcOk, true);
    assert.ok(p.warnings.some(w => w.short === 'REV'), `PD 2.0 rev=${rev}`);
  }
});

test('PD 3.2 §6.5.1.1/§9.1.2.1.2.3: nonzero final-chunk padding is warned, trimmed, and not treated as data', () => {
  const header = 0x8000 | 0x1000 | (2 << 6) | 31; // Extended, one object, rev 3.x, reserved ext type.
  const wire = [header & 0xFF, header >>> 8, 0x01, 0x80, 0xA5, 0x7E];
  const p = new PdDecoder({ sampleRate: 2_500_000, specRevision: '3.2' }).decodeWire(wire, { crc: crc32(wire) });
  assert.equal(p.crcOk, true);
  assert.equal(p.frameValid, true);
  assert.equal(p.reassembly.complete, true);
  assert.deepEqual(p.reassembly.bytes, [0xA5]);
  assert.ok(p.warnings.some(w => w.short === 'PADDING'));
});

const results = [];
for (const [name, fn] of tests) {
  try {
    fn();
    results.push({ name, status: 'passed' });
    process.stdout.write(`ok - ${name}\n`);
  } catch (error) {
    results.push({ name, status: 'failed', error: String(error?.stack ?? error) });
    process.stderr.write(`not ok - ${name}\n${String(error?.stack ?? error)}\n`);
  }
}
const report = { suite: 'pd-audit-wire', generatedAt: new Date().toISOString(), passed: results.filter(r => r.status === 'passed').length,
  failed: results.filter(r => r.status === 'failed').length, results };
const resultUrl = new URL('../artifacts/pd-spec-audit/wire-audit-results.json', import.meta.url);
await mkdir(new URL('../artifacts/pd-spec-audit/', import.meta.url), { recursive: true });
await writeFile(resultUrl, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
process.stdout.write(`${report.passed}/${results.length} wire audit vectors passed; wrote ${resultUrl.pathname}\n`);
if (report.failed) process.exitCode = 1;
