/**
 * atkcc.js — 正点原子 ATK-C (.atkcc) 抓包文件格式解析
 *
 * 格式（实测归纳）：
 *   .atkcc 就是 ZIP：
 *     channel.ini        "SamplingFrequency=2500"   —— 数值单位是 kHz，即数字采样率 2.5 MHz
 *     bus.ini            "sample=N,vbus=1.234,ibus=0.567"  —— 模拟量轨迹，sample 与数字采样同域
 *     0/channel.ini      第 1 行=通道组号，第 2 行=总采样点数（所有通道共享同一时基）
 *     0/<ch>-<idx>.bin   通道 <ch> 的第 <idx> 块，每块固定 1 MiB
 *
 * 关键结论（已用官方 ATK-C 截图逐字段交叉验证，完全一致）：
 *   · 每个采样点 1 bit，**LSB 优先**（每字节内 bit0 时间最早）
 *   · 某字节 0xFF = 该 8 个采样点全高；0x00 = 全低（空载/空闲段，末块尾部为补齐）
 *   · 采样率**由文件声明**（channel.ini），本工具不写死；只管两点：① 声明值怎么读
 *     （见 parseSampleRate，认多种键名与单位），② 缺失/不可信时怎么办（见 pipeline.js
 *     的 resolveSampleRate：用波形节拍反推，再兜底 DEFAULT_SAMPLE_RATE）。
 *     BMC 时钟 600 kHz（UI=1.6667us）是 PD 协议定的，与采样率无关。
 *   · 分块序号按数值排序（0-9 在 0-10 之前），最后一块尾部用 0x00 补齐
 */

import { ZipReader } from './zip.js';
import { nowMs, yieldToMain } from './bmc.js';

export const CHUNK_SIZE = 1048576;      // 1 MiB

/** 文件没声明采样率、且波形也认不出来时的兜底值（实测 ATK-C 一直导出 2.5 MHz） */
export const DEFAULT_SAMPLE_RATE = 2500000;

/** 通道活动度扫描两次让出主线程之间的时间预算（多通道文件要扫 通道数 × 3 块） */
const SCAN_YIELD_MS = 20;

/**
 * 从 ini 文本里读出采样率 —— 兼容不同版本 ATK-C 的写法，不假定键名。
 *
 *   SamplingFrequency=2500        ← 实测就是这个，单位 kHz
 *   SampleRate=2500000            ← 也有工具直接给 Hz
 *   Sampling_Freq = 2.5 MHz       ← 带单位后缀
 *
 * 单位判定顺序：键名里带 khz/mhz → 行尾带单位 → 都没有则看数量级
 * （≥ 100 kHz 当 Hz，否则当 kHz —— 因为实测 ATK-C 写的是 kHz 的 2500）。
 *
 * @param {string} text
 * @returns {{hz:number, source:'declared'|'default', key:string|null, value:number, unit:string, raw:string|null}}
 */
export function parseSampleRate(text) {
  const fallback = { hz: DEFAULT_SAMPLE_RATE, source: 'default', key: null, value: 0, unit: '', raw: null };
  if (!text) return fallback;

  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w .\-]*?)\s*[=:]\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z\/]*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const norm = key.toLowerCase().replace(/[\s._\-]/g, '');
    if (!/freq|rate|hz/.test(norm)) continue;          // 只认像采样率的键

    const value = Number(m[2]);
    if (!(value > 0)) continue;

    let unit = (m[3] || '').toLowerCase();
    if (!unit) unit = /khz/.test(norm) ? 'khz' : /mhz/.test(norm) ? 'mhz' : '';
    let hz;
    if (unit === 'khz' || unit === 'k') hz = value * 1e3;
    else if (unit === 'mhz' || unit === 'm') hz = value * 1e6;
    else if (unit === 'hz') hz = value;
    else hz = value >= 100000 ? value : value * 1e3;

    if (!(hz >= 10000 && hz <= 1e9)) continue;         // 数量级明显不对的值不当采样率
    return { hz, source: 'declared', key, value, unit: unit || (hz === value ? 'hz' : 'khz'), raw: line.trim() };
  }
  return fallback;
}

export class AtkccCapture {
  constructor(zip, meta) {
    this.zip = zip;
    this.meta = meta;
    /** @type {Map<number, {folder:string, prefixes:number[], chunks:string[]}>} */
    this.channels = meta.channels;
  }

  /**
   * 打开 .atkcc。
   * @param {Uint8Array} bytes
   * @param {{inflate:(raw:Uint8Array,n:number)=>Promise<Uint8Array>}} io
   */
  static async open(bytes, io) {
    const zip = new ZipReader(bytes);

    // ── channel.ini：采样率（文件声明 → 波形自检 → 兜底，三级策略见 pipeline.js）──
    const rootIni = await zip.readText('channel.ini', io.inflate);
    let rate = parseSampleRate(rootIni);
    // 个别版本把参数写在子目录那份 channel.ini 里，根目录缺失时也认
    const subIni = await zip.readText('0/channel.ini', io.inflate);
    if (rate.source !== 'declared') {
      const alt = parseSampleRate(subIni);
      if (alt.source === 'declared') rate = alt;
    }
    const sampleRate = rate.hz;

    // ── bus.ini：VBUS / IBUS ──
    const busIni = await zip.readText('bus.ini', io.inflate);
    const bus = [];
    if (busIni) {
      for (const line of busIni.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        const m = /sample\s*=\s*(\d+)\s*,\s*vbus\s*=\s*(-?[\d.]+)\s*,\s*ibus\s*=\s*(-?[\d.]+)/i.exec(t);
        if (m) bus.push({ sample: Number(m[1]), vbus: Number(m[2]), ibus: Number(m[3]) });
      }
    }

    // ── 各通道分块清单 ──
    const channelMap = new Map();
    const re = /^(\d+)\/(\d+)-(\d+)\.bin$/i;
    for (const e of zip.entries) {
      const m = re.exec(e.name);
      if (!m) continue;
      const folder = m[1];
      const ch = Number(m[2]);
      const idx = Number(m[3]);
      let c = channelMap.get(ch);
      if (!c) { c = { channel: ch, folder, chunks: [] }; channelMap.set(ch, c); }
      c.chunks.push({ idx, name: e.name, size: e.uncompressedSize });
    }
    for (const c of channelMap.values()) {
      c.chunks.sort((a, b) => a.idx - b.idx);
      c.totalBytes = c.chunks.reduce((s, x) => s + x.size, 0);
      c.totalSamples = c.totalBytes * 8;
    }

    // ── 总采样数 ──
    let totalSamples = 0;
    if (subIni) {
      const lines = subIni.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length >= 2) totalSamples = Number(lines[1]) || 0;
    }
    const channelList = [...channelMap.values()].sort((a, b) => a.channel - b.channel);
    if (!totalSamples) totalSamples = channelList[0]?.totalSamples ?? 0;

    return new AtkccCapture(zip, {
      sampleRate,
      sampleRateSource: rate.source,       // 'declared'（文件声明） | 'default'（没写，用的兜底值）
      sampleRateKey: rate.key,             // 命中的键名，便于排查
      sampleRateRaw: rate.raw,             // 命中的整行原文
      samplingFrequencyRaw: rate.value,    // 文件里写的那个数字（未换算）
      rawChannelIni: subIni,
      totalSamples,
      channels: channelList,
      channelMap,
      bus,
      entryCount: zip.entries.length,
    });
  }

  get durationSec() { return this.meta.totalSamples / this.meta.sampleRate; }

  /** 读取某通道某块（已解压） */
  async readChunk(channel, chunkIdx, inflate) {
    const c = this.meta.channelMap.get(channel);
    if (!c) return null;
    const item = c.chunks[chunkIdx];
    if (!item) return null;
    return await this.zip.read(item.name, inflate);
  }

  /**
   * 计算某通道真正的有效采样上限。
   *   · 单通道文件：直接使用 channel.ini 里的总采样数
   *   · 多通道文件：尾部 0x00 是补齐用的，按最后一段非零数据裁掉
   */
  effectiveSampleLimit(channel) {
    const c = this.meta.channelMap.get(channel);
    if (!c) return 0;
    if (this.meta.channels.length === 1) {
      return Math.min(this.meta.totalSamples, c.totalSamples);
    }
    // 多通道：交由 chunk 级裁剪（loadChunkTrimmed）处理
    return c.totalSamples;
  }

  /** 读取最后一块并裁掉尾部 0x00 补齐区 */
  static trimTrailingZeros(data) {
    let end = data.length;
    while (end > 0 && data[end - 1] === 0) end--;
    return end;
  }
}

/**
 * 对某个通道做活动度扫描：统计非空闲字节数量，用于判断哪条线才是 CC / 有报文。
 * 只扫前 maxChunks 块，保证耗时可控（每块 1 MiB，逐字节扫，所以块数必须封顶）。
 *
 * ⚠ **活动度高 ≠ 这条通道有报文**。浮空/未接的线会给出接近 50% 的随机电平，
 * 得分比真正在跑 PD 的 CC 线（大部分时间空闲在 0xFF，只在报文期间才跳变）**更高**。
 * 所以这里额外统计「长游程占比」：真实 PD 的空闲段是成千上万个连续同电平采样点，
 * 噪声则几乎没有长游程。调用方应当用 `idleRatio` 把噪声通道排除掉，
 * 而不是只看 activity —— 否则会把一条噪声线当成 CC 线去解码，
 * 解出一堆垃圾不说，还会让解码器在无边沿的位流上空转（历史事故，见 bmc.js 的 MAX_PACKET_BITS）。
 *
 * @returns {Promise<{channel:number, activity:number, bytes:number, scannedChunks:number,
 *                    idleRatio:number, liveRatio:number, edgeLike:number}>}
 */
export async function scanChannelActivity(capture, channel, inflate, maxChunks = 4, onProgress) {
  const c = capture.meta.channelMap.get(channel);
  if (!c) return { channel, activity: 0, bytes: 0, scannedChunks: 0, idleRatio: 0, liveRatio: 0, edgeLike: 0 };
  let activity = 0, bytes = 0, idle = 0, live = 0, edgeLike = 0;
  const n = Math.min(maxChunks, c.chunks.length);
  let lastYield = nowMs();
  for (let i = 0; i < n; i++) {
    const d = await capture.readChunk(channel, i, inflate);
    if (!d) continue;
    for (let k = 0; k < d.length; k++) {
      const b = d[k];
      if (b !== 0xFF) activity++;
      if (b === 0xFF) idle++;                            // 全高：空闲电平
      else if (b === 0x00) live++;                       // 全低：也是电平，但少见
      else edgeLike++;                                   // 混合字节：这段有电平跳变
    }
    bytes += d.length;
    onProgress?.(channel, i + 1, n);
    // 24 通道 × 3 块的逐字节扫描会累积成可感知的停顿，块间按时间预算让一次
    if (nowMs() - lastYield > SCAN_YIELD_MS) {
      await yieldToMain();
      lastYield = nowMs();
    }
  }
  return {
    channel, activity, bytes, scannedChunks: n,
    idleRatio: bytes ? idle / bytes : 0,                 // 空闲字节占比（真实 PD 通道很高）
    liveRatio: bytes ? live / bytes : 0,
    edgeLike: bytes ? edgeLike / bytes : 0,              // 混合字节占比（噪声 ≈ 0.5）
  };
}
