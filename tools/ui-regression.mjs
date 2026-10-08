#!/usr/bin/env node
/** 浏览器导出与 Node CSV 逐字节一致，并检查真实 EPR/AVS 会话、缺失测量和格式分流。 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { writePdStream } from '../src/js/core/pdstream.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const dir=join(root,'artifacts','ui-regression');
await mkdir(dir,{recursive:true});
function run(args) {
  const r=spawnSync(process.execPath,args,{cwd:root,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
  assert.equal(r.status,0,r.error?.message || r.stderr || r.stdout);
  return r.stdout;
}
run(['tools/make-test-atkcc.mjs','--pd','--out','artifacts/_pd_synth.atkcc']);
run(['tools/make-test-atkcc.mjs','--pd','--no-bus','--out','artifacts/_pd_no_bus.atkcc']);
run(['tools/make-test-atkcc.mjs','--pd-bist','--out','artifacts/_pd_bist.atkcc']);
run(['tools/make-test-ufcs.mjs','--stream-out','artifacts/_ufcs_synth.ufcsStream']);

// 独立的 EPR / AVS 会话：用真实 SOP 逻辑字节写成 .pdStream，再经过 CLI 与浏览器导入。
// PDO / RDO 常量取自 PD 3.1/3.2 字段定义：Fixed 5V EPR-capable、Fixed 15V/2A、
// SPR AVS 9~15V/2A（15V~20V 电流域为 0）、EPR Fixed 28V 和 15~28V/100W EPR AVS。
const eprPdos = {
  fixed5Epr: 0x0081912C,
  fixed15: 0x0004B0C8,
  sprAvs: 0xE0032000,
  fixed28: 0x0008C1F4,
  eprAvs: 0xD2309664,
};
const eprRows = [];
const eprMessageIds = [0, 0];
const le16 = (v) => [v & 0xFF, (v >>> 8) & 0xFF];
const le32 = (v) => [v & 0xFF, (v >>> 8) & 0xFF, (v >>> 16) & 0xFF, (v >>> 24) & 0xFF];
function eprHeader({ type, n = 0, id, sender = 1, extended = false }) {
  const revision = 2; // Header Revision 3.x (PD 3.1/3.2)
  return ((extended ? 1 : 0) << 15) | ((n & 7) << 12) | ((id & 7) << 9)
    | ((sender & 1) << 8) | (revision << 6) | ((sender & 1) << 5) | (type & 0x1F);
}
function eprRaw(tsMs, wire) {
  const total = 1 + 4 + 1 + wire.length;
  return Uint8Array.from([0x80 | ((total - 1) & 0x3F), tsMs & 0xFF, (tsMs >>> 8) & 0xFF,
    (tsMs >>> 16) & 0xFF, (tsMs >>> 24) & 0xFF, 0, ...wire]);
}
function addEprMessage(type, { sender = 1, words = [], extBytes = null, vbus = 5, ibus = 0 } = {}) {
  const id = eprMessageIds[sender]++ & 7;
  const isExtended = extBytes !== null;
  const wire = le16(eprHeader({ type, n: isExtended ? 0 : words.length, id, sender, extended: isExtended }));
  if (isExtended) wire.push(...le16(extBytes.length), ...extBytes);
  else for (const word of words) wire.push(...le32(word >>> 0));
  const tsMs = 500 + eprRows.length * 100;
  eprRows.push({ time: tsMs / 1000, vbus, ibus, raw: eprRaw(tsMs, wire) });
}
function avsRdo(position, volts, amps, eprCapable = false) {
  return (((position & 15) << 28) | (Math.round(volts / 0.025) << 9)
    | Math.round(amps / 0.05) | (eprCapable ? (1 << 22) : 0)) >>> 0;
}
const sprPdos = [eprPdos.fixed5Epr, eprPdos.fixed15, eprPdos.sprAvs];
addEprMessage(1, { words: sprPdos, vbus: 5.02, ibus: 0.12 }); // Source_Capabilities
addEprMessage(2, { sender: 0, words: [avsRdo(3, 15, 2, true)], vbus: 5.03, ibus: 0.18 }); // SPR AVS Request
addEprMessage(3, { vbus: 5.04, ibus: 0.24 });
addEprMessage(6, { vbus: 15, ibus: 0.45 }); // SPR AVS contract
addEprMessage(10, { sender: 0, words: [0x01640000], vbus: 15, ibus: 0.45 }); // Enter, 100 W
addEprMessage(10, { words: [0x02000000], vbus: 15, ibus: 0.45 }); // Enter Acknowledged
addEprMessage(10, { words: [0x03000000], vbus: 15, ibus: 0.45 }); // Enter Succeeded
const eprCapabilitySlots = [
  ...sprPdos, 0, 0, 0, 0, // 7 SPR slots: mirror advertised PDOs, then zero-fill
  eprPdos.fixed28, eprPdos.eprAvs,
];
addEprMessage(17, { extBytes: eprCapabilitySlots.flatMap(le32), vbus: 15, ibus: 0.45 });
addEprMessage(9, { sender: 0, words: [avsRdo(9, 28, 3), eprPdos.eprAvs], vbus: 15, ibus: 0.5 }); // EPR AVS request
addEprMessage(3, { vbus: 15, ibus: 0.55 });
addEprMessage(6, { vbus: 28, ibus: 0.7 }); // EPR AVS contract
addEprMessage(16, { sender: 0, extBytes: [3, 0], vbus: 28, ibus: 0.7 }); // Keep Alive
addEprMessage(16, { extBytes: [4, 0], vbus: 28, ibus: 0.7 }); // Keep Alive Ack
addEprMessage(9, { sender: 0, words: [avsRdo(3, 15, 2), eprPdos.sprAvs], vbus: 28, ibus: 0.7 }); // return to SPR AVS
addEprMessage(3, { vbus: 28, ibus: 0.6 });
addEprMessage(6, { vbus: 15, ibus: 0.45 }); // SPR contract, still EPR mode
addEprMessage(10, { sender: 0, words: [0x05000000], vbus: 15, ibus: 0.45 }); // Exit EPR
addEprMessage(1, { words: sprPdos, vbus: 15, ibus: 0.45 }); // SPR Source_Capabilities after exit
const eprFixture = 'artifacts/_epr_avs_regression.pdStream';
await writeFile(join(root, eprFixture), writePdStream(eprRows));

const cases=[
  ['artifacts/_pd_synth.atkcc','USB PD',12,5,0.1],
  ['artifacts/_pd_no_bus.atkcc','USB PD',12,null,null],
  ['rawdata/DJIPOWER_VIVOX300U_PPS.pdStream','USB PD',3674,5.174,0.006],
  [eprFixture,'USB PD',eprRows.length,5.02,0.12],
  ['artifacts/_ufcs_synth.sqlite','UFCS',null,9,2],
  ['artifacts/_ufcs_synth.ufcsStream','UFCS',null,9,2],
  ['artifacts/_pd_bist.atkcc','USB PD',6,5,0.1],
];
if(process.argv.includes('--real'))for(const [base,count] of [['CTK6U_X300U_UFCS',2754],['CTK10UL_X300U_UFCS',2734]]) {
  for(const ext of ['sqlite','ufcsStream'])cases.push([`rawdata/${base}.${ext}`,'UFCS',count]);
}
for(let i=0;i<cases.length;i++) {
  const [file,protocol,count,vbus,ibus]=cases[i];
  const csv=run(['tools/cli.js',file,'--csv']).replace(/\n$/,'');
  const ref=join(dir,`reference-${i}.csv`);
  await writeFile(ref,csv,'utf8');
  const expression=`(async()=>{
    const bytes=new Uint8Array(await(await fetch(${JSON.stringify(pathToFileURL(resolve(root,file)).href)})).arrayBuffer());
    const result=await window.PDScope.exportCsv({name:${JSON.stringify(file.split('/').pop())},bytes,bom:false});
    const expected=await(await fetch(${JSON.stringify(pathToFileURL(ref).href)})).text();
    if(result.csv!==expected)throw new Error('浏览器与 Node CSV 字节不一致');
    if(result.protocol!==${JSON.stringify(protocol)})throw new Error('协议识别不正确');
    ${count==null?'':`if(result.rows!==${count})throw new Error('报文总数不正确');`}
    const cells=result.csv.split('\\r\\n')[1].split(',');
    ${vbus===undefined?'':`if(cells[8]!==${JSON.stringify(vbus==null?'""':`"${vbus.toFixed(4)}"`)})throw new Error('CSV 电压丢失或伪造');`}
    ${ibus===undefined?'':`if(cells[9]!==${JSON.stringify(ibus==null?'""':`"${ibus.toFixed(4)}"`)})throw new Error('CSV 电流丢失或伪造');`}
    document.querySelector('#btnReset').click();
    await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
    const display=document.querySelector('#vrows .tr .bus').textContent;
    ${vbus===null?`if(!display.includes('—'))throw new Error('界面没有标出缺失测量');`:''}
    ${file===eprFixture?`const loaded=window.PDScope.status();
    if(loaded.protocol!=='USB PD'||loaded.packets!==${eprRows.length})throw new Error('EPR .pdStream 未经真实导入流程完整解码');
    async function packetDetail(type, occurrence=0) {
      const input=document.querySelector('#fSearch');input.value=type;input.dispatchEvent(new Event('input',{bubbles:true}));
      await new Promise(r=>setTimeout(r,220));
      const rows=[...document.querySelectorAll('#vrows .tr')].filter(r=>r.children[2]?.textContent.trim()===type);
      const row=rows[occurrence];if(!row)throw new Error('列表中找不到 '+type+' #'+occurrence);
      row.click();await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
      return {detail:document.querySelector('#detailBody').innerText.replace(/\\s+/g,' '),row:row.innerText.replace(/\\s+/g,' ')};
    }
    function includes(label,result,parts) {
      const missing=parts.filter(x=>!result.detail.includes(x));
      if(missing.length)throw new Error(label+' 详情缺少 '+missing.join(' / ')+'；实际：'+result.detail);
    }
    let d=await packetDetail('Source_Cap',0);
    includes('SPR AVS PDO',d,['9~15V','9V~15V 最大电流 [B19-10]','2 A','15V~20V 最大电流 [B9-0]','0 A']);
    d=await packetDetail('Request');includes('SPR AVS Request',d,['15 V','2 A','EPR Capable']);
    d=await packetDetail('EPR_Mode',0);includes('EPR Enter',d,['模式','SPR','阶段','已请求进入','PDO #3 · spr_avs · SPR']);
    d=await packetDetail('EPR_Mode',1);includes('EPR Enter Ack',d,['阶段','进入请求已确认','PDO #3 · spr_avs · SPR']);
    d=await packetDetail('EPR_Mode',2);includes('EPR Enter Succeeded',d,['模式','EPR','阶段','等待 EPR 能力','PDO #3 · spr_avs · SPR']);
    d=await packetDetail('EPR_Source_Capabilities');
    includes('EPR Source AVS capability block',d,['阶段','等待 EPR 请求','PDO #1','PDO #7','PDO #8','PDO #9','SPR 槽位未使用，按 0 填充','28 V','15 V','PDP [B7-0]','100 W']);
    if((d.detail.match(/SPR 槽位未使用，按 0 填充/g)||[]).length!==4)throw new Error('EPR Source_Capabilities 的 SPR 空槽未恰好零填充 4 位');
    d=await packetDetail('EPR_Request',0);includes('EPR AVS Request',d,['PDO 副本','引用 #9','28 V','3 A','阶段','等待 Accept','PDO #3 · spr_avs · SPR']);
    d=await packetDetail('Accept',1);includes('EPR Accept',d,['阶段','等待 PS_RDY','PDO #3 · spr_avs · SPR']);
    d=await packetDetail('PS_RDY',1);includes('EPR PS_RDY contract',d,['模式','EPR','阶段','合同已建立','PDO #9 · epr_avs · EPR']);
    d=await packetDetail('Extended_Control',0);includes('EPR Keep Alive',d,['Keep Alive','等待 Source Ack','PDO #9 · epr_avs · EPR']);
    d=await packetDetail('Extended_Control',1);includes('EPR Keep Alive Ack',d,['Keep Alive','已收到 Source Ack','PDO #9 · epr_avs · EPR']);
    d=await packetDetail('EPR_Request',1);includes('SPR AVS return request',d,['PDO 副本','引用 #3','15 V','2 A','阶段','等待 Accept','PDO #9 · epr_avs · EPR']);
    d=await packetDetail('Accept',2);includes('SPR return Accept',d,['阶段','等待 PS_RDY','PDO #9 · epr_avs · EPR']);
    d=await packetDetail('PS_RDY',2);includes('SPR return PS_RDY',d,['模式','EPR','阶段','合同已建立','PDO #3 · spr_avs · SPR']);
    d=await packetDetail('EPR_Mode',3);includes('legal EPR Exit',d,['模式','SPR','阶段','已退出，等待 SPR 能力','PDO #3 · spr_avs · SPR']);`:''}
    ${file.includes('_pd_bist')?`const bistRows=[...document.querySelectorAll('#vrows .tr')].filter(r=>r.textContent.includes('BIST_Test_Frame'));
    if(bistRows.length!==2)throw new Error('BIST 原始帧被方向/类别筛选隐藏');
    bistRows[1].click();
    const detail=document.querySelector('#detailBody');
    if(detail.textContent.includes('报文头 (16 bit)'))throw new Error('BIST 原始帧显示了虚构 Header');
    if(!detail.textContent.includes('本帧格式不含 CRC') || !detail.textContent.includes('累计错误位'))throw new Error('BIST 错误计数或 CRC 规则未显示');`:''}
    return {file:${JSON.stringify(file)},protocol:result.protocol,rows:result.rows,csvMatches:true,display,eprUiChecks:${file===eprFixture}};
  })()`;
  const e2eArgs=['tools/e2e.mjs','--file','dist/PDScope.html','--dbg',String(80+i)];
  if(file===eprFixture)e2eArgs.push('--drop',file);
  e2eArgs.push('--eval',expression,'--out',join(dir,`export-${i}.png`));
  const output=run(e2eArgs);
  console.log(`PASS 浏览器/Node CSV 对照：${file}`);
  await writeFile(join(dir,`export-${i}.log`),output,'utf8');
}
console.log(`${cases.length} browser export checks passed`);
