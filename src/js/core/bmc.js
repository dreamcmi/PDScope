/**
 * bmc.js — USB PD 的 BMC（Biphase Mark Coding）解码
 *
 * 完全对齐 sigrok `usb_power_delivery` 解码器的实现语义：
 *   UI            = 1 / 600kHz = 1.6667 µs        （单位间隔 = 半位）
 *   threshold     = 1.5 * UI   = 2.5   µs          （区分「半位1」与「位0」）
 *   maxbit        = 3 * UI     = 5.0   µs          （超过即视为空闲，包结束）
 *
 * 状态机（与参考实现一致）：
 *   diff = 本次边沿 - 上次边沿
 *   isZero = diff > threshold
 *   位0  : isZero && !halfOne
 *   位1  : !isZero && halfOne
 *   half : !isZero && !halfOne  -> 记 halfOne
 *   other: 非法序列，按 0 处理并记录
 */

export const UI_US = 1000000 / 600000;            // 1.6666666...
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
      // 重新开始
      this.startsample = flush ? null : sample;
      this.bits = [];
      this.edges = [];
      this.bad = [];
      this.halfOne = false;
      this.startOne = 0;
      this.previous = sample;
      return packet;
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
