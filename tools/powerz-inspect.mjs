/**
 * powerz-inspect.mjs — POWER-Z（SQLite）抓包体检
 *
 * 做两件事：
 *   1. **全样本体检** —— 每个库打一行汇总（协议 / 报文数 / 连接事件 / 拆帧自检 /
 *      警告 / 跳过原因），有任何异常就非 0 退出，供改完解析后一把梭。
 *   2. **人工核对** —— 打印线缆链路（SOP'/SOP''）报文与首条扩展消息的完整详情分组，
 *      与 pd-inspect.mjs 看的是同一批东西，方便两条路径（.atkcc / .sqlite）对照。
 *
 * 用法：
 *   node tools/powerz-inspect.mjs [文件名子串] [--packets] [--json]
 * 样本目录默认取仓库上一级（.sqlite 不入库，与 PDScope/ 平级存放），
 * 可用环境变量 PD_SAMPLES 覆盖。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PowerzCapture, sniffPowerz } from '../src/js/core/powerz.js';

/** 抓包样本目录：默认 <仓库>/.. ，可用 PD_SAMPLES 覆盖 */
const DIR = (process.env.PD_SAMPLES ?? fileURLToPath(new URL('../../', import.meta.url))).replace(/\/?$/, '/');

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const filter = args.find((a) => !a.startsWith('--'));

/** 缺省样本清单（与 pd-inspect.mjs 的 .atkcc 样本一一对应，便于交叉验证） */
const DEFAULT = [
  '山泽60w-ip18pro.sqlite',
  '酷泰科6u-18pro.sqlite',
];

/** 目录里还有别的 .sqlite 的话也一起体检，但只认能识别成 POWER-Z 的那些 */
async function listFiles() {
  if (filter) {
    const all = await readdir(DIR).catch(() => []);
    return all.filter((f) => f.includes(filter)).filter((f) => /\.sqlite$/i.test(f)).sort();
  }
  const all = await readdir(DIR).catch(() => []);
  const pool = new Set(DEFAULT);
  for (const f of all) if (/\.sqlite$/i.test(f)) pool.add(f);
  return [...pool].sort();
}

const files = await listFiles();
if (!files.length) {
  console.log(`没有在 ${DIR} 找到匹配的 .sqlite 样本`);
  process.exit(1);
}

let failed = 0;
const report = [];

for (const name of files) {
  const path = DIR + name;
  let u8;
  try {
    if (!(await stat(path)).isFile()) throw new Error('不是文件');
    u8 = new Uint8Array(await readFile(path));
  } catch (e) {
    console.log(`## ${name}   读取失败：${e.message}`);
    failed++;
    continue;
  }

  const kind = sniffPowerz(u8);
  if (!kind) {
    console.log(`## ${name}   —— 不是 POWER-Z 导出（跳过）`);
    continue;
  }

  const cap = PowerzCapture.open(u8);
  const t0 = performance.now();
  const { packets, stats } = await cap.decode();
  const ms = Math.round(performance.now() - t0);

  const cable = packets.filter((p) => p.link === 'cable');
  const ext = packets.filter((p) => p.msgKind === 'ext');
  const types = new Map();
  for (const p of packets) types.set(p.msgType, (types.get(p.msgType) ?? 0) + 1);

  const ok = !stats.badWire && !stats.warnings && !stats.truncatedRows;
  console.log('══════════════════════════════════════════════');
  console.log(`## ${name}`);
  console.log(`   ${cap.meta.title}   报文 ${packets.length}`
    + (stats.unsupportedMsgs ? `  原始帧 ${stats.unsupportedMsgs}（未解析）` : '')
    + `  线缆链路 ${cable.length}  扩展 ${ext.length}`
    + `  连接 ${stats.connectCount} / 断开 ${stats.disconnectCount}`);
  console.log(`   时长 ${stats.durationSec.toFixed(3)} s   ADC 采样 ${stats.chartRows}`
    + `   表行 ${stats.tableRows}   解码 ${ms} ms`);
  console.log(`   拆帧自检 badWire ${stats.badWire}   截断行 ${stats.truncatedRows}`
    + `   警告 ${stats.warnings}   CRC ${stats.crcUnknown ? `${stats.crcUnknown} 条未记录（分析仪不存 CRC）` : '—'}`
    + `   ${ok ? '✔' : '✖'}`);
  if (stats.unsupportedMsgs) {
    console.log(`   ⚠ ${stats.unsupported ?? '该协议尚未实现语义解析'}`
      + `（原始帧 ${stats.unsupportedMsgs} 条已读入但未做语义解析）`);
  }
  if (!ok) failed++;
  if (!ok || flags.has('--packets')) {
    console.log(`   类型分布：${[...types.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join('  ')}`);
  }

  for (const p of cable) printPacket(`${p.sop} ${p.msgType}`, p);
  if (ext.length) printPacket('扩展消息示例', ext[0]);

  // 异常时把告警明细打出来，便于定位
  if (!ok) {
    for (const p of packets) {
      for (const w of p.warnings ?? []) {
        console.log(`   ⚠ #${p.index} ${p.sop} ${p.msgType}  ${w.long ?? w.short ?? w}`);
      }
    }
  }

  report.push({
    file: name, kind, protocol: cap.meta.protocol,
    packets: packets.length, cable: cable.length, ext: ext.length,
    chartRows: stats.chartRows, tableRows: stats.tableRows,
    connect: stats.connectCount, disconnect: stats.disconnectCount,
    badWire: stats.badWire, truncatedRows: stats.truncatedRows, warnings: stats.warnings,
    durationSec: stats.durationSec, ms,
  });
}

if (flags.has('--json')) {
  console.log('\n── JSON ──');
  console.log(JSON.stringify(report, null, 2));
}

if (failed) {
  console.log(`\n⚠ ${failed} 个样本有异常，请回看上面的汇总行。`);
  process.exitCode = 1;
} else {
  console.log(`\n✔ ${report.length} 个样本全部通过。`);
}

function printPacket(title, p) {
  console.log(`\n──── ${title} ────`);
  console.log(`#${p.index ?? p.seq} ${p.sop} ${p.msgType} role=${p.role}`
    + ` ${p.revText} id=${p.msgId} n=${p.nObjects} crc=${p.crcOk === null ? '未记录' : p.crcOk}`);
  console.log(`summary: ${p.summary}`);
  for (const d of p.details || []) {
    if (d.key === 'Object') { console.log(`  ▸ ${d.value}`); continue; }
    console.log(`      ${d.key.padEnd(42)} ${d.value}`);
  }
  if (p.warnings?.length) for (const w of p.warnings) console.log(`  ⚠ ${w.long ?? w.short ?? w}`);
}
