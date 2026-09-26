#!/usr/bin/env node
/**
 * tauri-e2e.mjs — 在**真实 Tauri 窗口**里跑端到端自检（Windows / WebView2）
 *
 * 原理：
 *   1. 用环境变量 WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS 让 WebView2 打开 CDP 调试端口
 *   2. 用 Chrome DevTools Protocol 连上去
 *   3. 把真实 .atkcc 交给界面，两条路径分别验证：
 *        · `--drop`  在页面里构造 File 塞进 <input type=file> 并派发 change
 *                    —— 等价于用户点「打开」→ 选文件
 *        · `--open`  把文件路径作为命令行参数交给 exe
 *                    —— 等价于双击关联的 .atkcc / 拖到 exe 图标上，走外壳的 read_capture 桥
 *   4. 校验界面骨架、形态识别、解码结果、配色与异常，最后 Page.captureScreenshot 截图
 *
 * 为什么不用 tools/e2e.mjs：那个是自己拉起 Chrome 去开页面，测不到 Tauri 外壳本身；
 * 这里连的是 Tauri 真正在跑的那个 WebView2。
 *
 * 用法：
 *   node tools/tauri-e2e.mjs --drop "../制糖40w-ip18pro.atkcc" \
 *        --shot artifacts/tauri-shot.png --report artifacts/tauri-selftest.txt
 *   node tools/tauri-e2e.mjs --open "../绿联70w-ip18pro.atkcc"      # 测命令行打开
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const argv = process.argv.slice(2);
const arg = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

/**
 * 找可执行文件。
 *
 * 注意 Windows 的文件系统**大小写不敏感**：对 `PDScope.exe` 和 `pdscope.exe` 做
 * existsSync 都会命中同一个文件。所以这里列目录取「真实文件名」，
 * 免得报告里写出一个磁盘上并不存在的拼写。
 *
 * 两种拼写都要认，因为：
 *   · `tauri build` 走 productName，某些平台会产出 PDScope.exe
 *   · 直接 `cargo build --release` 产出的是 Cargo 包名 pdscope.exe
 */
function detectExe() {
  const dir = resolve(ROOT, 'src-tauri', 'target', 'release');
  try {
    const found = readdirSync(dir).find((f) => /^pdscope\.exe$/i.test(f));
    if (found) return join(dir, found);
  } catch { /* 目录还不存在 */ }
  return join(dir, 'pdscope.exe');   // 不存在时给出预期路径，报错信息才有指导意义
}

const EXE = arg('--exe') ? resolve(ROOT, arg('--exe')) : detectExe();
const DROP = arg('--drop', null);          // 页面内注入（等价于点「打开」选文件）
const OPEN = arg('--open', null);          // 命令行参数喂入（等价于双击 .atkcc 关联）
const SHOT = arg('--shot', null);
const REPORT = arg('--report', null);
const PORT = Number(arg('--port', 9333));
const WAIT = Number(arg('--wait', 45));       // 等调试端口出现的秒数
const DECODE_WAIT = Number(arg('--decode-wait', 25));  // 等解码完成的秒数
const VERBOSE = argv.includes('--verbose');

if (!existsSync(EXE)) {
  console.error(`找不到可执行文件：${EXE}\n先跑：npm run app:exe   （或 cargo build --release）`);
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
let child = null;
let cdp = null;

function record(name, pass, extra = '') {
  results.push({ name, pass, extra });
  console.log(`  ${pass ? '✔' : '✘'} ${name}${extra ? `   ${extra}` : ''}`);
}

/* ── 1. 拉起应用，并让 WebView2 暴露调试端口 ───────────────── */
function launch() {
  // --disable-gpu / --no-sandbox 的由来：远程桌面、虚拟机、或装了行为管控类安全软件的机器上，
  // WebView2 的 GPU 与沙箱辅助进程会成片退出，现象是「窗口出来了但内容空白」。
  // 自检场景下带上它们最稳（这也是早先 Windows 原生外壳踩过的同一个坑）。
  const extra = arg('--browser-args', '--disable-gpu --no-sandbox');
  const env = {
    ...process.env,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT} ${extra}`.trim(),
  };
  // --open 时把抓包路径当命令行参数交给 exe，测的是外壳自己那条读文件的路
  const args = OPEN ? [resolve(ROOT, OPEN)] : [];
  child = spawn(EXE, args, { env, stdio: 'ignore', windowsHide: false });
  child.on('error', (e) => { console.error('启动失败：', e.message); });
}

async function killApp() {
  if (!child) return;
  try {
    // Tauri 会带起 WebView2 子进程，必须整棵树杀掉，否则调试端口不释放
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* 忽略 */ }
  await sleep(800);
}

/* ── 2. 等调试端口，并连上 CDP ─────────────────────────────── */
async function findPageTarget() {
  const deadline = Date.now() + WAIT * 1000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page;
    } catch { /* 端口还没起来 */ }
    await sleep(400);
  }
  return null;
}

function connect(url) {
  return new Promise((ok, fail) => {
    const ws = new WebSocket(url);
    const pending = new Map();
    const events = [];
    let seq = 0;

    ws.addEventListener('open', () => ok({
      events,
      send(method, params = {}, timeoutMs = 30000) {
        return new Promise((res, rej) => {
          const id = ++seq;
          // 超时保护：WebView2 上个别 CDP 方法（如 DOM.setFileInputFiles）会一直不返回，
          // 没有这道保险就会把整个自检挂死。
          const timer = setTimeout(() => {
            pending.delete(id);
            rej(new Error(`${method} 超时（${timeoutMs}ms 未返回）`));
          }, timeoutMs);
          pending.set(id, {
            res: (v) => { clearTimeout(timer); res(v); },
            rej: (e) => { clearTimeout(timer); rej(e); },
          });
          ws.send(JSON.stringify({ id, method, params }));
        });
      },
      close: () => ws.close(),
    }));

    ws.addEventListener('error', (e) => fail(new Error(`WebSocket 连接失败：${e.message || e.type}`)));

    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) rej(new Error(JSON.stringify(msg.error)));
        else res(msg.result);
      } else if (msg.method) {
        events.push(msg);
      }
    });
  });
}

/* ── 3. 主流程 ─────────────────────────────────────────────── */
let shotPath = null;

async function run() {
  console.log('');
  console.log('  Tauri 窗口自检');
  console.log('  ─────────────────────────────────────────');
  console.log(`  可执行文件  ${EXE}`);
  if (DROP) console.log(`  页面注入    ${DROP}`);
  if (OPEN) console.log(`  命令行打开  ${OPEN}`);
  console.log('');

  launch();

  const page = await findPageTarget();
  if (!page) {
    record('连上 WebView2 调试端口', false, `端口 ${PORT} 在 ${WAIT}s 内没有响应`);
    return;
  }
  record('连上 WebView2 调试端口', true, `:${PORT}`);

  cdp = await connect(page.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('DOM.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');

  const evaluate = async (expression, { awaitPromise = true } = {}) => {
    const r = await cdp.send('Runtime.evaluate', {
      expression, awaitPromise, returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(d);
    }
    return r.result.value;
  };

  /* 等前端把界面挂起来 */
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      if (await evaluate("!!document.querySelector('#fileInput')")) { ready = true; break; }
    } catch { /* 页面还在换文档 */ }
    await sleep(400);
  }
  record('界面已挂载（找到 #fileInput）', ready);
  if (!ready) return;

  record('窗口标题正确', (await evaluate('document.title')).includes('PDScope'),
    await evaluate('document.title'));

  /* 外壳注入的桥接与样式 */
  record('样式已生效', (await evaluate(
    "getComputedStyle(document.body).backgroundColor !== 'rgba(0, 0, 0, 0)'")));

  /* 形态识别：同一份 HTML 在桌面外壳里必须自认「桌面版」，而不是单文件版/网页版 */
  const envName = await evaluate('window.PDScope && window.PDScope.env.name');
  record('页面识别出桌面形态', envName === 'desktop', `env=${envName}`);
  record('外壳桥已就绪', await evaluate('typeof window.pdscopeOpenBytes === "function"'));

  /* ── 把真实抓包交给界面，走完整解码链路 ── */
  const feed = DROP || OPEN;
  if (feed) {
    const abs = resolve(ROOT, feed);
    const label = DROP ? basename(abs) : '（由命令行参数喂入）';
    if (!existsSync(abs)) {
      record('找到抓包文件', false, abs);
    } else {
      record('找到抓包文件', true, DROP ? label : label + ' ' + basename(abs));

      if (DROP) {
        // ⚠ 别用 CDP 的 DOM.setFileInputFiles —— 在 WebView2 上这个调用会一直不返回（挂死）。
        // 改为把字节读进来，在页面里构造 File 塞进 input 再派发 change，
        // 效果与用户点「打开」→ 选文件完全等价。
        const bytes = await readFile(abs);
        await evaluate(`(() => {
          const bin = atob(${JSON.stringify(bytes.toString('base64'))});
          const u8 = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
          const dt = new DataTransfer();
          dt.items.add(new File([u8], ${JSON.stringify(basename(abs))}));
          const input = document.querySelector('#fileInput');
          input.files = dt.files;
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        })()`);
      }

      let stat = '';
      let rows = 0;
      for (let i = 0; i < DECODE_WAIT * 2; i++) {
        stat = await evaluate("document.querySelector('#statLine')?.textContent || ''");
        rows = await evaluate("document.querySelectorAll('#vrows > *').length");
        if (VERBOSE) {
          console.log(`      [${i}] rows=${rows} statLine=${JSON.stringify(stat.trim().slice(0, 60))}`);
        }
        if (rows > 0) break;
        await sleep(500);
      }

      // --open 模式下，这条链路的每一环都是新的（命令行解析 → read_capture → IPC → 桥），
      // 所以单独证一句「文件名已经进到界面里」，失败时能一眼看出断在哪。
      if (OPEN) {
        const shown = await evaluate("document.querySelector('#fileName')?.textContent || ''");
        record('命令行指定的文件名已进到界面', shown.includes(basename(abs)), shown.trim().slice(0, 40));
      }

      record('抓包已解码（状态行已更新）', !!stat && !stat.includes('等待'),
        stat.trim().slice(0, 60));

      record('报文表已渲染出行', rows > 0, `${rows} 行`);

      // 数报文表里实际渲染出多少种文字颜色 —— 各类报文（控制/数据/扩展/VDM/异常）
      // 都会上色，颜色单调就说明配色逻辑没生效。用「整棵子树 + 去重」而不是盯某个类名，
      // 这样前端改类名也不会让自检误报。
      const colors = await evaluate(`(() => {
        const s = new Set();
        document.querySelectorAll('#vrows *').forEach((el) => {
          const c = getComputedStyle(el).color;
          if (c) s.add(c);
        });
        return s.size;
      })()`);
      record('报文表用了多种颜色', colors >= 3, `${colors} 种文字色`);

      const hasTimeline = await evaluate(`(() => {
        const c = document.querySelector('canvas');
        return !!c && c.width > 100;
      })()`);
      record('时间轴画布已绘制', hasTimeline);
    }
  }

  /* 主题切换 */
  try {
    await evaluate("document.querySelector('#btnTheme')?.click()");
    await sleep(600);
    record('主题切换无异常', true);
    await evaluate("document.querySelector('#btnTheme')?.click()"); // 切回去
    await sleep(400);
  } catch (e) {
    record('主题切换无异常', false, e.message.slice(0, 60));
  }

  /* ── 页面异常 ── */
  const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
  const errors = cdp.events.filter(
    (e) => e.method === 'Log.entryAdded' && e.params?.entry?.level === 'error');
  record('页面无 JS 异常', exceptions.length === 0,
    exceptions.length ? exceptions[0].params?.exceptionDetails?.text : '');
  // 带上 url：定位「资源加载失败」时，光有 text（永远是同一句）等于没线索
  const e0 = errors[0]?.params?.entry;
  record('控制台无 error', errors.length === 0,
    e0 ? `${e0.text || ''} ${e0.url || ''}`.trim().slice(0, 120) : '');

  /* ── 截图 ── */
  if (SHOT) {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    shotPath = resolve(ROOT, SHOT);
    await mkdir(dirname(shotPath), { recursive: true });
    await writeFile(shotPath, Buffer.from(shot.data, 'base64'));
    record('已抓取窗口截图', true, SHOT);
  }
}

/* ── 4. 收尾：写报告、退出 ─────────────────────────────────── */
const t0 = Date.now();
try {
  await run();
} catch (e) {
  record('自检过程本身未抛异常', false, e.message.slice(0, 120));
} finally {
  try { cdp?.close(); } catch { /* 忽略 */ }
  await killApp();
}

const passed = results.filter((r) => r.pass).length;
const total = results.length;
const secs = ((Date.now() - t0) / 1000).toFixed(1);

console.log('');
console.log('  ─────────────────────────────────────────');
console.log(`  ${passed}/${total} 项通过   耗时 ${secs}s`);
if (shotPath) console.log(`  截图  ${shotPath}`);
console.log('');

if (REPORT) {
  const p = resolve(ROOT, REPORT);
  const lines = [
    'Tauri 窗口自检报告',
    `时间      ${new Date().toISOString()}`,
    `可执行    ${EXE}`,
    `抓包      ${DROP ? `页面注入 ${DROP}` : (OPEN ? `命令行打开 ${OPEN}` : '(未喂入)')}`,
    `结果      ${passed}/${total} 通过，耗时 ${secs}s`,
    `截图      ${shotPath || '(未抓取)'}`,
    '',
    ...results.map((r) => `${r.pass ? '[PASS]' : '[FAIL]'} ${r.name}${r.extra ? '  -- ' + r.extra : ''}`),
  ];
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, lines.join('\n') + '\n', 'utf8');
  console.log(`  报告  ${p}`);
  console.log('');
}

process.exit(passed === total ? 0 : 1);
