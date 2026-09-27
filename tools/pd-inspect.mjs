/**
 * pd-inspect.mjs — 抽查「线缆链路 plug 信令」与扩展消息的解析结果
 *
 * 只看 SOP'/SOP''（含 Debug）上的报文，以及全部扩展消息，打印其详情分组，
 * 用于人工核对 PD 库对 e-Marker 线缆 VDO / 扩展数据块的还原是否完整。
 * 每个样本先打一行汇总（报文数 / 线缆链路数 / 扩展消息数 / 坏 CRC / 警告），
 * 所以也能当「改完解析后来一次全样本体检」用。
 *
 * 用法：node tools/pd-inspect.mjs [文件名子串]
 * 样本目录默认取仓库上一级（.atkcc 不入库，与 PDScope/ 平级存放），
 * 可用环境变量 PD_SAMPLES 覆盖。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { AtkccCapture } from '../src/js/core/atkcc.js';
import { decodeChannel } from '../src/js/core/pipeline.js';
import { makeNodeInflator } from '../src/js/core/inflate.js';

const inflate = await makeNodeInflator();
/** 抓包样本目录：默认 <仓库>/.. ，可用 PD_SAMPLES 覆盖 */
const DIR = process.env.PD_SAMPLES ?? fileURLToPath(new URL('../../', import.meta.url));
const ALL = [
  '苹果40w-ip18pro', '安可60w-ip18pro', '酷泰科6u-ip18pro', '绿联70w-ip18pro',
  '制糖40w-ip18pro', 'apple_40w_avs_iphone_air', '酷泰科10u线-ip18pro',
];

const filter = process.argv[2];
const files = filter ? ALL.filter((f) => f.includes(filter)) : ALL;
if (!files.length) {
  console.log(`没有匹配「${filter}」的样本，可选：${ALL.join(' / ')}`);
  process.exit(1);
}

let failed = 0;
for (const f of files) {
  let cap;
  try {
    cap = await AtkccCapture.open(new Uint8Array(await readFile(DIR + f + '.atkcc')), { inflate });
  } catch (e) {
    console.log(`## ${f}   读取失败：${e.message}`);
    failed++;
    continue;
  }

  const { packets, stats } = await decodeChannel(cap, 0, { inflate });
  const cable = packets.filter((p) => p.link === 'cable');
  const ext = packets.filter((p) => p.msgKind === 'ext');

  console.log('══════════════════════════════════════════════');
  console.log(`## ${f}   报文 ${packets.length}  线缆链路 ${cable.length}`
    + `  扩展 ${ext.length}  badCRC ${stats.badCrc}  警告 ${stats.warnings}`);
  if (stats.badCrc || stats.warnings) failed++;

  // 逐条打印线缆链路报文（数量很少，便于人工核对 plug 信令）
  for (const p of cable) printPacket(`${p.sop} ${p.msgType}`, p);

  // 打印第一条「扩展消息」完整详情
  if (ext.length) printPacket('扩展消息示例', ext[0]);
}

if (failed) {
  console.log(`\n⚠ ${failed} 个样本有坏 CRC / 警告或读取失败，请回看上面的汇总行。`);
  process.exitCode = 1;
}

function printPacket(title, p) {
  console.log(`\n──── ${title} ────`);
  console.log(`#${p.index ?? p.seq} ${p.sop} ${p.msgType} role=${p.role}`
    + ` r${p.rev} id=${p.msgId} n=${p.nObjects} crc=${p.crcOk}`);
  console.log(`summary: ${p.summary}`);
  for (const d of p.details || []) {
    if (d.key === 'Object') { console.log(`  ▸ ${d.value}`); continue; }
    console.log(`      ${d.key.padEnd(42)} ${d.value}`);
  }
  if (p.warnings?.length) for (const w of p.warnings) console.log(`  ⚠ ${w.long ?? w.short ?? w}`);
}
