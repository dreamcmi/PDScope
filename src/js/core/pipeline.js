/**
 * pipeline.js — 把 .atkcc 变成 PD 报文列表的完整流水线
 *
 *   解压分块 -> 位流(1bit/采样) -> BMC 边沿状态机 -> 4B5B/PD 解析 -> 报文对象
 *
 * 全程流式处理，逐块回调进度，支持中断（长抓包可随时停止）。
 */

import { EdgeExtractor, BmcDecoder } from './bmc.js';
import { PdDecoder } from './pd.js';
import { AtkccCapture } from './atkcc.js';

/**
 * @param {AtkccCapture} capture
 * @param {number} channel
 * @param {{inflate:Function, onProgress?:Function, shouldStop?:()=>boolean}} opts
 * @returns {Promise<{packets:object[], stats:object}>}
 */
export async function decodeChannel(capture, channel, opts) {
  const { inflate, onProgress, shouldStop } = opts;
  const sampleRate = capture.meta.sampleRate;
  const ch = capture.meta.channelMap.get(channel);
  if (!ch) throw new Error(`通道 ${channel} 不存在`);

  const bmc = new BmcDecoder({ sampleRate });
  const pd = new PdDecoder({ sampleRate });
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

    ex.push(data, sampleBase, (edge) => {
      const p = bmc.pushEdge(edge);
      if (p) emit(p);
    });
    sampleBase += data.length * 8;

    onProgress?.({
      channel,
      chunk: i + 1,
      chunks: ch.chunks.length,
      ratio: (i + 1) / ch.chunks.length,
      packets: packets.length,
      samples: sampleBase,
    });

    // 让出主线程，避免长任务卡死 UI
    if ((i & 7) === 7) await new Promise((r) => setTimeout(r, 0));
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

  // 建立 GOOD CRC → 被确认报文的对应关系（供界面「同色配对」及导出使用）
  linkGoodCrc(packets);

  return {
    packets,
    stats: {
      channel,
      totalSamples: sampleBase,
      durationSec: sampleBase / sampleRate,
      edges,
      trimmedBytes: trimmed,
      packetCount: packets.length,
      badCrc: packets.filter((p) => p.crcOk === false).length,
      warnings: packets.reduce((s, p) => s + (p.warnings?.length ?? 0), 0),
    },
  };
}

// ── GOOD CRC 配对 ────────────────────────────────────────────────────

/**
 * 给每条 GOOD CRC 找出「它所确认的那条报文」，写入：
 *   p.ackOf   —— 被确认报文的序号（packets 下标）
 *   p.ackType —— 被确认报文的类型名（便于展示）
 *
 * 判据来源：
 *   ① **紧邻性**——GoodCRC 是对报文的即时应答，必然落在被确认报文之后最近处。
 *      向前找最近一条「非 GOOD CRC 且方向相反」的报文，即物理上唯一合理的对象。
 *      这一条也能覆盖 Hard Reset / Cable Reset 这类没有 MessageID 的报文。
 *   ② **MessageID**——PD 规范要求 GoodCRC 的 MessageID 与被确认报文相同。
 *      用它校验 ①；若邻近报文 CRC 完好却 ID 对不上（说明中间夹了别的方向的报文），
 *      再向后找同 ID 的那条。找不到仍按邻近关系配对。
 *
 * 注意不能只用 ②：被确认报文本身是坏包时 MessageID 不可信，若拿它去查
 * 「最近登记的同 ID 报文」，会误配到几十条报文之前的一条陈旧记录上。
 * 坏掉的 GOOD CRC 不参与配对（保持错误标识，便于定位）。
 */
const ACK_WINDOW = 16;   // 向前搜索窗口（条）
function linkGoodCrc(packets) {
  const pick = (p, needId) => {
    for (let j = p.index - 1; j >= 0 && j > p.index - ACK_WINDOW; j--) {
      const q = packets[j];
      if (q.msgType === 'GOOD CRC' || q.role === p.role) continue;
      if (needId && q.crcOk !== false && q.msgId !== p.msgId) continue;
      return q;
    }
    return null;
  };
  for (const p of packets) {
    if (p.msgType !== 'GOOD CRC' || p.crcOk === false) continue;
    let ref = pick(p, false);
    if (!ref) continue;
    // 邻近报文 CRC 完好但 MessageID 对不上 → 改按 MessageID 精确匹配
    if (ref.crcOk !== false && ref.msgId !== p.msgId) ref = pick(p, true) || ref;
    p.ackOf = ref.index;
    p.ackType = ref.msgType;
  }
}

// ── bus.ini 模拟量轨迹 ────────────────────────────────────────────────

/** 取某个采样点处的 VBUS/IBUS（阶梯保持） */
export function busAt(bus, sample) {
  if (!bus || !bus.length) return { vbus: 0, ibus: 0 };
  let lo = 0, hi = bus.length - 1, ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bus[mid].sample <= sample) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return bus[ans];
}

/**
 * 把 bus.ini 展开成等间隔序列，用于画图。
 * @returns {{t0:number, dt:number, vbus:Float64Array, ibus:Float64Array, min:number, max:number, vmax:number, imax:number}}
 */
export function buildBusSeries(bus, totalSamples, sampleRate, targetPoints = 3000) {
  if (!bus || !bus.length) {
    return { t0: 0, dt: 0, vbus: new Float64Array(0), ibus: new Float64Array(0), vmax: 0, imax: 0 };
  }
  const step = Math.max(1, Math.floor(totalSamples / targetPoints));
  const n = Math.floor(totalSamples / step) + 1;
  const vbus = new Float64Array(n);
  const ibus = new Float64Array(n);
  let vmax = 0, imax = 0;
  let j = 0;
  for (let i = 0; i < n; i++) {
    const s = i * step;
    while (j + 1 < bus.length && bus[j + 1].sample <= s) j++;
    vbus[i] = bus[j].vbus;
    ibus[i] = bus[j].ibus;
    if (vbus[i] > vmax) vmax = vbus[i];
    if (ibus[i] > imax) imax = ibus[i];
  }
  return { t0: 0, step, n, vbus, ibus, vmax, imax, sampleRate };
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
