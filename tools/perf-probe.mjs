#!/usr/bin/env node
/**
 * perf-probe.mjs — 诊断「打开文件时界面卡住」到底卡在哪。
 *
 * 思路：光看「总耗时」分不出是读文件慢、解压慢、还是解码把主线程占住了。
 * 所以同时采三样东西：
 *   ① **主线程阻塞间隙** —— 页面里跑一条 setTimeout(0) 心跳，记下每次实际间隔。
 *      被卡住 800 ms 就会记录一条 ~800 ms 的间隙，直接印证「卡死」这个体感。
 *   ② **longtask** —— PerformanceObserver 的 longtask 条目（>50 ms 的任务）。
 *   ③ **CPU profile** —— CDP Profiler，按「自身耗时」聚合到函数级，
 *      这才是回答「卡在哪个函数」的最终依据。
 *
 * 用法：
 *   node tools/perf-probe.mjs --file dist/PDScope.html --drop "../apple_40w_avs_iphone_air.atkcc"
 *   node tools/perf-probe.mjs --file dist/PDScope.html --drop "../ufcs_vivo_x300u.sqlite"
 *   node tools/perf-probe.mjs --file dist/PDScope.html --drop "a.atkcc" --drop2 "b.sqlite"   # 多份
 */
import { spawn } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const FILE = arg('--file', 'dist/PDScope.html');
const DROP = arg('--drop', null);
const DROP2 = arg('--drop2', null);
const TARGET = pathToFileURL(resolve(ROOT, FILE)).href;

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);
const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) { console.error('找不到 Chrome/Edge'); process.exit(1); }

// 端口随进程变，避免上一次的 Chrome 没退干净时撞端口
const DEBUG_PORT = 9411 + (process.pid % 97);
const profileDir = join(tmpdir(), 'pdscope-perf-' + Date.now());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

const proc = spawn(browser, [
  // --headed 走真实窗口：canvas 合成、backdrop-filter 模糊、字体加载这些开销
  // 在无头模式下都会被跳过，而用户是双击 HTML 用有头浏览器打开的。
  ...(argv.includes('--headed') ? ['--window-position=0,0'] : ['--headless=new', '--disable-gpu']),
  '--no-first-run', '--no-default-browser-check',
  '--disable-extensions', '--hide-scrollbars', '--allow-file-access-from-files',
  '--window-size=1680,1000', `--user-data-dir=${profileDir}`,
  `--remote-debugging-port=${DEBUG_PORT}`, TARGET,
], { stdio: 'ignore' });
const cleanup = async () => {
  try { proc.kill('SIGKILL'); } catch {}
  await sleep(300);
  try { await rm(profileDir, { recursive: true, force: true }); } catch {}
};
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch {} });

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); }
  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id);
        m.error ? rej(new Error(m.error.message)) : res(m.result);
      }
    });
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); } }, 300000);
    });
  }
  async eval(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 出错');
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

async function findTarget() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
      const list = await r.json();
      const pg = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (pg) return pg;
    } catch {}
    await sleep(250);
  }
  throw new Error('调试端口未就绪');
}

/** 把文件读成 base64，在页面里拼成 File，一次 drop 全部 */
async function makeFilesExpr(relPaths) {
  const out = [];
  for (const rel of relPaths) {
    const abs = resolve(ROOT, rel);
    const buf = await readFile(abs);
    log(`  样本：${basename(abs)}  ${(buf.length / 1024).toFixed(1)} KB`);
    out.push(`(()=>{const b=atob('${buf.toString('base64')}');const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return new File([a],${JSON.stringify(basename(abs))});})()`);
  }
  return `[${out.join(',')}]`;
}

/** 按「自身耗时」聚合 CPU profile */
function aggregate(profile) {
  const byId = new Map();
  for (const n of profile.nodes) byId.set(n.id, n);
  const total = profile.endTime - profile.startTime;              // µs
  const selfById = new Map();
  const intervals = profile.timeDeltas || [];
  for (let i = 0; i < (profile.samples || []).length; i++) {
    const id = profile.samples[i];
    const dt = intervals[i] || 0;
    selfById.set(id, (selfById.get(id) || 0) + dt);
  }
  // 同名合并（同名函数可能来自不同 scriptId，这里合并看总账）
  const rows = new Map();
  for (const [id, us] of selfById) {
    const n = byId.get(id);
    if (!n) continue;
    const cf = n.callFrame || {};
    const key = `${cf.functionName || '(anonymous)'}`;
    const cur = rows.get(key) || { us: 0, url: cf.url || '', line: cf.lineNumber };
    cur.us += us;
    rows.set(key, cur);
  }
  const list = [...rows.entries()].map(([name, v]) => ({ name, ms: v.us / 1000, pct: (v.us / total) * 100, url: v.url, line: v.line }))
    .sort((a, b) => b.ms - a.ms);
  return { totalMs: total / 1000, list };
}

(async () => {
  log('');
  log('  PDScope 性能探针');
  log('  ─────────────────────────────────────────────');
  log(`  浏览器：${browser}`);
  log(`  目标：  ${TARGET}`);
  log('');

  const pg = await findTarget();
  const cdp = await new CDP(pg.webSocketDebuggerUrl).connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Profiler.enable');
  await sleep(1500);                                   // 等页面就绪

  const ready = await cdp.eval('!!(window.PDScope && window.PDScope.ready)');
  log(`  页面就绪：${ready}`);
  if (!ready) { log('  ✘ 页面没起来'); cdp.close(); await cleanup(); process.exit(1); }

  // ① 先装探针（必须早于 drop）
  await cdp.eval(`(()=>{
    window.__probe = { gaps: [], longtasks: [], marks: {} };
    let last = performance.now();
    window.__probeStop = false;
    (function tick(){
      if (window.__probeStop) return;
      const now = performance.now();
      const d = now - last;
      if (d > 60) window.__probe.gaps.push([Math.round(last), Math.round(d)]);
      last = now;
      setTimeout(tick, 0);
    })();
    try {
      new PerformanceObserver((l)=>{ for (const e of l.getEntries())
        window.__probe.longtasks.push([Math.round(e.startTime), Math.round(e.duration)]); })
        .observe({ entryTypes:['longtask'] });
    } catch(e) { window.__probe.longtaskUnsupported = String(e); }
    window.__probe.mark = (k) => { window.__probe.marks[k] = Math.round(performance.now()); };
    window.__probe.mark('start');
    return true;
  })()`);

  const rels = [DROP, DROP2].filter(Boolean);
  if (!rels.length) { log('  ✘ 需要 --drop'); cdp.close(); await cleanup(); process.exit(1); }
  const filesExpr = await makeFilesExpr(rels);

  await cdp.send('Profiler.setSamplingInterval', { interval: 400 });   // 0.4 ms
  await cdp.send('Profiler.start');

  const t0 = Date.now();
  // 注意：mark 必须紧贴 dispatchEvent —— 前面构造 File 的开销（把那串 base64 解成
  // Uint8Array）是**探针自己的**，跟应用无关，不能算进「打开耗时」里。
  await cdp.eval(`(()=>{ const files = ${filesExpr}; window.__probe.mark('drop');
    const dt=new DataTransfer();
    for (const f of files) dt.items.add(f);
    window.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
    return true; })()`);

  // 等所有标签都 done（或出错）
  let lastStat = '';
  for (let i = 0; i < 240; i++) {
    await sleep(250);
    const tabs = await cdp.eval('window.PDScope.tabs()');
    lastStat = await cdp.eval(`document.querySelector('#statLine').textContent || ''`);
    const done = tabs.length > 0 && tabs.every((t) => t.state === 'done' || t.state === 'error');
    if (done && tabs.some((t) => t.state === 'done')) break;
  }
  const wallMs = Date.now() - t0;
  await cdp.eval(`window.__probe.mark('end'); window.__probeStop = true; true`);

  const prof = await cdp.send('Profiler.stop');
  const probe = await cdp.eval(`JSON.stringify({ marks: window.__probe.marks, gaps: window.__probe.gaps,
    longtasks: window.__probe.longtasks, ltUnsupported: window.__probe.longtaskUnsupported || null })`);
  const appInfo = await cdp.eval(`JSON.stringify({ stat: document.querySelector('#statLine').textContent.trim(),
    tabs: window.PDScope.tabs().map(t=>({n:t.name,st:t.state,ms:t.decodedMs||null})) })`);

  const p = JSON.parse(probe);
  const a = JSON.parse(appInfo);
  log('');
  log('  ── 结果 ──────────────────────────────────────');
  log(`  从 drop 到全部标签就绪：${wallMs} ms`);
  log(`  应用自报统计行：${a.stat}`);
  log(`  标签：${JSON.stringify(a.tabs)}`);
  log(`  drop→end（页面内时钟）：${p.marks.end - p.marks.drop} ms`);

  const gaps = p.gaps.filter(([, d]) => d > 60).sort((x, y) => y[1] - x[1]);
  const maxBlock = gaps.length ? gaps[0][1] : 0;
  log('');
  log(`  ① 主线程阻塞间隙 > 60 ms 共 ${gaps.length} 处（最长 ${maxBlock} ms）；最长的 8 处（相对 drop 的 ms / 持续 ms）：`);
  const dropT = p.marks.drop;
  if (!gaps.length) log('     （无 —— 主线程没有被长时间占住）');
  for (const [at, d] of gaps.slice(0, 8)) log(`     +${Math.round(at - dropT)} ms  阻塞 ${d} ms`);

  log('');
  log(`  ② longtask（>50 ms 的任务）共 ${p.longtasks.length} 处${p.ltUnsupported ? `［不支持：${p.ltUnsupported}］` : ''}；最长的 8 处：`);
  if (!p.longtasks.length) log('     （无）');
  for (const [at, d] of [...p.longtasks].sort((x, y) => y[1] - x[1]).slice(0, 8)) log(`     +${Math.round(at - dropT)} ms  时长 ${d} ms`);

  const agg = aggregate(prof.profile);
  log('');
  log(`  ③ CPU profile（采样区间 ${agg.totalMs.toFixed(0)} ms），按自身耗时前 20 名：`);
  log(`     自身耗时    占比   函数`);
  for (const r of agg.list.slice(0, 20)) {
    log(`     ${r.ms.toFixed(1).padStart(8)} ms  ${r.pct.toFixed(1).padStart(5)}%   ${r.name}`);
  }

  cdp.close();
  await cleanup();
  log('');
  log(`  【单行汇总】wall=${wallMs}ms  page=${p.marks.end - p.marks.drop}ms  maxBlock=${maxBlock}ms  gaps=${gaps.length}  longtask=${p.longtasks.length}`);
  log('');
})()
  .then(() => process.exit(0))
  .catch(async (e) => { console.error('探针失败：', e.message); await cleanup(); process.exit(1); });
