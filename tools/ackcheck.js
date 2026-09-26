#!/usr/bin/env node
/**
 * GOOD CRC 配对校验 —— 跨全部真实抓包验证 `linkGoodCrc()` 的配对是否正确。
 *
 * 校验项：
 *   ① 被确认对象不能是 GOOD CRC 自己，方向必须相反（linkGoodCrc 的构造约束）；
 *   ② 双方 CRC 都通过时，MessageID 必须相同（PD 规范的强约束）——这是真正的正确性判据；
 *   ③ 配对距离必须很近（GoodCRC 是即时应答，实测恒为 1 条）；
 *   ④ 统计「继承配色」后多少条 GOOD CRC 会呈现 Control 以外的新颜色。
 *
 * 用法：node tools/ackcheck.js [文件.atkcc ...]
 *       不带参数则扫描上级目录里的全部 .atkcc
 */
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeNodeInflator } from '../src/js/core/inflate.js';
import { AtkccCapture, scanChannelActivity } from '../src/js/core/atkcc.js';
import { decodeChannel } from '../src/js/core/pipeline.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PARENT = resolve(ROOT, '..');
const inflate = await makeNodeInflator();

/** 与界面 `toneOf()` 保持一致：只取报文自身的语义类别，不看 CRC */
function toneOf(p) {
  if (p.msgType === 'VDM') return 'VDM';
  if (p.msgKind === 'ext') return 'Extended';
  if (p.msgKind === 'data') return 'Data';
  if (p.msgKind === 'special') return 'Error';
  return 'Control';
}
const OPPOSITE = { SRC: 'SNK', SNK: 'SRC' };

async function bestChannel(cap) {
  if (cap.meta.channels.length === 1) return cap.meta.channels[0].channel;
  let best = cap.meta.channels[0].channel, bestA = -1;
  for (const c of cap.meta.channels) {
    const r = await scanChannelActivity(cap, c.channel, inflate, 3);
    if (r.activity > bestA) { bestA = r.activity; best = c.channel; }
  }
  return best;
}

async function check(file) {
  const bytes = new Uint8Array(await readFile(file));
  const cap = await AtkccCapture.open(bytes, { inflate });
  const ch = await bestChannel(cap);
  const { packets, stats } = await decodeChannel(cap, ch, { inflate, bitOrder: 'lsb' });

  const gc = packets.filter((p) => p.msgType === 'GOOD CRC');
  const okGc = gc.filter((p) => p.crcOk !== false);
  const paired = okGc.filter((p) => p.ackOf != null);

  let badSelf = 0, badDir = 0, badId = 0, badDist = 0, maxDist = 0, idChecked = 0;
  let inhControl = 0, inhOther = 0;
  const samples = [];
  for (const p of paired) {
    const ref = packets[p.ackOf];
    if (!ref || ref.msgType === 'GOOD CRC') { badSelf++; continue; }
    if (ref.role === p.role) badDir++;
    if (ref.crcOk !== false) { idChecked++; if (ref.msgId !== p.msgId) badId++; }
    const dist = p.index - ref.index;
    if (dist > maxDist) maxDist = dist;
    if (dist > 4) badDist++;
    const t = toneOf(ref);
    if (t === 'Control') inhControl++; else inhOther++;
    if (samples.length < 4) samples.push(`#${p.index} GOOD CRC(${p.role}) ⟵ #${ref.index} ${ref.msgType}(${ref.role})` + `${ref.crcOk === false ? ' [坏包]' : ''} → 取 ${t} 色`);
  }

  const errs = badSelf + badDir + badId + badDist;
  const name = basename(file).replace(/\.atkcc$/i, '');
  console.log(`\n── ${name}  (通道 ${ch}, ${packets.length} 条报文)`);
  console.log(`   GOOD CRC ${gc.length} 条 · 有效 ${okGc.length} · 已配对 ${paired.length} · 未配对 ${okGc.length - paired.length}`);
  console.log(`   配对正确性: 自指 ${badSelf} · 同向 ${badDir} · ID 不符 ${badId}/${idChecked} · 距离>4 ${badDist}  → ${errs ? '✗ 存在错误' : '✓ 全部正确'}`);
  console.log(`   最远配对距离: ${maxDist} 条报文`);
  console.log(`   继承配色: 沿用 Control(青) ${inhControl} 条 · 变成其他色 ${inhOther} 条`);
  for (const s of samples) console.log(`     ${s}`);
  return errs === 0 && paired.length > 0;
}

let files = process.argv.slice(2);
if (!files.length) {
  const names = (await readdir(PARENT)).filter((n) => n.toLowerCase().endsWith('.atkcc'));
  files = names.map((n) => join(PARENT, n));
}
files = files.filter((f) => existsSync(f));

console.log('═══ GOOD CRC 配对校验 ═══');
let allOk = true;
for (const f of files) {
  try { if (!(await check(f))) allOk = false; }
  catch (e) { allOk = false; console.log(`\n── ${basename(f)}\n   ✗ 失败: ${e.message}`); }
}
console.log(`\n结论: ${allOk ? '✓ 全部通过' : '✗ 存在失败项'}`);
process.exit(allOk ? 0 : 1);
