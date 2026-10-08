/** Four supplied PDF baselines: fixed message-set vectors and public-entry integration. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { PdDecoder } from '../src/js/pd/index.js';
import { AtkccCapture } from '../src/js/core/atkcc.js';
import { PowerzCapture } from '../src/js/core/powerz.js';
import { PowerzStreamCapture, writePdStream } from '../src/js/core/pdstream.js';
import { decodeChannel } from '../src/js/core/pipeline.js';
import { makeNodeInflator } from '../src/js/core/inflate.js';

const results = [];
async function test(name, fn) {
  try { await fn(); results.push({ name, pass: true }); console.log(`PASS ${name}`); }
  catch (e) { results.push({ name, pass: false, error: e.stack }); console.error(`FAIL ${name}: ${e.message}`); }
}
// Literal sets from PD2 Tables 6-2/6-3, PD3.0 Tables 6-5/6-6/6-42,
// PD3.1 Tables 6-5/6-6/6-53, PD3.2 Tables 6.4/6.5/6.47. Not imported from tables.js.
const sets = {
  '2.0': { control:[1,2,3,4,5,6,7,8,9,10,11,12,13], data:[1,2,3,4,15], ext:[] },
  '3.0': { control:[1,2,3,4,5,6,7,8,9,10,11,12,13,16,17,18,19,20,21], data:[1,2,3,4,5,6,7,15], ext:[1,2,3,4,5,6,7,8,9,10,11,12,13,14] },
  '3.1': { control:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24], data:[1,2,3,4,5,6,7,8,9,10,11,12,15], ext:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,30] },
  '3.2': { control:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24], data:[1,2,3,4,5,6,7,8,9,10,11,12,15], ext:[1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,30] },
};
const le16 = n => [n & 255, n >>> 8 & 255];
const le32 = n => [n & 255, n >>> 8 & 255, n >>> 16 & 255, n >>> 24 & 255];
const header = (type, n, ext=0, id=0) => ext << 15 | n << 12 | id << 9 | 0x180 | type;
function message(type, words=[], { ext=false, id=0 }={}) {
  return Uint8Array.from(ext ? [...le16(header(type,0,1,id)),0,0]
    : [...le16(header(type,words.length,0,id)),...words.flatMap(le32)]);
}
for (const profile of Object.keys(sets)) for (const kind of ['control','data','ext']) {
  await test(`message-set ${profile} ${kind}: every 5-bit type`, () => {
    for (let type=0;type<32;type++) {
      const d = new PdDecoder({sampleRate:1000,specRevision:profile});
      const p=d.decodeWire(message(type,kind==='data'?[0]:[],{ext:kind==='ext'}),{crcRecorded:false});
      assert.equal(p.msgType==='Reserved',!sets[profile][kind].includes(type),`${profile}/${kind}/${type}`);
      assert.equal(p.specProfile,profile);
    }
  });
}
await mkdir('artifacts/pd-spec-audit',{recursive:true});
// Source Cap: Fixed5V/3A plus SPR AVS 9..15V/2A; Source_Info has two objects.
// The same bytes have intentionally different meanings in the four baselines.
const fixture='artifacts/pd-spec-audit/profiles.pdStream';
const rows=[message(1,[0x0001912C,0xE0032000]),message(11,[0x00640064,0x800000C8],{id:1}),message(14,[],{id:2})]
  .map((wire,i)=>({time:(i+1)/10,vbus:5,ibus:0.1,raw:Uint8Array.from([0x80|(5+wire.length),...le32((i+1)*100),0,...wire])}));
await writeFile(fixture,writePdStream(rows));
for (const profile of Object.keys(sets)) await test(`stream/CLI option reaches decoder ${profile}`, async () => {
  const stream=PowerzStreamCapture.open(new Uint8Array(await readFile(fixture)));
  const direct=await stream.decode({specRevision:profile});
  assert.equal(direct.stats.specRevision,profile);
  assert.equal(direct.packets[0].specProfile,profile);
  const reservedAvs=direct.packets[0].summary.includes('Reserved_APDO');
  assert.equal(reservedAvs,profile!=='3.2');
  assert.equal(direct.packets[1].msgType==='Source_Info',['3.1','3.2'].includes(profile));
  if(profile==='3.1') assert.ok(direct.packets[1].warnings.some(w=>w.short==='COUNT'));
  if(profile==='3.2') assert.ok(!direct.packets[1].warnings.some(w=>w.short==='COUNT'));
  const run=spawnSync(process.execPath,['tools/cli.js',fixture,'--json','--spec',profile],{encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,run.stderr);
  const cli=JSON.parse(run.stdout);
  assert.equal(cli.meta.stats.specRevision,profile);
  assert.deepEqual(cli.packets.map(p=>[p.msgType,p.summary]),direct.packets.map(p=>[p.msgType,p.summary]));
});
for (const arg of ['5.0','',undefined]) await test(`CLI rejects invalid --spec ${String(arg)}`,()=>{
  const args=['tools/cli.js',fixture,'--spec'];if(arg!==undefined)args.push(arg);
  const run=spawnSync(process.execPath,args,{encoding:'utf8',timeout:30000});
  assert.notEqual(run.status,0);assert.match(run.stderr,/--spec 必须/);
});
await test('auto default remains ambiguous and invalid library profile fails',async()=>{
  assert.throws(()=>new PdDecoder({sampleRate:1000,specRevision:'3.9'}),RangeError);
  const result=await PowerzStreamCapture.open(new Uint8Array(await readFile(fixture))).decode();
  assert.equal(result.stats.specRevision,null);assert.equal(result.packets[0].specProfile,null);
});
await test('raw BMC pipeline preserves exact selected baseline',async()=>{
  const name='artifacts/pd-spec-audit/profiles.atkcc';
  const run=spawnSync(process.execPath,['tools/make-test-atkcc.mjs','--pd','--out',name],{encoding:'utf8',timeout:30000});
  assert.equal(run.status,0,run.stderr);
  const inflate=await makeNodeInflator();
  const cap=await AtkccCapture.open(new Uint8Array(await readFile(name)),{inflate});
  for(const profile of ['2.0','3.0','3.1','3.2']) {
    const r=await decodeChannel(cap,0,{inflate,specRevision:profile});
    assert.equal(r.stats.specRevision,profile);
    assert.equal(r.packets.length,12);
    assert.ok(r.packets.filter(p=>p.header!=null).every(p=>p.specProfile===profile));
  }
});
await test('SQLite selected baseline uses the same semantic path',async()=>{
  const cap=PowerzCapture.open(new Uint8Array(await readFile('rawdata/DJIPOWER_VIVOX300U_PPS.sqlite')));
  const r=await cap.decode({specRevision:'3.0'});
  assert.equal(r.stats.specRevision,'3.0');assert.equal(r.packets.length,3674);
  assert.ok(r.packets.filter(p=>p.revText==='3.x').every(p=>p.specProfile==='3.0'));
});
const report={suite:'four supplied PDF profiles',passed:results.filter(r=>r.pass).length,failed:results.filter(r=>!r.pass).length,results};
await writeFile('artifacts/pd-spec-audit/profile-results.json',JSON.stringify(report,null,2)+'\n');
console.log(`${report.passed} profile checks passed, ${report.failed} failed`);
if(report.failed)process.exitCode=1;
