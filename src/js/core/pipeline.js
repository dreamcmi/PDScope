/**
 * pipeline.js — 把 .atkcc 变成 PD 报文列表的完整流水线
 *
 *   解压分块 -> 位流(1bit/采样) -> BMC 边沿状态机 -> 4B5B/PD 解析 -> 报文对象
 *
 * 全程流式处理，逐块回调进度，支持中断（长抓包可随时停止）。
 */

import { EdgeExtractor, BmcDecoder, collectRunStats, estimateSampleRate, nowMs, yieldToMain } from './bmc.js';
import { PdDecoder } from '../pd/index.js';
import { AtkccCapture } from './atkcc.js';

/**
 * 喂给边沿提取器的**单片**字节数（64 KiB = 52 万个采样点）。
 *
 * 为什么要切片：一块数据是 1 MiB，而「边沿提取 → BMC 状态机 → PD 解析」
 * 全程同步。块本身如果边沿密集，单块就能占住主线程几百毫秒。
 * 切成小片之后，片与片之间才有机会看时间预算让出主线程。
 *
 * 注意这**不改变解码结果**：`EdgeExtractor` / `BmcDecoder` 的状态都挂在实例上
 * （当前电平、游程起点、已积累的位），连续小片依次喂入与整块一次喂入完全等价 ——
 * 只是每次传入的 `baseSample` 要跟着片偏移走。
 */
const SLICE_BYTES = 65536;

/**
 * 两次让出主线程之间的时间预算。
 *
 * 原实现是「每 8 块让一次」（`if ((i & 7) === 7)`），这在真实抓包上够用
 * （实测最长阻塞 67~83 ms），但它**与单块成本无关**：块贵起来就是
 * 「8 × 单块成本」的连续阻塞。改成按时间算之后，无论数据多难解，
 * 主线程最多被占住「一片 + 预算」≈ 30 ms，界面和进度条始终有反应。
 */
const YIELD_BUDGET_MS = 20;

/**
 * @param {AtkccCapture} capture
 * @param {number} channel
 * @param {{inflate:Function, onProgress?:Function, shouldStop?:()=>boolean, sampleRate?:number, specRevision?:'2.0'|'3.0'|'3.1'|'3.2'|null}} opts
 * @returns {Promise<{packets:object[], stats:object}>}
 */
export async function decodeChannel(capture, channel, opts) {
  const { inflate, onProgress, shouldStop } = opts;
  const ch = capture.meta.channelMap.get(channel);
  if (!ch) throw new Error(`通道 ${channel} 不存在`);

  // 采样率不是写死的：先看文件声明，再用波形节拍核对 / 兜底（同一份文件只测一次）
  const rate = await resolveSampleRate(capture, channel, inflate, { shouldStop, sampleRate: opts.sampleRate });
  const sampleRate = rate.rate;

  const bmc = new BmcDecoder({ sampleRate });
  const pd = new PdDecoder({ sampleRate, specRevision: opts.specRevision ?? null });
  const ex = new EdgeExtractor({ bitOrder: opts.bitOrder || 'lsb' });
  const packets = [];

  const limit = capture.effectiveSampleLimit(channel);
  let sampleBase = 0;
  let trimmed = 0;
  let edges = 0;

  const emit = (raw) => {
    edges += raw.edges.length;
    const pkt = pd.decode(raw, channel);
    if (pkt) packets.push(pkt);
  };

  // 复用同一个回调，别在切片循环里每次新建闭包（切片数量很大，白造垃圾）
  const onEdge = (edge) => {
    const p = bmc.pushEdge(edge);
    if (p) emit(p);
  };

  /**
   * 时间预算到了就让出一次主线程。
   * @returns {Promise<boolean>} false = 调用方要求中断，外层应立即收工
   */
  let lastYield = nowMs();
  const breathe = async () => {
    if (nowMs() - lastYield < YIELD_BUDGET_MS) return !shouldStop?.();
    await yieldToMain();
    lastYield = nowMs();
    return !shouldStop?.();
  };

  outer:
  for (let i = 0; i < ch.chunks.length; i++) {
    if (shouldStop?.()) break;
    let data = await capture.readChunk(channel, i, inflate);
    if (!data) continue;

    const isLast = i === ch.chunks.length - 1;
    let keep = data.length;
    if (limit > 0) {
      const remainBytes = Math.ceil((limit - sampleBase) / 8);
      if (remainBytes < keep) keep = Math.max(0, remainBytes);
    }
    if (isLast) {
      const t = AtkccCapture.trimTrailingZeros(data);
      if (t < keep) { trimmed += keep - t; keep = t; }
    }
    data = data.subarray(0, keep);

    // 分片喂入：片内是同步的，片间可以让出主线程（见 SLICE_BYTES / YIELD_BUDGET_MS）
    for (let off = 0; off < data.length; off += SLICE_BYTES) {
      const end = Math.min(off + SLICE_BYTES, data.length);
      ex.push(data.subarray(off, end), sampleBase + off * 8, onEdge);
      if (!(await breathe())) break outer;         // 用户切走了 / 取消了，别再往下跑
    }
    sampleBase += data.length * 8;

    onProgress?.({
      channel,
      chunk: i + 1,
      chunks: ch.chunks.length,
      ratio: (i + 1) / ch.chunks.length,
      packets: packets.length,
      samples: sampleBase,
    });
  }

  // 收尾：补一个虚拟边沿，让最后一个包也能落地
  if (!shouldStop?.()) {
    ex.flush((edge) => {
      const p = bmc.pushEdge(edge, true);
      if (p) emit(p);
    }, bmc.maxbit + 1);
  }

  // 按采样点排序，并分配序号
  packets.sort((a, b) => a.startSample - b.startSample);
  packets.forEach((p, i) => { p.index = i; });

  // 建立 GoodCRC → 被确认报文的对应关系（供界面「同色配对」及导出使用）
  linkGoodCrc(packets);

  return {
    packets,
    stats: {
      channel,
      specRevision: opts.specRevision ?? null,
      totalSamples: sampleBase,
      durationSec: sampleBase / sampleRate,
      sampleRate,
      sampleRateSource: rate.source,          // declared | measured | default | override
      sampleRateDeclared: rate.declared,
      sampleRateMeasured: rate.measured ?? null,
      sampleRateNote: rate.note ?? null,      // 与声明值不一致时给界面一句人话解释
      edges,
      trimmedBytes: trimmed,
      packetCount: packets.length,
      badCrc: packets.filter((p) => p.crcOk === false).length,
      warnings: packets.reduce((s, p) => s + (p.warnings?.length ?? 0), 0),
    },
  };
}

// ── 采样率：声明 → 波形自检 → 兜底 ───────────────────────────────────

/**
 * 声明值与波形实测的最大允许偏差。超出这个比例才认为「文件写的采样率不可信」。
 *
 * 为什么门槛这么宽（±25%）而不是 5%？因为 PD 标称的 600 kHz BMC 时钟只是**标称**：
 * 用波形节拍反推的采样率与文件声明的 2.5 MHz 之间，实测 5 份不同厂商的抓包都稳定
 * 偏低约 4%（器件时钟与标称值的正常离散）。而文件声明的采样率才是「采样点序号 → 时间」
 * 的换算依据（用它算出来的时标与官方上位机逐字段一致），所以只要两者量级相符就以声明为准。
 */
export const RATE_TOLERANCE = 0.25;

const fmtHz = (hz) => `${(hz / 1e6).toFixed(3).replace(/\.?0+$/, '')} MHz`;

/**
 * 只用波形的游程分布反推采样率 —— 只读最前面 1~2 个块，量级几十毫秒。
 * @returns {Promise<null|{sampleRate:number, uiSamples:number, confidence:number}>}
 */
export async function probeSampleRate(capture, channel, inflate, { maxChunks = 2, maxRuns = 40000, shouldStop } = {}) {
  const ch = capture.meta.channelMap.get(channel);
  if (!ch) return null;
  let runs = [];
  for (let i = 0; i < Math.min(maxChunks, ch.chunks.length); i++) {
    if (shouldStop?.()) break;
    const data = await capture.readChunk(channel, i, inflate);
    if (!data) continue;
    runs = runs.concat(collectRunStats(data, { maxRuns: Math.max(0, maxRuns - runs.length) }));
    if (runs.length >= maxRuns) break;
  }
  return estimateSampleRate(runs);
}

/**
 * 决定这份抓包用哪个采样率把「采样点序号」换算成时间。三级策略，越靠前越优先：
 *
 *   ① **文件声明**（`channel.ini`）—— 5 份真实抓包都声明 2500 kHz，且据此算出的时标
 *      与官方 ATK-C 截图逐字段一致，所以它是首选。
 *   ② **波形自检** —— 用 BMC 游程反推（`estimateSampleRate`）。只有当 ① 缺失，或 ① 与
 *      波形相差超过 ±RATE_TOLERANCE 时才推翻 ①。这样遇到「别的采样率」「单位写错」
 *      「压根没写」的文件也能解，而正常文件的行为一字不变。
 *   ③ **兜底** `DEFAULT_SAMPLE_RATE`（2.5 MHz）。
 *
 * 结果会缓存到 capture 上：同一份文件切换通道时不重复测。
 *
 * @returns {Promise<{rate:number, source:'declared'|'measured'|'default'|'override',
 *                    declared:number, measured:number|null, note:string|null, cached?:boolean}>}
 */
export async function resolveSampleRate(capture, channel, inflate, opts = {}) {
  const declared = capture.meta.sampleRate;
  const declaredSource = capture.meta.sampleRateSource || 'default';

  if (opts.sampleRate > 0) {
    return { rate: opts.sampleRate, source: 'override', declared, measured: null,
      note: `采样率由调用方指定为 ${fmtHz(opts.sampleRate)}（文件声明 ${fmtHz(declared)}）` };
  }

  capture._rateCache ||= new Map();
  if (capture._rateCache.has(channel)) return capture._rateCache.get(channel);

  const measured = await probeSampleRate(capture, channel, inflate, opts);
  const info = {
    declared,
    declaredSource,
    measured: measured?.sampleRate ?? null,
    measuredUi: measured?.uiSamples ?? null,
    confidence: measured?.confidence ?? 0,
    declaredText: capture.meta.sampleRateRaw || null,
  };

  let out;
  if (!measured) {
    // 波形认不出来（比如通道是空的、或数据不是 PD）→ 保持声明值/兜底值
    out = { ...info, rate: declared, source: declaredSource, note: null };
  } else {
    const ratio = measured.sampleRate / declared;
    if (declaredSource === 'declared' && ratio >= 1 - RATE_TOLERANCE && ratio <= 1 + RATE_TOLERANCE) {
      out = { ...info, rate: declared, source: 'declared', ratio, note: null };     // 一致 → 信文件
    } else if (declaredSource === 'default') {
      out = { ...info, rate: measured.sampleRate, source: 'measured', ratio,
        note: `文件未声明采样率，按波形节拍取 ${fmtHz(measured.sampleRate)}` };
    } else {
      out = { ...info, rate: measured.sampleRate, source: 'measured', ratio,
        note: `文件声明 ${fmtHz(declared)} 与波形节拍（${fmtHz(measured.sampleRate)}）相差过大，已按实测值解码` };
    }
  }
  capture._rateCache.set(channel, out);
  return out;
}

// ── GoodCRC 配对 ─────────────────────────────────────────────────────

/**
 * 给每条 GoodCRC 找出「它所确认的那条报文」，写入：
 *   p.ackOf   —— 被确认报文的序号（packets 下标）
 *   p.ackType —— 被确认报文的类型名（便于展示）
 *
 * 判据来源：
 *   ① 向前找最近一条同 SOP、方向相反的普通报文；复位信令不参与确认配对。
 *   ② **MessageID**——PD 规范要求 GoodCRC 的 MessageID 与被确认报文相同。
 *      邻近报文 CRC 未报错却 ID 对不上时，在窗口内继续向前找同 ID 的报文。
 *      没有匹配对象时保留未配对状态。
 *
 * 注意不能只用 ②：被确认报文本身是坏包时 MessageID 不可信，若拿它去查
 * 「最近登记的同 ID 报文」，会误配到几十条报文之前的一条陈旧记录上。
 * 坏掉的 GoodCRC 不参与配对（保持错误标识，便于定位）。
 */
const ACK_WINDOW = 16;   // 向前搜索窗口（条）
export function linkGoodCrc(packets) {
  const pick = (p, needId) => {
    for (let j = p.index - 1; j >= 0 && j > p.index - ACK_WINDOW; j--) {
      const q = packets[j];
      if (q.msgType === 'GoodCRC' || q.role === p.role || q.sop !== p.sop || q.msgKind === 'special') continue;
      if (needId && q.crcOk !== false && q.msgId !== p.msgId) continue;
      return q;
    }
    return null;
  };
  for (const p of packets) {
    if (p.msgType === 'GoodCRC') { delete p.ackOf; delete p.ackType; }
    if (p.msgType !== 'GoodCRC' || p.crcOk === false) continue;
    let ref = pick(p, false);
    if (!ref) continue;
    // 邻近报文 CRC 完好但 MessageID 对不上 → 改按 MessageID 精确匹配
    if (ref.crcOk !== false && ref.msgId !== p.msgId) ref = pick(p, true);
    if (!ref) continue;
    p.ackOf = ref.index;
    p.ackType = ref.msgType;
  }
}

// ── bus.ini 模拟量轨迹 ────────────────────────────────────────────────

/** 取某个采样点处的 VBUS/IBUS（阶梯保持） */
export function busAt(bus, sample) {
  if (!bus || !bus.length || sample < bus[0].sample) return { vbus: null, ibus: null };
  let lo = 0, hi = bus.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bus[mid].sample <= sample) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return bus[ans];
}

/** 保留容器逐报文测量；仅在缺失时用 ADC 序列阶梯保持回填。 */
export function attachBusValues(packets, bus) {
  for (const p of packets) {
    const b = busAt(bus, p.startSample);
    if (!Number.isFinite(p.vbus)) p.vbus = Number.isFinite(b.vbus) ? b.vbus : null;
    if (!Number.isFinite(p.ibus)) p.ibus = Number.isFinite(b.ibus) ? b.ibus : null;
  }
}

/**
 * 把模拟量轨迹展开成等间隔序列，用于画图。
 *
 * `bus` 与 .atkcc 的 bus.ini 同形（`{sample, vbus, ibus}`）；分析仪导出的抓包
 * （见 core/powerz.js）会再多两个字段 `a` / `b`（POWER-Z 的 CC1/CC2 或 UFCS 的 DP/DM，
 * 见 `meta.busLabels`）。有就一并展开成 `ca` / `cb`，没有就是 null —— 界面据此决定
 * 要不要给出「CC 线」那一档视图，两条路径共用这一个builder。
 *
 * @returns {{t0:number, step:number, n:number, vbus:Float64Array, ibus:Float64Array,
 *            vmax:number, imax:number, sampleRate:number,
 *            hasAux:boolean, ca:Float64Array|null, cb:Float64Array|null,
 *            camax:number, cbmax:number}}
 */
export function buildBusSeries(bus, totalSamples, sampleRate, targetPoints = 3000) {
  if (!bus || !bus.length) {
    return {
      t0: 0, step: 0, n: 0, vbus: new Float64Array(0), ibus: new Float64Array(0),
      vmax: 0, imax: 0, sampleRate, hasAux: false, ca: null, cb: null, camax: 0, cbmax: 0,
    };
  }
  const hasAux = bus.some((r) => r.a !== undefined || r.b !== undefined);

  const step = Math.max(1, Math.floor(totalSamples / targetPoints));
  const n = Math.floor(totalSamples / step) + 1;
  const vbus = new Float64Array(n);
  const ibus = new Float64Array(n);
  const ca = hasAux ? new Float64Array(n) : null;
  const cb = hasAux ? new Float64Array(n) : null;
  let vmax = 0, imax = 0, camax = 0, cbmax = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * step;
    while (j + 1 < bus.length && bus[j + 1].sample <= s) j++;
    vbus[i] = bus[j].vbus;
    ibus[i] = bus[j].ibus;
    if (vbus[i] > vmax) vmax = vbus[i];
    if (ibus[i] > imax) imax = ibus[i];
    if (hasAux) {
      ca[i] = bus[j].a ?? 0;
      cb[i] = bus[j].b ?? 0;
      if (ca[i] > camax) camax = ca[i];
      if (cb[i] > cbmax) cbmax = cb[i];
    }
  }
  return { t0: 0, step, n, vbus, ibus, vmax, imax, sampleRate, hasAux, ca, cb, camax, cbmax };
}

/** 取一段采样区间内的原始电平，用于波形视图（压缩为 min/max 包络） */
export async function readWaveform(capture, channel, inflate, startSample, endSample, maxPoints = 1200) {
  const ch = capture.meta.channelMap.get(channel);
  if (!ch) return null;
  const startByte = Math.floor(startSample / 8);
  const endByte = Math.min(Math.ceil(endSample / 8), ch.totalBytes);
  const firstChunk = Math.floor(startByte / 1048576);
  const lastChunk = Math.floor((endByte - 1) / 1048576);

  const span = Math.max(1, endSample - startSample);
  const bucket = Math.max(1, Math.ceil(span / maxPoints));
  const points = [];
  let cur = { s: startSample, hi: 0, lo: 1 };

  const consumeRun = (level, len, sample) => {
    // 把一段电平塞进桶里
    let bucketIdx = Math.floor((sample - startSample) / bucket);
    // 简化：只记录该桶内是否出现过高低
    if (bucketIdx >= maxPoints) bucketIdx = maxPoints - 1;
    while (points.length <= bucketIdx) {
      points.push({ s: startSample + points.length * bucket, hi: 0, lo: 1 });
    }
    const p = points[bucketIdx];
    if (level) p.hi = 1; else p.lo = 0;
  };

  for (let ci = firstChunk; ci <= lastChunk; ci++) {
    const data = await capture.readChunk(channel, ci, inflate);
    if (!data) continue;
    const chunkBase = ci * 1048576 * 8;
    for (let b = 0; b < data.length; b++) {
      const bitBase = chunkBase + b * 8;
      if (bitBase + 8 <= startSample || bitBase >= endSample) continue;
      const byte = data[b];
      if (byte === 0xFF) { consumeRun(1, 8, bitBase); continue; }
      if (byte === 0x00) { consumeRun(0, 8, bitBase); continue; }
      for (let k = 0; k < 8; k++) {          // LSB 优先：bit0 时间最早
        const bit = (byte >> k) & 1;
        const s = bitBase + k;
        if (s < startSample || s >= endSample) continue;
        consumeRun(bit, 1, s);
      }
    }
  }
  return { points, bucket, startSample, endSample, sampleRate: capture.meta.sampleRate };
}
