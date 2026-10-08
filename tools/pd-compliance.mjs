/** Spec vectors: doc USB PD 2.0 v1.3, 3.0 v1.1, 3.1 v1.4, 3.2 v1.2.
 * Expected bit positions/units are literal fixtures independent of decoder tables.
 * Run: node tools/pd-compliance.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { PdDecoder, crc32, pdoParse, rdoParse, matchOrderedSet } from '../src/js/pd/index.js';
import { BmcDecoder } from '../src/js/core/bmc.js';
import { PowerzStreamCapture, writePdStream, sniffPdStream } from '../src/js/core/pdstream.js';

const results = [];
function test(name, fn) {
  try { fn(); results.push({ name, pass: true }); }
  catch (e) { results.push({ name, pass: false, error: e.stack }); console.error(`FAIL ${name}: ${e.message}`); }
}
const codes = [30, 9, 20, 21, 10, 11, 14, 15, 18, 19, 22, 23, 26, 27, 28, 29]; // Table 5.2
const ordered = { SOP: [24, 24, 24, 17], "SOP'": [24, 24, 6, 6], "SOP''": [24, 6, 24, 6],
  "SOP' Debug": [24, 25, 25, 6], "SOP'' Debug": [24, 25, 6, 17], 'Hard Reset': [7, 7, 7, 25], 'Cable Reset': [7, 24, 7, 6] };
const u32 = v => [v & 255, v >>> 8 & 255, v >>> 16 & 255, v >>> 24 & 255];
const u16 = v => [v & 255, v >>> 8 & 255];
function checksum(bytes) {
  let c = 0xFFFFFFFF;
  for (const b of bytes) { c ^= b; for (let k = 0; k < 8; k++) c = (c & 1) ? c >>> 1 ^ 0xEDB88320 : c >>> 1; }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
const head = (type, n = 0, { rev = 2, sender = 1, dr = 0, id = 0, ext = 0 } = {}) => ext << 15 | n << 12 | id << 9 | sender << 8 | rev << 6 | dr << 5 | type;
function raw(wire, sop = 'SOP', crc = checksum(wire)) {
  const bits = [];
  const sym = code => { for (let k = 0; k < 5; k++) bits.push(code >>> k & 1); };
  for (const code of ordered[sop]) sym(code);
  for (const b of [...wire, ...u32(crc)]) { sym(codes[b & 15]); sym(codes[b >>> 4]); }
  sym(13);
  return { bits, edges: [], startSample: 0, endSample: bits.length * 8, bitrate: 300000 };
}
const decoder = (profile = null) => new PdDecoder({ sampleRate: 2500000, specRevision: profile });
const send = (d, type, words = [], o = {}) => d.decode(raw([...u16(head(type, words.length, o)), ...words.flatMap(u32)], o.sop ?? 'SOP', o.badCrc ? 0 : undefined), o.channel ?? 0);
function extRaw(type, bytes, { chunked = false, chunk = 0, size = bytes.length, request = false, sender = 1, id = 0, sop = 'SOP', badCrc = false } = {}) {
  const n = chunked ? Math.ceil((2 + bytes.length) / 4) : 0;
  const eh = (chunked ? 0x8000 : 0) | chunk << 11 | (request ? 0x400 : 0) | size;
  const pad = chunked ? (4 - (2 + bytes.length) % 4) % 4 : 0;
  const wire = [...u16(head(type, n, { ext: 1, sender, id })), ...u16(eh), ...bytes, ...new Array(pad).fill(0)];
  return raw(wire, sop, badCrc ? 0 : undefined);
}
const extended = (d, t, b, o = {}) => d.decode(extRaw(t, b, o), o.channel ?? 0);
const warn = (p, code) => p.warnings.some(w => w.short === code);
const detail = (p, key, value) => p.details.some(d => d.key.includes(key) && (value === undefined || d.value.includes(value)));
const st = () => ({ pdos: { source: {}, sink: {} }, pdoMeta: { source: {}, sink: {} } });
const emitter = () => ({ details: [], warnings: [], object(v) { this.details.push(['Object', v]); }, detail(k,v) { this.details.push([k, String(v)]); }, note() {}, warn(v,c) { this.warnings.push([c,v]); } });
const fixed5 = 0x0001912C; // 100*50mV, 300*10mA
const fixed9 = 0x0002D12C;
const pps = 0xC0DC3264; // 5..11V, 5A
const avs = 0xD2309664; // 15..28V, PDP100W
const requestPps = 0x2003843C; // PDO2, 9V, 3A

test('5.1 Figure: GoodCRC [41 02] CRC 46B50D97', () => assert.equal(crc32([0x41, 0x02]), 0x46B50D97));
test('5.2 all 16 data symbols and legal 0BAD halves', () => {
  const p = send(decoder(), 0, [0x76543210, 0xFEDCBA98, 0x0BAD0BAD]);
  assert.deepEqual(p.dataWords, [0x76543210, 0xFEDCBA98, 0x0BAD0BAD]); assert.equal(p.crcOk, true);
});
test('Header 0BAD is data, not failure sentinel', () => {
  const p = decoder().decode(raw([0xAD, 0x0B])); assert.equal(p.header, 0xBAD); assert.equal(p.crcOk, true);
});
test('5.3/5.4 every ordered set incl debug and reset', () => {
  for (const sop of Object.keys(ordered)) {
    const p = decoder().decode(raw([0x81, 0x01], sop)); assert.equal(p.sop, sop);
  }
});
test('5.5 ambiguous 3/4 SOP cannot choose arbitrarily', () => assert.equal(matchOrderedSet([0x11,0x11,0x11,0x13]).set, null));
test('Invalid 4B5B symbol cannot masquerade as a data nibble', () => {
  const r = raw([...u16(head(1, 1)), ...u32(fixed5)]); r.bits.fill(0, 40, 45);
  const d = decoder(); const p = d.decode(r); assert.equal(p.crcOk, false); assert.ok(warn(p, 'SYM')); assert.deepEqual(d.st.pdos.source, {});
});
test('Every truncation boundary returns safely without state updates', () => {
  const r = raw([...u16(head(1, 1)), ...u32(fixed5)]);
  for (let n = 0; n < r.bits.length; n++) { const d = decoder(); const p = d.decode({ ...r, bits: r.bits.slice(0,n) }); assert.deepEqual(d.st.pdos.source, {}); if (p) assert.equal(p.frameValid, false); }
});
test('CRC failure and missing EOP cannot replace advertised PDOs', () => {
  const d = decoder(); send(d, 1, [fixed5]); send(d,1,[fixed9],{badCrc:true});
  assert.equal(d.st.pdoMeta.source[1].raw, fixed5);
  const r = raw([...u16(head(1,1)), ...u32(fixed9)]); r.bits.splice(-5); const p = d.decode(r);
  assert.ok(warn(p,'EOP')); assert.equal(d.st.pdoMeta.source[1].raw, fixed5);
});
test('Capabilities replace entire list; GoodCRC does not clear it', () => {
  const d = decoder(); send(d,1,[fixed5,pps]); send(d,1); assert.ok(d.st.pdoMeta.source[2]);
  send(d,1,[fixed5],{id:1}); assert.equal(d.st.pdoMeta.source[2], undefined);
});
test('PDO tables isolate channel and SOP links', () => {
  const d = decoder(); send(d,1,[fixed5,pps]);
  assert.ok(send(d,2,[requestPps],{sender:0}).summary.includes('9V 3A'));
  assert.ok(send(d,2,[requestPps],{sender:0,channel:1}).summary.includes('Unknown PDO'));
  assert.ok(send(d,2,[requestPps],{sender:0,sop:"SOP'"}).summary.includes('Unknown PDO'));
});
test('Hard Reset clears all links; Cable Reset preserves port PDOs', () => {
  const d = decoder(); send(d,1,[fixed5,pps]); d.decode(raw([], 'Cable Reset'));
  assert.ok(send(d,2,[requestPps],{sender:0}).summary.includes('9V 3A'));
  const p = d.decode(raw([], 'Hard Reset')); assert.ok(p.summary.includes('硬复位'));
  assert.ok(send(d,2,[requestPps],{sender:0}).summary.includes('Unknown PDO'));
});
test('Soft Reset clears transfers; Data Reset Complete is not VDM', () => {
  const d = decoder(); extended(d,8,new Array(26).fill(1),{chunked:true,size:30}); send(d,13);
  const p = extended(d,8,[2,2,2,2],{chunked:true,size:30,chunk:1}); assert.ok(warn(p,'CHUNK_GAP'));
  assert.ok(!send(d,15).summary.includes('VDM'));
});
test('Duplicate message flagged and does not replay semantic state', () => { const d = decoder(); send(d,1,[fixed5]); assert.equal(send(d,1,[fixed5]).isRetry,true); });
test('decodeWire timestamps obey sampleRate and CRC evidence', () => {
  const wire = [...u16(head(1,1)),...u32(fixed5)]; const d = decoder();
  const p = d.decodeWire(wire,{timeMs:123.25,crcRecorded:true}); assert.equal(p.timeMs,123.25); assert.equal(p.crcOk,null);
  assert.equal(d.decodeWire(wire,{crc:0}).crcOk,false); assert.equal(d.decodeWire(wire,{crc:checksum(wire)}).crcOk,true);
  assert.equal(p.bitrate,300000);
});
for (const [word, kind, volts, current, power] of [
  [fixed5,'fixed',[5,5],3,15], [0x59019190,'battery',[5,20],undefined,100],
  [0x9901912C,'variable',[5,20],3,undefined], [pps,'pps',[5,11],5,undefined],
  [avs,'epr_avs',[15,28],undefined,100], [0xE007D12C,'spr_avs',[9,20],undefined,undefined],
]) test(`6.8..6.17 ${kind} units`, () => {
  const r = pdoParse(st(), emitter(), word, { role:'source',position:kind==='epr_avs'?8:1,isEpr:kind==='epr_avs',revText:'3.x' });
  assert.equal(r.meta.kind,kind); assert.deepEqual([r.meta.minVoltage,r.meta.maxVoltage],volts);
  if (current !== undefined) assert.equal(r.meta.current,current); if (power !== undefined) assert.equal(r.meta.power,power);
});
test('Sink fixed/PPS reserved bits cannot claim peak or power limiting', () => {
  const e = emitter(); pdoParse(st(),e,fixed5 | 0x300000,{role:'sink',position:1});
  assert.ok(!e.details.some(([k,v]) => k.startsWith('Peak Current') && !v.includes('Reserved')));
  const e2=emitter(); pdoParse(st(),e2,pps | 0x8000000,{role:'sink',position:2}); assert.ok(!e2.details.some(([k])=>k.includes('PPS Power Limited')));
});
test('PD2.0 PDO APDO and EPR flags are reserved', () => {
  const s=st(),e=emitter(); pdoParse(s,e,pps,{role:'source',position:2,revText:'2.0'}); assert.equal(s.pdoMeta.source[2].kind,'reserved_apdo');
  pdoParse(s,e,fixed5 | 0x1800000,{role:'source',position:1,revText:'2.0'}); assert.ok(!e.details.some(([k])=>k.includes('EPR Capable')));
});
test('6.19..6.22 RDO units and voltage/current bounds', () => {
  const d=decoder(); send(d,1,[fixed5,pps]); const p=send(d,2,[requestPps],{sender:0}); assert.ok(p.summary.includes('9V 3A')); assert.ok(!warn(p,'RDO_RANGE'));
  assert.ok(warn(send(d,2,[0x200FA07F],{sender:0,id:1}),'RDO_RANGE'));
});
test('EPR Request uses copied PDO without overwriting advertisements', () => {
  const d=decoder(); send(d,1,[fixed5,pps]); const p=send(d,9,[0x8008C03C,avs],{sender:0});
  assert.ok(p.summary.includes('28V 3A')); assert.equal(d.st.pdoMeta.source[2].raw,pps); assert.equal(d.st.pdoMeta.source[8],undefined);
});
test('RDO positions 0/8/12/15 reject appropriately by profile', () => {
  for(const pos of [0,8,12,15]) assert.ok(warn(send(decoder('3.2'),2,[pos<<28],{sender:0}),'RDO_POSITION'));
  assert.ok(warn(send(decoder('3.2'),9,[12<<28,avs],{sender:0}),'RDO_POSITION'));
  assert.ok(!warn(send(decoder('3.1'),9,[12<<28,avs],{sender:0}),'RDO_POSITION'));
});
test('PD2.0 GiveBack and BIST error counter preserve legacy interpretation', () => {
  const d=decoder(); send(d,1,[fixed5],{rev:1}); const p=send(d,2,[0x1804B064],{rev:1,sender:0}); assert.ok(detail(p,'最小工作电流','1 A'));
  assert.ok(detail(send(d,3,[0x20001234],{rev:1}),'BIST Error Counter','4660'));
  assert.ok(send(d,3,[0x50000000],{rev:1,id:1}).summary.includes('Carrier Mode 2'));
});
test('6.23..6.31 data message fixed fields', () => {
  const d=decoder(); assert.ok(detail(send(d,5,[0x00640A00]),'电池当前容量','10 Wh'));
  assert.ok(detail(send(d,6,[0x80000004]),'Extended Alert Event Type','4'));
  assert.ok(detail(send(d,7,[0x434E0000]),'First Character','C'));
  assert.ok(detail(send(d,8,[0x20400000]),'USB Mode','USB4'));
  assert.ok(detail(send(d,10,[0x018C0000],{sender:0}),'Data','140 W'));
  assert.ok(detail(send(d,11,[0x80643C1E,0xC000FA64]),'Port Guaranteed PDP','50 W'));
  assert.ok(send(d,12,[0x32120000]).summary.includes('Revision 3.2 Version 1.2'));
});
const vdm = (d, cmd, type=0, extra=[], { pos=0, svid=0xFF00, ...o }={}) => send(d,15,[(svid<<16 | 0xA000 | pos<<8 | type<<6 | cmd)>>>0,...extra],o);
test('6.33 BUSY discovery is legal, Attention object position is meaningful', () => {
  const d=decoder(); const p=vdm(d,1,3); assert.ok(!p.summary.includes('不是')); assert.ok(!warn(p,'VDM_FIELD'));
  const a=vdm(d,6,0,[0x12345678],{svid:0xFF01,pos:2,id:1}); assert.ok(detail(a,'Object Position','第 2')); assert.ok(!warn(a,'VDM_FIELD'));
});
test('6.34 DFP-only identity selects DFP VDO', () => {
  const p=vdm(decoder(),1,1,[0x01601234,0,0x56780001,0x46000003]); assert.ok(detail(p,'Object','DFP VDO')); assert.ok(!detail(p,'Object','UFP VDO'));
});
test('6.34 invalid cable product type preserved as raw', () => {
  const p=vdm(decoder(),1,1,[0x08001234,0,0,0x12345678],{sop:"SOP'"}); assert.ok(detail(p,'Object','未知产品类型')); assert.ok(!detail(p,'Object','Passive Cable VDO'));
});
test('PD2.0 and PD3.0 active cables need one legacy VDO', () => {
  for(const profile of ['2.0','3.0']) {
    const p=vdm(decoder(profile),1,1,[0x20001234,0,0,0x00086058],{rev:profile==='2.0'?1:2,sop:"SOP'"});
    assert.ok(!p.summary.includes('缺少 Active')); assert.ok(detail(p,profile==='2.0'?'SSTX1 Directionality':'Maximum VBUS Voltage'));
  }
});
test('6.46 SVID list stops at first zero and accumulates paged discovery', () => {
  const d=decoder(); vdm(d,2,1,[0xFF01FF02],{id:0}); vdm(d,2,1,[0x00001234],{id:1}); assert.deepEqual(d.st.svidList,[0xFF01,0xFF02]);
});
test('Modes/Enter/Exit and Data Reset preserve power and clear modes', () => {
  const d=decoder(); send(d,1,[fixed5]); vdm(d,3,1,[0x12345678],{svid:0xFF01}); assert.equal(d.st.modes[0xFF01][0],0x12345678);
  vdm(d,4,1,[],{svid:0xFF01,pos:1,id:1}); assert.ok(d.st.activeModes['65281:1']);
  send(d,14); assert.deepEqual(d.st.activeModes,{}); assert.equal(d.st.pdoMeta.source[1].raw,fixed5);
});
test('6.48 Request Chunk consumes two padding bytes and is not payload', () => {
  const p=extended(decoder(),1,[],{chunked:true,request:true,chunk:3,size:0}); assert.equal(p.crcOk,true); assert.equal(p.nObjects,1); assert.equal(p.reassembly.status,'request'); assert.ok(!detail(p,'Vendor ID'));
});
test('6.48 invalid ext headers and padding are diagnosed', () => {
  assert.ok(warn(extended(decoder(),8,new Array(26).fill(0),{chunked:true,size:261}),'EXT_HEADER'));
  assert.ok(warn(extended(decoder(),8,[0],{chunked:true,size:1,chunk:10}),'EXT_HEADER'));
  assert.ok(warn(extended(decoder(),8,[0],{chunked:false,chunk:1}),'EXT_HEADER'));
});
test('Unchunked NDO ignored; all 260 bytes preserved', () => {
  const b=Array.from({length:260},(_,i)=>i&255); const p=extended(decoder(),8,b); assert.equal(p.crcOk,true); assert.deepEqual(p.reassembly.bytes,b); assert.equal(p.extended.dataSize,260);
});
test('260-byte ten-chunk transfer incl retries, request and GoodCRC', () => {
  const b=Array.from({length:260},(_,i)=>i&255),d=decoder(); let p;
  for(let chunk=0;chunk<10;chunk++) {
    p=extended(d,8,b.slice(chunk*26,(chunk+1)*26),{chunked:true,size:260,chunk,id:chunk%8});
    if(chunk===3) { extended(d,8,b.slice(78,104),{chunked:true,size:260,chunk:3,id:3}); send(d,1); extended(d,8,[],{chunked:true,size:0,chunk:4,request:true,sender:0}); }
  }
  assert.equal(p.reassembly.complete,true); assert.deepEqual(p.reassembly.bytes,b);
});
test('Cross-SOP/type/sender/channel chunk streams remain isolated', () => {
  const d=decoder(),b=new Array(30).fill(42);
  for(const o of [{},{sop:"SOP'"},{sender:0},{channel:2}]) extended(d,8,b.slice(0,26),{...o,chunked:true,size:30});
  extended(d,9,new Array(26).fill(77),{chunked:true,size:30});
  for(const o of [{},{sop:"SOP'"},{sender:0},{channel:2}]) assert.deepEqual(extended(d,8,b.slice(26),{...o,chunked:true,size:30,chunk:1,id:1}).reassembly.bytes,b);
});
test('Missing/out-of-order/bad CRC chunks cannot produce complete block', () => {
  const b=new Array(56).fill(1); const d=decoder(); extended(d,8,b.slice(0,26),{chunked:true,size:56});
  const p=extended(d,8,b.slice(52),{chunked:true,size:56,chunk:2}); assert.ok(warn(p,'CHUNK_GAP')); assert.equal(p.reassembly.complete,false);
  const d2=decoder(); extended(d2,8,b.slice(0,26),{chunked:true,size:56}); extended(d2,8,b.slice(26,52),{chunked:true,size:56,chunk:1,badCrc:true});
  assert.equal(extended(d2,8,b.slice(52),{chunked:true,size:56,chunk:2}).reassembly.complete,false);
});
test('EPR PDO crossing byte26 decoded only after complete reassembly', () => {
  const b=[...u32(fixed5),...new Array(24).fill(0),...u32(0x0008C1F4),...u32(avs)],d=decoder('3.2');
  extended(d,17,b.slice(0,26),{chunked:true,size:36}); assert.deepEqual(d.st.pdoMeta.source,{});
  const p=extended(d,17,b.slice(26),{chunked:true,size:36,chunk:1,id:1}); assert.equal(p.crcOk,true); assert.equal(d.st.pdoMeta.source[8].maxVoltage,28); assert.equal(d.st.pdoMeta.source[7],undefined);
});
const extFixtures = [
  [1,[0x34,0x12,0x78,0x56,...new Array(19).fill(0),65,140],'SPR Source PDP','65 W'],
  [2,[25,0,0,0,2,0,0x19],'Power State Change','Breathing'],
  [3,[7],'Battery Cap Ref','7'], [4,[4],'Battery Status Ref','4'],
  [5,[0x34,0x12,0x78,0x56,100,0,200,0,0],'Battery Design Capacity','10 Wh'],
  [6,[1,7],'Manufacturer Info Ref','7'], [7,[0x34,0x12,0x78,0x56,65,0],'Manufacturer String','A'],
  [8,[1,2,3,4],'说明','USBC Auth'],[9,[1,2,3,4],'说明','USBC Auth'],
  [10,[1,2,3,4],'说明','PDFU'],[11,[1,2,3,4],'说明','PDFU'],
  [12,[0xC2,1,60,8],'Output Voltage','9 V'], [13,[67,78,0,0,0x80,1],'Country Specific Data','80 01'],
  [14,[1,0,67,78,85,83],'Country Code 1','CN'],
  [15,[...new Array(10).fill(0),1,...new Array(7).fill(0),10,20,30,100,140,240],'EPR Sink Maximum PDP','240 W'],
  [16,[3,0],'Type','EPR_Keep_Alive'],
  [17,u32(fixed5),'Object','PDO #1'],[18,u32(fixed5),'Object','PDO #1'],
  [30,[0x01,0xFF,0x34,0x12,0xAA],'Vendor Defined Data','AA'],
];
for(const [t,b,key,value] of extFixtures) test(`6.50..6.64 extended type ${t} field/units`,()=>{const p=extended(decoder(),t,b);assert.equal(p.crcOk,true);assert.ok(detail(p,key,value));});
test('Status cannot infer cable layout from truncated length',()=>{const p=extended(decoder(),2,[25,0]);assert.ok(warn(p,'EXT_SIZE'));assert.ok(!p.summary.includes('线缆'));});
test('Status indicator 4..7 invalid, never aliases Off/On/Blink/Breath',()=>{const p=extended(decoder(),2,[25,0,0,0,0,0,32]);assert.ok(detail(p,'Power State Change','无效'));assert.ok(warn(p,'EXT_FIELD'));});
test('Country Codes ignores pairs beyond Length',()=>{const p=extended(decoder(),14,[1,0,67,78,85,83]);assert.ok(!detail(p,'Country Code 2'));assert.ok(!p.summary.includes('US'));});
test('SCEDB legacy24 bytes and SKEDB SPR range',()=>{
  const p=extended(decoder('3.0'),1,new Array(24).fill(0));assert.ok(!detail(p,'EPR Source PDP'));
  const b=new Array(24).fill(0);b[10]=1;b[19]=101;assert.ok(warn(extended(decoder(),15,b),'EXT_FIELD'));
});
test('All control and reserved type IDs retain headers and raw data',()=>{
  for(let t=0;t<32;t++){const p=send(decoder(),t);assert.equal(p.msgTypeRaw,t);assert.equal(p.crcOk,true);assert.ok(p.msgType);}
  const p=send(decoder(),31,[0x12345678]);assert.equal(p.msgType,'Reserved');assert.deepEqual(p.dataWords,[0x12345678]);
});
test('Malformed extended frames at every bit boundary never throw',()=>{
  for(const [t,b] of extFixtures){const r=extRaw(t,b);for(let n=20;n<r.bits.length;n+=5)decoder().decode({...r,bits:r.bits.slice(0,n)});}
  const r=extRaw(1,new Array(25).fill(0)),p=decoder().decode({...r,bits:r.bits.slice(0,75)});
  assert.ok(p.dataWords.includes(null));assert.ok(p.dataHex.includes('??'));assert.equal(p.reassembly.complete,false);
});
test('PD2.0 Fig5-35 PRBS feedback output and continuous 1024-bit frames', () => {
  // One frozen 255-bit period from the diagram's feedback/Transmit out node.
  const period = '000010111100011010000000100011100010010111000000110010010011011100100000101011011010110010110000111110110111101011101000100001101100011110011100110001011010010001010010101001110111011001111011111101001100110101000110000011101010101111100101000010011111111';
  assert.equal(period.length,255);
  const d=decoder('2.0'); send(d,3,[0],{rev:1}); send(d,1,[],{rev:1,sender:0});
  for(let frame=0;frame<3;frame++) {
    const bits=ordered.SOP.flatMap(c=>Array.from({length:5},(_,k)=>c>>>k&1));
    for(let i=0;i<1024;i++) bits.push(Number(period[(frame*1024+i)%255]) ^ (frame===1 && i===42 ? 1 : 0));
    const bmc=new BmcDecoder({sampleRate:2400000}); let sample=0;
    bmc.pushEdge(sample);
    for(const bit of [1,0,...bits]) {
      if(bit) bmc.pushEdge(sample+4);
      sample+=8; bmc.pushEdge(sample);
    }
    const r=bmc.pushEdge(sample+100); const p=d.decode(r);
    assert.equal(p.msgType,'BIST_Test_Frame'); assert.equal(p.dataBytes.length,128); assert.equal(p.crc,null); assert.equal(p.header,null);
    assert.equal(p.bist.bitErrors,frame===1?1:0); assert.equal(p.bist.totalBits,(frame+1)*1024); assert.equal(p.bist.totalBitErrors,frame?1:0);
    assert.ok(p.text.includes('BIST_Test_Frame')); assert.equal(p.warnings.length,0);
  }
  d.decode(raw([],'Hard Reset')); assert.equal(d.st.bist,undefined);
});
test('Selected spec rejects newer message types without modern field dispatch', () => {
  assert.equal(send(decoder('3.0'),8,[0x20400000]).msgType,'Reserved');
  assert.equal(send(decoder('3.0'),14).msgType,'Reserved');
  assert.equal(extended(decoder('3.0'),15,new Array(24).fill(0)).msgType,'Reserved');
  assert.ok(!detail(send(decoder('3.0'),8,[0x20400000]),'USB Mode'));
});
test('APDO support follows exact 3.0/3.1 document versions', () => {
  for(const [profile,word] of [['3.0',avs],['3.0',0xE007D12C],['3.1',0xE007D12C]]) {
    const d=decoder(profile);send(d,1,[fixed5,word]);assert.equal(d.st.pdoMeta.source[2].kind,'reserved_apdo');
  }
  const d=decoder('3.0');send(d,1,[fixed5,pps|0x08000000]);assert.equal(d.st.pdoMeta.source[2].powerLimited,false);
});
test('Source_Info object count is one in 3.1 v1.4 and two in 3.2 v1.2', () => {
  assert.ok(!warn(send(decoder('3.1'),11,[0x00643C1E]),'COUNT'));
  assert.ok(warn(send(decoder('3.2'),11,[0x00643C1E]),'COUNT'));
  assert.ok(warn(send(decoder('3.1'),11,[0x00643C1E,0]),'COUNT'));
  assert.ok(!warn(send(decoder('3.2'),11,[0x00643C1E,0]),'COUNT'));
});
test('UFP USB2/Billboard encoding differs between supplied 3.1 and 3.2', () => {
  for(const [profile,code,text] of [['3.1',1,'支持 USB 2.0'],['3.1',2,'仅支持 USB 2.0 Billboard'],['3.2',1,'仅支持 USB 2.0 Billboard'],['3.2',2,'支持 USB 2.0']]) {
    const p=vdm(decoder(profile),1,1,[0x10601234,0,0,0x60000000|code<<24]);assert.ok(detail(p,'USB 2.0 Device 能力',text));
  }
  const p=vdm(decoder(),1,1,[0x10601234,0,0,0x61000000]);assert.ok(detail(p,'USB 2.0 Device 能力','PD 3.1 v1.4'));assert.ok(detail(p,'USB 2.0 Device 能力','PD 3.2 v1.2'));
});
test('Active Cable VDO2 B1 reserved in 3.1 and asymmetric in 3.2', () => {
  const extra=[0x20001234,0,0,0x00686058,0x64502002];
  const p=vdm(decoder('3.1'),1,1,extra,{sop:"SOP'"});assert.ok(detail(p,'Reserved [B1]','1'));assert.ok(!detail(p,'Asymmetric Mode'));assert.ok(warn(p,'RESERVED'));
  assert.ok(detail(vdm(decoder('3.2'),1,1,extra,{sop:"SOP'"}),'Asymmetric Mode','1'));
});
test('SVDM minor and USB Gen4 honor the selected 3.1 specification', () => {
  const p=send(decoder('3.1'),15,[0xFF00A801]);assert.ok(warn(p,'VDM_FIELD'));assert.ok(detail(p,'(Minor)','Reserved'));
  assert.ok(detail(send(decoder('3.1'),8,[0x20800000]),'Cable Speed','Reserved'));
  assert.ok(detail(send(decoder('3.2'),8,[0x20800000]),'Cable Speed','Gen4'));
});
test('VPD impedance steps, AMA VBUS polarity, and UFP power dependencies', () => {
  const p=vdm(decoder(),1,1,[0x30001234,0,0,(10<<7)|(20<<1)|1],{sop:"SOP'"});assert.ok(detail(p,'VBUS Impedance','20 mΩ'));assert.ok(detail(p,'Ground Impedance','20 mΩ'));
  const a=vdm(decoder('2.0'),1,1,[0x28001234,0,0,8],{rev:1});assert.ok(detail(a,'VBUS required','需要 VBUS'));
  const u=vdm(decoder('3.2'),1,1,[0x10601234,0,0,0x620003C0]);assert.ok(detail(u,'VCONN Required','Reserved'));assert.ok(detail(u,'VBUS Required','Reserved'));
});
test('Power swap only clears capabilities after opposite sender Accept', () => {
  const d=decoder();send(d,1,[fixed5,pps]);send(d,10);send(d,3);assert.ok(d.st.pdoMeta.source[2]);
  send(d,10,[],{id:1});send(d,3,[],{sender:0});assert.deepEqual(d.st.pdoMeta.source,{});
  send(d,1,[fixed5,pps],{id:2});send(d,10,[],{id:2});send(d,2,[requestPps],{sender:0,id:1});send(d,3,[],{sender:1,id:3});assert.ok(d.st.pdoMeta.source[2]);
});
test('Bad CRC unchunked block never claims valid complete reassembly', () => {
  const p=extended(decoder(),1,new Array(25).fill(0),{badCrc:true});assert.equal(p.reassembly.complete,false);assert.equal(p.reassembly.bytes,null);
});
test('Fixed, Variable and Battery RDO use their respective current/power units', () => {
  for(const [pdo,rdo,key,value] of [[fixed9,0x2004B12C,'工作电流','3 A'],[0x9901912C,0x2004B12C,'工作电流','3 A'],[0x59019190,0x2003C0F0,'工作功率','60 W']]) {
    const d=decoder('3.2');send(d,1,[fixed5,pdo]);const p=send(d,2,[rdo],{sender:0});assert.ok(detail(p,key,value));assert.ok(!warn(p,'RDO_RANGE'));
  }
});
test('SPR AVS RDO selects the current limit above and below 15V', () => {
  const d=decoder('3.2');send(d,1,[fixed5,0xE007D12C]);const low=send(d,2,[0x2002D064],{sender:0});assert.ok(low.summary.includes('9V 5A'));assert.ok(!warn(low,'RDO_RANGE'));
  const high=send(d,2,[0x20064064],{sender:0,id:1});assert.ok(high.summary.includes('20V 5A'));assert.ok(warn(high,'RDO_RANGE'));
});
test('PD3.0 Alert reserved high bit cannot claim an extended event', () => {
  const p=send(decoder('3.0'),6,[0x80000004]);assert.ok(detail(p,'Reserved [B31]'));assert.ok(!p.summary.includes('Controller initiated wake'));
});
test('PD3.1 Status and Sink extended blocks enforce their documented size', () => {
  assert.ok(warn(extended(decoder('3.1'),2,new Array(5).fill(0)),'EXT_SIZE'));
  assert.ok(warn(extended(decoder('3.1'),15,new Array(21).fill(0)),'EXT_SIZE'));
});
test('Legacy Header preserves actual reserved B15/B4 values', () => {
  const p=decoder().decode(raw([0x51,0x80]));assert.ok(detail(p,'Reserved [B15]','1'));assert.ok(detail(p,'Reserved [B4]','1'));
});

// EPR/AVS whole-session vectors. Literals follow the supplied PDF tables;
// per-sender IDs advance independently and unrelated SOP/channel traffic is interleaved.
const epr5 = 0x0081912C, fixed28 = 0x0008C1F4;
const eprWords = [epr5, 0, 0, 0, 0, 0, 0, fixed28, avs];
const eprBytes = eprWords.flatMap(u32);
const avsRdo = (pos, volts, amps) => (pos << 28 | Math.round(volts / 0.025) << 9 | Math.round(amps / 0.05)) >>> 0;
function session(profile = '3.2') {
  const d = decoder(profile), ids = [0, 0];
  return { d, data(t, words=[], o={}) { const sender=o.sender ?? 1; return send(d,t,words,{id:ids[sender]++%8,...o}); },
    ext(t,b,o={}) { const sender=o.sender ?? 1; return extended(d,t,b,{id:ids[sender]++%8,...o}); } };
}
function sprContract(s, flags = true) {
  s.data(1,[flags ? epr5 : fixed5]);
  s.data(2,[flags ? 0x1044B12C : 0x1004B12C],{sender:0}); s.data(3); s.data(6);
}
function enterEpr(s) {
  s.data(10,[0x01640000],{sender:0}); s.data(10,[0x02000000]); s.data(10,[0x03000000]);
}
function eprContract(s) {
  sprContract(s); enterEpr(s); s.ext(17,eprBytes);
  s.data(9,[avsRdo(9,28,3),avs],{sender:0}); s.data(3); s.data(6);
}
test('EPR AVS request clamps PDP/V to 5A and rounds down by 50mA', () => {
  const s=session();
  for(const [v,a,word,invalid] of [[15,5,0xD3C096F0,false],[15,5.05,0xD3C096F0,true],[28,3.55,avs,false],[28,3.6,avs,true]]) {
    const p=s.data(9,[avsRdo(8,v,a),word],{sender:0});assert.equal(warn(p,'RDO_RANGE'),invalid);assert.equal(p.request.valid,!invalid);
  }
});
test('EPR AVS Source exact voltage constraints differ from Sink ranges', () => {
  for(const [role,word,invalid] of [['source',0xD230A064,true],['source',0xD2589664,true],['sink',0xD258A064,false],['sink',0xD12C9664,false]]) {
    const e=emitter(),r=pdoParse(st(),e,word,{role,position:8,isEpr:true});assert.equal(r.meta.valid,!invalid);assert.equal(e.warnings.some(([c])=>c==='PDO_RANGE'),invalid);
  }
});
test('SPR AVS 15V-only PDO summary and request bounds', () => {
  const s=session();s.data(1,[fixed5,0x0004B0C8,0xE0032000]);
  const m=s.d.st.capabilities.spr.source.pdoMeta[3];assert.equal(m.maxVoltage,15);assert.equal(m.valid,true);
  assert.ok(s.d.st.pdos.source[3].includes('9~15V'));assert.ok(!s.d.st.pdos.source[3].includes('9~20V'));
  assert.ok(!warn(s.data(2,[avsRdo(3,15,2)],{sender:0}),'RDO_RANGE'));
  assert.ok(warn(s.data(2,[avsRdo(3,15.1,0.05)],{sender:0}),'RDO_RANGE'));
});
test('SPR AVS Source currents match 15V/20V Fixed PDOs', () => {
  const s=session();const p=s.data(1,[fixed5,0x0004B12C,0x000640C8,0xE004B0C8]);assert.ok(!warn(p,'AVS_CAP'));
  assert.equal(s.d.st.capabilities.spr.source.pdoMeta[4].valid,true);
  assert.ok(warn(s.data(1,[fixed5,0x0004B12C,0x000640C8,0xE004B0C9]),'AVS_CAP'));
  assert.ok(warn(s.data(1,[fixed5,0xE004B0C8]),'AVS_CAP'));
});
test('SPR AVS 15V boundary uses low segment; 15.1V uses high segment', () => {
  const s=session();s.data(1,[fixed5,0x0004B12C,0x000640C8,0xE004B0C8]);
  assert.ok(!warn(s.data(2,[avsRdo(4,15,3)],{sender:0}),'RDO_RANGE'));
  assert.ok(warn(s.data(2,[avsRdo(4,15.1,3)],{sender:0}),'RDO_RANGE'));
  assert.ok(!warn(s.data(2,[avsRdo(4,20,2)],{sender:0}),'RDO_RANGE'));
});
test('AVS RDO nonzero low voltage bits cannot establish a valid request', () => {
  const p=send(decoder(),9,[avsRdo(8,15.025,1),avs],{sender:0});assert.ok(warn(p,'RDO_STEP'));assert.equal(p.request.valid,false);
});
test('EPR fixed ordering, sole AVS and highest Fixed voltage cross checks', () => {
  const s=session();assert.ok(!warn(s.ext(17,eprBytes),'AVS_CAP'));
  assert.ok(warn(s.ext(17,[...eprWords.slice(0,7),0x000B41F4,fixed28,0xD2D096B4].flatMap(u32)),'PDO_ORDER'));
  assert.ok(warn(s.ext(17,[...eprWords.slice(0,7),avs,fixed28].flatMap(u32)),'PDO_ORDER'));
  assert.ok(warn(s.ext(17,[...eprWords,avs].flatMap(u32)),'AVS_CAP'));
  assert.ok(warn(s.ext(17,[...eprWords.slice(0,8),0xD2D096B4].flatMap(u32)),'AVS_CAP'));
});
test('SPR and informational EPR capability queries retain separate request tables', () => {
  const s=session();s.data(1,[fixed5,pps]);s.ext(17,[epr5,fixed9,0,0,0,0,0,fixed28,avs].flatMap(u32));
  assert.equal(s.d.st.epr.mode,'unknown');const p=s.data(2,[requestPps],{sender:0});assert.equal(p.request.kind,'pps');assert.ok(p.summary.includes('9V 3A'));
  const copy=s.data(9,[0x2004B12C,fixed9],{sender:0});assert.equal(copy.request.kind,'fixed');assert.ok(!warn(copy,'PDO_COPY'));
  s.data(1,[fixed5]);assert.equal(s.d.st.capabilities.epr.source.pdoMeta[9].raw,avs);
});
test('EPR copied PDO cannot override advertised type or raise current limit', () => {
  const s=session();sprContract(s);enterEpr(s);
  const offered=0x0008C12C,forged=0x0008C1F4;s.ext(17,[...eprWords.slice(0,7),offered,avs].flatMap(u32));
  const before=s.d.st.epr.contract,p=s.data(9,[0x80064190,forged],{sender:0});assert.ok(warn(p,'PDO_COPY'));assert.ok(warn(p,'RDO_RANGE'));assert.equal(p.request.valid,false);
  assert.ok(warn(s.data(3),'EPR_REQUEST'));s.data(6);assert.deepEqual(s.d.st.epr.contract,before);assert.equal(s.d.st.capabilities.epr.source.pdoMeta[8].raw,offered);
});
test('EPR Request cannot reference zero padding or absent advertised position', () => {
  const s=session();s.ext(17,eprBytes);const p=s.data(9,[0x2004B12C,fixed9],{sender:0});assert.ok(warn(p,'PDO_COPY'));assert.equal(p.request.valid,false);
});
test('EPR Enter → Ack → Succeeded does not establish an EPR power contract', () => {
  const s=session();sprContract(s);const old=s.d.st.epr.contract;
  assert.equal(s.data(10,[0x01640000],{sender:0}).epr.phase,'enter_sent');
  assert.equal(s.data(10,[0x02000000]).epr.phase,'enter_acknowledged');
  const p=s.data(10,[0x03000000]);assert.equal(p.epr.mode,'epr');assert.equal(p.epr.phase,'await_capabilities');assert.deepEqual(p.epr.contract,old);
});
test('EPR capabilities update session only after final chunk; negotiation needs PS_RDY', () => {
  const s=session();sprContract(s);enterEpr(s);
  s.ext(17,eprBytes.slice(0,26),{chunked:true,size:36});assert.equal(s.d.st.epr.phase,'await_capabilities');
  s.ext(17,eprBytes.slice(26),{chunked:true,chunk:1,size:36});assert.equal(s.d.st.epr.phase,'await_request');
  const r=s.data(9,[avsRdo(9,28,3),avs],{sender:0});assert.equal(r.epr.contract.range,'spr');assert.equal(r.epr.phase,'negotiating');
  assert.equal(s.data(3).epr.phase,'transitioning');s.data(1,[],{sender:0});
  const p=s.data(6);assert.equal(p.epr.phase,'ready');assert.equal(p.epr.contract.range,'epr');assert.equal(p.epr.contract.kind,'epr_avs');
});
test('EPR Reject and Wait retain previous explicit contract', () => {
  const s=session();eprContract(s);const before=s.d.st.epr.contract;
  for(const response of [4,12]) {s.data(9,[avsRdo(9,20,3),avs],{sender:0});s.data(response);s.data(6);assert.deepEqual(s.d.st.epr.contract,before);assert.equal(s.d.st.epr.pending,null);}
});
test('Power contract cannot be confirmed by missing Accept, wrong sender or CRC', () => {
  const s=session();s.data(1,[epr5]);s.data(2,[0x1044B12C],{sender:0});s.data(6);assert.equal(s.d.st.epr.contract,null);
  s.data(3,[],{sender:0});s.data(6);assert.equal(s.d.st.epr.contract,null);
  s.data(3);s.data(6,[],{sender:0});s.data(6,[],{badCrc:true});assert.equal(s.d.st.epr.contract,null);
  assert.equal(s.data(6).epr.contract.position,1);
});
test('VCONN Swap Accept/PS_RDY cannot confirm an interrupted power request', () => {
  const s=session();s.data(1,[epr5]);s.data(2,[0x1044B12C],{sender:0});s.data(11,[],{sender:0});s.data(3);s.data(6);
  assert.equal(s.d.st.epr.contract,null);assert.equal(s.d.st.epr.pending,null);
});
test('EPR Enter prerequisite bits and direct Enter Failed preserve SPR contract', () => {
  const s=session();sprContract(s,false);const old=s.d.st.epr.contract;
  assert.ok(warn(s.data(10,[0x01640000],{sender:0}),'EPR_PREREQUISITE'));
  const p=s.data(10,[0x04030000]);assert.equal(p.epr.mode,'spr');assert.equal(p.epr.phase,'failed');assert.deepEqual(p.epr.contract,old);assert.ok(!warn(p,'EPR_SEQUENCE'));
});
test('EPR Enter PDP is full byte; known SKEDB PDP consistency is checked', () => {
  const s=session();assert.ok(!warn(s.data(10,[0x01FF0000],{sender:0}),'EPR_FIELD'));
  s.data(13);const b=new Array(24).fill(0);b[10]=1;b[22]=100;b[23]=140;s.ext(15,b,{sender:0});
  assert.ok(warn(s.data(10,[0x018C0000],{sender:0}),'EPR_PDP'));s.data(13);
  assert.ok(!warn(s.data(10,[0x01640000],{sender:0}),'EPR_PDP'));
});
test('Invalid Action, role, count and CRC cannot change EPR mode', () => {
  for(const o of [{word:0x06000000},{word:0x03000000,sender:0},{word:0x03000000,badCrc:true},{word:0x03000000,words:[0x03000000,0]}]) {
    const s=session();s.data(10,o.words??[o.word],o);assert.equal(s.d.st.epr.mode,'unknown');
  }
});
test('Cable EPR_Mode and other channels cannot advance port EPR state', () => {
  const s=session();sprContract(s);enterEpr(s);const old=s.d.linkStates.get('0:SOP').epr;
  assert.equal(s.data(10,[0x05000000],{sop:"SOP'"}).epr,null);assert.deepEqual(s.d.linkStates.get('0:SOP').epr,old);
  s.data(10,[0x03000000],{channel:1});assert.equal(s.d.linkStates.get('1:SOP').epr.mode,'epr');assert.deepEqual(s.d.linkStates.get('0:SOP').epr,old);
});
test('EPR capture beginning at Succeeded retains unknown contract without false prerequisite error', () => {
  const p=send(decoder(),10,[0x03000000]);assert.equal(p.epr.mode,'epr');assert.equal(p.epr.contractKnown,false);assert.ok(!warn(p,'EPR_SEQUENCE'));assert.ok(!warn(p,'EPR_PREREQUISITE'));
});
test('EPR duplicate Enter does not replay state or discard cached capabilities', () => {
  const d=decoder('3.2');send(d,10,[0x01000000],{sender:0});send(d,10,[0x02000000]);send(d,10,[0x03000000],{id:1});
  const p=send(d,10,[0x01000000],{sender:0});assert.equal(p.isRetry,true);assert.equal(p.epr.mode,'epr');assert.equal(p.epr.phase,'await_capabilities');
});
test('EPR exit requires renegotiated SPR contract even while in EPR mode', () => {
  const s=session();eprContract(s);assert.ok(warn(s.data(10,[0x05000000],{sender:0}),'EPR_EXIT'));
  const s2=session();eprContract(s2);s2.ext(17,eprWords.slice(0,7).flatMap(u32));
  s2.data(9,[0x1044B12C,epr5],{sender:0});s2.data(3);s2.data(6);assert.equal(s2.d.st.epr.mode,'epr');assert.equal(s2.d.st.epr.contract.range,'spr');
  const exit=s2.data(10,[0x05000000]);assert.ok(!warn(exit,'EPR_EXIT'));assert.equal(exit.epr.phase,'await_spr_capabilities');
  assert.equal(s2.data(1,[epr5]).epr.phase,'idle');
});
test('Soft Reset preserves EPR mode/contract; resets pending negotiation and entry AMS', () => {
  const s=session();eprContract(s);const before=s.d.st.epr.contract;s.data(9,[avsRdo(9,20,3),avs],{sender:0});
  const p=s.data(13);assert.equal(p.epr.mode,'epr');assert.equal(p.epr.phase,'await_capabilities');assert.deepEqual(p.epr.contract,before);assert.equal(p.epr.pending,null);
  const s2=session();sprContract(s2);s2.data(10,[0x01640000],{sender:0});assert.equal(s2.data(13).epr.phase,'idle');assert.equal(s2.d.st.epr.mode,'spr');
});
test('Hard Reset exits EPR and invalidates contracts/caps; Cable Reset preserves them', () => {
  const s=session();eprContract(s);const before=s.d.st.epr;s.d.decode(raw([],'Cable Reset'));assert.deepEqual(s.d.st.epr,before);
  const p=s.d.decode(raw([],'Hard Reset'));assert.equal(p.epr.mode,'spr');assert.equal(p.epr.contract,null);assert.equal(s.d.st.capabilities.epr.source,null);
});
test('EPR PR_Swap rejected/incorrectly accepted does not discard EPR state', () => {
  const s=session();eprContract(s);const before=s.d.st.epr.contract;
  assert.ok(warn(s.data(10,[],{sender:0}),'EPR_PR_SWAP'));s.data(4);assert.equal(s.d.st.epr.mode,'epr');
  s.data(10,[],{sender:0});assert.ok(warn(s.data(3),'EPR_PR_SWAP'));assert.deepEqual(s.d.st.epr.contract,before);assert.ok(s.d.st.capabilities.epr.source);
});
test('Fast Role Swap exits EPR only after both PS_RDY messages, not at Accept', () => {
  const s=session();eprContract(s);const before=s.d.st.epr.contract;s.data(19,[],{sender:0});s.data(3);
  assert.equal(s.d.st.epr.mode,'epr');assert.equal(s.d.st.epr.phase,'fr_swap_source_off');assert.deepEqual(s.d.st.epr.contract,before);assert.ok(s.d.st.capabilities.epr.source);
  s.data(6,[],{sender:0});assert.equal(s.d.st.epr.mode,'epr');assert.equal(s.d.st.epr.phase,'fr_swap_source_on');
  const acceptRetry=send(s.d,3,[],{id:(s.d.st.messages['1'].id)});assert.equal(acceptRetry.isRetry,true);assert.equal(s.d.st.epr.phase,'fr_swap_source_on');
  s.data(6);assert.equal(s.d.st.epr.mode,'spr');assert.equal(s.d.st.epr.contract,null);assert.equal(s.d.st.capabilities.epr.source,null);
});
test('DR_Swap and Data Reset preserve EPR power mode/contract', () => {
  const s=session();eprContract(s);const before=s.d.st.epr.contract;s.data(9,[],{sender:0});s.data(3);s.data(14);s.data(15);assert.equal(s.d.st.epr.mode,'epr');assert.deepEqual(s.d.st.epr.contract,before);
});
test('EPR Keep Alive and Ack roles/CRC preserve state until valid source response', () => {
  const s=session();eprContract(s);assert.ok(warn(s.ext(16,[3,0]),'ROLE'));assert.equal(s.d.st.epr.keepAlive,null);
  assert.equal(s.ext(16,[3,0],{sender:0}).epr.keepAlive.pending,true);
  assert.ok(warn(s.ext(16,[4,0],{sender:0}),'ROLE'));s.ext(16,[4,0],{badCrc:true});assert.equal(s.d.st.epr.keepAlive.pending,true);
  assert.equal(s.ext(16,[4,0]).epr.keepAlive.pending,false);assert.equal(s.d.st.epr.phase,'ready');
});
test('EPR mode rejects ordinary Request; Source_Capabilities query exception is respected', () => {
  const s=session();eprContract(s);const before=s.d.st.epr.contract;
  assert.ok(warn(s.data(2,[0x1044B12C],{sender:0}),'EPR_MODE'));s.data(3);s.data(6);assert.deepEqual(s.d.st.epr.contract,before);
  assert.ok(warn(s.data(1,[epr5]),'EPR_MODE'));s.data(7,[],{sender:0});assert.ok(!warn(s.data(1,[epr5]),'EPR_MODE'));assert.equal(s.d.st.epr.mode,'epr');
});
test('Malformed EPR capability block cannot replace prior cache or advance session', () => {
  const s=session();eprContract(s);const before=s.d.st.capabilities.epr.source;
  for(const b of [eprBytes.slice(0,-1),[...u32(fixed9)],new Array(48).fill(0)]) {s.ext(17,b);assert.deepEqual(s.d.st.capabilities.epr.source,before);}
  const reordered=[epr5,0,fixed9,0,0,0,0,fixed28,avs].flatMap(u32);s.ext(17,reordered);assert.deepEqual(s.d.st.capabilities.epr.source,before);
});
test('Supplied PD3.1 capability list is limited to 11 despite RDO field allowing 13', () => {
  const s=session('3.1');s.ext(17,eprBytes);const before=s.d.st.capabilities.epr.source;assert.ok(warn(s.ext(17,[...eprWords,avs,avs,avs].flatMap(u32)),'EXT_FIELD'));assert.deepEqual(s.d.st.capabilities.epr.source,before);
});
test('DRP capabilities advertised by current Sink cannot replace active Source tables', () => {
  const s=session();s.data(1,[epr5,pps]);s.data(1,[fixed5,fixed9],{sender:0});
  assert.equal(s.data(2,[requestPps],{sender:0}).request.kind,'pps');
  s.ext(17,eprBytes);const before=s.d.st.capabilities.epr.source;
  s.ext(17,[...eprWords.slice(0,8),0xD230968C].flatMap(u32),{sender:0});assert.deepEqual(s.d.st.capabilities.epr.source,before);
});
test('Get_Source_Cap exception expires after another Source response and ignores Source-origin query', () => {
  const s=session();eprContract(s);s.data(7,[],{sender:0});s.data(4);assert.ok(warn(s.data(1,[epr5]),'EPR_MODE'));
  s.data(7);assert.ok(warn(s.data(1,[epr5]),'EPR_MODE'));
});
test('Another SOP data AMS cannot let a stale accepted request claim its PS_RDY', () => {
  const s=session();sprContract(s);const before=s.d.st.epr.contract;s.data(2,[0x104320C8],{sender:0});s.data(3);
  s.data(15,[0xFF00A001]);const p=s.data(6);assert.equal(p.epr.pending,null);assert.deepEqual(p.epr.contract,before);
});
test('Repeated success and out-of-mode Keep Alive cannot replay EPR transitions', () => {
  const s=session();eprContract(s);assert.ok(warn(s.data(10,[0x03000000]),'EPR_SEQUENCE'));assert.equal(s.d.st.epr.phase,'ready');
  const s2=session();sprContract(s2);assert.ok(warn(s2.ext(16,[3,0],{sender:0}),'EPR_MODE'));assert.equal(s2.d.st.epr.keepAlive,null);
});
test('EPR Sink AVS maximum power is bounded by known SKEDB maximum PDP in either order', () => {
  const b=new Array(24).fill(0);b[10]=1;b[22]=100;b[23]=140;
  const s=session();s.ext(15,b,{sender:0});assert.ok(warn(s.ext(18,[...eprWords.slice(0,8),0xD23096B4].flatMap(u32),{sender:0}),'AVS_CAP'));
  const s2=session();s2.ext(18,[...eprWords.slice(0,8),0xD23096B4].flatMap(u32),{sender:0});assert.ok(warn(s2.ext(15,b,{sender:0}),'AVS_CAP'));
});
test('Invalid SKEDB PDP ordering cannot overwrite known EPR Enter context', () => {
  const s=session(),b=new Array(24).fill(0);b[10]=1;b[22]=100;b[23]=140;s.ext(15,b,{sender:0});
  b[21]=150;b[22]=140;assert.ok(warn(s.ext(15,b,{sender:0}),'EXT_FIELD'));assert.equal(s.d.st.sinkOperationalPdp,100);
  assert.ok(!warn(s.data(10,[0x01640000],{sender:0}),'EPR_PDP'));
});
test('Fast Role Swap cannot finish with wrong role, bad CRC or missing initial PS_RDY', () => {
  const s=session();eprContract(s);s.data(19,[],{sender:0});s.data(3);assert.ok(warn(s.data(6),'SWAP_SEQUENCE'));
  s.data(6,[],{sender:0,badCrc:true});assert.equal(s.d.st.epr.phase,'fr_swap_source_off');
  s.data(1,[],{sender:0});s.data(6,[],{sender:0});assert.equal(s.d.st.epr.phase,'fr_swap_source_on');
  s.data(6,[],{badCrc:true});assert.equal(s.d.st.epr.mode,'epr');assert.equal(s.data(6).epr.mode,'spr');
});
test('PD3.2 AVS Giveback label differs from PD3.1 Reserved and is ignored in both', () => {
  const p=send(decoder('3.2'),9,[avsRdo(8,28,3)|0x08000000,avs],{sender:0});assert.ok(detail(p,'Giveback (Deprecated) [B27]'));assert.equal(p.request.giveback,false);
  const p2=send(decoder('3.1'),9,[avsRdo(8,28,3)|0x08000000,avs],{sender:0});assert.ok(detail(p2,'Reserved [B27]'));assert.equal(p2.request.giveback,false);
});
test('Valid extended traffic interrupts FRS and later PS_RDY cannot complete it', () => {
  for(const [type,bytes,sender] of [[2,[25,0,0,0,0,0,0],1],[16,[3,0],0],[17,eprBytes,1]]) {
    const s=session();eprContract(s);const before=s.d.st.epr.contract;s.data(19,[],{sender:0});s.data(3);
    const p=s.ext(type,bytes,{sender});assert.ok(warn(p,'SWAP_SEQUENCE'));assert.equal(p.epr.phase,'fr_swap_unknown');
    s.data(6,[],{sender:0});s.data(6);assert.equal(s.d.st.epr.mode,'epr');assert.deepEqual(s.d.st.epr.contract,before);assert.equal(s.d.st.pendingSwap,null);
  }
});
async function asyncTest(name,fn) {
  try { await fn(); results.push({name,pass:true}); } catch(e) { results.push({name,pass:false,error:e.stack});console.error(`FAIL ${name}: ${e.message}`); }
}
await asyncTest('POWER-Z stream accepts unchunked ext lengths and clears state on detach', async () => {
  const wrap=(wire,ts)=>Uint8Array.from([0x80|(wire.length+5),...u32(ts),0,...wire]);
  const wire=[...u16(head(1,0,{ext:1})),25,0,...new Array(25).fill(0)];
  const rows=[wire,wire,wire].map((w,i)=>({time:i/1000,vbus:5,ibus:1,raw:wrap(w,i)}));
  const stream=writePdStream(rows);assert.equal(sniffPdStream(stream),true);
  const ext=await PowerzStreamCapture.open(stream).decode();assert.equal(ext.packets.length,3);assert.equal(ext.stats.badWire,0);assert.equal(ext.packets[0].extended.dataSize,25);
  const seq=[wrap([...u16(head(1,2)),...u32(fixed5),...u32(pps)],0),Uint8Array.from([0x45,1,0,0,0,0x12]),wrap([...u16(head(2,1,{sender:0})),...u32(requestPps)],2)];
  const r=await PowerzStreamCapture.open(writePdStream(seq.map((b,i)=>({time:i/1000,vbus:5,ibus:1,raw:b})))).decode();
  assert.equal(r.packets.length,2);assert.ok(r.packets[1].summary.includes('Unknown PDO'));assert.deepEqual(r.packets.map(p=>p.seq),[1,2]);
});
await mkdir(new URL('../artifacts/pd-spec-audit/',import.meta.url),{recursive:true});
await writeFile(new URL('../artifacts/pd-spec-audit/compliance-results.json',import.meta.url),JSON.stringify({pass:results.filter(r=>r.pass).length,fail:results.filter(r=>!r.pass).length,results},null,2));
console.log(`PD specification compliance: ${results.filter(r=>r.pass).length} passed, ${results.filter(r=>!r.pass).length} failed`);
if(results.some(r=>!r.pass))process.exitCode=1;
