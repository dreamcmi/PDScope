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
 *   · 采样率 2.5 MHz；BMC 时钟 600 kHz（UI=1.6667us），故 1 UI ≈ 4.167 采样点、1 bit = 2 UI
 *   · 分块序号按数值排序（0-9 在 0-10 之前），最后一块尾部用 0x00 补齐
 */

import { ZipReader } from './zip.js';

export const CHUNK_SIZE = 1048576;      // 1 MiB

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

    // ── channel.ini：采样率 ──
    const rootIni = await zip.readText('channel.ini', io.inflate);
    let samplingFrequency = 0;
    if (rootIni) {
      const m = /SamplingFrequency\s*=\s*([0-9.]+)/i.exec(rootIni);
      if (m) samplingFrequency = Number(m[1]);
    }
    // 实测 2500 的单位是 kHz。若文件给出的是 Hz 量级（<100000），按 Hz 处理。
    const sampleRate = samplingFrequency > 0
      ? (samplingFrequency >= 100000 ? samplingFrequency : samplingFrequency * 1000)
      : 2500000;

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
    const subIni = await zip.readText('0/channel.ini', io.inflate);
    if (subIni) {
      const lines = subIni.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      if (lines.length >= 2) totalSamples = Number(lines[1]) || 0;
    }
    const channelList = [...channelMap.values()].sort((a, b) => a.channel - b.channel);
    if (!totalSamples) totalSamples = channelList[0]?.totalSamples ?? 0;

    return new AtkccCapture(zip, {
      sampleRate,
      samplingFrequencyRaw: samplingFrequency,
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
 * 只扫前 maxChunks 块，保证耗时可控。
 */
export async function scanChannelActivity(capture, channel, inflate, maxChunks = 4, onProgress) {
  const c = capture.meta.channelMap.get(channel);
  if (!c) return { channel, activity: 0, bytes: 0, scannedChunks: 0 };
  let activity = 0, bytes = 0;
  const n = Math.min(maxChunks, c.chunks.length);
  for (let i = 0; i < n; i++) {
    const d = await capture.readChunk(channel, i, inflate);
    if (!d) continue;
    for (let k = 0; k < d.length; k++) if (d[k] !== 0xFF) activity++;
    bytes += d.length;
    onProgress?.(channel, i + 1, n);
  }
  return { channel, activity, bytes, scannedChunks: n };
}
