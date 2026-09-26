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
 */

import { AtkccCapture, scanChannelActivity } from '../js/core/atkcc.js';
import { decodeChannel, buildBusSeries } from '../js/core/pipeline.js';
import { makeBrowserInflator } from '../js/core/inflate.js';

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

function fmtTime(ms) {
  const s = ms / 1000;
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}
const fmtSize = (n) => n > 1048576 ? (n / 1048576).toFixed(2) + ' MB' : (n / 1024).toFixed(1) + ' KB';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * 报文的「语义类别」——只看报文自身的协议属性，不看 CRC 是否通过。
 * 用于给「被确认的报文」取配色（坏包仍要显示为错误色，但它的语义类别依旧有效）。
 */
function toneOf(p) {
  if (p.msgType === 'VDM') return 'VDM';
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
const CAT_CLASS = { Control: 'cat-Control', Data: 'cat-Data', Extended: 'cat-Extended', VDM: 'cat-VDM', Error: 'cat-Error' };

/**
 * GOOD CRC 配色配对（界面侧）。
 *
 * 配对关系由内核 `linkGoodCrc()` 算好（p.ackOf），这里只负责取色：
 * 让回应包与它所确认的报文同色，一眼看出「哪条被谁确认了」；
 * 否则 GOOD CRC 只能笼统地取 Control 色，与它确认的报文各成一色。
 *
 * 坏掉的 GOOD CRC 保持错误色，不参与配对。
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

/** 是否属于「功率协商」/「状态切换」这两类关注点 */
const POWER_TYPES = /Source_Cap|Request|EPR_Request|EPR_Mode|PPS|BIST|Source_Capabilities_Extended|EPR_Source|EPR_Sink|Sink_Cap/i;
const ENTER_TYPES = /PS RDY|VDM|Alert|Status|Source_Info|Revision|Enter_USB|Discover|Sink_Cap|Notify/i;

/* ═══════════════════════ 状态 ═══════════════════════ */
const S = {
  cap: null,
  meta: null,
  fileName: '',
  fileSize: 0,
  channel: 0,
  /** 本文件实际采用的采样率（文件声明 → 波形自检 → 兜底，见 pipeline.resolveSampleRate） */
  rate: 0,
  packets: [],
  view: [],          // 过滤 + 排序后的结果
  stats: null,
  busSeries: null,
  selected: -1,
  cancel: false,
  filters: {
    roles: new Set(['SRC', 'SNK', 'Plug']),
    sops: new Set(['SOP', "SOP'", "SOP''", 'Hard Reset', 'Cable Reset']),
    cats: new Set(['Control', 'Data', 'Extended', 'VDM', 'Error']),
    types: new Set(),          // 空 = 全部
    hideGoodCrc: true,
    onlyBad: false,
    onlyPower: false,
    onlyEnter: false,
    q: '',
    tFrom: 0,
    tTo: 1,
  },
  sort: { k: 'index', asc: true },
  rowH: 30,
  viewMode: 'all',
  chActivity: new Map(),
};

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

/* ═══════════════════════ 打开文件 ═══════════════════════ */
$('#btnOpen').addEventListener('click', () => $('#fileInput').click());
$('#btnOpen2')?.addEventListener('click', () => $('#fileInput').click());
$('#fileInput').addEventListener('change', (e) => {
  const f = e.target.files?.[0];
  if (f) loadFile(f);
  e.target.value = '';
});

// 拖拽
let dragDepth = 0;
addEventListener('dragenter', (e) => { e.preventDefault(); if (++dragDepth === 1) $('#drop').classList.add('show'); });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('#drop').classList.remove('show'); } });
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; $('#drop').classList.remove('show');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

/** 打开一份抓包：读字节 -> 解析容器 -> 选通道 -> 解码 */
async function loadFile(file) {
  S.cancel = false;
  showProgress('正在读取文件…', file.name);
  try {
    const t0 = performance.now();
    const buf = new Uint8Array(await file.arrayBuffer());
    setProgress(0.05, `${fmtSize(buf.length)} 已载入，解析容器…`);

    const cap = await AtkccCapture.open(buf, { inflate });
    S.cap = cap; S.meta = cap.meta;
    S.fileName = file.name; S.fileSize = buf.length;
    S.rate = cap.meta.sampleRate;      // 先用文件声明的值，解码时再由波形自检核一遍

    const chs = cap.meta.channels;
    // 多通道时扫描活动度，自动挑一个「有报文」的通道
    let pick = chs[0].channel;
    if (chs.length > 1) {
      showProgress('正在扫描各通道活动度…', `${chs.length} 个通道`);
      S.chActivity = new Map();
      for (let i = 0; i < chs.length; i++) {
        const r = await scanChannelActivity(cap, chs[i].channel, inflate, 3);
        S.chActivity.set(chs[i].channel, r.activity);
        setProgress(0.05 + 0.25 * (i + 1) / chs.length, `通道 ${chs[i].channel}：${r.activity} 个活动字节`);
      }
      let best = chs[0], bestA = -1;
      for (const c of chs) { const a = S.chActivity.get(c.channel) ?? 0; if (a > bestA) { bestA = a; best = c; } }
      pick = best.channel;
    }

    renderMeta();
    renderChannels();
    await decodeAndShow(pick);
    const dt = Math.round(performance.now() - t0);
    toast(`解析完成 · ${S.packets.length} 条报文 · ${dt} ms`, 'ok');
  } catch (err) {
    console.error(err);
    toast('解析失败：' + (err?.message || err), 'err');
    hideProgress();
  }
}

/** 解码指定通道并刷新整个界面 */
async function decodeAndShow(channel) {
  if (!S.cap) return;
  S.cancel = false;
  S.channel = channel;
  showProgress(`正在解码通道 ${channel}…`, 'BMC 位流 → 4B5B → PD 报文');

  const t0 = performance.now();
  const { packets, stats } = await decodeChannel(S.cap, channel, {
    inflate,
    bitOrder: 'lsb',
    shouldStop: () => S.cancel,
    onProgress: (p) => setProgress(0.3 + 0.65 * p.ratio, `分块 ${p.chunk}/${p.chunks} · 已解出 ${p.packets} 条`),
  });

  // 附上 VBUS / IBUS
  const bus = S.cap.meta.bus;
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
  pairAckTone(packets);   // GOOD CRC 与它确认的报文同色
  S.packets = packets;
  S.stats = stats;
  S.decodedMs = Math.round(performance.now() - t0);
  // 采样率以解码时定下来的为准（文件声明 / 波形实测 / 兜底），后面所有「采样点 → 秒」都用它
  if (stats.sampleRate > 0) S.rate = stats.sampleRate;
  if (stats.sampleRateNote) toast(stats.sampleRateNote, 'warn');

  // 时间轴数据
  const total = stats.totalSamples || S.cap.meta.totalSamples || 1;
  S.busSeries = buildBusSeries(bus, total, S.rate, 2400);
  S.totalSamples = total;

  buildTypeList();
  resetTimeRange();
  applyFilters(true);
  renderMeta();
  renderChannels();
  setProgress(1, '完成');
  hideProgress();
  drawTimeline();
}

/* ═══════════════════════ 顶栏元信息 / 通道 ═══════════════════════ */
function renderMeta() {
  const chip = $('#fileChip');
  $('#fileName').textContent = S.fileName || '未打开抓包文件';
  chip.title = `${S.fileName}  ·  ${fmtSize(S.fileSize)}`;
  chip.classList.toggle('has', !!S.fileName);

  const box = $('#metaChips');
  box.innerHTML = '';
  if (!S.meta) { $('#btnExport').disabled = true; return; }
  const m = S.meta;
  const add = (k, v) => box.appendChild(Object.assign(el('span', 'mchip'), { innerHTML: `${k} <b>${v}</b>` }));

  // 采样率：数值 + 来源标记。值不是写死的，来源可能是 channel.ini 的声明、
  // 也可能是波形自检反推出来的（文件没声明或声明得离谱时），所以必须标出来。
  const rate = S.rate || m.sampleRate;
  const src = S.stats?.sampleRateSource || m.sampleRateSource || 'declared';
  const tag = { declared: '文件声明', measured: '波形实测', default: '默认值', override: '手动指定' }[src] || src;
  const rateChip = el('span', 'mchip');
  rateChip.innerHTML = `采样率 <b>${(rate / 1e6).toFixed(2)} MHz</b>`
    + `<span class="mtag${src === 'measured' || src === 'override' ? ' warn' : ''}">${tag}</span>`;
  rateChip.title = S.stats?.sampleRateNote
    || (m.sampleRateRaw ? `取自 channel.ini：${m.sampleRateRaw}` : '文件未声明采样率，用默认值');
  box.appendChild(rateChip);

  const dur = (S.totalSamples || m.totalSamples) / rate;
  add('时长', dur >= 60 ? (dur / 60).toFixed(2) + ' min' : dur.toFixed(2) + ' s');
  if (S.packets.length) {
    add('报文', S.packets.length);
    if (S.stats?.badCrc) add('CRC 错误', `<span style="color:var(--bad)">${S.stats.badCrc}</span>`);
  }
  if (m.channels.length > 1) add('通道', m.channels.length);
}

function renderChannels() {
  const box = $('#chList');
  box.innerHTML = '';
  if (!S.meta) { $('#chHint').textContent = ''; return; }
  const chs = S.meta.channels;
  $('#chHint').textContent = chs.length > 1 ? `${chs.length} 个通道（已按活动度排序）` : '';

  const list = [...chs].sort((a, b) => (S.chActivity.get(b.channel) ?? 0) - (S.chActivity.get(a.channel) ?? 0));
  for (const c of list) {
    const b = el('button', 'chitem' + (c.channel === S.channel ? ' is-on' : ''));
    b.innerHTML = `<b>CH${c.channel}</b><span>${c.chunks.length} 块</span>`
      + (S.chActivity.has(c.channel) ? `<span class="act">${S.chActivity.get(c.channel)}</span>` : '');
    b.title = `${c.totalSamples} 采样点 ≈ ${(c.totalSamples / (S.rate || S.meta.sampleRate)).toFixed(2)} s`;
    b.addEventListener('click', () => { if (c.channel !== S.channel) decodeAndShow(c.channel); });
    box.appendChild(b);
  }
}

/* ═══════════════════════ 筛选 ═══════════════════════ */
function buildTypeList() {
  const counts = new Map();
  for (const p of S.packets) counts.set(p.msgType, (counts.get(p.msgType) || 0) + 1);
  const arr = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

  const body = $('#msBody');
  body.innerHTML = '';
  for (const [t, n] of arr) {
    const lab = el('label', 'ms-item');
    const cb = el('input'); cb.type = 'checkbox'; cb.value = t;
    cb.addEventListener('change', () => {
      if (cb.checked) S.filters.types.add(t); else S.filters.types.delete(t);
      updateMsHead(arr.length);
      applyFilters();
    });
    const dot = el('span', 'dot');
    dot.style.background = catColor(kindOf({ msgType: t, msgKind: guessKind(t) }));
    lab.append(cb, dot, el('span', '', t), el('span', 'cnt', String(n)));
    body.appendChild(lab);
  }
  updateMsHead(arr.length);
}
function guessKind(t) {
  if (t === 'VDM') return 'data';
  if (/GOOD CRC|ACCEPT|REJECT|PING|PS RDY|GOTO MIN|Swap|Wait|Soft_Reset|Data_Reset|Not_Supported|FR_Swap|Get_/.test(t)) return 'control';
  if (/Extended|_Info$|Status|Battery|Country|Manufacturer|Security|Firmware|Revision/.test(t)) return 'ext';
  return 'data';
}
function catColor(k) {
  const v = getComputedStyle(document.documentElement).getPropertyValue('--' + ({ Control: 'ctrl', Data: 'data', Extended: 'ext', VDM: 'vdm', Error: 'err' }[k] || 'ctrl'));
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

// 角色 / SOP / 类别 chips
function wireChips(sel, set) {
  $$(sel + ' .chip').forEach((c) => c.addEventListener('click', () => {
    const v = c.dataset.v;
    if (set.has(v)) { set.delete(v); c.classList.remove('is-on'); }
    else { set.add(v); c.classList.add('is-on'); }
    applyFilters();
  }));
}
wireChips('#fRole', S.filters.roles);
wireChips('#fSop', S.filters.sops);
wireChips('#fCat', S.filters.cats);

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
  $$('.th').forEach((x) => x.classList.remove('sorted', 'asc'));
  th.classList.add('sorted'); if (S.sort.asc) th.classList.add('asc');
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

$('#btnReset').addEventListener('click', () => {
  const f = S.filters;
  f.roles = new Set(['SRC', 'SNK', 'Plug']);
  f.sops = new Set(['SOP', "SOP'", "SOP''", 'Hard Reset', 'Cable Reset']);
  f.cats = new Set(['Control', 'Data', 'Extended', 'VDM', 'Error']);
  f.types = new Set();
  f.hideGoodCrc = true; f.onlyBad = false; f.onlyPower = false; f.onlyEnter = false; f.q = '';
  resetTimeRange();
  $('#fHideGoodCrc').checked = true; $('#fOnlyBad').checked = false;
  $('#fOnlyPower').checked = false; $('#fOnlyEnter').checked = false; $('#fSearch').value = '';
  $('#msBody').querySelectorAll('input').forEach((c) => (c.checked = false));
  updateMsHead();
  $$('#fRole .chip, #fSop .chip, #fCat .chip').forEach((c) => c.classList.add('is-on'));
  S.viewMode = 'all';
  $$('#viewSeg .seg-item').forEach((x, i) => x.classList.toggle('is-on', i === 0));
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
    if (f.hideGoodCrc && p.msgType === 'GOOD CRC') continue;
    if (f.onlyBad && p.crcOk !== false) continue;
    if (f.onlyPower && !POWER_TYPES.test(p.msgType)) continue;
    if (f.onlyEnter && !ENTER_TYPES.test(p.msgType)) continue;
    const t = p.startSample / tb;
    if (t < f.tFrom - 1e-9 || t > f.tTo + 1e-9) continue;
    if (q) {
      const hay = (p.msgType + ' ' + (p.summary || '') + ' ' + (p.dataHex || '') + ' ' + p.sop + ' ' + p.role).toLowerCase();
      if (!hay.includes(q)) continue;
    }
    if (S.viewMode === 'neg' && !(POWER_TYPES.test(p.msgType) || ENTER_TYPES.test(p.msgType))) continue;
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
  $('#statLine').innerHTML = S.packets.length
    ? `显示 <b>${shown}</b> / ${total} 条报文`
      + (shown !== total ? ` <span style="color:var(--tx-3)">（已屏蔽 ${total - shown} 条）</span>` : '')
      + (bad ? ` · <span class="bad">CRC 错误 ${bad}</span>` : ' · <span style="color:var(--ok)">CRC 全通过</span>')
      + (S.decodedMs ? ` · <span style="color:var(--tx-3)">解码 ${S.decodedMs} ms</span>` : '')
    : '等待打开抓包文件…';
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
function renderTable() {
  const tbody = $('#tbody');
  const vph = $('#vph'), vrows = $('#vrows');
  const n = S.view.length;

  $('#emptyState').style.display = n ? 'none' : (S.packets.length ? 'none' : 'flex');
  if (!n) {
    if (S.packets.length) {
      $('#emptyState').style.display = 'flex';
      $('#emptyState').querySelector('h3').textContent = '当前筛选条件下没有报文';
      $('#emptyState').querySelector('p').textContent = '试试放宽左侧的方向 / 类型 / 时间筛选，或点「重置全部筛选」。';
    }
    vph.style.height = '0px'; vrows.innerHTML = ''; vrows.style.transform = 'translateY(0)';
    return;
  }
  const RH = S.rowH;
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
  // GOOD CRC 取被确认报文的颜色，悬停提示它确认的是哪一条
  const tip = p.ackOf != null ? ` title="确认 #${p.ackOf} · ${p.ackType || ''}"` : '';
  r.innerHTML =
    `<div class="td num">${p.index}</div>`
  + `<div class="td"><span class="pill sop">${esc(p.sop)}</span></div>`
  + `<div class="td type ${cls}"${tip}>${esc(p.msgType)}</div>`
  + `<div class="td num">${p.msgId ?? ''}</div>`
  + `<div class="td"><span class="pill ${p.role}">${esc(p.role)}</span></div>`
  + `<div class="td num">${p.nObjects ?? ''}</div>`
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
    const tbody = $('#tbody'), RH = S.rowH, top = tbody.scrollTop, h = tbody.clientHeight;
    const y = i * RH;
    if (y < top + RH) tbody.scrollTop = Math.max(0, y - RH * 2);
    else if (y + RH > top + h) tbody.scrollTop = y + RH * 3 - h;
  }
  renderDetail(p);
  if ($('#tlFollow').checked) drawTimeline(p);
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

function renderDetail(p) {
  const box = $('#detailBody');
  const cls = CAT_CLASS[p.tone] || '';
  const h = [];

  h.push(`<div class="dhero ${p.crcOk === false ? 'dhero-bad' : ''}">
    <div class="t1 ${cls}">${esc(p.msgType)}</div>
    <div class="t2">#${p.index} · ${esc(p.sop)} · ${esc(p.role)} · ID ${p.msgId ?? '-'} · r${p.rev} · ${fmtTime(p.timeMs)}</div>
  </div>`);

  if (p.warnings?.length) {
    for (const w of p.warnings) h.push(`<div class="dwarn err"><b>!</b><span>${esc(w.long || w.short || w)}</span></div>`);
  }

  // 概览
  h.push(`<div class="dsec"><h5>链路概览</h5><div class="dgrid">
    ${cell('VBUS', p.vbus.toFixed(3) + ' V')}
    ${cell('IBUS', p.ibus.toFixed(3) + ' A')}
    ${cell('起始时间', fmtTime(p.timeMs))}
    ${cell('报文时长', p.durationUs.toFixed(1) + ' µs')}
    ${cell('数据对象', String(p.nObjects ?? 0))}
    ${cell('实测码率', (p.bitrate / 1000).toFixed(1) + ' kbps')}
    ${p.ackOf != null ? cell('确认的报文', `#${p.ackOf} · ${p.ackType || ''}`) : ''}
  </div></div>`);

  // 报文头位域
  h.push(`<div class="dsec"><h5>报文头 (16 bit)</h5><div class="dbits">
    ${bit('B15', 'Extended', bid(p.header, 15, 15), p.msgKind === 'ext' ? '扩展消息' : '标准消息')}
    ${bit('B14-12', 'Object 数', bid(p.header, 12, 14), String(p.nObjects ?? 0))}
    ${bit('B11-9', 'Message ID', bid(p.header, 9, 11), String(p.msgId ?? 0))}
    ${bit('B8', 'Power Role', bid(p.header, 8, 8), p.powerRole ? '1 · Source' : '0 · Sink')}
    ${bit('B7-6', 'Spec Revision', bid(p.header, 6, 7), `${bid(p.header, 6, 7)} · PD ${p.rev === 3 ? '3.x' : '2.0'}`)}
    ${bit('B5', 'Data Role', bid(p.header, 5, 5), p.dataRole ? '1 · DFP' : '0 · UFP')}
    ${bit('B4-0', 'Message Type', bid(p.header, 0, 4), `${p.msgTypeRaw ?? 0} · ${p.msgType}`)}
  </div></div>`);

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
    h.push(`<div class="dsec"><h5>数据对象 (hex)</h5><div class="dobj"><div class="dobj-b hx">${esc(p.dataHex)}</div></div></div>`);
  }

  // 逐字段解析（按 Object 分组）
  const groups = groupDetails(p.details || []);
  for (const g of groups) {
    if (!g.title) {
      h.push(`<div class="dsec"><h5>字段解析</h5><div class="dbits">${g.items.map(([k, v]) => `<div class="dbit"><div class="bk">${esc(k)}</div><div class="bv">${esc(v)}</div></div>`).join('')}</div></div>`);
    } else {
      h.push(`<div class="dsec"><h5>${esc(g.title)}</h5><div class="dbits">${g.items.map(([k, v]) => `<div class="dbit"><div class="bk">${esc(k)}</div><div class="bv">${esc(v)}</div></div>`).join('')}</div></div>`);
    }
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
    if (d.key === 'Object') { cur = { title: String(d.value), items: [] }; groups.push(cur); continue; }
    if (!cur) { cur = { title: null, items: [] }; if (!groups.includes(cur)) groups.push(cur); }
    if (cur.title === null) {
      cur.items.push([d.key, d.value]);
    } else {
      cur.items.push([d.key, d.value]);
    }
  }
  return groups.filter((g) => g.items.length || g.title);
}

/* ═══════════════════════ 时间轴 ═══════════════════════ */
const cv = $('#busCanvas');
let TL = { x0: 0, y0: 0, w: 0, h: 0, dpr: 1, drag: null };
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
  const cData = cs.getPropertyValue('--data').trim();
  const cSnk = cs.getPropertyValue('--snk').trim();
  const cSrc = cs.getPropertyValue('--src').trim();
  const cPlug = cs.getPropertyValue('--plug').trim();

  const padL = 42, padR = 42, padT = 8, padB = 16;
  const x0 = padL, y0 = padT, W = Math.max(10, w - padL - padR), H = Math.max(10, hgt - padT - padB);
  TL = { x0, y0, w: W, h: H, dpr };

  // 网格
  g.strokeStyle = cLine; g.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = y0 + (H * i) / 4;
    g.beginPath(); g.moveTo(x0, y + .5); g.lineTo(x0 + W, y + .5); g.stroke();
  }

  if (!s || !s.n) {
    g.fillStyle = cTx3; g.font = '11px sans-serif';
    g.fillText(S.cap ? '该抓包没有 bus.ini 模拟量数据' : '打开抓包后显示 VBUS / IBUS', x0 + 8, y0 + H / 2);
    return;
  }

  const N = s.n;
  const xs = (i) => x0 + (i / (N - 1)) * W;
  const vmax = Math.max(5, s.vmax * 1.12);
  const imax = Math.max(0.5, s.imax * 1.12);
  const yV = (v) => y0 + H - (v / vmax) * H;
  const yI = (v) => y0 + H - (v / imax) * H;

  // 填充 VBUS
  g.beginPath();
  g.moveTo(x0, y0 + H);
  for (let i = 0; i < N; i++) g.lineTo(xs(i), yV(s.vbus[i]));
  g.lineTo(x0 + W, y0 + H); g.closePath();
  g.fillStyle = hexA(cAccent, .16); g.fill();

  // VBUS 线
  g.beginPath();
  for (let i = 0; i < N; i++) i ? g.lineTo(xs(i), yV(s.vbus[i])) : g.moveTo(xs(i), yV(s.vbus[i]));
  g.strokeStyle = cAccent; g.lineWidth = 1.7; g.stroke();

  // IBUS 线
  g.beginPath();
  for (let i = 0; i < N; i++) i ? g.lineTo(xs(i), yI(s.ibus[i])) : g.moveTo(xs(i), yI(s.ibus[i]));
  g.strokeStyle = cData; g.lineWidth = 1.3; g.setLineDash([3, 2]); g.stroke(); g.setLineDash([]);

  // 坐标轴刻度
  g.fillStyle = cTx3; g.font = '10px ui-monospace, monospace';
  for (let i = 0; i <= 4; i++) {
    const y = y0 + (H * i) / 4;
    g.textAlign = 'right'; g.fillText((vmax * (1 - i / 4)).toFixed(1) + 'V', x0 - 5, y + 3);
    g.textAlign = 'left'; g.fillText((imax * (1 - i / 4)).toFixed(2) + 'A', x0 + W + 5, y + 3);
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

  TL.timeToX = (t) => x0 + t * W;
  TL.xToTime = (x) => clamp((x - x0) / W, 0, 1);
}
function hexA(hex, a) {
  hex = (hex || '#888').replace('#', '');
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  const n = parseInt(hex, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// 时间轴交互：拖拽缩放 / 点击选中
cv.addEventListener('mousedown', (e) => {
  if (!S.busSeries) return;
  const r = cv.getBoundingClientRect();
  TL.drag = { x: e.clientX - r.left, moved: false, a: TL.xToTime(e.clientX - r.left) };
});
addEventListener('mousemove', (e) => {
  if (!TL.drag) return;
  const r = cv.getBoundingClientRect();
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
  const tip = $('#tlTip');
  if (!S.busSeries || x < TL.x0 || x > TL.x0 + TL.w) { tip.style.display = 'none'; return; }
  const t = TL.xToTime(x);
  const i = clamp(Math.round(t * (S.busSeries.n - 1)), 0, S.busSeries.n - 1);
  const sec = (t * (S.totalSamples || 1)) / (S.rate || 1);
  tip.textContent = `${sec.toFixed(3)}s  ${S.busSeries.vbus[i].toFixed(3)}V  ${S.busSeries.ibus[i].toFixed(3)}A`;
  tip.style.display = 'block';
  tip.style.left = x + 'px';
  tip.style.top = (y - 6) + 'px';
});
cv.addEventListener('mouseleave', () => ($('#tlTip').style.display = 'none'));
$('#btnTlFit').addEventListener('click', () => { resetTimeRange(); applyFilters(true); drawTimeline(); });
addEventListener('resize', () => drawTimeline());

/* ═══════════════════════ 视图控制 ═══════════════════════ */
$('#btnToggleSide').addEventListener('click', () => { document.body.classList.toggle('side-collapsed'); setTimeout(drawTimeline, 200); });
$('#btnDense').addEventListener('click', (e) => {
  S.rowH = S.rowH === 30 ? 23 : 30;
  document.documentElement.style.setProperty('--rh', S.rowH + 'px');
  e.target.textContent = S.rowH === 30 ? '紧凑' : '舒适';
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
  const base = (S.fileName || 'pdscope').replace(/\.atkcc$/i, '');
  let blob, name;
  if (fmt === 'csv') {
    const head = ['#', 'SOP', 'MsgType', 'ID', 'Direction', 'Objects', 'Elapsed', 'Time(ms)', 'VBUS(V)', 'IBUS(A)', 'Data', 'CRC', 'Note'];
    const rows = S.view.map((p) => [
      p.index, p.sop, p.msgType, p.msgId ?? '', p.role, p.nObjects ?? '', fmtTime(p.timeMs), p.timeMs.toFixed(4),
      p.vbus.toFixed(4), p.ibus.toFixed(4), p.dataHex || '',
      p.crcOk === null ? '' : p.crcOk ? 'OK' : 'BAD', (p.summary || '').replace(/"/g, '""'),
    ]);
    const csv = '\uFEFF' + [head, ...rows].map((r) => r.map((c) => `"${c}"`).join(',')).join('\r\n');
    blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    name = `${base}-ch${S.channel}.csv`;
  } else {
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
      await loadFile(new File([buf], pick.name));
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
 *   · 桌面版：Tauri 原生菜单已经注册了 CmdOrCtrl+O，页面再绑一次就会弹出两个文件对话框，
 *     所以这里在有原生菜单时主动让位（菜单项最终仍会去点同一个 `#fileInput`）。
 * 不带修饰键的快捷键（↑↓ / Esc / / / T / G）三种形态都不冲突，统一在页面里处理。
 */
addEventListener('keydown', (e) => {
  if (e.target.matches('input,textarea')) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') { if (!ENV.desktop) { e.preventDefault(); $('#fileInput').click(); } }
  else if (e.key === 'ArrowDown') { e.preventDefault(); navDetail(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); navDetail(-1); }
  else if (e.key === 'Escape') { document.body.classList.add('detail-collapsed'); setTimeout(drawTimeline, 200); }
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
 * 设计原则：**界面不反向依赖外壳**。页面里没有一行 `__TAURI__` 调用，所以把同一个文件丢进
 * 浏览器照样跑；外壳只要在页面就绪后调下面两个函数之一即可，没有外壳时它们就一直闲置。
 *
 *   · `window.pdscopeOpenBytes(name, bytes)` —— 外壳已经拿到字节（Tauri 走这条）
 *   · `window.pdscopeOpenUrl(name, url)`     —— 外壳能给一个可取回的 URL
 *
 * 为什么字节和 URL 两个入口都要：外壳把文件给页面的方式差别很大（读进内存、映射虚拟主机、
 * 临时文件、内嵌资源…）。给 URL 的走 URL，给字节的走字节，两边都不必为对方改变实现。
 */
window.pdscopeOpenBytes = async (name, bytes) => {
  try {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    await loadFile(new File([u8], name));
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
 * 对外自述：外壳与自动化测试都可以读它，判断「页面是什么形态、就绪没有、加载了什么」。
 * 外壳的启动流程应该是「等 `PDScope.ready === true`，再调 openBytes/openUrl」。
 */
window.PDScope = {
  version: '0.1.0',
  env: ENV,                       // { tauri, http, file, desktop, hasServer, name, label, proto }
  ready: false,
  openBytes: window.pdscopeOpenBytes,
  openUrl: window.pdscopeOpenUrl,
  /** 当前状态快照，供外壳自检 / 调试面板读取 */
  status: () => ({
    env: ENV.name,
    file: S.fileName,
    channel: S.channel,
    packets: S.packets?.length ?? 0,
    filtered: S.view?.length ?? 0,
  }),
};

/* 初始化 */
document.documentElement.style.setProperty('--rh', S.rowH + 'px');
// 标注形态，便于 CSS 按形态微调（桌面版没有「载入示例」，单文件版可用 file: 特有能力）
document.documentElement.dataset.env = ENV.name;
initSamples();
requestAnimationFrame(() => drawTimeline());
// 就绪信号：外壳据此决定何时把命令行里带的抓包文件推进来
window.PDScope.ready = true;
window.dispatchEvent(new Event('pdscope-ready'));
