/**
 * app.js — PDScope 前端主程序
 *
 * 纯客户端实现：所有解析都在浏览器/渲染进程里完成（ZIP + inflate + BMC + PD）。
 * **同一份代码，三种运行形态**，靠运行期探测自动适配，没有条件编译、没有分支产物：
 *
 *   ┌ 形态 ──────────┬ 地址协议 ─┬ 由谁承载 ─────────────────────────────────────┐
 *   │ 桌面应用        │ http:     │ src-tauri/ Tauri 外壳（WebView2 / WKWebView） │
 *   │ 本地服务        │ http:     │ tools/serve.mjs（开发调试，多一个「载入示例」）│
 *   │ 单文件免安装版  │ file:     │ 双击 dist/PDScope.html，系统默认浏览器        │
 *   └────────────────┴───────────┴───────────────────────────────────────────────┘
 *
 * 三者的区别只有两点，都在下面 `ENV` 里显式判定：
 *   1. 「载入示例」按钮依赖 `api/samples` 接口，只有 http 形态才存在；
 *   2. 桌面形态下原生菜单已经接管了 Ctrl+O / Ctrl+T 等快捷键，页面不再重复绑定。
 *
 * 外壳（任何形态都可以有，也可以没有）通过下面两个入口与界面交互，见文件末尾的
 * 「外壳桥」一节：`window.pdscopeOpenUrl()` 由外壳调用，`window.PDScope` 由外壳/调试读取。
 *
 * ── 多文档 ─────────────────────────────────────────────
 * 可以同时打开多份抓包，一份一个标签。状态是「一份文件一个 doc 对象」，见「文档」一节；
 * 全局的 `S` 只是**当前激活那一份**的别名，所以下文几百处 `S.packets` / `S.filters`
 * 读的都是「当前文件」，切换标签就是给 `S` 换个指向。
 * 换文档时界面必须**整片重画**（见 `renderAll`）——面板只有一副、文档有多份，
 * 只改个标题就会出现「勾着 A 的筛选、筛的是 B 的数据」。
 */

import { AtkccCapture, scanChannelActivity } from '../js/core/atkcc.js';
import { decodeChannel, buildBusSeries } from '../js/core/pipeline.js';
import { PowerzCapture, sniffPowerz } from '../js/core/powerz.js';
import { makeBrowserInflator } from '../js/core/inflate.js';
import { csvClock, csvText, csvExport, csvFileName, fmtRate } from '../js/core/csv.js';

/* ═══════════════════════ 运行形态探测 ═══════════════════════ */
/**
 * 判定当前跑在哪种形态里。判据只有「地址协议」和「有没有 Tauri 注入的全局对象」，
 * 都是运行期事实，因此同一份 dist/PDScope.html 丢到哪儿都能正确自适应。
 */
const ENV = (() => {
  const proto = location.protocol;
  // Tauri v2 会注入 __TAURI_INTERNALS__；__TAURI__ 只在开了 withGlobalTauri 时出现，
  // 两个都认，避免以后关掉 withGlobalTauri 就认不出来。
  const tauri = typeof globalThis.__TAURI__ !== 'undefined'
             || typeof globalThis.__TAURI_INTERNALS__ !== 'undefined';
  const http = proto === 'http:' || proto === 'https:';
  const file = proto === 'file:';
  return {
    tauri, http, file, proto,
    /** 桌面外壳承载 —— 有原生菜单、可被外壳喂文件 */
    desktop: tauri,
    /** 有同源后端 —— 「载入示例」接口可用 */
    hasServer: http && !tauri,
    /** 文件名/展示用的形态标识 */
    name: tauri ? 'desktop' : (http ? 'server' : (file ? 'standalone' : 'unknown')),
    label: tauri ? '桌面版' : (http ? '本地服务' : (file ? '单文件版' : '网页')),
  };
})();

/* ═══════════════════════ 小工具 ═══════════════════════ */
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

/**
 * 时标格式化。实现只有一份（`src/js/core/csv.js` 的 `csvClock`），
 * 界面（表格 / 详情 / 时间轴）与 CSV 导出共用 —— 两处各写一遍迟早会差一位小数。
 */
const fmtTime = csvClock;
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 报文的「语义类别」——只看报文自身的协议属性，不看 CRC 是否通过。
 * 用于给「被确认的报文」取配色（坏包仍要显示为错误色，但它的语义类别依旧有效）。
 */
function toneOf(p) {
  if (p.msgType === 'VDM') return 'VDM';
  if (p.msgKind === 'custom') return 'Custom';     // UFCS 厂家自定义消息
  if (p.msgKind === 'ext') return 'Extended';
  if (p.msgKind === 'data') return 'Data';
  if (p.msgKind === 'special') return 'Error';
  return 'Control';
}
/** 报文颜色分类（用于「报文类别」筛选 + 字体配色）：坏包一律归错误色 */
function kindOf(p) {
  if (p.crcOk === false) return 'Error';
  return toneOf(p);
}
const CAT_CLASS = {
  Control: 'cat-Control', Data: 'cat-Data', Extended: 'cat-Extended',
  VDM: 'cat-VDM', Custom: 'cat-Custom', Error: 'cat-Error',
};

/* ── 协议相关的形状差异 ────────────────────────────────
   同一份界面要同时服务两种协议，差异集中在三处：链路叫法（SOP 序列 / D+D-）、
   报文类别（Extended/VDM / Custom）、以及「心跳包」「功率协商」这类语义分组。
   下面几个帮助函数是唯一的分叉点，别在别处再写 `=== 'UFCS'` 的判断。 */
const isUfcs = () => S?.meta?.protocol === 'UFCS';
/** 自动应答心跳包：PD 是 GoodCRC，UFCS 是 ACK / NCK */
const isAutoAck = (p) => (isUfcs()
  ? (p.msgType === 'ACK' || p.msgType === 'NCK')
  : p.msgType === 'GoodCRC');
/** 链路一栏的名字与候选取值 */
const linkTitle = () => (isUfcs() ? '物理链路' : 'SOP 类型');
const linkValues = () => (isUfcs()
  ? [['D+', 'D+'], ['D-', 'D−'], ['D±', 'D±']]
  : [['SOP', 'SOP'], ["SOP'", 'SOP&prime;'], ["SOP''", 'SOP&Prime;'],
    ['Hard Reset', 'Hard Reset'], ['Cable Reset', 'Cable Reset']]);
/** 报文类别一栏的候选 */
const catValues = () => (isUfcs()
  ? [['Control', '控制'], ['Data', '数据'], ['Custom', '自定义'], ['Error', '异常']]
  : [['Control', '控制'], ['Data', '数据'], ['Extended', '扩展'], ['VDM', 'VDM'], ['Error', '异常']]);

/**
 * GoodCRC 配色配对（界面侧）。
 *
 * 配对关系由内核 `linkGoodCrc()` 算好（p.ackOf），这里只负责取色：
 * 让回应包与它所确认的报文同色，一眼看出「哪条被谁确认了」；
 * 否则 GoodCRC 只能笼统地取 Control 色，与它确认的报文各成一色。
 *
 * 坏掉的 GoodCRC 保持错误色，不参与配对。
 */
function pairAckTone(packets) {
  for (const p of packets) {
    p.tone = p.kind;
    if (p.ackOf == null) continue;
    if (p.crcOk === false) continue;
    const ref = packets[p.ackOf];
    if (ref) p.tone = toneOf(ref);
  }
}

/**
 * 是否属于「功率协商」/「状态切换」这两类关注点（两种协议各一套判据）。
 *
 * 这两条正则匹配的是**协议表里的类型名**（`src/js/pd/tables.js`），
 * 所以类型名一改，这里必须跟着改；名字变更时请一并核对。
 */
const POWER_TYPES = /Source_Cap|Request|EPR_Request|EPR_Mode|PPS|BIST|Source_Capabilities_Extended|EPR_Source|EPR_Sink|Sink_Cap/i;
const ENTER_TYPES = /PS_RDY|VDM|Alert|Status|Source_Info|Revision|Enter_USB|Discover|Sink_Cap|Notify/i;
/** UFCS：协商 = 能力/请求/输出调整；状态 = 各类信息上报与查询 */
const UFCS_POWER_TYPES = /Output_Capabilities|Request|Power_Change|Power_Ready|Accept|Config_Watchdog/i;
const UFCS_ENTER_TYPES = /_Information|Source_Info|Sink_Info|Cable_Info|Device_Info|Error_Info|Get_/i;
const isPowerType = (t) => (isUfcs() ? UFCS_POWER_TYPES : POWER_TYPES).test(t);
const isEnterType = (t) => (isUfcs() ? UFCS_ENTER_TYPES : ENTER_TYPES).test(t);

/* ═══════════════════════ 文档（一份抓包 = 一个标签） ═══════════════════════ */
/**
 * 一份打开的抓包。
 *
 * 这些字段原先统统挂在全局 `S` 上，只装得下一份文件。改成「一份文件一个对象」之后，
 * `S` 的含义收窄成**当前激活的那一份**，于是下面其余几百处 `S.packets`、`S.filters`
 * 一字未改就是「当前文件的状态」，而切换标签只是给 `S` 换个指向。
 *
 * `filters / sort / viewMode / tlMode / channel / selected` 刻意也放在这里 ——
 * 它们是「对这份抓包的看法」，不是全局偏好，切回来必须原样还在。
 */
/**
 * 一份抓包的筛选条件。**默认值跟着协议走**：UFCS 的链路是 D+/D-、类别里没有
 * Extended/VDM 而有自定义消息 —— 用 PD 的默认集合去筛 UFCS，会把所有报文都筛没。
 *
 * @param {'pd'|'UFCS'} [protocol]
 */
function newFilters(protocol = 'pd') {
  const ufcs = protocol === 'UFCS';
  return {
    roles: new Set(['SRC', 'SNK', 'Plug']),
    sops: new Set(ufcs
      ? ['D+', 'D-', 'D±']
      : ['SOP', "SOP'", "SOP''", 'Hard Reset', 'Cable Reset']),
    cats: new Set(ufcs
      ? ['Control', 'Data', 'Custom', 'Error']
      : ['Control', 'Data', 'Extended', 'VDM', 'Error']),
    types: new Set(),          // 空 = 全部
    hideGoodCrc: true,
    onlyBad: false,
    onlyPower: false,
    onlyEnter: false,
    q: '',
    tFrom: 0,
    tTo: 1,
  };
}

let docSeq = 0;
/**
 * @param {File|null} file 不给就是「还没打开任何文件」的空白占位文档
 */
function newDoc(file) {
  return {
    id: ++docSeq,
    fileName: file?.name || '',
    fileSize: file?.size || 0,
    /** 空白占位文档：不进标签栏，也不在列表里 */
    blank: !file,
    cap: null,
    meta: null,
    channel: 0,
    /** 本文件实际采用的采样率（声明 → 波形自检 → 兜底，见 pipeline.resolveSampleRate） */
    rate: 0,
    packets: [],
    view: [],            // 过滤 + 排序后的结果
    stats: null,
    busSeries: null,
    totalSamples: 0,
    decodedMs: 0,
    selected: -1,
    cancel: false,
    /** 时间轴画哪一组曲线：'power' = VBUS/IBUS，'aux' = CC1/CC2（分析仪导出才有） */
    tlMode: 'power',
    /**
     * 时间轴的**纵轴视图**：两档各记一套（两档量程差一个数量级，共用一套会很别扭）。
     *
     *   · `z` 缩放：1 = 自适应（曲线刚好铺满，留 12% 余量），2 = 放大两倍只看下半截；
     *   · `o` 平移：以「自适应满量程」为单位，0 = 贴底，0.5 = 整体上移半屏。
     *
     * 屏幕映射 `y = y0 + H − (v / vmax − o) × z × H`，可见窗口（归一化值）是 `[o, o + 1/z]`。
     * 它是「对这份数据的看法」，所以跟着文档走；换文件 / 换通道时回到默认（见 decodeDoc）。
     */
    tlY: newTlY(),
    chActivity: new Map(),
    /** 多通道文件自动挑通道的结果（挑中哪个、排除了几条噪声线） */
    channelPick: null,
    /** 加载期发现的问题（例如所有通道都像噪声线），解码后若一条报文都没有才顶上来显示 */
    loadNotice: null,
    /** 常驻提示条的内容（切回来要还原）；noticeOff 记「用户点过知道了」 */
    notice: null,
    noticeOff: false,
    /** 'blank' 未开文件 | 'ready' 容器就绪待解析 | 'running' 解析中 | 'done' | 'error' 打不开 */
    state: 'blank',
    error: '',
    /**
     * 解码进度旁路：命令行导出（无界面）时由外壳挂上来，把进度转成终端里的一行行字。
     * 界面形态下恒为 null —— 进度照旧只走左下角那根进度条。
     */
    progressCb: null,
    /** 已排队等待解析（避免同一份文件被排进队列两次） */
    pending: false,
    filters: newFilters(),
    sort: { k: 'index', asc: true },
    viewMode: 'all',
  };
}

/** 所有已打开的抓包，顺序即标签顺序 */
const DOCS = [];
/** 当前激活的文档 —— 下文所有 `S.xxx` 读的都是它（可能是不在 DOCS 里的空白占位文档） */
let S = newDoc(null);
/** 与「哪一份文件」无关的界面偏好，跨标签共用 */
const UI = { rowH: 30 };

/**
 * 多通道文件自动挑通道时，混合字节占比超过这个值就认为「像浮空 / 噪声线」而不优先选它。
 *
 * 依据：真实 PD 的 CC 线上，绝大多数字节是整字节同电平（0xFF 空闲 / 0x00 低电平），
 * 混合字节只在报文跳变处出现，实测占比远低于 10%；而浮空线的电平随机，
 * 混合字节占比接近 50%。取 35% 落在两者之间，两边都不会误判。
 */
const NOISE_EDGE_LIKE = 0.35;

const inflate = makeBrowserInflator();

/* ═══════════════════════ 主题 ═══════════════════════ */
function setTheme(t) {
  document.documentElement.dataset.theme = t;
  try { localStorage.setItem('pdscope.theme', t); } catch {}
}
(function initTheme() {
  let t = null;
  try { t = localStorage.getItem('pdscope.theme'); } catch {}
  if (!t) t = window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  setTheme(t);
})();
$('#btnTheme').addEventListener('click', () => {
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  drawTimeline();
});

/* ═══════════════════════ Toast / 进度 ═══════════════════════ */
function toast(msg, kind = '') {
  const t = el('div', 'toast ' + kind, msg);
  $('#toastWrap').appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 2600);
  setTimeout(() => t.remove(), 3000);
}
function showProgress(title, sub) {
  $('#progTitle').textContent = title;
  $('#progSub').textContent = sub || '';
  $('#progBar').style.width = '0%';
  $('#progress').classList.add('show');
}
const setProgress = (r, sub) => {
  $('#progBar').style.width = (clamp(r, 0, 1) * 100).toFixed(1) + '%';
  if (sub != null) $('#progSub').textContent = sub;
};
const hideProgress = () => $('#progress').classList.remove('show');
$('#progCancel').addEventListener('click', () => { S.cancel = true; });

/* ═══════════════════════ 打开文件（可多份） ═══════════════════════ */
$('#btnOpen').addEventListener('click', () => $('#fileInput').click());
$('#btnOpen2')?.addEventListener('click', () => $('#fileInput').click());
$('#btnTabAdd').addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const { files } = pickCaptureFiles(e.target.files || []);
  if (files.length) openFiles(files);
  e.target.value = '';       // 清空才能再次选中同一个文件
});

// 拖拽
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) $('#drop').classList.add('show'); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('show');
  const { files, skipped } = pickCaptureFiles(e.dataTransfer?.files || []);
  if (!files.length) return;
  if (skipped) toast(`已忽略 ${skipped} 个不像抓包的文件`, 'warn');
  openFiles(files);
});

/**
 * 从拖进来/选进来的一堆文件里挑出要打开的。
 *
 * 拖进来的东西五花八门：文件夹会变成 0 字节的伪文件、顺手拖进来的图片、.DS_Store…
 * 所以先按「名字像不像抓包」筛一道。但只要**一个都不像**，就把全部放进来交给内容嗅探
 * （`sniffPowerz` / ZIP 魔数）自己判 —— 免得用户把抓包改了个扩展名就再也打不开。
 */
const CAPTURE_EXT = /\.(atkcc|sqlite|db|bin|zip)$/i;
function pickCaptureFiles(list) {
  const all = [...list].filter((f) => f && (f.size > 0 || f.name));
  const named = all.filter((f) => CAPTURE_EXT.test(f.name));
  return { files: named.length ? named : all, skipped: named.length ? all.length - named.length : 0 };
}

/* ── 载入 / 解码的串行队列 ──────────────────────────────
 * 两份文件同时解会互相踩：`S` 是共享的、进度条只有一根、localStorage 也只有一个。
 * 串行化最省事，代价只是每步之间多一次微任务。
 * 注意两点：
 *   ① 队列**不可重入**（任务里再 enqueue 并 await 会死锁），所以 openFiles / activateDoc
 *      这两个「调度方」必须跑在队列外，只把具体活（loadContainer / decodeDoc）丢进去；
 *   ② 任务的**返回值必须带出来**（`await job.run()` 的结果要交给 resolve）——
 *      否则调用方拿到的是 undefined 而不是文档对象。
 */
const jobs = [];
let jobRunning = false;
async function pumpJobs() {
  if (jobRunning) return;
  jobRunning = true;
  try {
    while (jobs.length) {
      const job = jobs.shift();
      let out;
      try { out = await job.run(); } catch (err) { console.error(err); }
      job.done(out);
    }
  } finally { jobRunning = false; }
}
/** 排一个任务并等它跑完；resolve 的值就是任务的返回值 */
const enqueue = (run) => new Promise((resolve) => { jobs.push({ run, done: resolve }); pumpJobs(); });

/**
 * 打开一批抓包 —— 每份一个标签，本批里**第一份成功载入的**自动激活。
 *
 * 解码推迟到标签被激活时（见 `activateDoc`）：一次拖 5 份文件时，
 * 没必要把 5 份全解完才能看第一份。
 */
async function openFiles(files) {
  const list = [...files];
  if (!list.length) return;
  const opened = [];
  for (const f of list) opened.push(await enqueue(() => loadContainer(f)));

  const first = opened.find((d) => !d?.error) || opened[0];
  if (first) await activateDoc(first);
  else renderAll();
  if (opened.length > 1) {
    const bad = opened.filter((d) => d?.error).length;
    toast(bad ? `已打开 ${opened.length - bad} 份，${bad} 份打不开` : `已打开 ${opened.length} 份抓包，可点上方标签切换`,
      bad ? 'warn' : 'ok');
  }
}

/**
 * 读字节 → 认格式 → 解析容器 → 挑通道，然后登记成一个标签。
 * **到这里为止都不解码**，所以这一段的开销只跟文件大小有关、跟报文多少无关。
 *
 * 失败也不抛：把原因记在文档上（标签变红 + 表格区给出解释），
 * 这样一次打开多份时，坏的那份不会把好的那份一起带崩。
 */
async function loadContainer(file) {
  const doc = takeSlotDoc(file);
  doc.state = 'running';
  doc.error = '';
  doc.loadNotice = null;
  doc.channelPick = null;
  renderTabs();
  showProgress('正在读取文件…', file.name);
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    setProgress(0.05, `${fmtSize(buf.length)} 已载入，解析容器…`);

    // ── 格式分流：只看文件内容（魔数 + 表名），不看扩展名 ──
    // POWER-Z 导出的是 SQLite（报文已被分析仪解到逻辑字节），ATK-C 是 ZIP 装的原始采样。
    // 二者后续的「解码」步骤完全不同，但解出来的报文对象同形，界面只有这一处分叉。
    const cap = sniffPowerz(buf)
      ? PowerzCapture.open(buf)
      : await AtkccCapture.open(buf, { inflate });

    doc.cap = cap;
    doc.meta = cap.meta;
    doc.fileSize = buf.length;
    doc.rate = cap.meta.sampleRate;      // 先用文件声明的值，解码时再由波形自检核一遍
    doc.tlMode = 'power';
    doc.decodedMs = 0;
    // 协议在容器层才认出来，而筛选的默认值跟协议绑定（见 newFilters）——
    // 这里补一次，免得 UFCS 抓包一打开就被 PD 的默认筛选条件滤成空表。
    doc.filters = newFilters(cap.meta.protocol);

    // 多通道时扫描活动度，自动挑一个「有报文」的通道（分析仪导出只有 1 个逻辑通道）
    const chs = cap.meta.channels;
    let pick = chs[0].channel;
    if (chs.length > 1) {
      showProgress('正在扫描各通道活动度…', `${chs.length} 个通道`);
      doc.chActivity = new Map();
      for (let i = 0; i < chs.length; i++) {
        const r = await scanChannelActivity(cap, chs[i].channel, inflate, 3);
        doc.chActivity.set(chs[i].channel, r);
        setProgress(0.05 + 0.25 * (i + 1) / chs.length, `通道 ${chs[i].channel}：${r.activity} 个活动字节`);
      }
      // ⚠ 不能只挑「活动度最高」的通道。浮空 / 未接的线是接近 50% 的随机电平，
      // 活动度反而**远高于**真正在跑 PD 的 CC 线（那条线大部分时间空闲在同一电平、
      // 只在报文期间才跳变）。只看 activity 就会把噪声线当 CC 线去解，
      // 解出一堆垃圾；更早的版本还会让解码器在无边沿的位流上空转几秒（见 bmc.js MAX_PACKET_BITS）。
      // 所以先用「混合字节占比」把噪声排除，再在剩下的里挑活动度最高的。
      const scored = chs.map((c) => {
        const r = doc.chActivity.get(c.channel) || { activity: 0, edgeLike: 0 };
        return { c, activity: r.activity, edgeLike: r.edgeLike };
      });
      const clean = scored.filter((s) => s.edgeLike <= NOISE_EDGE_LIKE);
      const pool = clean.length ? clean : scored;
      let best = pool[0];
      for (const s of pool) if (s.activity > best.activity) best = s;
      pick = best.c.channel;
      doc.channelPick = {
        picked: pick,
        noiseRejected: scored.length - clean.length,
        allNoisy: clean.length === 0,
      };
      if (!clean.length) {
        doc.loadNotice = {
          text: '所有通道都像浮空 / 噪声线',
          sub: '没有一条呈现「大部分时间空闲在同一电平、只在报文期间跳变」的 PD 特征，'
            + '下面的报文列表很可能是空的 —— 请确认探头接的是 CC 线',
        };
      }
    }
    doc.channel = pick;
    doc.state = 'ready';
  } catch (err) {
    console.error(err);
    doc.error = String(err?.message || err);
    doc.cap = null; doc.meta = null;
    doc.state = 'error';
  } finally {
    hideProgress();
    renderTabs();
  }
  return doc;
}

/**
 * 取一个空位放这份文件：一份都没开过时复用那份空白占位文档，
 * 否则新开一个 —— 这样「空白文档」始终只有一份，也不会在标签栏里多一个空标签。
 */
function takeSlotDoc(file) {
  let doc;
  if (S.blank && !DOCS.length) { doc = S; doc.blank = false; }
  else doc = newDoc(file);
  doc.fileName = file.name;
  doc.fileSize = file.size || 0;
  if (!DOCS.includes(doc)) DOCS.push(doc);
  return doc;
}

/**
 * 切到某个标签。
 *
 * 分两段：**同步段**立刻把 `S` 指过去并重画（点标签必须马上有反应），
 * **解码段**排进串行队列（目标还没解过，或要换通道重解）。
 * 切走时把上一份正在跑的解码置 `cancel`：它的结果会被丢弃、状态退回「待解析」，
 * 下次转回来重解 —— 半截结果绝不能当成完整结果留下来。
 */
function activateDoc(doc, channel) {
  if (!doc) return Promise.resolve();
  const prev = S;
  if (prev && prev.state === 'running' && (prev !== doc || channel != null)) prev.cancel = true;
  S = doc;
  if (channel != null) doc.channel = channel;
  renderTabs();

  const need = !doc.error && !doc.blank && (doc.state !== 'done' || channel != null);
  if (!need) { renderAll(); return Promise.resolve(); }
  if (doc.pending) { renderAll(); return Promise.resolve(); }   // 已排队，别重复排
  doc.pending = true;
  return enqueue(async () => { doc.pending = false; await decodeDoc(doc); });
}

/**
 * 解码指定文档（用 `doc.channel` 那个通道），然后把整个界面刷新成它的样子。
 *
 * 两种格式在这里合流：ATK-C 要跑「分块 → BMC → 4B5B」，
 * POWER-Z 只要拆事件行并把逻辑字节交给同一个 PD 解码器。
 * 两者产出的 `{packets, stats}` 同形，所以下面这段渲染代码一份都不用复制。
 */
async function decodeDoc(doc) {
  if (!doc?.cap) { renderAll(); return; }
  const channel = doc.channel;
  doc.cancel = false;
  doc.state = 'running';
  const pz = doc.meta?.source === 'powerz';
  /** 这段解码期间用户可能已经切走 —— 那就只把结果收进文档，一行界面都别动 */
  const visible = () => S === doc;
  renderTabs();
  showProgress(pz ? `正在解析通道 ${channel}…` : `正在解码通道 ${channel}…`,
    pz ? 'SQLite 事件流 → PD 报文' : 'BMC 位流 → 4B5B → PD 报文');

  /**
   * 进度有两个去处：界面那根进度条（只在本文档还激活时动），以及
   * `doc.progressCb`（命令行导出挂上来的旁路，把同一句话转成终端里的一行）。
   * 两者互不干扰，界面形态下 progressCb 是 null。
   */
  const report = (ratio, text) => {
    if (visible()) setProgress(ratio, text);
    doc.progressCb?.(ratio, text);
  };

  const t0 = performance.now();
  try {
    const { packets, stats } = pz
      ? await doc.cap.decode({
        shouldStop: () => doc.cancel,
        onProgress: (p) => {
          if (p.phase === 'read') report(0.30 + 0.30 * p.ratio, `读取事件行 ${Math.round(p.ratio * 100)}%`);
          else report(0.60 + 0.35 * p.ratio, `已解出 ${p.packets} 条`);
        },
      })
      : await decodeChannel(doc.cap, channel, {
        inflate,
        bitOrder: 'lsb',
        shouldStop: () => doc.cancel,
        onProgress: (p) => {
          report(0.3 + 0.65 * p.ratio, `分块 ${p.chunk}/${p.chunks} · 已解出 ${p.packets} 条`);
        },
      });

    // 中途被取消 / 被切走：结果作废，退回「待解析」，下次转回来重解
    if (doc.cancel || !visible()) { doc.state = 'ready'; return; }

    // 附上 VBUS / IBUS
    const bus = doc.cap.meta.bus;
    for (const p of packets) {
      let v = 0, i = 0;
      if (bus && bus.length) {
        let lo = 0, hi = bus.length - 1, ans = 0;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (bus[m].sample <= p.startSample) { ans = m; lo = m + 1; } else hi = m - 1; }
        v = bus[ans].vbus; i = bus[ans].ibus;
      }
      p.vbus = v; p.ibus = i;
      p.kind = kindOf(p);
    }
    pairAckTone(packets);   // GoodCRC 与它确认的报文同色

    doc.packets = packets;
    doc.stats = stats;
    doc.decodedMs = Math.round(performance.now() - t0);
    // 采样率以解码时定下来的为准（文件声明 / 波形实测 / 兜底），后面所有「采样点 → 秒」都用它
    if (stats.sampleRate > 0) doc.rate = stats.sampleRate;
    if (stats.sampleRateNote) toast(stats.sampleRateNote, 'warn');

    // 时间轴数据
    const total = stats.totalSamples || doc.cap.meta.totalSamples || 1;
    doc.busSeries = buildBusSeries(bus, total, doc.rate, 2400);
    doc.totalSamples = total;

    // 该协议只有容器、没有语义解析 → 明确说清，别让人以为解析失败。
    // 加载期记下的 loadNotice（比如「所有通道都像噪声线」）只在一条报文都没解出来时才顶上来，
    // 免得正常抓包上挂个多余提示。
    doc.notice = stats.unsupported
      ? { text: stats.unsupported, sub: `${stats.unsupportedMsgs} 条原始帧已读入，模拟量轨迹正常可用` }
      : (stats.ufcsUnlocatedRows
        ? {
          text: `${stats.ufcsUnlocatedRows} 行没能认出 UFCS 报文`,
          sub: `已解出 ${stats.packetCount} 条报文；这些行既不是 UFCS 报文、也不像状态事件，已跳过（不影响其余报文）`,
        }
        : (doc.loadNotice && !packets.length ? doc.loadNotice : null));
    doc.noticeOff = false;
    doc.selected = -1;
    doc.filters.tFrom = 0; doc.filters.tTo = 1;      // 换了文件/通道 → 时间窗口回到全时段
    doc.tlY = newTlY();                              // 纵轴的缩放/平移同理（量程变了，旧参数没意义）
    doc.state = 'done';

    setProgress(1, '完成');
    renderAll();
    toast(`解析完成 · ${packets.length} 条报文 · ${doc.decodedMs} ms`, 'ok');
  } finally {
    hideProgress();
    if (doc.state === 'running') doc.state = 'ready';
    renderTabs();
  }
}

/* ── 标签栏 ──────────────────────────────────────────── */

/**
 * 重画标签栏。只在打开了文件时出现 —— 一份都没开就让位给表格里的空态引导，
 * 免得顶着一排空标签。任一次整片重画都会把它带上，所以这里是唯一的标签渲染入口。
 */
function renderTabs() {
  closeTabMenu();
  const bar = $('#tabBar');
  const box = $('#tabs');
  bar.hidden = !DOCS.length;
  if (bar.hidden) box.replaceChildren();
  else {
    box.replaceChildren(...DOCS.map(tabEl));
    // 标签多了会横向滚动，保证当前这个始终看得见
    box.querySelector('.tab.is-on')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  syncAppbarChip();
}

/** 一个标签：状态点 + 文件名 + 报文数 + 关闭按钮 */
function tabEl(doc, i) {
  const t = el('div', 'tab');
  t.dataset.id = String(doc.id);
  t.dataset.name = doc.fileName;
  t.setAttribute('role', 'tab');
  t.setAttribute('aria-selected', String(doc === S));
  t.tabIndex = doc === S ? 0 : -1;
  t.title = tabTitle(doc, i);
  const on = doc === S;
  if (on) t.classList.add('is-on');
  if (doc.error) t.classList.add('is-err');
  else if (doc.state !== 'done') t.classList.add('is-idle');

  t.appendChild(el('i', 'tab-dot ' + tabTone(doc)));
  t.appendChild(el('span', 'tab-name', doc.fileName || '未命名'));
  const n = doc.state === 'done' ? doc.packets.length
    : doc.error ? null
      : doc.state === 'running' ? null
        : (doc.stats?.unsupportedMsgs ?? null);
  if (n != null) t.appendChild(el('span', 'tab-count', String(n)));

  const x = el('button', 'tab-x');
  x.type = 'button';
  x.title = '关闭这份抓包（中键也可以）';
  x.setAttribute('aria-label', `关闭 ${doc.fileName}`);
  x.innerHTML = '<svg viewBox="0 0 16 16" class="i"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  x.addEventListener('click', (e) => { e.stopPropagation(); closeDoc(doc); });
  t.appendChild(x);

  t.addEventListener('click', () => activateDoc(doc));
  t.addEventListener('auxclick', (e) => { if (e.button === 1) { e.preventDefault(); closeDoc(doc); } });
  t.addEventListener('contextmenu', (e) => { e.preventDefault(); openTabMenu(doc, e.clientX, e.clientY); });
  t.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); activateDoc(doc); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); closeDoc(doc); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      const j = i + (e.key === 'ArrowRight' ? 1 : -1);
      if (DOCS[j]) { e.preventDefault(); activateDoc(DOCS[j]); $('#tabs .tab.is-on')?.focus(); }
    }
  });
  return t;
}

/**
 * 标签状态点的语义：解出了报文=绿；有坏包、或协议语义未实现=黄；
 * 打不开=红；待解析=空心圈；正在解析=呼吸的蓝点。
 */
function tabTone(doc) {
  if (doc.error) return 'is-err';
  if (doc.state === 'running' || doc.pending) return 'is-busy';
  if (doc.state !== 'done') return 'is-idle';
  if (doc.stats?.badCrc || doc.stats?.unsupported) return 'is-warn';
  return 'is-ok';
}

function tabTitle(doc, i) {
  const parts = [`第 ${i + 1} / ${DOCS.length} 份`, doc.fileName];
  if (doc.fileSize) parts.push(fmtSize(doc.fileSize));
  if (doc.error) parts.push('打不开：' + doc.error);
  else if (doc.state === 'done') parts.push(`${doc.packets.length} 条报文 · 通道 ${doc.channel}`);
  else if (doc.state === 'running' || doc.pending) parts.push('正在解析…');
  else parts.push('尚未解析，点一下开始');
  return parts.join('  ·  ');
}

/**
 * 顶栏那枚文件 chip。
 * 与标签栏分工：标签栏会横向滚动、名字会截断，这枚不滚、悬停给全名，
 * 所以它始终能回答「当前看的到底是哪一份」。
 */
function syncAppbarChip() {
  const chip = $('#fileChip');
  const i = DOCS.indexOf(S);
  $('#fileName').textContent = S.fileName || '未打开抓包文件';
  chip.title = S.fileName
    ? `${S.fileName}  ·  ${fmtSize(S.fileSize)}`
    + (DOCS.length > 1 ? `  ·  第 ${i + 1} / ${DOCS.length} 份（点上方标签切换）` : '')
    : '还没打开抓包 · 可直接把文件拖进窗口（支持一次多份）';
  chip.classList.toggle('has', !!S.fileName);
}

/**
 * 关闭一个标签。
 * 关的是当前标签时，接着激活「右边那个，没有就左边那个」—— 编辑器的老规矩；
 * 全关光了就回到空白态（`S` 换成一份新的空白文档），而不是让指针悬空。
 */
function closeDoc(doc) {
  const i = DOCS.indexOf(doc);
  if (i < 0) return;
  if (doc.state === 'running') doc.cancel = true;
  DOCS.splice(i, 1);
  if (!DOCS.length) { S = newDoc(null); renderAll(); return; }
  if (S === doc) { S = null; activateDoc(DOCS[Math.min(i, DOCS.length - 1)]); }
  else renderTabs();
}

/** 关闭其他 / 关闭全部：攒完再渲染一次，别每关一个就整片重画 */
function closeOtherDocs(keep) {
  const drop = DOCS.filter((d) => d !== keep);
  if (!drop.length) return;
  for (const d of drop) if (d.state === 'running') d.cancel = true;
  DOCS.splice(0, DOCS.length, ...(keep ? [keep] : []));
  if (!DOCS.length) { S = newDoc(null); renderAll(); return; }
  if (S !== keep) { S = null; activateDoc(keep); } else renderTabs();
}

/* ── 标签右键菜单 ──────────────────────────────────────
   标签开多了以后「关掉除了这个以外的全部」是高频操作，光靠一个个点 × 太慢。 */
function openTabMenu(doc, x, y) {
  closeTabMenu();
  const m = el('div', 'ctxmenu');
  m.id = 'tabMenu';
  const item = (label, fn, disabled) => {
    const b = el('button', 'ctxmenu-item', label);
    b.type = 'button';
    b.disabled = !!disabled;
    b.addEventListener('click', () => fn());
    return b;
  };
  m.append(
    item('关闭', () => closeDoc(doc)),
    item('关闭其他', () => closeOtherDocs(doc), DOCS.length < 2),
    item('关闭全部', () => closeOtherDocs(null)),
  );
  document.body.appendChild(m);
  // 贴边时翻转，别让菜单跑出窗口
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 6)) + 'px';
  m.style.top = Math.max(4, Math.min(y + 2, innerHeight - r.height - 6)) + 'px';
}
function closeTabMenu() { $('#tabMenu')?.remove(); }
addEventListener('click', () => closeTabMenu());
addEventListener('resize', () => closeTabMenu());

/* ═══════════════════════ 整片重画 ═══════════════════════ */
/**
 * 把「当前文档」的全部界面重画一遍。
 *
 * 界面是共用的一副、文档是各自一份，所以每次换文档都必须整片重画，不能只改个标题：
 * 左侧筛选控件的勾选状态、时间轴标题、详情面板全都要跟着换人。
 */
function renderAll() {
  tlCancelDrag();        // 换文档/切标签时，上一份文档上没结束的拖拽不能带过来
  renderTabs();
  renderMeta();
  renderChannels();
  renderNotice();
  renderFilterSections();
  buildTypeList();
  syncFilterUI();
  applyFilters(true);
  renderTimelineHead();
  drawTimeline();
  renderDetailFor(S.selected);
  refitDetailW();
}

/* ── 筛选面板的协议自适应 ──────────────────────────────
   面板只有一副、协议有两套：链路一栏从「SOP 序列」换成「D+/D-」，类别去掉
   Extended/VDM、加上自定义，快速过滤与关键字按钮也换一批文案。
   每次整片重画都调一次 —— 重画本来就是「这份文件的一切都重来」的意思。 */
const UFCS_KEYWORDS = ['Request', 'Output_Capabilities', 'Power_Ready', 'Cable', 'Refuse', 'Verify'];
const PD_KEYWORDS = ['PPS', 'AVS', 'VID', 'Alert', 'CRC'];

function renderFilterSections() {
  const ufcs = isUfcs();

  $('#sopTitle').textContent = linkTitle();
  $('#catTitle').textContent = '报文类别';
  $('#thSop').textContent = ufcs ? '链路' : 'SOP';
  $('#thObj').textContent = ufcs ? '字节' : 'Obj';

  $('#fSop').innerHTML = linkValues()
    .map(([v, t]) => `<button class="chip is-on" data-v="${esc(v)}">${t}</button>`).join('');
  $('#fCat').innerHTML = catValues()
    .map(([v, t]) => `<button class="chip cat-${v.toLowerCase()} is-on" data-v="${v}">${t}</button>`).join('');

  $('#lbHideGoodCrc').textContent = ufcs ? '屏蔽 ACK / NCK 应答包' : '屏蔽 GoodCRC 心跳包';
  $('#lbOnlyPower').textContent = ufcs
    ? '只看功率协商（Output_Capabilities / Request）'
    : '只看功率协商（Source_Cap / Request / PPS）';
  $('#lbOnlyEnter').textContent = ufcs
    ? '只看信息上报（Source/Sink/Cable_Information）'
    : '只看状态切换（PS_RDY / VDM / Alert）';

  const kws = ufcs ? UFCS_KEYWORDS : PD_KEYWORDS;
  $('#kwRow').innerHTML = kws.map((k) => `<button class="btn tiny" data-kw="${esc(k)}">${esc(k)}</button>`).join('');
  $$('#kwRow [data-kw]').forEach((b) => b.addEventListener('click', () => {
    $('#fSearch').value = b.dataset.kw; S.filters.q = b.dataset.kw; applyFilters();
  }));

  $('#fSearch').placeholder = ufcs ? '消息名 / 命令编号 / 数据hex…' : '消息名 / 数据hex / 备注…';
}

/* ── 常驻提示条：讲清「这份文件为什么只解出一部分」这类事 ──
   目前 UFCS 抓到「既不是报文、也不像插拔」的行会走这里（定位不出容器前缀或残行）。
   另有 `stats.unsupported` 这条扩展路径留给将来「认得容器但还没写语义解析」的新协议。
   与 toast 的分工：toast 是「刚刚发生了什么」，会自己消失；
   提示条是「这份文件是什么情况」，在整个浏览过程中都成立，必须一直看得见。
   内容按文档存（`doc.notice`），所以切回来还在；点过「知道了」的记在 `noticeOff` 上。 */
function renderNotice() {
  const n = S.notice;
  const show = !!n && !S.noticeOff;
  $('#notice').hidden = !show;
  if (!show) return;
  $('#noticeText').textContent = n.text;
  $('#noticeSub').textContent = n.sub || '';
  $('#noticeSub').hidden = !n.sub;
}
$('#noticeClose').addEventListener('click', () => {
  S.noticeOff = true;
  renderNotice();
});

/**
 * 把「当前文档」的筛选状态推回左侧面板那副共用控件上。
 *
 * 切标签**必须**做这件事：面板只有一副，而筛选是每份文件各记一份，
 * 不推回去就会出现「勾着 A 的选项、筛的是 B 的数据」这种最难查的错。
 */
function syncFilterUI() {
  const f = S.filters;
  $$('#fRole .chip').forEach((c) => c.classList.toggle('is-on', f.roles.has(c.dataset.v)));
  $$('#fSop .chip').forEach((c) => c.classList.toggle('is-on', f.sops.has(c.dataset.v)));
  $$('#fCat .chip').forEach((c) => c.classList.toggle('is-on', f.cats.has(c.dataset.v)));
  $('#fHideGoodCrc').checked = f.hideGoodCrc;
  $('#fOnlyBad').checked = f.onlyBad;
  $('#fOnlyPower').checked = f.onlyPower;
  $('#fOnlyEnter').checked = f.onlyEnter;
  if ($('#fSearch').value !== f.q) $('#fSearch').value = f.q;
  $('#tFrom').value = Math.round(f.tFrom * 1000);
  $('#tTo').value = Math.round(f.tTo * 1000);
  $$('#viewSeg .seg-item').forEach((b) => b.classList.toggle('is-on', b.dataset.v === S.viewMode));
  $$('#msBody input').forEach((c) => (c.checked = f.types.has(c.value)));
  updateMsHead();
  $$('.th').forEach((x) => {
    const hit = x.dataset.k && x.dataset.k === S.sort.k;
    x.classList.toggle('sorted', !!hit);
    x.classList.toggle('asc', !!hit && S.sort.asc);
  });
  renderTimeHint();
}

/* ═══════════════════════ 顶栏元信息 / 通道 ═══════════════════════ */
// 采样率按量级选单位（ATK-C 是 2.5 MHz，POWER-Z 的 1 ms/采样点只有 1 kHz）——
// 实现与 CSV 导出摘要共用一份（src/js/core/csv.js），免得顶栏写 2.50 MHz、终端写 2500.00 kHz

function renderMeta() {
  syncAppbarChip();

  const box = $('#metaChips');
  box.innerHTML = '';
  if (!S.meta) {
    $('#btnExport').disabled = true;
    document.documentElement.dataset.source = '';
    if (S.error) {
      box.appendChild(Object.assign(el('span', 'mchip'),
        { innerHTML: `来源 <b style="color:var(--bad)">无法识别</b>` }));
    }
    return;
  }
  const m = S.meta;
  const pz = m.source === 'powerz';
  // 标注数据来源，CSS 也据此微调（例如时间轴标题前的方块颜色）
  document.documentElement.dataset.source = pz ? 'powerz' : 'atkcc';
  const add = (k, v) => box.appendChild(Object.assign(el('span', 'mchip'), { innerHTML: `${k} <b>${v}</b>` }));

  add('来源', pz ? esc(m.title) : 'ATK-C · .atkcc');

  // 时间基准 / 采样率：数值 + 来源标记。值不是写死的 —— ATK-C 来自 channel.ini 的声明，
  // 也可能由波形自检反推；POWER-Z 只有毫秒时间戳，按「1 采样点 = 1 ms」映射。
  const rate = S.rate || m.sampleRate;
  const src = S.stats?.sampleRateSource || m.sampleRateSource || 'declared';
  const tag = {
    declared: '文件声明', measured: '波形实测', default: '默认值',
    override: '手动指定', powerz: '分析仪时间戳',
  }[src] || src;
  const rateChip = el('span', 'mchip');
  rateChip.innerHTML = `采样率 <b>${fmtRate(rate)}</b>`
    + `<span class="mtag${src === 'measured' || src === 'override' ? ' warn' : ''}">${tag}</span>`;
  rateChip.title = S.stats?.sampleRateNote
    || (pz ? 'POWER-Z 只记录毫秒时间戳，时间轴按「1 采样点 = 1 ms」映射'
      : (m.sampleRateRaw ? `取自 channel.ini：${m.sampleRateRaw}` : '文件未声明采样率，用默认值'));
  box.appendChild(rateChip);

  const dur = (S.totalSamples || m.totalSamples) / rate;
  add('时长', dur >= 60 ? (dur / 60).toFixed(2) + ' min' : dur.toFixed(2) + ' s');

  if (S.packets.length) {
    add('报文', S.packets.length);
    if (S.stats?.badCrc) add('CRC 错误', `<span style="color:var(--bad)">${S.stats.badCrc}</span>`);
  } else if (pz && S.stats?.unsupportedMsgs) {
    add('原始帧', S.stats.unsupportedMsgs);
  }
  // 连接事件是分析仪导出独有的（ATK-C 只存波形，看不到 DFP/UFP 的插入动作）
  if (pz && (S.stats?.connectCount || S.stats?.disconnectCount)) {
    add('插拔', `${S.stats.connectCount ?? 0} / ${S.stats.disconnectCount ?? 0}`);
  }
  // UFCS 容器的「状态事件」行：既不是报文、也不是插拔，是分析仪记的链路状态变迁。
  // 语义尚未确证（只见过 0x02/0x03/0x04 三种，无规范可对照），所以只报条数 + 明细 tooltip，
  // 不硬起「插入/拔出」这种确定性的名字 —— 那会是无中生有。
  if (pz && S.stats?.ufcsEvents) {
    const chip = el('span', 'mchip');
    chip.innerHTML = `状态事件 <b>${S.stats.ufcsEvents}</b>`;
    chip.title = (S.stats.ufcsEventCodes ?? [])
      .map((c) => `opcode 0x${c.code.toString(16).toUpperCase().padStart(2, '0')} × ${c.n}`).join('　')
      + '\n容器约定、语义待确认（未见于规范）；已如实标注，不当作报文计入';
    box.appendChild(chip);
  }
  if (m.channels.length > 1) add('通道', m.channels.length);
}

function renderChannels() {
  const box = $('#chList');
  box.innerHTML = '';
  if (!S.meta) { $('#chHint').textContent = ''; return; }
  const m = S.meta;

  // 分析仪导出没有「通道」这个概念（一条 CC 线就是一条通路），给一张说明卡而不是可点的列表
  if (m.source === 'powerz') {
    const pz = S.stats;
    $('#chHint').textContent = '单通路';
    const b = el('div', 'chitem static is-on');
    b.innerHTML = `<b>${esc(m.protocol)}</b><span>${(pz?.tableRows ?? m.tableRows)} 行事件</span>`;
    b.title = `${m.title}｜SQLite ${m.sqlite.pageSize} B/页 · ${m.sqlite.pageCount} 页`
      + `｜ADC 采样 ${m.chartRows} 点｜时间轴纵轴 ${m.busLabels.join(' / ')}`;
    box.appendChild(b);
    return;
  }

  const chs = m.channels;
  $('#chHint').textContent = chs.length > 1 ? `${chs.length} 个通道（已按活动度排序）` : '';

  /** 活动度扫描结果（新格式是对象；老的纯数字也认，避免历史数据路径踩空） */
  const act = (ch) => {
    const v = S.chActivity.get(ch);
    return typeof v === 'number' ? { activity: v, edgeLike: 0 } : (v || { activity: 0, edgeLike: 0 });
  };

  const list = [...chs].sort((a, b) => act(b.channel).activity - act(a.channel).activity);
  for (const c of list) {
    const a = act(c.channel);
    const noisy = a.edgeLike > NOISE_EDGE_LIKE;
    const b = el('button', 'chitem' + (c.channel === S.channel ? ' is-on' : '') + (noisy ? ' is-noisy' : ''));
    b.innerHTML = `<b>CH${c.channel}</b><span>${c.chunks.length} 块</span>`
      + (S.chActivity.has(c.channel) ? `<span class="act">${a.activity}</span>` : '');
    b.title = `${c.totalSamples} 采样点 ≈ ${(c.totalSamples / (S.rate || S.meta.sampleRate)).toFixed(2)} s`
      + (S.chActivity.has(c.channel)
        ? `｜活动字节 ${a.activity}（${(a.edgeLike * 100).toFixed(1)}% 是混合字节${noisy ? '，像浮空/噪声线' : ''}）`
        : '');
    b.addEventListener('click', () => { if (c.channel !== S.channel) activateDoc(S, c.channel); });
    box.appendChild(b);
  }
}

/* ═══════════════════════ 筛选 ═══════════════════════ */
/**
 * 报文类型清单（筛选面板的「类型」多选）。
 *
 * 配色取自该类型**首条报文自己的语义类别**（`toneOf`，即协议解析出的 `msgKind`），
 * 而不是拿类型名去猜。名字是给人看的，不该反过来决定颜色：
 * 早先这里用一条「正则猜类别」的兜底，一旦协议表里改名（`PS RDY` → `PS_RDY`）
 * 或冒出正则没覆盖的类型，同一语义的报文就会在清单里被涂成两种颜色。
 * 现在颜色随报文走，改名不会再影响它，`guessKind()` 也随之删掉。
 */
function buildTypeList() {
  /** msgType → { n, kind }：同一类型名只可能来自同一类别，取首条即可 */
  const byType = new Map();
  for (const p of S.packets) {
    const e = byType.get(p.msgType);
    if (e) e.n++;
    else byType.set(p.msgType, { n: 1, kind: toneOf(p) });
  }
  const arr = [...byType.entries()].sort((a, b) => b[1].n - a[1].n || a[0].localeCompare(b[0]));

  const body = $('#msBody');
  body.innerHTML = '';
  for (const [t, { n, kind }] of arr) {
    const lab = el('label', 'ms-item');
    const cb = el('input'); cb.type = 'checkbox'; cb.value = t;
    // 勾选状态跟着「当前文档」走 —— 这份列表在每次切标签时都会重建，
    // 不还原就会出现「勾着的框没生效 / 生效的没勾」。
    cb.checked = S.filters.types.has(t);
    cb.addEventListener('change', () => {
      if (cb.checked) S.filters.types.add(t); else S.filters.types.delete(t);
      updateMsHead(arr.length);
      applyFilters();
    });
    const dot = el('span', 'dot');
    dot.style.background = catColor(kind);
    lab.append(cb, dot, el('span', '', t), el('span', 'cnt', String(n)));
    body.appendChild(lab);
  }
  updateMsHead(arr.length);
}
function catColor(k) {
  const map = { Control: 'ctrl', Data: 'data', Extended: 'ext', VDM: 'vdm', Custom: 'custom', Error: 'err' };
  const v = getComputedStyle(document.documentElement).getPropertyValue('--' + (map[k] || 'ctrl'));
  return v.trim() || '#888';
}
function updateMsHead(total) {
  const n = S.filters.types.size;
  $('#msHead').innerHTML = (n === 0 ? '全部类型' : `已选 ${n} 种`) + ` <span class="caret"></span>`;
}
$('#msHead').addEventListener('click', () => $('#msBody').classList.toggle('open'));
addEventListener('click', (e) => {
  if (!e.target.closest('#fType')) $('#msBody').classList.remove('open');
});

// 角色 / 链路 / 类别 chips
/**
 * 用**事件委托**绑在容器上，而不是逐个 chip 绑 —— 这几个容器会随协议整片重建
 * （见 renderFilterSections），逐个绑的话每次重建都要重绑，漏一次就点不动了。
 *
 * 注意改的是 `S.filters[key]` 这个**键**而不是 Set 本身：`S.filters` 每切一次标签
 * 就换一份，把 Set 引用抓下来，之后点 chip 改的就会一直是第一份文档的筛选集。
 */
function wireChips(sel, key) {
  $(sel).addEventListener('click', (e) => {
    const c = e.target.closest('.chip');
    if (!c || !c.dataset.v) return;
    const set = S.filters[key];
    const v = c.dataset.v;
    if (set.has(v)) { set.delete(v); c.classList.remove('is-on'); }
    else { set.add(v); c.classList.add('is-on'); }
    applyFilters();
  });
}
wireChips('#fRole', 'roles');
wireChips('#fSop', 'sops');
wireChips('#fCat', 'cats');

// 开关
const sw = (id, key) => $(id).addEventListener('change', (e) => { S.filters[key] = e.target.checked; applyFilters(); });
sw('#fHideGoodCrc', 'hideGoodCrc');
sw('#fOnlyBad', 'onlyBad');
sw('#fOnlyPower', 'onlyPower');
sw('#fOnlyEnter', 'onlyEnter');

// 搜索
let qTimer;
$('#fSearch').addEventListener('input', (e) => {
  clearTimeout(qTimer);
  qTimer = setTimeout(() => { S.filters.q = e.target.value.trim(); applyFilters(); }, 160);
});
$$('[data-kw]').forEach((b) => b.addEventListener('click', () => {
  $('#fSearch').value = b.dataset.kw; S.filters.q = b.dataset.kw; applyFilters();
}));

// 视图分段
$$('#viewSeg .seg-item').forEach((b) => b.addEventListener('click', () => {
  $$('#viewSeg .seg-item').forEach((x) => x.classList.remove('is-on'));
  b.classList.add('is-on');
  S.viewMode = b.dataset.v;
  applyFilters();
}));

// 排序
$$('.th').forEach((th) => th.addEventListener('click', () => {
  const k = th.dataset.k;
  if (!k) return;
  if (S.sort.k === k) S.sort.asc = !S.sort.asc; else { S.sort.k = k; S.sort.asc = true; }
  syncFilterUI();     // 表头的排序箭头（含清掉其它列）
  applyFilters();
}));

// 时间范围
function resetTimeRange() { S.filters.tFrom = 0; S.filters.tTo = 1; $('#tFrom').value = 0; $('#tTo').value = 1000; }
$('#tFrom').addEventListener('input', (e) => {
  const v = +e.target.value; if (v > +$('#tTo').value) $('#tTo').value = v;
  S.filters.tFrom = +$('#tFrom').value / 1000; S.filters.tTo = +$('#tTo').value / 1000; applyFilters();
});
$('#tTo').addEventListener('input', (e) => {
  const v = +e.target.value; if (v < +$('#tFrom').value) $('#tFrom').value = v;
  S.filters.tFrom = +$('#tFrom').value / 1000; S.filters.tTo = +$('#tTo').value / 1000; applyFilters();
});
$('#btnClearTime').addEventListener('click', () => { resetTimeRange(); applyFilters(); });
$('#btnCurView').addEventListener('click', applyTimeRangeFromView);

/** 重置当前文档的全部筛选（只影响这一份，其它标签各自的筛选原样保留） */
$('#btnReset').addEventListener('click', () => {
  // 默认值必须跟着**当前文件的协议**走。写死 newFilters() 就等于拿 PD 的
  // SOP / 类别白名单去筛 UFCS —— D+ / D- / Data 一个都不在里面，
  // 一按重置整张列表会连同搜索框一起被清空。
  S.filters = newFilters(S.meta?.protocol);
  S.viewMode = 'all';
  syncFilterUI();
  applyFilters();
});

/* ── 过滤核心 ── */
function applyFilters(keepScroll) {
  const f = S.filters;
  const tb = S.totalSamples || 1;
  const q = f.q.toLowerCase();
  const out = [];
  for (const p of S.packets) {
    if (!f.roles.has(p.role)) continue;
    if (!f.sops.has(p.sop)) continue;
    if (!f.cats.has(p.kind)) continue;
    if (f.types.size && !f.types.has(p.msgType)) continue;
    if (f.hideGoodCrc && isAutoAck(p)) continue;
    if (f.onlyBad && p.crcOk !== false) continue;
    if (f.onlyPower && !isPowerType(p.msgType)) continue;
    if (f.onlyEnter && !isEnterType(p.msgType)) continue;
    const t = p.startSample / tb;
    if (t < f.tFrom - 1e-9 || t > f.tTo + 1e-9) continue;
    if (q) {
      const hay = (p.msgType + ' ' + (p.summary || '') + ' ' + (p.dataHex || '') + ' ' + p.sop + ' ' + p.role).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    if (S.viewMode === 'neg' && !(isPowerType(p.msgType) || isEnterType(p.msgType))) continue;
    if (S.viewMode === 'err' && p.crcOk !== false) continue;
    out.push(p);
  }

  // 排序
  const k = S.sort.k, dir = S.sort.asc ? 1 : -1;
  out.sort((a, b) => {
    let x = a[k], y = b[k];
    if (x == null) x = -1; if (y == null) y = -1;
    if (typeof x === 'string') return dir * x.localeCompare(y);
    return dir * (x - y);
  });

  S.view = out;
  updateCounters();
  if (!keepScroll) $('#tbody').scrollTop = 0;
  renderTable();
  renderTimeHint();
}

function updateCounters() {
  const c = { SRC: 0, SNK: 0, Plug: 0 };
  for (const p of S.packets) if (c[p.role] != null) c[p.role]++;
  $('#cSrc').textContent = c.SRC; $('#cSnk').textContent = c.SNK; $('#cPlug').textContent = c.Plug;

  const total = S.packets.length, shown = S.view.length;
  const bad = S.packets.filter((p) => p.crcOk === false).length;
  // 分析仪只存到数据对象为止，不记 CRC（见 core/powerz.js）——
  // 这种情况必须说「未记录」，不能笼统地报「全通过」。
  const unknown = S.packets.filter((p) => p.crcOk === null).length;

  const crc = bad ? ` · <span class="bad">CRC 错误 ${bad}</span>`
    : unknown && unknown === total ? ' · <span style="color:var(--tx-3)">CRC 未记录（分析仪不存）</span>'
      : unknown ? ` · <span style="color:var(--tx-3)">CRC 未知 ${unknown}</span>`
        : ' · <span style="color:var(--ok)">CRC 全通过</span>';

  let line;
  if (S.packets.length) {
    line = `显示 <b>${shown}</b> / ${total} 条报文`
      + (shown !== total ? ` <span style="color:var(--tx-3)">（已屏蔽 ${total - shown} 条）</span>` : '')
      + crc
      + (S.decodedMs ? ` · <span style="color:var(--tx-3)">解码 ${S.decodedMs} ms</span>` : '');
  } else if (S.error) {
    line = `打不开这份文件：<span class="bad">${esc(S.error)}</span>`;
  } else if (S.state === 'running' || S.pending) {
    line = '<span style="color:var(--tx-3)">正在解析…</span>';
  } else if (S.state === 'ready') {
    line = '这份抓包还没解析，点一下上方标签即可开始';
  } else if (S.meta?.source === 'powerz') {
    // 载入了文件但一条报文都没有：两种情况，话术不一样
    if (S.stats?.unsupported) {
      line = `已读入 <b>${S.stats.unsupportedMsgs ?? 0}</b> 条原始帧 · <span style="color:var(--warn)">${esc(S.meta.protocol)} 语义解析未实现</span>`;
    } else if (S.stats?.ufcsUnlocatedRows) {
      line = `已读入 <b>${S.stats.ufcsUnlocatedRows}</b> 行，但没有一行能认出 ${esc(S.meta.protocol)} 报文`;
    } else {
      line = `已读入分析仪导出，但其中没有可解析的报文`;
    }
  } else {
    line = '等待打开抓包文件…';
  }
  $('#statLine').innerHTML = line;
  $('#btnExport').disabled = !S.packets.length;
}
function renderTimeHint() {
  const tb = S.totalSamples || 1;
  const f = S.filters;
  $('#tRangeHint').textContent = (f.tFrom > 0 || f.tTo < 1)
    ? `${(f.tFrom * tb / (S.rate || 1)).toFixed(2)}–${(f.tTo * tb / (S.rate || 1)).toFixed(2)} s`
    : '';
}
function applyTimeRangeFromView() {
  if (!S.view.length) return;
  const tb = S.totalSamples || 1;
  const a = Math.min(...S.view.map((p) => p.startSample)) / tb;
  const b = Math.max(...S.view.map((p) => p.endSample)) / tb;
  S.filters.tFrom = a; S.filters.tTo = b;
  $('#tFrom').value = Math.round(a * 1000); $('#tTo').value = Math.round(b * 1000);
  applyFilters();
}

/* ═══════════════════════ 报文表（虚拟滚动） ═══════════════════════ */
const OVERSCAN = 8;

/**
 * 空列表时说清「为什么空」——四种情况话术完全不同，混用会让人以为解析失败：
 *   · 还没开文件       → 介绍支持的格式
 *   · 文件打不开       → 说清是哪一步失败（格式不认识 / 容器坏了）
 *   · 开了但 0 条报文  → 多半是协议未实现语义解析（UFCS）
 *   · 有报文但被筛没   → 提示放宽筛选
 */
function setEmptyState(kind, extra) {
  const t = $('#emptyTitle'), p = $('#emptyText'), n = $('#emptyNote');
  const btns = $('#emptyBtns');
  btns.style.display = 'flex';
  if (kind === 'filtered') {
    t.textContent = '当前筛选条件下没有报文';
    p.textContent = '试试放宽左侧的方向 / 类型 / 时间筛选，或点「重置全部筛选」。';
    n.textContent = '';
    n.hidden = true;
    return;
  }
  if (kind === 'failed') {
    t.textContent = '这份文件打不开';
    p.textContent = extra || '无法识别它的格式。';
    n.textContent = '只认 ATK-C 的 .atkcc（ZIP 容器）与 POWER-Z 的 .sqlite（SQLite 库）—— 按文件内容判断，不看扩展名。';
    n.hidden = false;
    return;
  }
  if (kind === 'pending') {
    t.textContent = '正在解析这份抓包';
    p.textContent = '解析完成后这里会列出解出的报文。';
    n.textContent = '';
    n.hidden = true;
    return;
  }
  if (kind === 'unsupported') {
    t.textContent = `${extra || '该协议'} 抓包已载入，但语义解析未实现`;
    p.textContent = '报文容器与 VBUS / IBUS / 差分线模拟量轨迹已正常读出，可以直接在下方时间轴上看电压电流曲线。';
    n.textContent = '报文列表需要该协议的规范才能逐字段还原，本工程目前只覆盖 USB PD 与 UFCS。';
    n.hidden = false;
    return;
  }
  if (kind === 'noframe') {
    t.textContent = `${extra || '该抓包'} 里没有认出报文`;
    p.textContent = '文件里的每一行都读过了，但既不像 UFCS 报文（消息头 + CRC-8 对不上）、也不像状态事件。';
    n.textContent = '模拟量轨迹仍然可用；如果这条线路上确实跑着 UFCS，请把样本发来核对容器格式。';
    n.hidden = false;
    return;
  }
  if (kind === 'nomsg') {
    t.textContent = '这份导出里没有可解析的报文';
    p.textContent = '模拟量轨迹仍然可用，请在下方时间轴查看。';
    n.textContent = '';
    n.hidden = true;
    return;
  }
  t.textContent = '打开一份 PD 抓包文件';
  p.innerHTML = '支持正点原子 ATK-C 的 <b>.atkcc</b>（原始电平采样，走 BMC → 4B5B 解码）'
    + '与 POWER-Z 的 <b>.sqlite</b>（分析仪已解好的逻辑字节），两者解析后逐字段溯源。';
  n.textContent = '也可以把文件直接拖进窗口 —— 一次拖多份，每份各占一个标签页';
  n.hidden = false;
}

function renderTable() {
  const tbody = $('#tbody');
  const vph = $('#vph'), vrows = $('#vrows');
  const n = S.view.length;

  if (!n) {
    $('#emptyState').style.display = 'flex';
    if (S.error) setEmptyState('failed', S.error);
    else if (!S.meta) setEmptyState('none');
    else if (!S.packets.length) {
      if (S.state === 'ready' || S.pending) setEmptyState('pending');
      else if (S.stats?.unsupported) setEmptyState('unsupported', S.meta.protocol);
      else if (S.stats?.kind === 'ufcs' && S.stats?.ufcsUnlocatedRows) setEmptyState('noframe', S.meta.protocol);
      else setEmptyState('nomsg');
    } else setEmptyState('filtered');
    vph.style.height = '0px'; vrows.innerHTML = ''; vrows.style.transform = 'translateY(0)';
    return;
  }
  $('#emptyState').style.display = 'none';
  const RH = UI.rowH;
  vph.style.height = n * RH + 'px';

  const top = tbody.scrollTop;
  const h = tbody.clientHeight;
  let start = clamp(Math.floor(top / RH) - OVERSCAN, 0, Math.max(0, n - 1));
  let end = clamp(Math.ceil((top + h) / RH) + OVERSCAN, 0, n);

  vrows.style.transform = `translateY(${start * RH}px)`;
  const frag = document.createDocumentFragment();
  for (let i = start; i < end; i++) frag.appendChild(rowEl(S.view[i], i));
  vrows.replaceChildren(frag);
}
let rafPending = false;
$('#tbody').addEventListener('scroll', () => {
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => { rafPending = false; renderTable(); });
});

function rowEl(p, i) {
  const r = el('div', 'tr' + (i === S.selected ? ' sel' : '') + (p.crcOk === false ? ' bad' : ''));
  r.dataset.i = i;
  const cls = CAT_CLASS[p.tone] || '';
  const hex = p.dataHex || '';
  const note = highlight(p.summary || '');
  // GoodCRC 取被确认报文的颜色，悬停提示它确认的是哪一条
  const tip = p.ackOf != null ? ` title="确认 #${p.ackOf} · ${p.ackType || ''}"` : '';
  r.innerHTML =
    `<div class="td num">${p.index}</div>`
  + `<div class="td"><span class="pill sop">${esc(p.sop)}</span></div>`
  + `<div class="td type ${cls}"${tip}>${esc(p.msgType)}</div>`
  + `<div class="td num">${p.msgId ?? ''}</div>`
  + `<div class="td"><span class="pill ${p.role}">${esc(p.role)}</span></div>`
  + `<div class="td num">${p.protocol === 'UFCS' ? (p.dataLen ?? '') : (p.nObjects ?? '')}</div>`
  + `<div class="td time">${fmtTime(p.timeMs)}</div>`
  + `<div class="td bus">${p.vbus.toFixed(3)} V <em>/</em> ${p.ibus.toFixed(3)} A</div>`
  + `<div class="td mono">${highlightHex(hex)}</div>`
  + `<div class="td note">${note || (p.crcOk === false ? '<span style="color:var(--err)">CRC 校验失败</span>' : '')}</div>`;
  r.addEventListener('click', () => select(i, true));
  r.addEventListener('dblclick', () => { document.body.classList.remove('detail-collapsed'); select(i, true); });
  return r;
}
function highlight(s) {
  if (!S.filters.q || !s) return esc(s);
  const q = S.filters.q;
  const idx = s.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return esc(s);
  return esc(s.slice(0, idx)) + '<span class="mark">' + esc(s.slice(idx, idx + q.length)) + '</span>' + esc(s.slice(idx + q.length));
}
function highlightHex(h) {
  if (!h) return '';
  if (!S.filters.q) return esc(h);
  const q = S.filters.q.replace(/\s+/g, '').toLowerCase();
  const flat = h.replace(/\s+/g, '').toLowerCase();
  if (!q || !flat.includes(q)) return esc(h);
  return '<b>' + esc(h) + '</b>';
}

/* ═══════════════════════ 选中 & 详情 ═══════════════════════ */
function select(i, scrollIntoView) {
  S.selected = i;
  const p = S.view[i];
  if (!p) return;
  document.body.classList.remove('detail-collapsed');
  $$('#vrows .tr').forEach((r) => r.classList.toggle('sel', +r.dataset.i === i));
  if (scrollIntoView) {
    const tbody = $('#tbody'), RH = UI.rowH, top = tbody.scrollTop, h = tbody.clientHeight;
    const y = i * RH;
    if (y < top + RH) tbody.scrollTop = Math.max(0, y - RH * 2);
    else if (y + RH > top + h) tbody.scrollTop = y + RH * 3 - h;
  }
  renderDetail(p);
  if ($('#tlFollow').checked) drawTimeline(p);
}

/**
 * 详情面板按「当前文档的第 i 条」重画。
 * 切换标签时也要走它：每份抓包各自记着自己的选中项，切回来得跟过去一致；
 * 没选中（或筛掉了 / 零报文）就回到引导文案，别留着上一份文件的字段解析。
 */
function renderDetailFor(i) {
  const p = S.view[i];
  if (p) renderDetail(p);
  else $('#detailBody').innerHTML = '<div class="detail-empty">点击左侧任意报文查看逐位解析</div>';
}
function navDetail(d) {
  if (!S.view.length) return;
  let i = S.selected + d;
  if (i < 0) i = 0; if (i >= S.view.length) i = S.view.length - 1;
  select(i, true);
}
$('#btnDetailNavPrev').addEventListener('click', () => navDetail(-1));
$('#btnDetailNavNext').addEventListener('click', () => navDetail(1));
$('#btnDetailClose').addEventListener('click', () => document.body.classList.add('detail-collapsed'));
/**
 * 展开详情面板。存在的理由是「收起之后得有路回来」：
 * 重开的常规路径是 `select()`（点列表里的报文）里去掉 `detail-collapsed`，
 * 但零报文的抓包（UFCS 这类未实现语义的协议）列表本来就是空的，
 * 点不到任何行 ⇒ 面板收起来就永久丢失。所以给一个不依赖数据的入口。
 */
$('#btnDetailOpen').addEventListener('click', () => {
  document.body.classList.remove('detail-collapsed');
  refitDetailW();               // 展开后可用宽度变了，夹一次
  scheduleTimelineDraw();       // 中间表格随之变窄，画布要重画
});

function renderDetail(p) {
  const box = $('#detailBody');
  const cls = CAT_CLASS[p.tone] || '';
  const h = [];
  const ufcs = p.protocol === 'UFCS';
  const revLabel = ufcs ? `UFCS ${p.revText || ''}`.trim() : `r${p.rev}`;

  h.push(`<div class="dhero ${p.crcOk === false ? 'dhero-bad' : ''}">
    <div class="t1 ${cls}">${esc(p.msgType)}</div>
    <div class="t2">#${p.index} · ${esc(p.sop)} · ${esc(p.role)} · ID ${p.msgId ?? '-'} · ${esc(revLabel)} · ${fmtTime(p.timeMs)}`
    + (p.synthetic ? '<span class="srcbadge">分析仪逻辑字节</span>' : '') + `</div>
  </div>`);

  if (p.warnings?.length) {
    for (const w of p.warnings) h.push(`<div class="dwarn err"><b>!</b><span>${esc(w.long || w.short || w)}</span></div>`);
  }

  // 概览
  h.push(`<div class="dsec"><h5>链路概览</h5><div class="dgrid">
    ${cell('VBUS', p.vbus.toFixed(3) + ' V')}
    ${cell('IBUS', p.ibus.toFixed(3) + ' A')}
    ${cell('起始时间', fmtTime(p.timeMs))}
    ${cell(p.bitrateNominal ? '线上时长' : '报文时长', p.durationUs.toFixed(1) + ' µs')}
    ${cell(ufcs ? '数据长度' : '数据对象', ufcs ? `${p.dataLen ?? 0} B` : String(p.nObjects ?? 0))}
    ${cell(p.bitrateNominal ? (ufcs ? '标称波特率' : 'BMC 码率') : '实测码率', (p.bitrate / 1000).toFixed(1) + ' kbps')}
    ${cell('CRC', p.crcOk === null ? '未记录（分析仪不存）' : p.crcOk ? '通过' : '校验失败')}
    ${p.ackOf != null ? cell(ufcs ? '应答的报文' : '确认的报文', `#${p.ackOf} · ${p.ackType || ''}`) : ''}
  </div></div>`);

  // 报文头位域：两种协议的 16 bit 头结构完全不同，各画各的
  if (ufcs) {
    const u = p.ufcs || {};
    h.push(`<div class="dsec"><h5>消息头 (16 bit)</h5><div class="dbits">
      ${bit('B15-13', '设备地址', bid(p.header, 13, 15), `${u.addrText || ''}（接收方）`)}
      ${bit('B12-9', '消息编号', bid(p.header, 9, 12), String(p.msgId ?? 0))}
      ${bit('B8-3', '协议版本编号', bid(p.header, 3, 8), `UFCS ${p.revText || ''}`)}
      ${bit('B2-0', '消息类型', bid(p.header, 0, 2), `${p.msgKind === 'custom' ? '自定义消息' : p.msgKind === 'data' ? '数据消息' : '控制消息'} · 命令 0x${(p.msgTypeRaw ?? 0).toString(16).toUpperCase().padStart(2, '0')}`)}
    </div></div>`);
  } else {
    h.push(`<div class="dsec"><h5>报文头 (16 bit)</h5><div class="dbits">
      ${bit('B15', 'Extended', bid(p.header, 15, 15), p.msgKind === 'ext' ? '扩展消息' : '标准消息')}
      ${bit('B14-12', 'Object 数', bid(p.header, 12, 14), String(p.nObjects ?? 0))}
      ${bit('B11-9', 'Message ID', bid(p.header, 9, 11), String(p.msgId ?? 0))}
      ${bit('B8', 'Power Role', bid(p.header, 8, 8), p.powerRole ? '1 · Source' : '0 · Sink')}
      ${bit('B7-6', 'Spec Revision', bid(p.header, 6, 7), `${bid(p.header, 6, 7)} · PD ${p.rev === 3 ? '3.x' : '2.0'}`)}
      ${bit('B5', 'Data Role', bid(p.header, 5, 5), p.dataRole ? '1 · DFP' : '0 · UFP')}
      ${bit('B4-0', 'Message Type', bid(p.header, 0, 4), `${p.msgTypeRaw ?? 0} · ${p.msgType}`)}
    </div></div>`);
  }

  if (p.extHeader != null) {
    h.push(`<div class="dsec"><h5>扩展报文头 (16 bit)</h5><div class="dbits">
      ${bit('B15', 'Chunked', bid(p.extHeader, 15, 15), (p.extHeader >> 15) & 1 ? '分块' : '不分块')}
      ${bit('B14-11', 'Chunk Number', bid(p.extHeader, 11, 14), String((p.extHeader >> 11) & 0xf))}
      ${bit('B10', 'Request Chunk', bid(p.extHeader, 10, 10), String((p.extHeader >> 10) & 1))}
      ${bit('B9-0', 'Data Size', bid(p.extHeader, 0, 9), String(p.extHeader & 0x3ff) + ' B')}
    </div></div>`);
  }

  // 原始数据
  if (p.dataHex) {
    h.push(`<div class="dsec"><h5>${ufcs ? '整帧字节 (hex)' : '数据对象 (hex)'}</h5><div class="dobj"><div class="dobj-b hx">${esc(p.dataHex)}</div></div></div>`);
  }

  // 逐字段解析（按 Object 分组，每组一个配色，便于区分相邻的 VDO / PDO / 数据对象）
  const groups = groupDetails(p.details || []);
  let gi = 0;
  for (const g of groups) {
    h.push(g.title
      ? dgroupHtml(g.title, g.items, gi++)
      : dgroupHtml('字段解析', g.items, null));
  }

  h.push(`<div class="dsec"><h5>解析文本</h5><div class="dobj"><div class="dobj-b hx">${esc(p.text || '')}</div></div></div>`);

  box.innerHTML = h.join('');
  box.scrollTop = 0;
}
const cell = (k, v) => `<div class="dcell"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`;
function bid(v, lo, hi) { const n = hi - lo + 1; return '0b' + (((v ?? 0) >> lo) & ((1 << n) - 1)).toString(2).padStart(n, '0'); }
function bit(name, label, raw, dec) {
  return `<div class="dbit"><div class="bk">${esc(name)} · ${esc(label)}</div><div class="bv"><u>${esc(raw)}</u> → ${esc(dec)}</div></div>`;
}
/** 把扁平 details 按 "Object: PDO #n" 切成组 */
function groupDetails(details) {
  const groups = [];
  let cur = null;
  for (const d of details) {
    if (d.key === 'Object' || d.key === '对象') {
      cur = { title: String(d.value), items: [] };
      groups.push(cur);
      continue;
    }
    if (!cur) { cur = { title: null, items: [] }; if (!groups.includes(cur)) groups.push(cur); }
    cur.items.push([d.key, d.value]);
  }
  return groups.filter((g) => g.items.length || g.title);
}

/* ── 详情分组配色 ──────────────────────────────────────
   相邻分组用不同色相区分（8 色循环），这样一屏里的
   多个 VDO / PDO / 数据对象不用读标题也能看出边界。
   具体颜色在 styles.css 的 .dg-0…​.dg-7 里，深浅主题各一套。 */
const DGROUP_HUES = 8;

/**
 * 渲染一个详情分组。
 * @param {string} title 分组标题
 * @param {Array<[string,string]>} items 字段行
 * @param {number|null} idx 配色序号；null 表示不着色（通用字段）
 */
function dgroupHtml(title, items, idx) {
  const cls = idx == null ? 'dsec' : `dsec dg dg-${idx % DGROUP_HUES}`;
  const rows = items
    .map(([k, v]) => `<div class="dbit"><div class="bk">${esc(k)}</div><div class="bv">${esc(v)}</div></div>`)
    .join('');
  return `<div class="${cls}"><h5><i class="gd"></i><span>${esc(title)}</span><i class="gl"></i></h5>`
    + `<div class="dbits">${rows}</div></div>`;
}

/* ═══════════════════════ 时间轴 ═══════════════════════ */
const cv = $('#busCanvas');
let TL = { x0: 0, y0: 0, w: 0, h: 0, drag: null };

/** Y 轴视图的两套默认值（power / aux），每份文档各持一份 */
function newTlY() {
  return { power: { z: 1, o: 0 }, aux: { z: 1, o: 0 } };
}

/** 当前文档 + 当前档位对应的 Y 视图参数 */
function tlView() {
  if (!S.tlY) S.tlY = newTlY();
  const k = S.tlMode === 'aux' ? 'aux' : 'power';
  if (!S.tlY[k]) S.tlY[k] = { z: 1, o: 0 };
  return S.tlY[k];
}

/**
 * 缩放/平移的合法区间。
 *
 * 缩放给到 ×0.25（整条曲线缩成下四分之一，看长时间的整体走势）到 ×200（放大看某个台阶的抖动）；
 * 平移以「自适应满量程」为单位，允许往下露半个量程、往上最多三个量程 —— 再远就是一片空白，
 * 徒增「我是不是把图拖丢了」的困惑（双击或「复位视图」一键回来）。
 */
const TL_Z_MIN = 0.25, TL_Z_MAX = 200;
function clampTlY(v) {
  v.z = clamp(v.z, TL_Z_MIN, TL_Z_MAX);
  // 可见窗口顶端 = o + 1/z，别让它超过 4 个量程；底端不低于 −0.5
  const hi = Math.max(-0.5, Math.min(3, 4 - 1 / v.z));
  v.o = clamp(v.o, -0.5, hi);
  return v;
}

const tlDirty = (v = tlView()) => Math.abs(v.z - 1) > 1e-3 || Math.abs(v.o) > 1e-3;

/** 「复位视图」按钮的两种状态：没动过就是普通样式，动过就点亮并说明当前倍率 */
function syncTlYUI() {
  const btn = $('#btnTlFit');
  if (!btn) return;
  const v = tlView();
  const dirty = tlDirty(v);
  btn.classList.toggle('is-dirty', dirty);
  btn.title = dirty
    ? `纵轴已调整：放大 ×${v.z.toFixed(2)}、偏移 ${v.o >= 0 ? '+' : ''}${v.o.toFixed(2)}`
      + ' —— 点这里复位；也可以双击曲线区，或 Ctrl+滚轮缩放 / 上下拖动平移'
    : 'Ctrl+滚轮缩放纵轴、上下拖动（或右键拖动、拖左右刻度栏）平移纵轴、双击复位；'
      + '点这里把时间与纵轴一起回到全览。曲线区本身的高度请拖它上方那条分隔条';
}

/**
 * 时间轴当前该画哪一对曲线。
 *
 * ATK-C 的 bus.ini 只有 VBUS / IBUS；POWER-Z 的 `pd_chart` 还多两路
 * （PD 是 CC1/CC2，UFCS 是 DP/DM，名字见 `meta.busLabels`）。
 * 这两路的量程与 VBUS 差一个数量级（3V 对 20V），叠在同一根纵轴上会糊成一条线，
 * 所以做成「两档视图」而不是叠加，纵轴刻度、提示文本都跟着换。
 */
function tlCurves() {
  const s = S.busSeries;
  if (!s || !s.n) return null;
  if (S.tlMode === 'aux' && s.hasAux) {
    const [la, lb] = S.meta?.busLabels ?? ['A', 'B'];
    return {
      aux: true,
      title: `${la} / ${lb} 时间轴`,
      lName: la, rName: lb,
      l: s.ca, r: s.cb,
      lmax: Math.max(0.5, s.camax * 1.12),
      rmax: Math.max(0.5, s.cbmax * 1.12),
      lUnit: 'V', rUnit: 'V',
      lDigits: 3, rDigits: 3,
      lColor: '--plug', rColor: '--snk',
    };
  }
  return {
    aux: false,
    title: 'VBUS / IBUS 时间轴',
    lName: 'VBUS', rName: 'IBUS',
    l: s.vbus, r: s.ibus,
    lmax: Math.max(5, s.vmax * 1.12),
    rmax: Math.max(0.5, s.imax * 1.12),
    lUnit: 'V', rUnit: 'A',
    lDigits: 1, rDigits: 2,
    lColor: '--accent', rColor: '--data',
  };
}

/** 时间轴标题 + 「电压/电流 ↔ 差分线」两档切换（后者只有分析仪导出才有数据） */
function renderTimelineHead() {
  const seg = $('#tlSeg');
  const cur = tlCurves();
  $('#tlTitle').textContent = cur ? cur.title : 'VBUS / IBUS 时间轴';
  const labels = S.meta?.busLabels ?? [];
  const hasAux = !!S.busSeries?.hasAux && labels.length === 2;
  // 档名跟着文件给的两路名字走：PD 是 CC 线，UFCS 是 DP / DM
  $('#tlSegAux').textContent = labels[0] === 'CC1' ? 'CC 线' : labels.join(' / ');
  seg.hidden = !hasAux;
  if (!hasAux) S.tlMode = 'power';
  $$('#tlSeg .seg-item').forEach((b) => b.classList.toggle('is-on', b.dataset.v === S.tlMode));
  syncTlYUI();                 // 切档 / 换文档后，「复位视图」按钮要反映当前档的纵轴状态
}
$$('#tlSeg .seg-item').forEach((b) => b.addEventListener('click', () => {
  S.tlMode = b.dataset.v;
  renderTimelineHead();
  drawTimeline();
}));

function drawTimeline(selPkt) {
  const s = S.busSeries;
  const box = cv.parentElement;
  const w = box.clientWidth || 600;
  const hgt = Math.max(60, box.clientHeight - 28);
  const dpr = window.devicePixelRatio || 1;
  cv.width = Math.round(w * dpr); cv.height = Math.round(hgt * dpr);
  cv.style.height = hgt + 'px';
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, hgt);

  const cs = getComputedStyle(document.documentElement);
  const cLine = cs.getPropertyValue('--line').trim();
  const cTx3 = cs.getPropertyValue('--tx-3').trim();
  const cAccent = cs.getPropertyValue('--accent').trim();
  const cSnk = cs.getPropertyValue('--snk').trim();
  const cSrc = cs.getPropertyValue('--src').trim();
  const cPlug = cs.getPropertyValue('--plug').trim();

  const padL = 42, padR = 42, padT = 8, padB = 18;
  const x0 = padL, y0 = padT, W = Math.max(10, w - padL - padR), H = Math.max(10, hgt - padT - padB);
  // 用展开更新几何，把 `drag` 一起带过去。**不能写成字面量** `TL = { x0, y0, ... }`：
  // 拖动过程中会调 drawTimeline 画预览，一换对象就把 TL.drag 抹掉，横向刷选当场自毁
  // （预览那一步还会读 TL.drag.x 抛异常）。
  TL = { ...TL, x0, y0, w: W, h: H };
  TL.axisBandTop = y0 + H;      // 横轴时间标签所在那条带子的上沿（CSS px）

  // 网格（横向：值刻度）
  g.strokeStyle = cLine; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = y0 + (H * i) / 4;
    g.beginPath(); g.moveTo(x0, y + .5); g.lineTo(x0 + W, y + .5); g.stroke();
  }

  /* ── 横轴：时间刻度 ──────────────────────────────────
   * 以前底下那条 padB 带子是留白，整条时间轴只有左右两个值刻度、看不到时间。
   * 这里补上五等分的时间标签 + 对应位置的淡竖线（竖线画在曲线之前，不压曲线）。
   * 单位随时长自适应：0.17s 的抓包标「0ms…170ms」，几秒的标「0.00s…2.50s」，
   * 超过一分钟标「0:00…1:23」—— 一律写死秒的话短抓包五格全是同一个数。
   */
  const totalSec = (S.totalSamples || 0) / (S.rate || 1);
  const xTicks = [];
  if (totalSec > 0) {
    for (let i = 0; i <= 4; i++) {
      const t = i / 4, x = x0 + t * W;
      xTicks.push({ t, sec: t * totalSec, label: fmtAxisTime(t * totalSec, totalSec), x });
      if (i > 0 && i < 4) {                  // 首尾两条与纵轴重叠，不画
        g.strokeStyle = hexA(cLine, .75);
        g.beginPath(); g.moveTo(x + .5, y0); g.lineTo(x + .5, y0 + H); g.stroke();
      }
    }
    g.fillStyle = cTx3; g.font = '10px ui-monospace, monospace'; g.textAlign = 'center';
    for (const tk of xTicks) g.fillText(tk.label, tk.x, y0 + H + 13);
  }
  TL.xTicks = xTicks;

  const cur = tlCurves();
  if (!cur) {
    g.fillStyle = cTx3; g.font = '11px sans-serif'; g.textAlign = 'left';
    g.fillText(S.cap ? '这份抓包没有模拟量轨迹数据' : '打开抓包后显示 VBUS / IBUS', x0 + 8, y0 + H / 2);
    return;
  }

  const themeVar = { '--accent': cAccent, '--data': cs.getPropertyValue('--data').trim(), '--plug': cPlug, '--snk': cSnk };
  const colL = themeVar[cur.lColor] || cAccent;
  const colR = themeVar[cur.rColor] || cAccent;

  const N = s.n;
  // N === 1（只有单个采样点，例如只导出一行 ADC 数据的分析仪文件）时 `i/(N-1)` 是 0/0 = NaN，
  // Canvas 遇到 NaN 会把整条路径丢掉 —— 网格和刻度都在、只有曲线消失，看着像数据丢了。
  // 这种序列就画在横向正中，并且**不画填充**（一个点撑不起一块面积，画成三角是撒谎）。
  const single = N === 1;
  const xs = (i) => x0 + (single ? 0.5 : i / (N - 1)) * W;

  // 纵轴视图：自适应量程 cur.lmax / cur.rmax 之上再叠一层「用户缩放 + 平移」
  const vy = clampTlY(tlView());
  const yOf = (v, base) => y0 + H - ((v / base - vy.o) * vy.z) * H;
  /** 第 p 条网格线（p = 0 顶部 … 1 底部）对应的值 */
  const valAt = (p, base) => (vy.o + (1 - p) / vy.z) * base;
  const yL = (v) => yOf(v, cur.lmax);
  const yR = (v) => yOf(v, cur.rmax);

  // 放大后曲线会画出画布可视区，套一层裁剪，免得压到刻度文字上
  g.save();
  g.beginPath(); g.rect(x0, y0, W, H); g.clip();

  // 填充左轴曲线（单点序列没有"曲线下的面积"可言，跳过填充，只画点）
  if (!single) {
    g.beginPath();
    g.moveTo(x0, y0 + H);
    for (let i = 0; i < N; i++) g.lineTo(xs(i), yL(cur.l[i]));
    g.lineTo(x0 + W, y0 + H); g.closePath();
    g.fillStyle = hexA(colL, .16); g.fill();
  }

  // 左轴曲线（单点时画一个实心点，不然路径长度为 0 什么都看不见）
  if (single) {
    g.fillStyle = colL; g.beginPath(); g.arc(xs(0), yL(cur.l[0]), 3, 0, 7); g.fill();
  } else {
    g.beginPath();
    for (let i = 0; i < N; i++) i ? g.lineTo(xs(i), yL(cur.l[i])) : g.moveTo(xs(i), yL(cur.l[i]));
    g.strokeStyle = colL; g.lineWidth = 1.7; g.stroke();
  }

  // 右轴曲线
  if (single) {
    g.fillStyle = colR; g.beginPath(); g.arc(xs(0), yR(cur.r[0]), 2.4, 0, 7); g.fill();
  } else {
    g.beginPath();
    for (let i = 0; i < N; i++) i ? g.lineTo(xs(i), yR(cur.r[i])) : g.moveTo(xs(i), yR(cur.r[i]));
    g.strokeStyle = colR; g.lineWidth = 1.3; g.setLineDash([3, 2]); g.stroke(); g.setLineDash([]);
  }

  // 报文刻度
  const tb = S.totalSamples || 1;
  const f = S.filters;
  for (const p of S.packets) {
    const t = p.startSample / tb;
    if (t < f.tFrom || t > f.tTo) continue;
    const x = x0 + t * W;
    const col = p.role === 'SRC' ? cSrc : p.role === 'SNK' ? cSnk : cPlug;
    g.strokeStyle = hexA(col, p.crcOk === false ? .95 : .5);
    g.lineWidth = p.crcOk === false ? 1.6 : 1;
    const hh = p.crcOk === false ? H : H * .45;
    g.beginPath(); g.moveTo(x, y0 + H - hh); g.lineTo(x, y0 + H); g.stroke();
  }

  // 时间范围遮罩
  if (f.tFrom > 0) { g.fillStyle = hexA('#000', .18); g.fillRect(x0, y0, f.tFrom * W, H); }
  if (f.tTo < 1) { g.fillStyle = hexA('#000', .18); g.fillRect(x0 + f.tTo * W, y0, (1 - f.tTo) * W, H); }

  // 选中标记
  const sel = selPkt || S.view[S.selected];
  if (sel) {
    const x = x0 + (sel.startSample / tb) * W;
    g.strokeStyle = cAccent; g.lineWidth = 1.4;
    g.beginPath(); g.moveTo(x, y0); g.lineTo(x, y0 + H); g.stroke();
    g.beginPath(); g.arc(x, y0 + 4, 2.6, 0, 7); g.fillStyle = cAccent; g.fill();
  }
  g.restore();

  // 坐标轴刻度 —— 跟着纵轴视图走：放得越大，小数位越多（否则 ×50 之后刻度全是同一个数）
  const lDig = cur.lDigits + (vy.z >= 20 ? 2 : vy.z >= 5 ? 1 : 0);
  const rDig = cur.rDigits + (vy.z >= 20 ? 2 : vy.z >= 5 ? 1 : 0);
  g.fillStyle = cTx3; g.font = '10px ui-monospace, monospace';
  for (let i = 0; i <= 4; i++) {
    const y = y0 + (H * i) / 4;
    g.textAlign = 'right'; g.fillText(valAt(i / 4, cur.lmax).toFixed(lDig) + cur.lUnit, x0 - 5, y + 3);
    g.textAlign = 'left'; g.fillText(valAt(i / 4, cur.rmax).toFixed(rDig) + cur.rUnit, x0 + W + 5, y + 3);
  }

  TL.timeToX = (t) => x0 + t * W;
  TL.xToTime = (x) => clamp((x - x0) / W, 0, 1);}
function hexA(hex, a) {
  hex = (hex || '#888').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * 横轴时间标签怎么写字：单位跟着**总时长**走，不是跟着单个刻度走。
 *
 *   · 不到 1 秒 → `0ms / 42ms / 85ms / 127ms / 170ms`（短抓包若写「0.00s」五格全一样，毫无信息；
 *     10ms 以内再补一位小数，否则相邻两格会连着重样）
 *   · 不到 60 秒 → `0.00s / 1.25s / 2.50s`（两位数以上收一位小数，免得标签互相挤）
 *   · 更长 → `0:00 / 0:21 / 1:23`
 *
 * 时间轴刻度只是**总时长的等分**（跟左边的时间窗口滑杆同一套归一化坐标），所以这里只吃
 * 「秒」两个数就能算，不必关心是 .atkcc 的采样点还是分析仪的毫秒时间戳。
 */
function fmtAxisTime(sec, total) {
  if (total < 0.01) return `${(sec * 1000).toFixed(1)}ms`;   // 10ms 以内：整数 ms 会连着重样，补一位小数
  if (total < 1) return `${Math.round(sec * 1000)}ms`;
  if (total < 60) return `${sec.toFixed(total < 10 ? 2 : 1)}s`;
  const m = Math.floor(sec / 60);
  return `${m}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
}

// 时间轴交互：横向拖拽刷选 / 点击选中 / 纵轴上下拖动 + 滚轮缩放
/**
 * 纵轴这一套为什么不跟「横向刷选」抢手势：
 *   · 曲线区里的**普通左键拖动仍然是刷选时间**（老习惯不能变，e2e 也在测它）；
 *   · 平移到**左右刻度栏**里拖（那里本来就只放数字）、或按住 **Shift** 拖、或**右键**拖；
 *   · **滚轮**缩放纵轴，以光标所在的那条值为锚点（想看清哪一段就把鼠标放那儿滚）。
 */
const tlInGutter = (x) => x < TL.x0 || x > TL.x0 + TL.w;

cv.addEventListener('mousedown', (e) => {
  if (!S.busSeries) return;
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  if (tlCurves() && (e.button === 2 || e.shiftKey || tlInGutter(x))) {
    e.preventDefault();
    TL.drag = { pan: true, y, o0: tlView().o, moved: false };
    cv.style.cursor = 'grabbing';
    return;
  }
  TL.drag = { x, moved: false, a: TL.xToTime(x) };
});
// 右键专门留给纵轴平移，别弹出上下文菜单
cv.addEventListener('contextmenu', (e) => e.preventDefault());

cv.addEventListener('wheel', (e) => {
  // 只认 Ctrl/⌘ + 滚轮：普通滚轮在曲线上什么都不做（跟改动前一致，免得误触把量程改了）。
  // 想让曲线区更大请看上面的时间轴分隔条 —— 那是「换个看法」，这（纵轴缩放）才是「看细节」。
  if (!(e.ctrlKey || e.metaKey) || !S.busSeries || !tlCurves()) return;
  e.preventDefault();
  const r = cv.getBoundingClientRect();
  const p = clamp((e.clientY - r.top - TL.y0) / Math.max(1, TL.h), 0, 1);
  const vy = tlView();
  const anchor = vy.o + (1 - p) / vy.z;                       // 光标下的归一化值：缩放时钉住不动
  // deltaMode 必须归一：Chrome/WebView2 给的是像素（0，一格约 ±100），Firefox 给的是**行**（1，一格约 ±3）。
  // 不换算的话 Firefox 上滚一格只放大 1.005 倍，观感就是「Ctrl+滚轮没反应」（而 Firefox 在支持矩阵里）。
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
  vy.z = clamp(vy.z * Math.exp(-e.deltaY * unit * 0.0016), TL_Z_MIN, TL_Z_MAX);
  vy.o = anchor - (1 - p) / vy.z;
  clampTlY(vy);
  drawTimeline(); syncTlYUI();
}, { passive: false });

// 双击 = 纵轴复位（横向不动）
cv.addEventListener('dblclick', (e) => {
  if (!S.busSeries || !tlCurves()) return;
  e.preventDefault();
  const vy = tlView();
  vy.z = 1; vy.o = 0;
  drawTimeline(); syncTlYUI();
});

/**
 * 取消画布上正在进行的拖拽（刷选 / 纵轴平移）。
 *
 * 拖拽状态原本只有 `mouseup` 一个出口：一旦 mouseup 丢了（窗口失焦、系统弹窗、拖到窗口外、
 * 切标签页），时间轴会永久停在拖动态 —— 不按键移动鼠标就在改纵轴或拖着灰色选区。
 * 所以窗口失焦、切文档、以及「移动事件说按键已经松开」这三种情况都要主动收尾。
 */
function tlCancelDrag() {
  if (!TL.drag) return;
  TL.drag = null;
  cv.style.cursor = '';
}

addEventListener('mousemove', (e) => {
  if (!TL.drag) return;
  // buttons 位 0 = 左键。松开之后还来的移动事件不该继续改视图（也不该继续画预览）
  if (typeof e.buttons === 'number' && !(e.buttons & 1)) { tlCancelDrag(); return; }
  const r = cv.getBoundingClientRect();
  if (TL.drag.pan) {
    const dy = (e.clientY - r.top) - TL.drag.y;
    if (Math.abs(dy) > 1) TL.drag.moved = true;
    const vy = tlView();
    // 往下拖 = 曲线跟着往下走 = 视野往高值挪：Δo 与像素位移同号，除以（缩放 × 画布高）
    vy.o = TL.drag.o0 + dy / (vy.z * Math.max(1, TL.h));
    clampTlY(vy);
    // 纯重绘，交给 rAF 合并（和分隔条那条路径一致），拖动时不必每个 move 都重画一遍
    scheduleTimelineDraw(); syncTlYUI();
    return;
  }
  const x = clamp(e.clientX - r.left, TL.x0, TL.x0 + TL.w);
  if (Math.abs(x - TL.drag.x) > 3) TL.drag.moved = true;
  if (TL.drag.moved) {
    drawTimeline();
    const g = cv.getContext('2d');
    g.fillStyle = hexA(getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), .22);
    const a = Math.min(TL.drag.x, x), b = Math.max(TL.drag.x, x);
    g.fillRect(a, TL.y0, b - a, TL.h);
  }
});
addEventListener('mouseup', (e) => {
  if (!TL.drag) return;
  const r = cv.getBoundingClientRect();
  if (TL.drag.pan) { TL.drag = null; cv.style.cursor = ''; return; }
  const x = clamp(e.clientX - r.left, TL.x0, TL.x0 + TL.w);
  const d = TL.drag; TL.drag = null;
  if (d.moved) {
    const a = Math.min(d.a, TL.xToTime(x)), b = Math.max(d.a, TL.xToTime(x));
    S.filters.tFrom = a; S.filters.tTo = b;
    $('#tFrom').value = Math.round(a * 1000); $('#tTo').value = Math.round(b * 1000);
    applyFilters(true); drawTimeline();
  } else {
    // 就近选中
    if (!S.view.length) return;
    const t = TL.xToTime(x);
    let best = 0, bd = Infinity;
    for (let i = 0; i < S.view.length; i++) { const dd = Math.abs(S.view[i].startSample / (S.totalSamples || 1) - t); if (dd < bd) { bd = dd; best = i; } }
    select(best, true);
  }
});
cv.addEventListener('mousemove', (e) => {
  const r = cv.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  // 光标提示：刻度栏（以及按住 Shift 时）提示「这里可以上下拖」，曲线区仍是十字准星
  if (!TL.drag && S.busSeries) cv.style.cursor = (e.shiftKey || tlInGutter(x)) ? 'ns-resize' : '';
  const tip = $('#tlTip');
  const cur = tlCurves();
  if (!cur || x < TL.x0 || x > TL.x0 + TL.w) { tip.style.display = 'none'; return; }
  const t = TL.xToTime(x);
  const i = clamp(Math.round(t * (S.busSeries.n - 1)), 0, S.busSeries.n - 1);
  const sec = (t * (S.totalSamples || 1)) / (S.rate || 1);
  tip.textContent = `${sec.toFixed(3)}s  `
    + `${cur.lName} ${cur.l[i].toFixed(cur.lDigits)}${cur.lUnit}  `
    + `${cur.rName} ${cur.r[i].toFixed(cur.rDigits)}${cur.rUnit}`;
  tip.style.display = 'block';
  tip.style.left = x + 'px';
  // 提示框的包含块是 #timeline（position:relative），而 y 是**画布内**坐标，
  // 画布顶上还有表头（28px）+ 上边框 —— 不加 offsetTop 提示框会飘在光标上方一格表头。
  tip.style.top = (cv.offsetTop + y - 6) + 'px';
});
cv.addEventListener('mouseleave', () => { $('#tlTip').style.display = 'none'; if (!TL.drag) cv.style.cursor = ''; });
$('#btnTlFit').addEventListener('click', () => {
  resetTimeRange(); applyFilters(true);
  const vy = tlView();
  vy.z = 1; vy.o = 0;
  drawTimeline(); syncTlYUI();
});
addEventListener('resize', () => { refitDetailW(); refitTlH(); drawTimeline(); });
// 窗口失焦（点别的程序、系统弹窗）会吞掉 mouseup —— 主动收尾，免得时间轴卡在拖动态
addEventListener('blur', tlCancelDrag);

/* ═══════════════════════ 视图控制 ═══════════════════════ */
$('#btnToggleSide').addEventListener('click', () => {
  document.body.classList.toggle('side-collapsed');
  refitDetailW();                       // 左栏开合改变可分配宽度，详情宽要重新夹一次
  setTimeout(drawTimeline, 200);
});

/* ── 详情面板宽度：拖拽 / 键盘 / 落盘 ──────────────────
 * 宽度只写进 CSS 变量 --detail-w，好处是 body.detail-collapsed 的 width:0
 * （选择器优先级更高）依然压得住，不需要为了「拖过之后还能收起」再写 JS 分支。
 */
const DETAIL_W_KEY = 'pdscope.detailW';
const DETAIL_W_DEF = 390;   // 与 CSS 里的默认值保持一致
const DETAIL_W_MIN = 280;   // 再窄字段名就开始换行，得不偿失
const DETAIL_W_MAX = 900;   // 再宽眼睛要在两栏之间横跳
const MAIN_W_MIN  = 420;    // 中间表格至少留这么宽（--cols 里有两列 minmax）
/** 用户选定的宽度：落盘的那一份。窗口 resize 时的临时夹取不许改它（见 refitDetailW） */
let detailWPref = DETAIL_W_DEF;

const detailEl = $('#detail');
const splitterEl = $('#detailSplitter');
const timelineEl = $('#timeline');
const tlSplitterEl = $('#tlSplitter');
let timelineRaf = 0;

/** 允许区间。上限定为「窗口宽 − 左栏 − 中间最小宽」，所以窄窗口下拖不出去 */
function detailLimits() {
  const bodyW = $('#appBody').getBoundingClientRect().width;
  const sideW = document.body.classList.contains('side-collapsed')
    ? 0 : $('#sidebar').getBoundingClientRect().width;
  return { min: DETAIL_W_MIN, max: Math.max(DETAIL_W_MIN, Math.min(DETAIL_W_MAX, bodyW - sideW - MAIN_W_MIN)) };
}

/** 写宽度（自动夹到合法区间）。persist=true 时落盘（并记下用户选的宽度），拖动过程中不落盘以免狂写 localStorage */
function setDetailW(w, persist) {
  const { min, max } = detailLimits();
  const px = Math.round(Math.min(max, Math.max(min, w)));
  document.documentElement.style.setProperty('--detail-w', px + 'px');
  splitterEl.setAttribute('aria-valuenow', String(px));
  splitterEl.setAttribute('aria-valuemin', String(min));
  splitterEl.setAttribute('aria-valuemax', String(max));
  if (persist) {
    detailWPref = px;                                   // 「用户选的宽度」只在这里更新
    try { localStorage.setItem(DETAIL_W_KEY, String(px)); } catch {}
  }
  return px;
}
const detailW = () => detailEl.getBoundingClientRect().width;

/**
 * 窗口尺寸或左栏开合变化后，把宽度重新夹回合法区间（否则会挤扁中间表格）。
 *
 * 注意用 `detailWPref`（用户选的那份）作为目标、且 **persist=false**：窗口临时变小只是
 * 渲染上夹一下，绝不能把夹出来的小值写回 localStorage，否则用户把窗口缩一下再放大，
 * 自己调好的宽度就永久丢了。
 */
function refitDetailW() {
  setDetailW(detailWPref, false);
}

/** 面板宽度变了，中间表格也跟着变宽 ⇒ 时间轴画布要重画。合并到一帧里，避免拖动中重复绘制 */
function scheduleTimelineDraw() {
  if (timelineRaf) return;
  timelineRaf = requestAnimationFrame(() => { timelineRaf = 0; drawTimeline(); });
}

/* ── 时间轴高度：拖拽 / 键盘 / 落盘 ────────────────────
 * 与详情面板宽度同一套做法（见上），只是方向反过来：分隔条在时间轴**上方**，
 * 往上拖 = 曲线区变高。默认 158px 只够看个大概，拉到半屏才能看清台阶与纹波。
 */
const TL_H_KEY = 'pdscope.tlH';
const TL_H_DEF = 158;    // 与 CSS :root 里的 --tl-h 保持一致
const TL_H_MIN = 92;     // 再矮就只剩表头了（canvas 至少还有 60px 可用）
const TABLE_MIN_H = 96;  // 上面那块报文表至少留几行的位置
/** 用户选定的高度：落盘的那一份。窗口 resize 时的临时夹取不许改它（见 refitTlH） */
let tlHPref = TL_H_DEF;

/** 允许区间：上限 = 中间栏高度 − 表格已经占掉的 − 表格最小高度 */
function tlLimits() {
  const body = $('#appBody').getBoundingClientRect();
  const top = $('#tbody').getBoundingClientRect().top - body.top;
  return { min: TL_H_MIN, max: Math.max(TL_H_MIN, Math.round(body.height - top - TABLE_MIN_H)) };
}
const tlH = () => Math.round(timelineEl.getBoundingClientRect().height);

/**
 * 写高度（夹到合法区间）。persist=true 才落盘，拖动过程中不落盘以免狂写 localStorage。
 *
 * `lim` 可以传进来「拖动开始时算好的区间」：拖动期间窗口没变、表格顶边也没动，
 * 每帧再量一次只是白白触发布局重算（拖起来会发涩）。
 */
function setTlH(h, persist, lim) {
  const { min, max } = lim || tlLimits();
  const px = Math.round(Math.min(max, Math.max(min, h)));
  document.documentElement.style.setProperty('--tl-h', px + 'px');
  tlSplitterEl.setAttribute('aria-valuenow', String(px));
  tlSplitterEl.setAttribute('aria-valuemin', String(min));
  tlSplitterEl.setAttribute('aria-valuemax', String(max));
  if (persist) {
    tlHPref = px;                                       // 「用户选的高度」只在这里更新
    try { localStorage.setItem(TL_H_KEY, String(px)); } catch {}
  }
  scheduleTimelineDraw();
  return px;
}

/**
 * 窗口尺寸变化后重新夹一次高度（否则矮窗口下时间轴会把表格挤没）。
 *
 * 目标始终是 `tlHPref`（用户选的那份）且 **persist=false**：窗口临时变小时只是渲染上夹一下，
 * 不许把夹出来的小值写回 localStorage —— 否则把窗口缩一下再放大，用户调好的高度就永久丢了。
 * 反过来窗口变大时，这里会自动把 `tlHPref` 还原回来。
 */
function refitTlH() {
  setTlH(tlHPref, false);
}

/**
 * 拖动：始终以「按下那一刻的高度与指针位置」为基准算目标高度。
 *
 * ⚠ 这里踩过一次坑：曾经把 `setTlH` 的返回值写回基准变量，于是每来一个 pointermove 就把
 * 「从按下到现在的总位移」重新加一遍 —— 位移被反复累加，轻轻一拖就顶到上限、反向一拖就到底。
 * 基准只能是**按下时**的 `dragH0`，当前值由它 + 总位移算出来，算完不许回写。
 */
let dragH0 = 0, dragY0 = 0, dragLim = null;
tlSplitterEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault();
  // 指针捕获：拖出 6px 命中区也不会丢事件（个别环境会抛，抛了不影响本次拖动）
  try { tlSplitterEl.setPointerCapture(e.pointerId); } catch {}
  tlSplitterEl.classList.add('is-drag');
  document.body.classList.add('tl-resizing');
  dragH0 = tlH();
  dragY0 = e.clientY;
  dragLim = tlLimits();
});
tlSplitterEl.addEventListener('pointermove', (e) => {
  if (!tlSplitterEl.classList.contains('is-drag')) return;
  // 按键已经松开（或事件本身不可信）就别再跟着走：宁可不跟，也不能跳
  if (e.buttons && !(e.buttons & 1)) { endTlDrag(e); return; }
  // 分隔条在时间轴上方：往上拖（clientY 变小）= 曲线区变高
  setTlH(dragH0 + (dragY0 - e.clientY), false, dragLim);
});
function endTlDrag(e) {
  if (!tlSplitterEl.classList.contains('is-drag')) return;
  tlSplitterEl.classList.remove('is-drag');
  document.body.classList.remove('tl-resizing');
  try { tlSplitterEl.releasePointerCapture(e.pointerId); } catch {}
  // 松手时用同一个基准再算一次并落盘（pointerup 也带坐标，不必依赖最后一次 move）
  if (Number.isFinite(e.clientY)) setTlH(dragH0 + (dragY0 - e.clientY), true, dragLim);
}
tlSplitterEl.addEventListener('pointerup', endTlDrag);
tlSplitterEl.addEventListener('pointercancel', endTlDrag);
tlSplitterEl.addEventListener('lostpointercapture', endTlDrag);
tlSplitterEl.addEventListener('dblclick', () => setTlH(TL_H_DEF, true));
tlSplitterEl.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 64 : 24;
  let h = null;
  // 分隔条在曲线上方：按 ↑ = 分隔条上移 = 曲线区变高，与直觉一致
  if (e.key === 'ArrowUp')        h = tlH() + step;
  else if (e.key === 'ArrowDown') h = tlH() - step;
  else if (e.key === 'Home')      h = tlLimits().min;   // 最矮
  else if (e.key === 'End')       h = tlLimits().max;   // 最高（半个屏以上）
  else if (e.key === 'Enter')     h = TL_H_DEF;
  if (h === null) return;
  e.preventDefault();
  setTlH(h, true);
});

let dragW = 0;
splitterEl.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;                        // 只认左键
  e.preventDefault();
  // 指针捕获：拖出 6px 命中区也不会丢事件。个别环境（老 WebView / 合成事件）会抛，
  // 抛了也不影响本次拖动，降级成「指针跑出条外就停更」即可。
  try { splitterEl.setPointerCapture(e.pointerId); } catch {}
  splitterEl.classList.add('is-drag');
  document.body.classList.add('resizing');
  dragW = Math.round(detailW());
});
splitterEl.addEventListener('pointermove', (e) => {
  if (!splitterEl.classList.contains('is-drag')) return;
  // 面板贴着窗口右边，所以「指针到视口右缘的距离」就是想要的宽度
  const next = setDetailW($('#appBody').getBoundingClientRect().right - e.clientX, false);
  if (next !== dragW) { dragW = next; scheduleTimelineDraw(); }
});
function endDetailDrag(e) {
  if (!splitterEl.classList.contains('is-drag')) return;
  splitterEl.classList.remove('is-drag');
  document.body.classList.remove('resizing');
  try { splitterEl.releasePointerCapture(e.pointerId); } catch {}
  setDetailW(dragW, true);                           // 松手才落盘
  scheduleTimelineDraw();
}
splitterEl.addEventListener('pointerup', endDetailDrag);
splitterEl.addEventListener('pointercancel', endDetailDrag);

splitterEl.addEventListener('dblclick', () => { setDetailW(DETAIL_W_DEF, true); scheduleTimelineDraw(); });
splitterEl.addEventListener('keydown', (e) => {
  const step = e.shiftKey ? 40 : 12;
  let w = null;
  // 分隔条在面板左侧，所以「按左键 = 分隔条左移 = 面板变宽」，与直觉一致
  if (e.key === 'ArrowLeft')       w = detailW() + step;
  else if (e.key === 'ArrowRight') w = detailW() - step;
  else if (e.key === 'Home')       w = detailLimits().min;   // 最窄
  else if (e.key === 'End')        w = detailLimits().max;   // 最宽
  else if (e.key === 'Enter')      w = DETAIL_W_DEF;
  if (w === null) return;
  e.preventDefault();
  setDetailW(w, true);
  scheduleTimelineDraw();
});

// 行高是界面偏好，不属于任何一份文件，所以放 UI 而不是文档
$('#btnDense').addEventListener('click', (e) => {
  UI.rowH = UI.rowH === 30 ? 23 : 30;
  document.documentElement.style.setProperty('--rh', UI.rowH + 'px');
  e.target.textContent = UI.rowH === 30 ? '紧凑' : '舒适';
  renderTable();
});
$('#btnDense').textContent = '紧凑';

/* ═══════════════════════ 导出 ═══════════════════════ */
$('#btnExport').addEventListener('click', () => {
  const wrap = el('div', 'overlay show');
  wrap.innerHTML = `<div class="prog-card"><div class="prog-title">导出报文</div>
    <div class="row gap center" style="margin-top:6px">
      <button class="btn primary" data-f="csv">CSV（当前筛选 ${S.view.length} 条）</button>
      <button class="btn" data-f="json">JSON（全部 ${S.packets.length} 条）</button>
    </div>
    <div class="row center mt6"><button class="btn tiny" data-f="cancel">取消</button></div></div>`;
  wrap.addEventListener('click', (e) => {
    const f = e.target.dataset.f;
    if (!f) return;
    if (f !== 'cancel') exportAs(f);
    wrap.remove();
  });
  document.body.appendChild(wrap);
});
function exportAs(fmt) {
  let blob, name;
  if (fmt === 'csv') {
    // 列名 / 转义 / BOM / 行尾 / 文件名统统在 src/js/core/csv.js 里 —— 命令行导出用的是同一份，
    // 改格式只改那一处（含 UFCS 那一列是「数据字节数」而 PD 是「数据对象个数」的差异）。
    const csv = csvText(S.view, { protocol: S.meta?.protocol });
    blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    name = csvFileName(S.fileName, S.channel);
  } else {
    const base = (S.fileName || 'pdscope').replace(/\.(atkcc|sqlite|db)$/i, '');
    blob = new Blob([JSON.stringify({
      file: S.fileName, channel: S.channel,
      // 实际采用的采样率 + 文件里声明的那个（不一致时 stats.sampleRateNote 里有人话解释）
      sampleRate: S.rate,
      sampleRateDeclared: S.meta?.sampleRate ?? null,
      totalSamples: S.totalSamples, stats: S.stats, packets: S.packets,
    }, null, 2)], { type: 'application/json' });
    name = `${base}-ch${S.channel}.json`;
  }
  const a = el('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`已导出 ${name}`, 'ok');
}

/* ═══════════════════════ 示例（仅本地服务形态可用） ═══════════════════════ */
/**
 * 「载入示例」靠 tools/serve.mjs 提供的 `api/samples` 接口，只有本地服务形态才有。
 * 单文件版（file:）连 fetch 同源路径都不被允许，桌面版（Tauri）的 asset 协议下也没有这个接口，
 * 所以这里先按形态短路 —— 不去发那个注定失败的请求，避免控制台里留下一条红色报错。
 */
async function initSamples() {
  const btn = $('#btnDemo');
  if (!btn) return;
  if (!ENV.hasServer) { btn.style.display = 'none'; return; }
  try {
    const r = await fetch('api/samples', { cache: 'no-store' });
    if (!r.ok) throw 0;
    const list = await r.json();
    if (!Array.isArray(list) || !list.length) throw 0;
    btn.addEventListener('click', async () => {
      const pick = list[0];
      showProgress('正在载入示例…', pick.name);
      const resp = await fetch('api/sample?name=' + encodeURIComponent(pick.name));
      const buf = new Uint8Array(await resp.arrayBuffer());
      await openFiles([new File([buf], pick.name)]);
    });
    btn.title = `示例：${list.map((x) => x.name).join(', ')}`;
  } catch {
    btn.style.display = 'none';
  }
}

/* ═══════════════════════ 快捷键 ═══════════════════════ */
/**
 * 键盘快捷键同样按形态分工：
 *   · 单文件版 / 本地服务：浏览器里没有任何原生菜单，Ctrl+O 必须由页面自己接管；
 *   · 桌面版：Tauri 原生菜单已经注册了 CmdOrCtrl+O / CmdOrCtrl+W，页面再绑一次就会
 *     弹出两个文件对话框、或和菜单抢同一个键，所以这里在有原生菜单时主动让位
 *     （菜单项最终仍会去点同一个 `#fileInput` / 调 `PDScope.closeActive()`）。
 * 不带修饰键的快捷键（↑↓ / Esc / / / T / G / Alt+数字）三种形态都不冲突，统一在页面里处理。
 */
addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') { if (!ENV.desktop) { e.preventDefault(); $('#fileInput').click(); } }
  // Alt+1…9 跳到第 N 个标签 —— 浏览器不占这个组合，桌面上也不跟菜单打架
  else if (e.altKey && /^[1-9]$/.test(e.key)) {
    const d = DOCS[+e.key - 1];
    if (d) { e.preventDefault(); activateDoc(d); }
  }
  else if (e.key === 'ArrowDown') { e.preventDefault(); navDetail(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); navDetail(-1); }
  else if (e.key === 'Escape') {
    // 标签右键菜单开着时，Esc 只关菜单，别顺手把详情面板也收了
    if ($('#tabMenu')) { closeTabMenu(); return; }
    document.body.classList.add('detail-collapsed'); setTimeout(drawTimeline, 200);
  }
  else if (e.key === '/') { e.preventDefault(); $('#fSearch').focus(); }
  else if (e.key === 't' || e.key === 'T') {
    setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
    drawTimeline();
  }
  else if (e.key === 'g') { $('#fHideGoodCrc').checked = !$('#fHideGoodCrc').checked; S.filters.hideGoodCrc = $('#fHideGoodCrc').checked; applyFilters(); }
});

/* ═══════════════════════ 外壳桥 ═══════════════════════ */
/**
 * 外壳（Tauri / 任何想把文件推给界面的宿主）与界面之间的契约。
 *
 * 设计原则：**界面不反向依赖外壳**。页面里没有一处调用 Tauri 的 API（只在 ENV 里探测一次
 * 「Tauri 注入的全局对象在不在」），所以把同一个文件丢进
 * 浏览器照样跑；外壳只要在页面就绪后调下面两个函数之一即可，没有外壳时它们就一直闲置。
 *
 *   · `window.pdscopeOpenBytes(name, bytes)` —— 外壳已经拿到字节（Tauri 走这条）
 *   · `window.pdscopeOpenUrl(name, url)`     —— 外壳能给一个可取回的 URL
 *
 * 为什么字节和 URL 两个入口都要：外壳把文件给页面的方式差别很大（读进内存、映射虚拟主机、
 * 临时文件、内嵌资源…）。给 URL 的走 URL，给字节的走字节，两边都不必为对方改变实现。
 *
 * 每次调用都**新开一个标签**：桌面版的文件关联/命令行、双击另一份抓包，
 * 语义上都是「再加一份」，而不是把手上这份替换掉。
 */
window.pdscopeOpenBytes = async (name, bytes) => {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    await openFiles([new File([u8], name)]);
  } catch (err) {
    hideProgress();
    toast('打开失败：' + (err?.message || err), 'err');
  }
};

window.pdscopeOpenUrl = async (name, url) => {
  try {
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
    await window.pdscopeOpenBytes(name, await r.arrayBuffer());
  } catch (err) {
    hideProgress();
    toast('打开失败：' + (err?.message || err), 'err');
  }
};

/**
 * 无界面导出 CSV —— 桌面版「命令行导出」走的入口（界面一屏都不用开）。
 *
 * 与界面里那条路**共用同一套代码**：容器加载（含多通道自动选道）→ 解码 → CSV 文本，
 * 所以命令行导出的结果与「打开这个文件，点导出」逐字节一致；唯一的差别是
 * 命令行导的是**全部报文**（界面导的是当前筛选结果 —— 命令行里没有筛选这个概念）。
 *
 * 出口仍是不依赖外壳的：这里只收字节、只吐文本，**不碰文件系统**（写盘由外壳做），
 * 所以浏览器里也能调它做自动化，见 `tools/e2e.mjs --eval`。
 *
 * @param {object} opts
 * @param {string} opts.name    文件名（只用于展示与默认导出名，格式靠内容嗅探判定）
 * @param {Uint8Array|ArrayBuffer} opts.bytes 抓包原始字节
 * @param {number} [opts.channel] 指定通道（多通道 .atkcc）；不给就自动挑
 * @param {number} [opts.limit]   只导前 N 条（调试/取样用）
 * @param {boolean} [opts.bom]    是否带 UTF-8 BOM（默认带；写文件要它，走管道不要）
 * @param {(ratio:number, text:string)=>void} [opts.onProgress] 解码进度旁路
 * @returns {Promise<object>} `{ csv, fileName, channel, protocol, source, packets, rows, … }`
 *   —— `csv` 就是可以直接落盘的完整文本；`fileName` 是建议的导出名，
 *   外壳的默认输出路径用它（命名规则与界面导出一致，只有 csv.js 一处定义）。
 *   失败一律**抛异常**（不吞），让外壳决定怎么报 —— 命令行里没有 toast 可弹。
 */
window.pdscopeExportCsv = async ({ name, bytes, channel, limit, bom = true, onProgress } = {}) => {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes ?? []);
  const file = new File([u8], name || 'capture.atkcc');

  // ① 容器 + 选道（与界面同一条队列、同一个函数）
  const doc = await enqueue(() => loadContainer(file));
  if (doc.error) throw new Error(doc.error);

  // ② 指定通道优先于自动选道
  if (channel !== undefined && channel !== null && channel !== '') doc.channel = Number(channel);

  // ③ 解码。进度走 progressCb 旁路（decodeDoc 里 report 的第二站）
  doc.progressCb = typeof onProgress === 'function' ? onProgress : null;
  await activateDoc(doc);
  doc.progressCb = null;
  if (doc.error) throw new Error(doc.error);
  if (doc.state !== 'done') throw new Error('解码未完成（文件可能被中途关闭）');

  // ④ 剩下的事（导全部报文、算文件名、攒摘要）与 `node tools/cli.js --csv` 同一份实现
  return csvExport(doc, { limit, bom });
};

/**
 * 对外自述：外壳与自动化测试都可以读它，判断「页面是什么形态、就绪没有、加载了什么」。
 * 外壳的启动流程应该是「等 `PDScope.ready === true`，再调 openBytes/openUrl/exportCsv」。
 */
window.PDScope = {
  version: '0.3.1',
  env: ENV,                       // { tauri, http, file, desktop, hasServer, name, label, proto }
  ready: false,
  openBytes: window.pdscopeOpenBytes,
  openUrl: window.pdscopeOpenUrl,
  /**
   * 无界面导出 CSV（桌面版命令行导出用；自动化自检也用它）。
   * 与界面导出共用 `src/js/core/csv.js`，见该函数的注释。
   */
  exportCsv: window.pdscopeExportCsv,
  /** 当前状态快照，供外壳自检 / 调试面板读取 */
  status: () => ({
    env: ENV.name,
    file: S.fileName,
    source: S.meta?.source ?? null,        // 'atkcc'（容器里没有这个字段）| 'powerz'
    protocol: S.meta?.protocol ?? 'USB PD',
    channel: S.channel,
    packets: S.packets?.length ?? 0,
    filtered: S.view?.length ?? 0,
    tabs: DOCS.length,
    tabIndex: DOCS.indexOf(S),             // -1 = 只在看空白页，没有打开的抓包
  }),
  /**
   * 标签清单 —— 外壳自检与 e2e 用它核对「开了几份、各自解出多少、当前是哪份」。
   * 这是给自动化读的稳定接口，界面内部结构变了也不用改测试。
   */
  tabs: () => DOCS.map((d, i) => ({
    index: i,
    name: d.fileName,
    active: d === S,
    state: d.state,
    error: d.error || null,
    source: d.meta?.source ?? null,
    protocol: d.meta?.protocol ?? null,
    channel: d.channel,
    packets: d.packets.length,
    filtered: d.view.length,
    totalSamples: d.totalSamples,
    /** 上次解码花掉的毫秒数（0 = 还没解过）。性能排查靠它，别删。 */
    decodedMs: d.decodedMs || 0,
    notices: d.notice ? 1 : 0,
    /**
     * UFCS 的方向依据分布：多少条来自容器的链路字节、多少条只能按接收方地址推断。
     * 推断出来的方向在双向命令上会直接反 —— 这是最难被肉眼发现的一类错，
     * 所以单独露给自动化盯（`dirInferred` 在真实样本上必须是 0）。
     */
    ufcs: d.meta?.protocol === 'UFCS'
      ? {
        frames: d.stats?.ufcsFrames ?? 0,
        dirFromLine: d.stats?.ufcsDirFromLine ?? 0,
        dirInferred: d.stats?.ufcsDirInferred ?? 0,
        unlocatedRows: d.stats?.ufcsUnlocatedRows ?? 0,
        events: d.stats?.ufcsEvents ?? 0,
      }
      : null,
  })),
  /** 切到第 i 个标签 / 关掉第 i 个标签 / 关掉全部（桌面菜单与自动化用） */
  activateTab: (i) => activateDoc(DOCS[i]),
  closeTab: (i) => closeDoc(DOCS[i]),
  closeAll: () => closeOtherDocs(null),
  closeActive: () => { if (DOCS.length) closeDoc(S); },
  /**
   * 时间轴的当前视图（给自动化用：e2e 靠它验「滚轮缩放 / 上下拖动」真的生效了，
   * 不必去比像素）。`visible` 是纵轴当前可见的值窗口，量纲就是左轴那把
   * （VBUS 是 V，差分线档也是 V）。
   */
  timeline: () => {
    const cur = tlCurves();
    const v = tlView();
    const span = 1 / v.z;
    return {
      mode: S.tlMode,
      curves: cur ? (cur.aux ? 'aux' : 'power') : null,
      /** 曲线区（时间轴面板）当前高度，px —— 拖拽分隔条能改的那个 */
      paneH: tlH(),
      paneMin: tlLimits().min,
      paneMax: tlLimits().max,
      /** 横轴时间刻度（五等分）：t 是 0..1 的归一化位置，sec 是绝对秒数，label 是画在轴上的字 */
      xTicks: (TL.xTicks || []).map((k) => ({ t: k.t, sec: k.sec, label: k.label })),
      /** 横轴标签那条带子的上沿（CSS px）—— e2e 用它把「底部以前是空白」钉住 */
      axisBandTop: TL.axisBandTop ?? null,
      zoom: v.z,
      offset: v.o,
      dirty: tlDirty(v),
      visible: cur ? { lo: v.o * cur.lmax, hi: (v.o + span) * cur.lmax } : null,
    };
  },
};

/* 初始化 */
document.documentElement.style.setProperty('--rh', UI.rowH + 'px');
// 详情面板宽度：还原上次拖到的位置（越界由 setDetailW 夹回合法区间）
let savedDetailW = NaN;
try { savedDetailW = parseInt(localStorage.getItem(DETAIL_W_KEY), 10); } catch {}
detailWPref = Number.isFinite(savedDetailW) ? savedDetailW : DETAIL_W_DEF;
setDetailW(detailWPref, false);
// 时间轴高度（曲线区那块）同理：还原上次拖到的高度，越界由 setTlH 夹回
let savedTlH = NaN;
try { savedTlH = parseInt(localStorage.getItem(TL_H_KEY), 10); } catch {}
tlHPref = Number.isFinite(savedTlH) ? savedTlH : TL_H_DEF;
setTlH(tlHPref, false);
// 标注形态，便于 CSS 按形态微调（桌面版没有「载入示例」，单文件版可用 file: 特有能力）
document.documentElement.dataset.env = ENV.name;
renderTabs();
initSamples();
renderTimelineHead();
requestAnimationFrame(() => drawTimeline());
// 就绪信号：外壳据此决定何时把命令行里带的抓包文件推进来
window.PDScope.ready = true;
window.dispatchEvent(new Event('pdscope-ready'));
