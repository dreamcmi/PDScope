#!/usr/bin/env node
/** 已确认缺陷的回归：事件/协议分流、测量值、ACK、时间、测试退出码。无需私人样本。 */
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PowerzCapture, parseUfcsBlob } from '../src/js/core/powerz.js';
import { PowerzStreamCapture, PdStreamCapture, sniffPowerzStream, sniffPdStream, writePdStream } from '../src/js/core/pdstream.js';
import { ufcsLocateFrames, ufcsParseEvent, ufcsCrc8 } from '../src/js/ufcs/index.js';
import { attachBusValues, busAt, linkGoodCrc } from '../src/js/core/pipeline.js';
import { csvClock, csvRow, csvFileName } from '../src/js/core/csv.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'artifacts', 'regression');
await mkdir(join(out, 'empty'), { recursive: true });
let passed = 0;
const check = async (name, fn) => { await fn(); passed++; console.log(`PASS ${name}`); };
const eventHex = ['de3f010002130040', 'e155010003000040', '956b010002120040', 'd36c010003000040'];
const events = eventHex.map(hex => new Uint8Array(Buffer.from(hex, 'hex')));
function record(timeMs, flag, addr) {
  const header = (addr << 13) | 8; // UFCS 1.0.0，Get_Device_Info 控制消息
  const frame = [header >> 8, header & 255, 0x0A];
  frame.push(ufcsCrc8(frame));
  return Uint8Array.from([timeMs & 255, (timeMs >> 8) & 255, (timeMs >> 16) & 255, 0,
    0, frame.length - 1, frame.length + 1, flag, 0xAA, ...frame]);
}
const ufcsRows = [
  {time:0.2,vbus:5.174,ibus:0.006,raw:record(200,1,1)},
  {time:0.3,vbus:0,ibus:0,raw:record(300,0,2)},
  ...events.map(raw => ({time:ufcsParseEvent(raw).tsMs / 1000,vbus:9,ibus:2,raw})),
];
const stream = writePdStream(ufcsRows);
const key = p => [p.sop,p.msgType,p.role,p.timeMs,p.dataHex,p.crcOk,p.vbus,p.ibus];

await check('状态事件时间戳不能被穷举成 UFCS 报文', () => {
  for (const raw of events) {
    assert.ok(ufcsParseEvent(raw));
    assert.equal(ufcsLocateFrames(raw), null);
    assert.equal(parseUfcsBlob(raw).frames.length, 0);
  }
});
await check('UFCS 记录流与表路径等价：2 帧 / 4 事件 / 零假 CRC 错误', async () => {
  const db = {hasTable:n=>n==='ufcs_table',count:n=>n==='ufcs_table'?ufcsRows.length:0,
    *rows(n){if(n==='ufcs_table')for(const r of ufcsRows)yield[r.time,r.vbus,r.ibus,r.raw];}};
  const table = await new PowerzCapture(db,'ufcs',new Uint8Array()).decode();
  const cap = PowerzStreamCapture.open(stream);
  const decoded = await cap.decode();
  assert.deepEqual(decoded.packets.map(key), table.packets.map(key));
  assert.equal(decoded.stats.packetCount,2);
  assert.equal(decoded.stats.ufcsEvents,4);
  assert.equal(decoded.stats.badCrc,0);
  assert.equal(decoded.stats.crcUnknown,0);
  assert.equal(decoded.stats.ufcsDirInferred,0);
  assert.equal(cap.meta.protocol,'UFCS');
  assert.equal(cap.meta.container,'ufcsstream');
  assert.equal(cap.meta.bus.length,0);
  assert.equal(cap.durationSec,93.395);
});
await check('UFCS 流不会进入 PD；结构完整但协议未知或混合的流被拒绝', () => {
  assert.equal(sniffPowerzStream(stream),'ufcs');
  assert.equal(sniffPdStream(stream),false);
  assert.throws(()=>PdStreamCapture.open(stream),/UFCS/);
  assert.equal(sniffPowerzStream(stream.subarray(0,stream.length-1)),null);
  const unknown=writePdStream([0,1,2].map(time=>({time,vbus:0,ibus:0,raw:Uint8Array.of(1,2,3)})));
  assert.equal(sniffPowerzStream(unknown),null);
  assert.throws(()=>PowerzStreamCapture.open(unknown),/协议无法确定/);
  const mixed=writePdStream([...ufcsRows,{time:100,vbus:5,ibus:1,raw:Uint8Array.of(0x45,1,0,0,0,0x11)}]);
  assert.equal(sniffPowerzStream(mixed),null);
  assert.throws(()=>PowerzStreamCapture.open(mixed),/混有/);
});
await check('逐报文测量优先，真实零值保留，缺失值在 CSV 留空', async () => {
  const packets=(await PowerzStreamCapture.open(stream).decode()).packets;
  attachBusValues(packets,[{sample:0,vbus:99,ibus:10}]);
  assert.deepEqual(csvRow(packets[0],'UFCS').slice(8,10),['5.1740','0.0060']);
  assert.deepEqual(csvRow(packets[1],'UFCS').slice(8,10),['0.0000','0.0000']);
  const missing=[{startSample:0}];
  attachBusValues(missing,[]);
  assert.deepEqual(csvRow(missing[0],'USB PD').slice(8,10),['','']);
  assert.deepEqual(busAt([{sample:10,vbus:5,ibus:1}],0),{vbus:null,ibus:null});
  attachBusValues(missing,[{sample:0,vbus:5,ibus:1}]);
  assert.equal(missing[0].vbus,5);
});
await check('GoodCRC 在同一 SOP 按 ID 配对，错误/无匹配包不配对', () => {
  const packets=[
    {index:0,msgType:'Source_Cap',role:'SRC',sop:'SOP',msgId:1,crcOk:true},
    {index:1,msgType:'VDM',role:'SRC',sop:"SOP'",msgId:1,crcOk:true},
    {index:2,msgType:'GoodCRC',role:'SNK',sop:'SOP',msgId:1,crcOk:true},
    {index:3,msgType:'GoodCRC',role:'SNK',sop:"SOP''",msgId:1,crcOk:true},
    {index:4,msgType:'GoodCRC',role:'SNK',sop:'SOP',msgId:2,crcOk:true},
    {index:5,msgType:'GoodCRC',role:'SNK',sop:'SOP',msgId:1,crcOk:false,ackOf:0},
  ];
  linkGoodCrc(packets);
  assert.equal(packets[2].ackOf,0);
  for(const p of packets.slice(3))assert.equal(p.ackOf,undefined);
  const bad=[{...packets[0],crcOk:false},{...packets[2],index:1,msgId:2}];
  linkGoodCrc(bad);
  assert.equal(bad[1].ackOf,0); // 坏包的 ID 不可信，仍允许紧邻配对
});
await check('时间在秒、分、小时边界正确舍入进位', () => {
  for(const [ms,expected] of [[59999.4,'00:00:59.999'],[59999.6,'00:01:00.000'],
    [3599999.6,'01:00:00.000'],[86399999.6,'24:00:00.000'],[1234.5,'00:00:01.235']])
    assert.equal(csvClock(ms),expected);
  assert.equal(csvFileName('capture.ufcsStream',0),'capture-ch0.csv');
  assert.equal(csvFileName('capture.pdStream',0),'capture-ch0.csv');
});
await check('CLI 按内容识别改名的 UFCS 流，CSV 保留测量值', async () => {
  const path=join(out,'renamed.bin');
  await writeFile(path,stream);
  const r=spawnSync(process.execPath,['tools/cli.js',path,'--csv'],{cwd:root,encoding:'utf8'});
  assert.equal(r.status,0,r.stderr);
  assert.match(r.stderr,/UFCS/);
  assert.equal(r.stdout.trim().split(/\r?\n/).length,3);
  assert.match(r.stdout, /"5\.1740","0\.0060"/);
  assert.doesNotMatch(r.stderr,/badCrc=[1-9]/);
});
await check('ACK 检查的空目录和不存在输入均返回失败', () => {
  for(const args of [['--dir',join(out,'empty')],[join(out,'absent.atkcc')]]) {
    const r=spawnSync(process.execPath,['tools/ackcheck.js',...args],{cwd:root,encoding:'utf8'});
    assert.equal(r.status,1);
    assert.doesNotMatch(r.stdout,/全部通过/);
  }
});

// 本地真实样本扩展验收；默认 CI 合成用例覆盖所有修复，--real 明确要求这些样本存在。
if(process.argv.includes('--real')) {
  for(const [base,count,eventCount] of [['CTK6U_X300U_UFCS',2754,21],['CTK10UL_X300U_UFCS',2734,5]]) {
    await check(`${base} 真实 SQLite / UFCS 流逐报文一致`, async()=>{
      const sqlite=PowerzCapture.open(new Uint8Array(await readFile(join(root,'rawdata',base+'.sqlite'))));
      const ufcs=PowerzStreamCapture.open(new Uint8Array(await readFile(join(root,'rawdata',base+'.ufcsStream'))));
      const a=await sqlite.decode(),b=await ufcs.decode();
      assert.equal(a.packets.length,count); assert.equal(b.packets.length,count);
      assert.equal(a.stats.ufcsEvents,eventCount); assert.equal(b.stats.ufcsEvents,eventCount);
      assert.equal(a.stats.badCrc,0); assert.equal(b.stats.badCrc,0);
      assert.equal(a.stats.ufcsDirInferred,0); assert.equal(b.stats.ufcsDirInferred,0);
      assert.deepEqual(a.packets.map(key),b.packets.map(key));
      assert.ok(b.stats.durationSec<400);
    });
  }
  await check('DJIPOWER 真实 PD 流与 SQLite 的测量和报文一致',async()=>{
    const a=await PowerzCapture.open(new Uint8Array(await readFile(join(root,'rawdata','DJIPOWER_VIVOX300U_PPS.sqlite')))).decode();
    const b=await PowerzStreamCapture.open(new Uint8Array(await readFile(join(root,'rawdata','DJIPOWER_VIVOX300U_PPS.pdStream')))).decode();
    assert.equal(a.packets.length,3674);assert.deepEqual(a.packets.map(key),b.packets.map(key));
    assert.deepEqual(csvRow(b.packets[0],'USB PD').slice(8,10),['5.1740','0.0060']);
  });
}
console.log(`${passed} regression checks passed`);
