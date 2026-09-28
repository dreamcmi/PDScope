/**
 * pd-regress.mjs — 重构前后 PD 解码器逐包对比（回归检查）
 *
 * 同一份抓包分别喂给「重构前的解码器（从 git HEAD 取 core/pd.js）」与「新 src/js/pd/」，
 * 比对每条报文的 sop / msgType / header / crcOk / nObjects / dataWords，
 * 任何差异都打印出来，确保新库没有丢功能。
 *
 * 预期差异只有一类：扩展消息的 dataWords（旧版不填这一栏，新版补全了 hex 回填）。
 * 其余任何差异都值得追。
 *
 * 用法：node tools/pd-regress.mjs [文件名子串]
 * 样本目录默认取仓库上一级，可用环境变量 PD_SAMPLES 覆盖。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AtkccCapture } from '../src/js/core/atkcc.js';
import { makeNodeInflator } from '../src/js/core/inflate.js';
import { EdgeExtractor, BmcDecoder } from '../src/js/core/bmc.js';
import { PdDecoder as NewDecoder } from '../src/js/pd/index.js';

/* 旧解码器（重构前那一版）从 git HEAD 取出来，放到被 gitignore 的 _explore/old/ 下，
   这样本脚本在任何 checkout 里都能复跑，不依赖工作区是否留着旧代码。 */
const OLD_DIR = new URL('./_explore/old/', import.meta.url);
if (!existsSync(new URL('pd.js', OLD_DIR))) {
  await mkdir(OLD_DIR, { recursive: true });
  for (const f of ['src/js/core/pd.js', 'src/js/core/pd_tables.js']) {
    const rel = f.split('/').pop();
    try {
      const src = execFileSync('git', ['show', `HEAD:${f}`], { cwd: new URL('..', import.meta.url), encoding: 'utf8' });
      await writeFile(new URL(rel, OLD_DIR), src);
    } catch (e) {
      console.error(`无法从 git HEAD 取出 ${f}（${e.message}）；请先 git add/commit 旧版本再跑。`);
      process.exit(1);
    }
  }
}
const { PdDecoder: OldDecoder } = await import(new URL('pd.js', OLD_DIR).href);

const inflate = await makeNodeInflator();
/** 抓包样本目录：默认 <仓库>/.. ，可用 PD_SAMPLES 覆盖 */
const D = process.env.PD_SAMPLES ?? fileURLToPath(new URL('../../', import.meta.url));
const all = [
  '苹果40w-ip18pro', '安可60w-ip18pro', '酷泰科6u-ip18pro', '绿联70w-ip18pro',
  '制糖40w-ip18pro', 'apple_40w_avs_iphone_air', '酷泰科10u线-ip18pro',
];
const filter = process.argv[2];
const files = filter ? all.filter((f) => f.includes(filter)) : all;

/** 用同一套 BMC 解出的 raw 包分别喂给新旧解码器 */
async function decodeBoth(cap) {
  const ch = cap.meta.channelMap.get(0);
  const rate = cap.meta.sampleRate;
  const oldPd = new OldDecoder({ sampleRate: rate });
  const newPd = new NewDecoder({ sampleRate: rate });

  const raws = [];
  const bmc = new BmcDecoder({ sampleRate: rate });
  const ex = new EdgeExtractor({ bitOrder: 'lsb' });
  for (let i = 0; i < ch.chunks.length; i++) {
    const data = await cap.readChunk(0, i, inflate);
    if (!data) continue;
    ex.push(data, 0, (edge) => { const p = bmc.pushEdge(edge); if (p) raws.push(p); });
  }
  ex.flush((edge) => { const p = bmc.pushEdge(edge, true); if (p) raws.push(p); }, bmc.maxbit + 1);

  const out = { old: [], new: [], errors: [] };
  for (const r of raws) {
    let o = null, n = null;
    try { o = oldPd.decode(r, 0); } catch (e) { out.errors.push('旧解码器异常: ' + e.message); }
    try { n = newPd.decode(r, 0); } catch (e) { out.errors.push('新解码器异常: ' + e.message); }
    if (o) out.old.push(o);
    if (n) out.new.push(n);
  }
  return out;
}

let totalDiff = 0, totalPkt = 0;
/**
 * 已知的「消息类型重命名」——统一命名口径时把 1…8 号控制消息从
 * sigrok / ATK-C 的「空格 + 全大写」改成规范写法，共 8 条。
 * 新旧解码器只在名字上不同、字段与语义完全一致，
 * 比对前先归一化，免得把**有意的改名**报成解析回归。
 */
const TYPE_RENAME = {
  'GOOD CRC': 'GoodCRC', 'GOTO MIN': 'GotoMin', 'ACCEPT': 'Accept', 'REJECT': 'Reject',
  'PING': 'Ping', 'PS RDY': 'PS_RDY', 'GET SOURCE CAP': 'Get_Source_Cap', 'GET SINK CAP': 'Get_Sink_Cap',
};

for (const f of files) {
  let cap;
  try { cap = await AtkccCapture.open(new Uint8Array(await readFile(D + f + '.atkcc')), { inflate }); }
  catch (e) { console.log(f, '打开失败', e.message); continue; }

  const { old, new: neu, errors } = await decodeBoth(cap);
  totalPkt += neu.length;
  const diffs = [];
  const n = Math.max(old.length, neu.length);
  for (let i = 0; i < n; i++) {
    const o = old[i], p = neu[i];
    if (!o || !p) { diffs.push(`#${i} 只在一侧：old=${o ? o.msgType : '-'} new=${p ? p.msgType : '-'}`); continue; }
    const f2 = [];
    if (o.sop !== p.sop) f2.push(`sop ${o.sop} → ${p.sop}`);
    if ((TYPE_RENAME[o.msgType] ?? o.msgType) !== p.msgType) f2.push(`type ${o.msgType} → ${p.msgType}`);
    if (o.header !== p.header) f2.push(`header 0x${o.header?.toString(16)} → 0x${p.header?.toString(16)}`);
    if (o.crcOk !== p.crcOk) f2.push(`crcOk ${o.crcOk} → ${p.crcOk}`);
    if (o.nObjects !== p.nObjects) f2.push(`n ${o.nObjects} → ${p.nObjects}`);
    if (JSON.stringify(o.dataWords) !== JSON.stringify(p.dataWords)) {
      const ext = p.msgKind === 'ext' && o.msgKind === 'ext';
      f2.push(ext ? 'dataWords 不同（扩展消息：新库补全了 hex 回填，预期差异）' : 'dataWords 不同');
    }
    if (f2.length) diffs.push(`#${i} ${f2.join(' ; ')}`);
  }
  totalDiff += diffs.length;
  console.log(`## ${f}  旧 ${old.length} 条 / 新 ${neu.length} 条  差异 ${diffs.length}`);
  diffs.slice(0, 12).forEach((d) => console.log('    ' + d));
  if (diffs.length > 12) console.log(`    …共 ${diffs.length} 处`);
  if (errors.length) [...new Set(errors)].slice(0, 5).forEach((e) => console.log('    ⚠ ' + e));
}
console.log(`\n合计：新解 ${totalPkt} 条，与新旧的字段级差异 ${totalDiff} 处`);
