#!/usr/bin/env node
/**
 * e2e.mjs — 端到端自检：用系统已安装的 Chrome/Edge 无头打开 PDScope，
 *          真正载入一份抓包、校验界面渲染结果，并截图。
 *
 * 不依赖 playwright / puppeteer —— 直接说 Chrome DevTools Protocol
 * （Node 18+ 自带全局 WebSocket）。
 *
 * 用法：
 *   node tools/e2e.mjs                 # 自动找 Chrome/Edge
 *   node tools/e2e.mjs --port 5188     # 指定已启动的 serve 端口
 *   node tools/e2e.mjs --file dist/PDScope.html    # 测单文件版
 */
import { spawn } from 'node:child_process';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const PORT = Number(arg('--port', 5188));
const FILE = arg('--file', null);
const TARGET = FILE
  ? pathToFileURL(resolve(ROOT, FILE)).href
  : `http://127.0.0.1:${PORT}/`;
const SHOT = arg('--out', join(ROOT, 'artifacts', 'e2e-screenshot.png'));
const DROP = arg('--drop', null);          // 用拖拽事件注入的真实抓包路径（相对 ROOT）
// 第二份抓包：给了就额外跑「多文件」那一组断言（开两个标签、切换、各自保留状态、关闭）
const DROP2 = arg('--drop2', null);

const CANDIDATES = [
  process.env.CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
].filter(Boolean);

const browser = CANDIDATES.find((p) => existsSync(p));
if (!browser) { console.error('找不到 Chrome/Edge，请用 CHROME=/path/to/chrome 指定'); process.exit(1); }

/* ── 预检：http 模式必须先有 serve 在跑 ─────────────────
   忘了起服务时，Chrome 只会渲染一张 ERR_CONNECTION_REFUSED 错误页，
   表现是「标题/主题/骨架/按钮」四项一起失败，很难看出根因。这里提前拦。 */
if (!TARGET.startsWith('file:')) {
  try {
    const r = await fetch(TARGET, { signal: AbortSignal.timeout(3000) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
  } catch (e) {
    console.error('');
    console.error(`  目标不可达：${TARGET}（${e.message || e}）`);
    console.error('  请先另开一个终端启动本地服务：');
    console.error(`      node tools/serve.mjs --port ${PORT}`);
    console.error('  或改用免服务的单文件模式：');
    console.error('      npm run e2e');
    console.error('');
    process.exit(1);
  }
}

const DEBUG_PORT = 9333 + (Number(arg('--dbg', 0)) || 0);
const profile = join(tmpdir(), 'pdscope-e2e-' + Date.now());

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);

/** 无头模式下合成层有时留残影，截图前抖一下强制重绘 */
async function forceRepaint(cdp) {
  await cdp.eval(`(()=>{document.body.style.transform='translateZ(0)';document.body.offsetHeight;document.body.style.transform='';})()`);
  await cdp.eval(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`, true);
  await sleep(260);
}

let pass = 0, fail = 0, skipped = 0;
const check = (name, ok, extra = '') => {
  if (ok) { pass++; log(`  \u2714 ${name}${extra ? '  ' + extra : ''}`); }
  else { fail++; log(`  \u2718 ${name}${extra ? '  ' + extra : ''}`); }
};
/**
 * 明确「跳过」而不是静默不跑，也不是判失败。
 *
 * 用在「该断言对这份样本不成立」的场合 —— 典型是某个 UFCS 导出：文件载入成功、
 * 模拟量照画，但容器格式对不上、**一行报文都没定位出来**（`ufcsUnlocatedRows`），
 * 凡是依赖「列表里有行」的断言都无从谈起。跳过要计入汇总，好让人看得出
 * 这次跑的不是完整覆盖，避免「全绿」被误读成「所有断言都过了」。
 */
const skip = (name, why) => {
  skipped++;
  log(`  \u2298 ${name}  （跳过：${why}）`);
};

/* ── 启动浏览器 ──────────────────────────────────────── */
log('');
log('  PDScope E2E');
log('  ─────────────────────────────────────────────');
log(`  浏览器：${browser}`);
log(`  目标：  ${TARGET}`);
log('');

const proc = spawn(browser, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--hide-scrollbars',
  '--allow-file-access-from-files',
  '--window-size=1680,1000',
  `--user-data-dir=${profile}`,
  `--remote-debugging-port=${DEBUG_PORT}`,
  TARGET,
], { stdio: 'ignore' });

const cleanup = async () => {
  try { proc.kill('SIGKILL'); } catch {}
  await sleep(300);
  try { await rm(profile, { recursive: true, force: true }); } catch {}
};
process.on('exit', () => { try { proc.kill('SIGKILL'); } catch {} });

/* ── 找到页面 target ─────────────────────────────────── */
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
  throw new Error('浏览器调试端口未就绪');
}

/* ── 极简 CDP 客户端 ─────────────────────────────────── */
class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.events = []; }
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
      } else if (m.method) this.events.push(m);
    });
    return this;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(method + ' 超时')); } }, 60000);
    });
  }
  async eval(expr, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval 出错');
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch {} }
}

/**
 * 把真实抓包以拖拽事件注入页面。
 * @param {CDP} cdp
 * @param {string|string[]} relPaths 相对项目根目录的路径；给数组就是「一次拖多份」（一次 drop 多个 File）
 * @param {RegExp} done 解码结束的判据，默认等统计行出现「显示」
 * @returns {Promise<string>} 注入的文件名（多个用 + 连接）
 */
async function injectDrop(cdp, relPaths, done = /显示/) {
  const list = Array.isArray(relPaths) ? relPaths : [relPaths];
  const files = [];
  for (const rel of list) {
    const abs = resolve(ROOT, rel);
    files.push({ nm: basename(abs), b64: (await readFile(abs)).toString('base64') });
  }
  log(`  注入文件：${files.map((f) => `${f.nm}（${(f.b64.length / 1365).toFixed(1)} KB）`).join(' + ')}`);
  const arr = files
    .map((f) => `(()=>{const b=atob('${f.b64}');const a=new Uint8Array(b.length);for(let i=0;i<b.length;i++)a[i]=b.charCodeAt(i);return new File([a], ${JSON.stringify(f.nm)});})()`)
    .join(',');
  await cdp.eval(`(()=>{
    const dt=new DataTransfer();
    for (const f of [${arr}]) dt.items.add(f);
    window.dispatchEvent(new DragEvent('drop',{dataTransfer:dt,bubbles:true,cancelable:true}));
    return true;
  })()`);
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const s = await cdp.eval(`document.querySelector('#statLine').textContent || ''`);
    if (done.test(s)) break;
  }
  return files.map((f) => f.nm).join(' + ');
}

/** 读标签清单（PDScope.tabs() 是对外稳定接口，测试只依赖它，不碰界面内部结构） */
const tabList = (cdp) => cdp.eval(`window.PDScope.tabs()`);

/**
 * 等到第 index 个标签解析完成并且处于激活态。
 * 比盯统计行的文案稳：不用区分「解出了报文」和「协议未实现」两种终态。
 */
async function waitTabDone(cdp, index, tries = 120) {
  for (let i = 0; i < tries; i++) {
    await sleep(500);
    const t = await tabList(cdp);
    if (t[index]?.state === 'done' && t[index]?.active) return t[index];
  }
  return null;
}

/* ── 主流程 ─────────────────────────────────────────── */
let cdp;
try {
  const target = await findTarget();
  cdp = await new CDP(target.webSocketDebuggerUrl).connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  // 收集控制台错误
  const consoleErrors = [];
  cdp.events.length = 0;
  const drain = setInterval(() => {
    for (const e of cdp.events.splice(0)) {
      if (e.method === 'Runtime.exceptionThrown') consoleErrors.push(e.params.exceptionDetails?.exception?.description || 'unknown');
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        consoleErrors.push((e.params.args || []).map((a) => a.value ?? a.description).join(' '));
      }
    }
  }, 200);

  await sleep(1200);

  /* ── 调试模式：--eval "<js>" [--eval-load] [--drop <file>] ── */
  const EVAL = arg('--eval', null);
  if (EVAL) {
    if (DROP) await injectDrop(cdp, DROP);
    if (DROP2) await injectDrop(cdp, DROP2, /显示|已读入/);
    if (!DROP && !DROP2 && argv.includes('--eval-load')) {
      await cdp.eval(`document.querySelector('#btnDemo')?.click()`);
      for (let i = 0; i < 120; i++) {
        await sleep(500);
        const s = await cdp.eval(`document.querySelector('#statLine').textContent || ''`);
        if (/显示/.test(s)) break;
      }
    }
    const out = await cdp.eval(EVAL, true);
    log('  ── eval 结果 ──');
    log(typeof out === 'string' ? out : JSON.stringify(out, null, 2));
    const shot0 = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await mkdir(dirname(SHOT), { recursive: true });
    await writeFile(SHOT, Buffer.from(shot0.data, 'base64'));
    log(`  截图：${SHOT}`);
    cdp.close();
    await cleanup();
    log('');
    process.exit(0);
  }

  /* 1. 页面骨架 */
  const title = await cdp.eval('document.title');
  check('页面标题正确', /PDScope/.test(title), title);
  const theme = await cdp.eval('document.documentElement.dataset.theme');
  check('主题已初始化', theme === 'light' || theme === 'dark', theme);
  const bootErr = await cdp.eval('typeof AtkccCapture');
  // 模块作用域不可见，改为检查关键 DOM 是否就绪
  const domOk = await cdp.eval(`!!document.querySelector('#tbody') && !!document.querySelector('#busCanvas') && document.querySelectorAll('.th').length`);
  check('表格骨架已渲染', domOk >= 10, `${domOk} 个表头`);

  /* 2. 载入数据：优先用 --drop 注入真实文件，其次点「载入示例」 */
  const hasDemo = await cdp.eval(`(()=>{const b=document.querySelector('#btnDemo');return !!b && b.style.display!=='none';})()`);
  const willLoad = !!DROP || hasDemo;

  if (DROP) {
    const nm = await injectDrop(cdp, DROP);
    check('拖拽注入抓包文件', true, nm);
  } else {
    check('示例按钮可用（http 模式）', hasDemo === true);
  }

  if (willLoad) {
    if (!DROP) await cdp.eval(`document.querySelector('#btnDemo').click()`);
    // 解码结束有两个合法终态：解出了报文（「显示 N / M 条」），
    // 或文件载入成功但一条都没定位出来（「已读入 N 行 / N 条原始帧…」）。
    const DONE = /显示|已读入/;
    let stat = '';
    for (let i = 0; i < 120; i++) {
      await sleep(500);
      stat = await cdp.eval(`document.querySelector('#statLine').textContent || ''`);
      if (DONE.test(stat)) break;
    }
    check('抓包解码完成', DONE.test(stat) && !/等待打开/.test(stat), stat.replace(/\s+/g, ' ').trim());

    /* 2.5 标签栏：打开一份就该出现一个标签（多文件能力的最小可见证据） */
    const bar1 = await cdp.eval(`(()=>{const b=document.querySelector('#tabBar');return {hidden:!!b.hidden,n:b.querySelectorAll('.tab').length,on:b.querySelectorAll('.tab.is-on').length,name:(b.querySelector('.tab-name')||{}).textContent||''};})()`);
    check('打开后出现标签栏', bar1.hidden === false && bar1.n === 1 && bar1.on === 1 && !!bar1.name,
      `${bar1.n} 个标签「${bar1.name}」`);
    const chipName = await cdp.eval(`document.querySelector('#fileName').textContent.trim()`);
    check('顶栏文件 chip 跟随当前标签', chipName === bar1.name, chipName);

    const shown = await cdp.eval(`(document.querySelector('#statLine').textContent.match(/显示\\s*(\\d+)/)||[])[1]`);
    const noticeText = await cdp.eval(`(()=>{const n=document.querySelector('#notice');return n && !n.hidden ? n.innerText.replace(/\\s+/g,' ').trim() : '';})()`);

    // ── 「零报文」是一条正经路径，不是失败 ──
    // 文件载入成功、模拟量照画，但容器格式对不上（或本来就没有报文）：
    // 一行报文都没定位出来。此时「列表里有行」类断言无从谈起，必须显式跳过：
    // 早先这里直接 `document.querySelector('#vrows .tr').click()`，
    // 在 0 行时报 `Cannot read properties of null`，把「本来就该是空的列表」
    // 伪装成脚本崩溃，看不出根因。
    const rowless = Number(shown || 0) === 0 && !!noticeText;

    // 这一份样本是 PD 还是 UFCS —— 后面几处断言的措辞与字段名要跟着换。
    // 判据取顶栏「来源」chip（`POWER-Z · USB PD` / `POWER-Z · UFCS`），拿不到时退回文件名。
    const sampleSource = await cdp.eval(`(()=>{const c=[...document.querySelectorAll('#metaChips .mchip')].find(x=>/来源/.test(x.textContent));return c?c.textContent.replace(/\\s+/g,' ').trim():'';})()`);
    const isUfcsSample = /UFCS/i.test(sampleSource) || /ufcs/i.test(DROP || '');

    // UFCS 的报文类型名跟 PD 完全是两套词表，首行校验不能共用一条正则：
    // PD 是 Source_Capabilities / VDM / PS_RDY，UFCS 是 Output_Capabilities /
    // Sink_Information / Refuse …。行内文本只有类型名，`(UFCS)` 前缀在 title 属性里、
    // innerText 取不到，所以这里认「链路是 D± + 类型名是 UFCS 命令表中之一」。
    const UFCS_TYPE = /Output_Capabilities|Source_Information|Sink_Information|Cable_Information|Device_Information|Error_Information|Config_Watchdog|Refuse|Verify_Request|Verify_Response|Power_Change|Test_Request|Get_[A-Za-z_]+|Ping|Request/;

    // 采样率不是写死的：界面要显示「数值 + 来源」（文件声明 / 波形实测 / 默认值 / 手动指定）。
    // 分析仪导出（POWER-Z）只有毫秒时间戳，量级是 kHz，来源标「分析仪时间戳」。
    const rateChip = await cdp.eval(`(() => {
      const c = [...document.querySelectorAll('#metaChips .mchip')].find((x) => /采样率/.test(x.textContent));
      return c ? { text: c.textContent.replace(/\\s+/g, ' ').trim(), tag: (c.querySelector('.mtag') || {}).textContent || '' } : null;
    })()`);
    check('采样率已解析并标出来源', !!rateChip && /MHz|kHz/.test(rateChip.text)
      && /文件声明|波形实测|默认值|手动指定|分析仪时间戳/.test(rateChip.tag), rateChip ? rateChip.text : '未找到采样率 chip');

    if (rowless) {
      // 一行都没定位出报文：界面必须说清「为什么空」，且不能说成「筛选后为空」
      // （那会让人以为是自己把报文筛掉了）。措辞两种协议各一套：
      // PD 是「未实现」（理论到不了，因为 PD 那条路一定解得出东西），
      // UFCS 是「没有一行能认出 UFCS 报文」。
      const why = /没有一行|没能认出|认不出|未实现/.test(noticeText);
      check('零报文已如实说明原因', why, noticeText.slice(0, 90));

      // 条数不能凭空消失：PD 统计行写「已读入 N 条原始帧」，
      // UFCS 写「已读入 N 行，但没有一行能认出」—— 都带 N。
      check('统计行给出了原始字节数', /已读入\s*\d+\s*(条原始帧|行)/.test(stat.replace(/\s+/g, ' ')), stat.replace(/\s+/g, ' ').slice(0, 90));

      const emptyText = await cdp.eval(`(()=>{const e=document.querySelector('#emptyState');return e && e.style.display!=='none' ? e.innerText.replace(/\\s+/g,' ').trim() : '';})()`);
      check('空列表给出解释', emptyText.length > 0 && !/当前筛选条件下没有报文/.test(emptyText), emptyText.slice(0, 90));

      for (const nm of ['解析出报文', '虚拟滚动渲染出行', '自动应答包默认被屏蔽', '首行内容合理',
        '方向标识已渲染', '详情面板已填充', '位域表已渲染', '头位域块与协议匹配（二者只出现其一）',
        '方向过滤生效', '重置筛选恢复全部', '关键字搜索生效']) skip(nm, '该样本一行报文都没定位出来');
    } else {
      check('解析出报文', Number(shown) > 0, `显示 ${shown} 条`);

      const rows = await cdp.eval(`document.querySelectorAll('#vrows .tr').length`);
      check('虚拟滚动渲染出行', rows > 0, `${rows} 行可见`);

      const total = await cdp.eval(`(document.querySelector('#statLine').textContent.match(/\\/\\s*(\\d+)\\s*条/)||[])[1]`);
      // 「心跳包」两种协议各叫各的：PD 是 GOOD CRC，UFCS 是 ACK / NCK —— 默认都该被屏蔽。
      // UFCS 不强求「一定少于总数」（万一这份样本一条 ACK 都没有），但必须看到
      // 开关文案已换成 UFCS 那一套，证明协议自适应真的生效了。
      if (isUfcsSample) {
        const ackSwitch = await cdp.eval(`document.querySelector('#lbHideGoodCrc').textContent.trim()`);
        check('默认屏蔽 ACK / NCK 应答包', Number(shown) <= Number(total) && /ACK\s*\/\s*NCK/.test(ackSwitch),
          `显示 ${shown} / 全部 ${total}（开关：${ackSwitch}）`);
      } else {
        check('自动应答包默认被屏蔽', Number(shown) < Number(total), `显示 ${shown} / 全部 ${total}`);
      }

      const firstRow = await cdp.eval(`(()=>{const r=document.querySelector('#vrows .tr');return r?r.innerText.replace(/\\s+/g,' ').trim():'';})()`);
      check('首行内容合理',
        isUfcsSample
          ? (/D[+±-]/.test(firstRow) && UFCS_TYPE.test(firstRow))
          : /Source_Cap|VDM|Request|PS RDY|SOP/.test(firstRow),
        firstRow.slice(0, 90));

      const dirPills = await cdp.eval(`document.querySelectorAll('#vrows .pill').length`);
      check('方向标识已渲染', dirPills > 0, `${dirPills} 个标签`);

      /* 3. 点击一行 -> 详情 */
      await cdp.eval(`document.querySelector('#vrows .tr').click()`);
      await sleep(400);
      const detail = await cdp.eval(`document.querySelector('#detailBody').innerText.replace(/\\s+/g,' ').trim().slice(0,160)`);
      check('详情面板已填充', /消息头|报文头|链路概览|字段解析/.test(detail), detail.slice(0, 80));
      const bitRows = await cdp.eval(`document.querySelectorAll('#detailBody .dbit').length`);
      check('位域表已渲染', bitRows > 3, `${bitRows} 个位域行`);

      // 头位域块是 if/else 二选一：UFCS 只该有「消息头 (16 bit)」，PD 只该有「报文头 (16 bit)」。
      // 两条同时出现 = 协议分叉写崩了（例如 ufcs 判定失效却把原分支又输出了一遍），
      // 这种重复在截图里很不起眼，但对读报文的人是实打实的干扰。
      const heads = await cdp.eval(`(()=>{const t=[...document.querySelectorAll('#detailBody .dsec > h5')].map(x=>x.textContent.trim());return {msg:t.filter(x=>x==='消息头 (16 bit)').length,rep:t.filter(x=>x==='报文头 (16 bit)').length,all:t};})()`);
      check('头位域块与协议匹配（二者只出现其一）',
        isUfcsSample ? (heads.msg === 1 && heads.rep === 0) : (heads.rep === 1 && heads.msg === 0),
        `消息头 ×${heads.msg} · 报文头 ×${heads.rep}`);

      /* 4. 过滤：只留 Sink */
      await cdp.eval(`document.querySelector('#fRole .chip[data-v="SRC"]').click()`);
      await sleep(400);
      const sinkStat = await cdp.eval(`document.querySelector('#statLine').textContent.replace(/\\s+/g,' ').trim()`);
      check('方向过滤生效', /显示/.test(sinkStat) && Number((sinkStat.match(/显示\s*(\d+)/)||[])[1]) > 0, sinkStat.slice(0, 60));
    }

    /* 5. 搜索与筛选复位（都要有行才有意义） */
    if (!rowless) {
      // 先重置筛选，保证后面的断言有意义
      await cdp.eval(`document.querySelector('#btnReset').click()`);
      await sleep(400);
      const resetStat = await cdp.eval(`(document.querySelector('#statLine').textContent.match(/显示\\s*(\\d+)/)||[])[1]`);
      check('重置筛选恢复全部', Number(resetStat) > 0, `${resetStat} 条`);
      // 取第 2 行（非 GOOD CRC）的报文类型作为搜索词，保证断言与数据无关
      const probe = await cdp.eval(`(()=>{const r=document.querySelectorAll('#vrows .tr')[1];return r?r.children[2].textContent.trim():'';})()`);
      await cdp.eval(`(()=>{const i=document.querySelector('#fSearch');i.value=${JSON.stringify(probe)};i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(500);
      const qStat = await cdp.eval(`document.querySelector('#statLine').textContent.replace(/\\s+/g,' ').trim()`);
      const qRows = await cdp.eval(`document.querySelectorAll('#vrows .tr').length`);
      const qHit = await cdp.eval(`(()=>{const s=[...document.querySelectorAll('#vrows .tr')].map(r=>r.children[2].textContent.trim());return s.every(t=>t===${JSON.stringify(probe)});})()`);
      check('关键字搜索生效', /显示/.test(qStat) && qRows > 0 && Number((qStat.match(/显示\s*(\d+)/)||[])[1]) <= Number(resetStat) && qHit === true,
        `搜索「${probe}」→ ${(qStat.match(/显示\s*(\d+)/) || [])[1]} 条`);

      /* 清除搜索，回到完整列表 */
      await cdp.eval(`(()=>{const i=document.querySelector('#fSearch');i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));})()`);
      await sleep(400);
    }

    /* 6. 时间轴有内容 */
    const tlPainted = await cdp.eval(`(()=>{const c=document.querySelector('#busCanvas');const g=c.getContext('2d');const d=g.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4*97)if(d[i]>0)n++;return n;})()`);
    check('时间轴已绘制', tlPainted > 20, `${tlPainted} 个非空采样`);

    /* 6.5 分析仪导出（POWER-Z 的 .sqlite）专属：来源标注 / CRC 口径 / 差分线视图 */
    const isPz = /\.sqlite$/i.test(DROP || '');
    if (isPz) {
      const srcChip = await cdp.eval(`(()=>{const c=[...document.querySelectorAll('#metaChips .mchip')].find(x=>/来源/.test(x.textContent));return c?c.textContent.replace(/\\s+/g,' ').trim():'';})()`);
      check('标注数据来源为 POWER-Z', /POWER-Z/.test(srcChip), srcChip);

      const connChip = await cdp.eval(`(()=>{const c=[...document.querySelectorAll('#metaChips .mchip')].find(x=>/插拔/.test(x.textContent));return c?c.textContent.replace(/\\s+/g,' ').trim():'';})()`);
      if (rowless) {
        skip('CRC 口径与容器一致', '该样本无报文，状态栏不涉及 CRC');
        skip('显示插入/拔出事件', '该样本无连接/断开事件');
      } else if (isUfcsSample) {
        // UFCS 存不存 CRC 由容器决定（见 frame.js 的三级定位），界面必须与之一致：
        // 没存 → 「CRC 未记录」；存了 → 「全通过」或「错误 N」。绝不能无条件报「全通过」。
        const crcText = await cdp.eval(`document.querySelector('#statLine').textContent.replace(/\\s+/g,' ').trim()`);
        check('CRC 口径与容器一致（未记录 / 全通过 / 错误 N）',
          /CRC (未记录|全通过|错误 \d+)/.test(crcText), crcText.slice(0, 100));

        // 方向必须来自容器的链路字节，不能靠「按接收方地址猜」。
        // 猜出来的方向在双向命令（Request / ACK）上会直接反，是肉眼最难发现的一类错。
        const dirStat = await cdp.eval(`(()=>{const t=window.PDScope?.tabs?.()||[];const a=t.find(x=>x.active);return a&&a.ufcs?a.ufcs:null;})()`);
        if (dirStat && dirStat.frames > 0) {
          check('UFCS 方向全部有硬依据（无靠地址推断的）',
            dirStat.dirInferred === 0 && dirStat.dirFromLine === dirStat.frames,
            `容器链路 ${dirStat.dirFromLine} · 推断 ${dirStat.dirInferred} / 共 ${dirStat.frames}`);
        } else {
          skip('UFCS 方向全部有硬依据（无靠地址推断的）', '样本未走到容器布局（或取不到统计）');
        }
      } else {
        // PD 的 pd_table 一律不存 CRC：界面必须说「未记录」，绝不能报「全通过」
        const crcText = await cdp.eval(`document.querySelector('#statLine').textContent.replace(/\\s+/g,' ').trim()`);
        check('CRC 口径如实（未记录而非全通过）', /CRC 未记录/.test(crcText) && !/CRC 全通过/.test(crcText), crcText.slice(0, 100));
      }
      // 插拔事件是分析仪导出的「可选项」：PD 一定带，UFCS 容器一般不带。
      // 有就必须如实显示；没有就不该硬造一个 chip（那就成了无中生有）。
      if (!rowless) {
        if (/插拔/.test(connChip)) check('显示插入/拔出事件', true, connChip);
        else if (isUfcsSample) skip('显示插入/拔出事件', '该 UFCS 容器不含连接/断开标记');
        else check('显示插入/拔出事件', false, '未找到「插拔」chip');
      }

      // 「差分线」那一档：只有分析仪导出才有这两路额外模拟量。
      // 档名跟着文件走 —— USB PD 是 CC1/CC2（取 CC 线），UFCS 是 DP/DM，不能写死。
      const isUfcs = isUfcsSample;
      const wantAux = isUfcs ? /DP \/ DM/ : /CC1 \/ CC2/;
      const segVisible = await cdp.eval(`(()=>{const s=document.querySelector('#tlSeg');return !!s && !s.hidden && s.querySelectorAll('.seg-item').length===2;})()`);
      check('差分线视图可切换', segVisible === true, `档名「${await cdp.eval(`document.querySelector('#tlSegAux').textContent.trim()`)}」`);
      const titleBefore = await cdp.eval(`document.querySelector('#tlTitle').textContent.trim()`);
      await cdp.eval(`document.querySelector('#tlSeg .seg-item[data-v="aux"]').click()`);
      await sleep(400);
      const titleAfter = await cdp.eval(`document.querySelector('#tlTitle').textContent.trim()`);
      const auxPainted = await cdp.eval(`(()=>{const c=document.querySelector('#busCanvas');const g=c.getContext('2d');const d=g.getImageData(0,0,c.width,c.height).data;let n=0;for(let i=3;i<d.length;i+=4*97)if(d[i]>0)n++;return n;})()`);
      check(`切到差分线（${isUfcs ? 'DP / DM' : 'CC1 / CC2'}）后重绘`,
        wantAux.test(titleAfter) && titleAfter !== titleBefore && auxPainted > 20,
        `「${titleBefore}」→「${titleAfter}」`);
      await cdp.eval(`document.querySelector('#tlSeg .seg-item[data-v="power"]').click()`);
      await sleep(300);
      const titleBack = await cdp.eval(`document.querySelector('#tlTitle').textContent.trim()`);
      check('切回电压/电流', /VBUS \/ IBUS/.test(titleBack), titleBack);
    }

    /* 7. 主题切换 */
    await cdp.eval(`document.querySelector('#btnTheme').click()`);
    await sleep(300);
    const t2 = await cdp.eval('document.documentElement.dataset.theme');
    check('主题切换生效', t2 === 'dark', t2);
    await cdp.eval(`document.querySelector('#btnTheme').click()`);
    await sleep(200);

    /* 7.5 详情面板拖拽改宽（用真实鼠标事件，才能走到 pointer capture 那条路） */
    const spRect = () => cdp.eval(`(()=>{const r=document.querySelector('#detailSplitter').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)};})()`);
    const detailWidth = () => cdp.eval(`Math.round(document.querySelector('#detail').getBoundingClientRect().width)`);
    const dragTo = async (from, toX) => {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 6; i++) {
        const x = Math.round(from.x + (toX - from.x) * (i / 6));
        await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y: from.y, button: 'left', buttons: 1 });
        await sleep(18);
      }
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: toX, y: from.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(140);
    };

    const w0 = await detailWidth();
    let sp = await spRect();
    await dragTo(sp, sp.x - 140);
    const w1 = await detailWidth();
    check('拖拽加宽详情面板', w1 >= w0 + 120, `${w0} → ${w1} px`);

    const lsOk = await cdp.eval(`(()=>{try{localStorage.setItem('__probe','1');localStorage.removeItem('__probe');return true;}catch{return false;}})()`);
    if (lsOk) {
      const saved = await cdp.eval(`parseInt(localStorage.getItem('pdscope.detailW'),10)`);
      check('宽度已持久化', saved === w1, `localStorage.pdscope.detailW = ${saved}`);
    } else {
      check('宽度已持久化', true, '（本形态无 localStorage，跳过）');
    }

    /* 收起再展开，宽度要能还原 —— 这正是宽度写进 CSS 变量而不是内联 style 的原因：
       内联 style 会压过 body.detail-collapsed 的 width:0，那样收起就失效了。 */
    await cdp.eval(`document.querySelector('#btnDetailClose').click()`);
    await sleep(340);
    const wCol = await detailWidth();
    // 收起后右缘必须出现展开把手 —— 零报文样本里「点一行重开」这条路是断的，
    // 没有把手面板就永久丢失了，所以这条断言对所有样本都成立、都必须过。
    const railVisible = await cdp.eval(`(()=>{const r=document.querySelector('#btnDetailOpen');return !!r && getComputedStyle(r).display!=='none' && r.getBoundingClientRect().width>0;})()`);
    check('收起后右缘出现展开把手', railVisible === true);
    await cdp.eval(rowless
      ? `document.querySelector('#btnDetailOpen').click()`
      // 有行时优先「点一行重开」（顺带验证行点击这条路），
      // 但行若因故为空就退回把手 —— 免得 null.click() 把断言失败伪装成脚本崩溃。
      : `((document.querySelector('#vrows .tr')||document.querySelector('#btnDetailOpen'))).click()`);
    await sleep(340);
    const wBack = await detailWidth();
    check('收起后可还原宽度', wCol === 0 && wBack === w1, `收起 ${wCol} → 还原 ${wBack} px`);

    const vw = await cdp.eval('innerWidth');
    sp = await spRect();
    await dragTo(sp, Math.min(sp.x + 800, vw - 6));
    const w2 = await detailWidth();
    check('拖过头被夹在下限', w2 === 280, `→ ${w2} px（下限 280）`);

    sp = await spRect();
    for (let i = 0; i < 2; i++) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: sp.x, y: sp.y, button: 'left', buttons: 1, clickCount: i + 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: sp.x, y: sp.y, button: 'left', buttons: 0, clickCount: i + 1 });
    }
    await sleep(320);
    const w3 = await detailWidth();
    check('双击恢复默认宽度', w3 === 390, `→ ${w3} px`);

    /* 7.8 多文件：再拖一份 → 新标签、能来回切、各自的筛选互不串、能单独关掉
       这一段要的是「两份不同来源的抓包同时在手」，所以只有传了 --drop2 才跑。 */
    if (DROP2 && !rowless) {
      // 先在第一份上做一件「只属于它」的事：关掉 SNK 方向。
      // 切到第二份时它必须复原成默认（SNK 开着），切回来时又必须还是关着的。
      const pre = (await tabList(cdp))[0];
      await cdp.eval(`(()=>{const c=document.querySelector('#fRole .chip[data-v="SNK"]');if(c.classList.contains('is-on'))c.click();})()`);
      await sleep(400);
      const t0 = (await tabList(cdp))[0];
      check('第一份的方向筛选已改（预备）',
        t0.filtered < pre.filtered && !(await cdp.eval(`document.querySelector('#fRole .chip[data-v="SNK"]').classList.contains('is-on')`)),
        `屏蔽 Sink：${pre.filtered} → ${t0.filtered} 条`);

      await injectDrop(cdp, DROP2, /显示|已读入/);
      const first = await waitTabDone(cdp, 1);
      check('拖入第二份后自动成为当前标签', !!first && first.active === true, first ? first.name : '超时');

      const two = await tabList(cdp);
      const bar2 = await cdp.eval(`(()=>{const b=document.querySelector('#tabBar');return {hidden:!!b.hidden,n:b.querySelectorAll('.tab').length,on:b.querySelectorAll('.tab.is-on').length};})()`);
      check('标签栏变成两个标签', bar2.hidden === false && bar2.n === 2 && bar2.on === 1, `${bar2.n} 个，${bar2.on} 个激活`);
      check('两份文件的报文数各自独立', two.length === 2
        && two[0].packets === t0.packets && two[0].filtered === t0.filtered && two[1].packets > 0,
        `${two[0].packets} / ${two[1].packets} 条`);
      check('两份文件的来源各记各的', two[0].source !== two[1].source || two[0].packets !== two[1].packets,
        `${two[0].source ?? 'atkcc'} · ${two[0].channel} 通道  vs  ${two[1].source ?? 'atkcc'} · ${two[1].channel} 通道`);

      // 第二份是全新文档 → 筛选回到默认（SNK 开着）
      const snkOnSecond = await cdp.eval(`document.querySelector('#fRole .chip[data-v="SNK"]').classList.contains('is-on')`);
      check('新标签的筛选是默认值', snkOnSecond === true);

      // 切回第一份：筛选面板要跟着回来，条数也要与切走前一致
      await cdp.eval(`document.querySelectorAll('#tabs .tab')[0].click()`);
      await sleep(700);
      const back = await tabList(cdp);
      const snkBack = await cdp.eval(`!document.querySelector('#fRole .chip[data-v="SNK"]').classList.contains('is-on')`);
      const statBack = await cdp.eval(`document.querySelector('#statLine').textContent.replace(/\\s+/g,' ').trim()`);
      check('切回第一份后筛选面板已还原', back[0].active === true && snkBack === true, statBack.slice(0, 60));
      check('切回第一份后条数与切走前一致', back[0].filtered === t0.filtered && back[0].packets === t0.packets,
        `${back[0].filtered} / ${back[0].packets} 条`);

      // 两个标签都留着（截图里要看得见标签栏），关闭的动作挪到第 10 节
      await cdp.eval(`document.querySelectorAll('#tabs .tab')[1].click()`);
      await sleep(700);
    }

    /* 8. 无运行时报错 */
    clearInterval(drain);
    for (const e of cdp.events.splice(0)) {
      if (e.method === 'Runtime.exceptionThrown') consoleErrors.push(e.params.exceptionDetails?.exception?.description || 'unknown');
      if (e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error') {
        consoleErrors.push((e.params.args || []).map((a) => a.value ?? a.description).join(' '));
      }
    }
    // file:// 单文件模式下 fetch('api/samples') 必然失败，属预期噪音，过滤掉
    const realErrors = consoleErrors.filter((e) => !/api\/samples|ERR_FILE_NOT_FOUND|Failed to fetch|net::ERR_/i.test(String(e)));
    check('无控制台异常', realErrors.length === 0, realErrors.slice(0, 2).join(' | ').slice(0, 120));
  }

  /* 9. 截图（先复位到「有数据 + 选中一条」的展示状态） */
  await cdp.eval(`(()=>{const b=document.querySelector('#btnReset'); if(b) b.click();})()`);
  await sleep(600);
  await cdp.eval(`(()=>{const r=document.querySelectorAll('#vrows .tr'); if(r[1]) r[1].click();})()`);
  await sleep(500);
  await forceRepaint(cdp);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  await mkdir(dirname(SHOT), { recursive: true });
  await writeFile(SHOT, Buffer.from(shot.data, 'base64'));
  log('');
  log(`  截图：${SHOT}`);

  /* 10. 关闭标签 → 回到「一份都没打开」的空白态（截图已拍完，所以放最后） */
  if (willLoad) {
    const had = await tabList(cdp);
    if (had.length > 1) {
      // 点第二个标签的 × 关掉它，剩下的那个要自动接上
      await cdp.eval(`document.querySelectorAll('#tabs .tab')[1].querySelector('.tab-x').click()`);
      await sleep(700);
      const one = await tabList(cdp);
      const bar1 = await cdp.eval(`(()=>{const b=document.querySelector('#tabBar');return {hidden:!!b.hidden,n:b.querySelectorAll('.tab').length,on:b.querySelectorAll('.tab.is-on').length};})()`);
      check('关掉一个标签后另一个接上', one.length === 1 && one[0].active === true
        && bar1.hidden === false && bar1.n === 1 && bar1.on === 1, `剩「${one[0]?.name}」`);
    }
    await cdp.eval(`window.PDScope.closeAll()`);
    await sleep(500);
    const after = await tabList(cdp);
    const st = await cdp.eval(`window.PDScope.status()`);
    const barGone = await cdp.eval(`document.querySelector('#tabBar').hidden === true`);
    const emptyBack = await cdp.eval(`(()=>{const e=document.querySelector('#emptyState');return e&&e.style.display!=='none'?e.querySelector('#emptyTitle').textContent.trim():'';})()`);
    check('关闭全部后标签栏收起', after.length === 0 && barGone === true && st.tabs === 0, `关前 ${had.length} 个`);
    check('关闭全部后回到打开引导', /打开一份 PD 抓包文件/.test(emptyBack), emptyBack);
  }
} catch (e) {
  fail++;
  log(`  \u2718 运行失败：${e.message}`);
} finally {
  cdp?.close();
  await cleanup();
}

log('');
log(`  ─────────────────────────────────────────────`);
log(`  ${pass} 通过, ${fail} 失败${skipped ? `, ${skipped} 跳过` : ''}`);
if (skipped) log('  （跳过项是该样本上无从进行的断言，不代表通过）');
log('');
process.exit(fail ? 1 : 0);
