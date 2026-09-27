/**
 * bmc.js — USB PD 的 BMC（Biphase Mark Coding）解码
 *
 * 完全对齐 sigrok `usb_power_delivery` 解码器的实现语义：
 *   UI            = 1 / 600kHz = 1.6667 µs        （单位间隔 = 半位）
 *   threshold     = 1.5 * UI   = 2.5   µs          （区分「半位1」与「位0」）
 *   maxbit        = 3 * UI     = 5.0   µs          （超过即视为空闲，包结束）
 *
 * ⚠ 这里的 600 kHz 是 **PD 协议规定的**，与抓包设备的采样率无关；
 *   采样率由调用方传入（来自 channel.ini 的声明）。所以本模块里出现的
 *   threshold / maxbit 都是「按采样率换算出来的采样点数」，不是写死的常数 ——
 *   16 MHz 采样的文件照样能解，门限会跟着变成 40 / 80 个采样点。
 *   文件没声明采样率时，可用本文件末尾的 estimateSampleRate() 从波形反推。
 *
 * 状态机（与参考实现一致）：
 *   diff = 本次边沿 - 上次边沿
 *   isZero = diff > threshold
 *   位0  : isZero && !halfOne
 *   位1  : !isZero && halfOne
 *   half : !isZero && !halfOne  -> 记 halfOne
 *   other: 非法序列，按 0 处理并记录
 */

/** PD 规范规定的 BMC 载波频率（1 UI = 半个位宽 = 1/600 kHz ≈ 1.6667 µs） */
export const BMC_HZ = 600000;

/**
 * 单调时钟。浏览器与 Node 都有全局 `performance`；万一没有就退回 `Date.now()`。
 *
 * 只用来判断「距上次让出主线程过了多久」，精度要求很低，退回也不影响正确性。
 *
 * ⚠ **只在这里定义一份**。`tools/build-standalone.mjs` 会把整个模块图拍平进同一个
 * IIFE 作用域，各模块再各写一份同名顶层 `const` 就会互相覆盖（打包器会告警），
 * 所以统一从这里导出给 atkcc.js / pipeline.js 用。
 */
export const nowMs = (typeof performance !== 'undefined' && performance.now)
  ? () => performance.now()
  : () => Date.now();

const IS_NODE = typeof process !== 'undefined' && !!process.versions && !!process.versions.node;

/**
 * 让出主线程一个宏任务，好让浏览器有机会渲染画面、响应点击。
 *
 * ★ 为什么不用 `setTimeout(0)`：实测（Chrome 有头模式，链式让出 12 次，单位 ms）
 *     前台可见： setTimeout 0,0,0,0,0,0,5,5,5,4,4,5    MessageChannel 全 0
 *     后台隐藏： setTimeout 0,0,0,0,0,0,730,996,997,1011,997,996    MessageChannel 全 0
 *   即链式 `setTimeout` 先被「嵌套节流」钳到 4 ms，页面一旦隐藏再被钳到 **约 1 秒**。
 *   解码循环是「每 20 ms 让出一次」，中等规模样本要几百次，被钳就会从
 *   「每 20 ms 推进一片」退化成「每 1 秒才推进一片」。
 *   `MessageChannel` 投递的是普通宏任务，两种情形下都不受钳制，同样会在任务之间
 *   给浏览器留出渲染机会（React Scheduler 用的就是这套）。
 *
 *   注意：隐藏标签下**解码整体仍会慢约 3 倍**（实测 appMs 0.7 s → 2.2 s）。那是 Chrome
 *   对不可见渲染进程的整体降级策略，跟换哪种让出方式无关（已用 A/B 构建验证：
 *   setTimeout 版 2180 ms vs MessageChannel 版 2157 ms，无差别）。这里换原语只是为了
 *   消除「让出本身变成 1 秒一次」这个可复现的钳制，不是为了治好隐藏标签的慢。
 *
 * Node 侧没有节流问题，而且 MessageChannel 的端口会把事件循环钉住不放、导致
 * selftest / ackcheck 这类一次性脚本跑完不退出，所以 Node 一律走 `setTimeout`。
 */
export const yieldToMain = (() => {
  if (IS_NODE) return () => new Promise((r) => setTimeout(r, 0));
  if (typeof MessageChannel === 'function') {
    const mc = new MessageChannel();
    const waiters = [];
    mc.port1.onmessage = () => { const r = waiters.shift(); if (r) r(); };
    return () => new Promise((r) => { waiters.push(r); mc.port2.postMessage(0); });
  }
  return () => new Promise((r) => setTimeout(r, 0));
})();

export const UI_US = 1000000 / BMC_HZ;            // 1.6666666...
export const THRESHOLD_US = (UI_US + 2 * UI_US) / 2; // 2.5
export const MAXBIT_US = 3 * UI_US;               // 5.0

/**
 * 针对某个字节值，预算好其 8 个采样位形成的游程。
 * 结果是 [{ bit, len }, ...]，并保证相邻项 bit 一定不同。
 * 这样扫描时可以避免逐位循环。
 *
 * 两种位序都预先算好：
 *   msb —— bit7 是最早的采样；
 *   lsb —— bit0 是最早的采样。
 *
 * ★ 实测正点原子 ATK-C 导出的 .bin 采用 **LSB 优先**（每字节内 bit0 时间最早）。
 *   用 LSB 解出的游程长度干净地聚集在 4 / 8 采样点（≈1UI / 2UI，2.5MHz 采样、
 *   600kHz BMC 时钟、300kbps 数据率），且报文开头呈现规整的 1010… SOP 前导；
 *   用 MSB 则游程散乱在 1~3 个采样点且无法解出报文。故默认 LSB。
 */
const BYTE_RUNS_MSB = (() => {
  const t = new Array(256);
  for (let b = 0; b < 256; b++) {
    const out = [];
    for (let k = 7; k >= 0; k--) {
      const bit = (b >> k) & 1;
      if (out.length && out[out.length - 1].bit === bit) out[out.length - 1].len++;
      else out.push({ bit, len: 1 });
    }
    t[b] = out;
  }
  return t;
})();

const BYTE_RUNS_LSB = (() => {
  const t = new Array(256);
  for (let b = 0; b < 256; b++) {
    const out = [];
    for (let k = 0; k < 8; k++) {
      const bit = (b >> k) & 1;
      if (out.length && out[out.length - 1].bit === bit) out[out.length - 1].len++;
      else out.push({ bit, len: 1 });
    }
    t[b] = out;
  }
  return t;
})();

/**
 * 从字节流中提取电平游程（run），并转换为「边沿采样点」序列。
 *
 * 采样约定：每个字节 8 个采样点。默认 LSB 优先（bit0 是最早的采样）。
 */
export class EdgeExtractor {
  /** @param {{bitOrder?: 'lsb'|'msb'}} [opts] */
  constructor(opts = {}) {
    this.runs = (opts.bitOrder || 'lsb') === 'msb' ? BYTE_RUNS_MSB : BYTE_RUNS_LSB;
    this.level = -1;      // 当前电平，-1 表示尚未确定
    this.runStart = 0;    // 当前游程起始采样序号
    this.sample = 0;      // 已消费的采样点数
    this.started = false;
  }

  /**
   * 处理一整块数据。
   * @param {Uint8Array} data
   * @param {number} baseSample 该块第一个采样点对应的全局采样序号
   * @param {(edgeSample:number)=>void} onEdge 电平翻转时的全局采样序号
   */
  push(data, baseSample, onEdge) {
    let sample = baseSample;
    for (let i = 0; i < data.length; i++) {
      const b = data[i];
      if (b === 0) {
        // 全 0：8 个采样点为低
        if (this.level === 0) { /* 延续 */ }
        else { onEdge(sample); this.level = 0; this.runStart = sample; }
        sample += 8;
        continue;
      }
      if (b === 0xff) {
        // 全 1：8 个采样点为高（绝大多数数据都是这种，走快路径）
        if (this.level === 1) { /* 延续 */ }
        else { onEdge(sample); this.level = 1; this.runStart = sample; }
        sample += 8;
        continue;
      }
      const runs = this.runs[b];
      for (let r = 0; r < runs.length; r++) {
        const run = runs[r];
        if (this.level !== run.bit) {
          onEdge(sample);
          this.level = run.bit;
          this.runStart = sample;
        }
        sample += run.len;
      }
    }
    this.sample = sample;
  }

  /** 收尾：补一个虚拟边沿，让最后一个包也能被刷新出来。 */
  flush(onEdge, padSamples) {
    onEdge(this.sample + padSamples);
  }
}

/**
 * 单包允许累积的最大位数。超过就判定「根本不是 PD 报文」并就地丢弃。
 *
 * 为什么必须有这道闸：`pushEdge` 只在「长时间空闲」（`diff > maxbit`）或收尾时才收包。
 * 于是遇到**噪声数据**（电平每个采样点都跳变，diff 永远很小）时，
 * `bits` / `edges` 会一路涨到几千万位而从不重置；等到最后收尾那一次，
 * `pd.decode()` 会对着这个巨型数组做一次 `_scanSop`（逐位取符号 + 逐位试匹配有序集），
 * **整个扫描是同步的、几秒钟**——界面就彻底卡住，连进度条都来不及画。
 * 实测：一份 18 KB 的噪声样本能让主线程连续阻塞 6.3 秒。
 *
 * 上限取 8192 位：PD 3.1 最长的扩展报文是 260 字节，
 * 4B5B 后 260 × 10 = 2600 位，再加 SOP(20) / EOP(5) 也就 2625 位 ——
 * 8192 是 3 倍余量，**任何合法报文都碰不到这道闸**，不会误伤。
 */
export const MAX_PACKET_BITS = 8192;

/**
 * PD 包的 BMC 状态机。边沿进来，包出去。
 */
export class BmcDecoder {
  constructor({ sampleRate, minEdges = 50, thresholdSamples = null, maxbitSamples = null }) {
    this.sampleRate = sampleRate;
    this.minEdges = minEdges;
    this.threshold = thresholdSamples != null
      ? thresholdSamples
      : Math.max(1, Math.round(THRESHOLD_US * sampleRate / 1e6));
    this.maxbit = maxbitSamples != null
      ? maxbitSamples
      : Math.max(1, Math.round(MAXBIT_US * sampleRate / 1e6));
    this.reset();
  }

  reset() {
    this.startsample = null;
    this.previous = 0;
    this.bits = [];
    this.edges = [];
    this.bad = [];
    this.halfOne = false;
    this.startOne = 0;
  }

  /**
   * 收完一包（或被丢弃的一段）之后重新对齐。
   * `flush` 为真表示这是整个流的收尾，之后不再有数据，起点要置空。
   */
  _restart(sample, flush) {
    this.startsample = flush ? null : sample;
    this.bits = [];
    this.edges = [];
    this.bad = [];
    this.halfOne = false;
    this.startOne = 0;
    this.previous = sample;
  }

  /**
   * 送入一个边沿。
   * @returns {null|{bits:number[],edges:number[],startSample:number,endSample:number,bad:number[][],bitrate:number}}
   */
  pushEdge(sample, flush = false) {
    if (this.startsample === null) {
      this.startsample = sample;
      this.previous = sample;
      return null;
    }

    const diff = sample - this.previous;

    // 长时间空闲 => 视为包结束
    if (diff > this.maxbit || flush) {
      if (!flush) this.edges.push(this.previous);
      const packet = this._emit();
      this._restart(sample, flush);
      return packet;
    }

    // 位累积超限 => 不是 PD 报文，就地丢弃并重新对齐（见 MAX_PACKET_BITS）
    if (this.bits.length >= MAX_PACKET_BITS) {
      this._restart(sample, false);
      return null;
    }

    const isZero = diff > this.threshold;
    if (isZero && !this.halfOne) {
      this.bits.push(0);
      this.edges.push(this.previous);
    } else if (!isZero && this.halfOne) {
      this.bits.push(1);
      this.edges.push(this.startOne);
      this.halfOne = false;
    } else if (!isZero && !this.halfOne) {
      this.halfOne = true;
      this.startOne = this.previous;
    } else {
      this.bad.push([this.startOne, this.previous]);
      this.bits.push(0);
      this.edges.push(this.previous);
      this.halfOne = false;
    }
    this.previous = sample;
    return null;
  }

  _emit() {
    if (this.edges.length < this.minEdges) return null;
    const ss = this.edges[0];
    const es = this.edges[this.edges.length - 1];
    if (!(es > ss)) return null;
    const bitrate = Math.round(this.sampleRate * this.bits.length / (es - ss));
    return {
      bits: this.bits,
      edges: this.edges,
      startSample: this.startsample,
      endSample: es,
      bad: this.bad,
      bitrate,
    };
  }
}

/* ═══════════════════════ 采样率反推（波形自检） ═══════════════════════ */

/**
 * 收集一段采样字节流里的「游程」长度（相邻同电平采样点的连续个数）。
 *
 * BMC 里的合法游程只有两种：1 UI（'1' 位的半段）和 2 UI（'0' 位的整段），
 * 空闲段会长得多。所以游程长度分布里只有两个簇，且长度比恒为 1:2 ——
 * 据此就能把「1 UI 等于几个采样点」解出来（见 estimateUiSamples）。
 *
 * @param {Uint8Array} data 采样字节流（每字节 8 个采样点，LSB 优先）
 * @param {{maxRun?:number, maxRuns?:number}} [opts] maxRun 以上的算空闲段直接丢弃
 * @returns {number[]} 游程长度（采样点数）列表，最多 maxRuns 个
 */
export function collectRunStats(data, { maxRun = 64, maxRuns = 40000 } = {}) {
  const runs = [];
  const push = (n) => { if (n >= 2 && n <= maxRun) runs.push(n); };
  let level = -1, len = 0;

  for (let i = 0; i < data.length; i++) {
    const b = data[i];
    if (b === 0 || b === 0xff) {                 // 快速路径：整字节同电平
      const bit = b === 0 ? 0 : 1;
      if (bit === level) { len += 8; }
      else { if (level !== -1) push(len); level = bit; len = 8; }
      continue;
    }
    const rs = BYTE_RUNS_LSB[b];
    for (let r = 0; r < rs.length; r++) {
      const run = rs[r];
      if (run.bit === level) { len += run.len; }
      else { if (level !== -1) push(len); level = run.bit; len = run.len; }
    }
    if (runs.length >= maxRuns) break;           // 统计量够了，不再往下扫
  }
  if (level !== -1 && runs.length < maxRuns) push(len);
  return runs;
}

/**
 * 由游程分布反推「1 UI = 多少采样点」。
 *
 * 原理：每个游程非 1 UI 即 2 UI，于是
 *        Σ 游程采样点数 = UI × (nShort + 2 × nLong)
 *     ⇒  UI = Σ / (nShort + 2 × nLong)
 * 分类门限取 1.5 × UI，迭代几轮即收敛（比只看直方图峰值精确得多：
 * 峰值只能给到整数，而这个式子能把 4.167 这种小数解出来）。
 *
 * @param {number[]} runs collectRunStats 的输出
 * @returns {null|{uiSamples:number, nShort:number, nLong:number, confidence:number, used:number}}
 */
export function estimateUiSamples(runs) {
  if (!runs || runs.length < 200) return null;

  // ① 粗搜候选 UI：挑「能把游程解释成 1 UI 或 2 UI 的比例最高」的那个。
  //    不能只看直方图峰值或最小值 —— UI=2.5 个采样点时，1 UI 的游程会在 2 和 3 之间
  //    来回跳，任何单点启发式都会被量化噪声带偏。全量扫候选值最稳，代价几十毫秒。
  const sub = runs.length > 4000
    ? Array.from({ length: 4000 }, (_, i) => runs[Math.floor((i * runs.length) / 4000)])
    : runs;
  let bestUi = 0, bestScore = 0;
  for (let ui = 1.2; ui <= 60; ui += 0.05) {
    const tol = ui * 0.3;
    let hit = 0, nS = 0, nL = 0;
    for (const r of sub) {
      if (Math.min(Math.abs(r - ui), Math.abs(r - 2 * ui)) >= tol) continue;
      hit++;
      if (r < ui * 1.5) nS++; else nL++;
    }
    if (hit / sub.length < 0.9) continue;
    if (nS < sub.length * 0.1 || nL < sub.length * 0.1) continue;   // 两个簇都得有料
    const score = hit / sub.length;
    if (score > bestScore) { bestScore = score; bestUi = ui; }
  }
  if (!bestUi) return null;

  // ② 精修：每个游程非 1 UI 即 2 UI ⇒ Σ 游程采样点数 = UI · (nShort + 2·nLong)，
  //    迭代几轮把这个式子解到底 —— 整数取整带来的偏差会被平均掉，能解出 4.167 这种小数。
  let ui = bestUi, nS = 0, nL = 0;
  for (let it = 0; it < 8; it++) {
    const cut = 1.5 * ui;
    nS = 0; nL = 0;
    let total = 0;
    for (const r of runs) {
      if (r < ui * 0.55 || r > ui * 3.2) continue;         // 既不像 1 UI 也不像 2 UI
      total += r;
      if (r < cut) nS++; else nL++;
    }
    if (nS + nL < 100) return null;
    const next = total / (nS + 2 * nL);
    if (!(next > 0)) return null;
    if (Math.abs(next - ui) < 1e-4) { ui = next; break; }
    ui = next;
  }

  // ③ 置信度：游程里有多大比例真的落在 1 UI / 2 UI 附近（±0.35 UI）
  let good = 0;
  for (const r of runs) {
    if (Math.min(Math.abs(r - ui), Math.abs(r - 2 * ui)) < ui * 0.35) good++;
  }
  const confidence = good / runs.length;
  if (confidence < 0.85 || nS < 50 || nL < 50) return null;  // 不像 PD 波形，别硬猜
  return { uiSamples: ui, nShort: nS, nLong: nL, confidence, used: nS + nL };
}

/**
 * 从波形反推采样率（Hz）。
 * @param {number[]} runs collectRunStats 的输出
 * @returns {null|{sampleRate:number, uiSamples:number, confidence:number}}
 */
export function estimateSampleRate(runs) {
  const e = estimateUiSamples(runs);
  if (!e) return null;
  const sampleRate = Math.round(e.uiSamples * BMC_HZ);
  if (!(sampleRate >= 100000 && sampleRate <= 50000000)) return null;   // 离谱的值不认
  return { sampleRate, uiSamples: e.uiSamples, confidence: e.confidence, nShort: e.nShort, nLong: e.nLong };
}
