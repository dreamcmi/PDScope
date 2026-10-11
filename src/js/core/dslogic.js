/**
 * dslogic.js — 梦源 DSLogic 分析仪的 .dsl 抓包文件格式解析
 *
 * 格式（实测归纳）：
 *   .dsl 就是 ZIP：
 *     header        ini 文本：samplerate / total samples / total probes / total blocks / probe0..N
 *     session       DSView 会话配置（JSON 文本）
 *     decoders      DSView 已挂的协议解码器（JSON 文本）
 *     L-<ch>/<block>  第 <ch> 个通道、第 <block> 块的数字采样数据，每块固定 2 MiB
 *
 * 与 .atkcc 的关系：
 *   · 同为 ZIP 容器、同为「每采样点 1 bit、LSB 优先」的原始电平采样；
 *   · 差别在多通道的组织方式 —— .atkcc 是「一个采样点一个字节、通道各自成文件」，
 *     .dsl 是「一个采样点占 ceil(probes/8) 字节、多个通道打包在同一个字节里」。
 *     所以这里的通道读取要**在块内按字节跨步抽取**再拼成位流（见 readChunk）。
 *
 * 两者解出来的位流交给同一套 BMC → 4B5B → PD 解析（pipeline.js），
 * 对本工具而言 .dsl 就是「另一种封装的原始采样容器」。
 */

import { ZipReader } from './zip.js';
import { nowMs, yieldToMain } from './bmc.js';

/** .dsl 每个数据块固定 2 MiB（与 .atkcc 的 1 MiB 不同） */
export const DSL_BLOCK_SIZE = 2097152;

/** 文件没声明采样率、且波形也认不出来时的兜底值 */
export const DSL_DEFAULT_SAMPLE_RATE = 100000000;

/** 通道活动度扫描两次让出主线程之间的时间预算 */
const DSL_SCAN_YIELD_MS = 20;

/** 从 ini 文本里读采样率 —— DSLogic 写的是 `samplerate = 100 MHz`，带单位后缀。 */
export function parseDslogicSampleRate(text) {
  const fallback = { hz: DSL_DEFAULT_SAMPLE_RATE, source: 'default', key: null, value: 0, unit: '', raw: null };
  if (!text) return fallback;

  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w .\-]*?)\s*[=:]\s*([0-9]+(?:\.[0-9]+)?)\s*([A-Za-z\/]*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1].trim();
    const norm = key.toLowerCase().replace(/[\s._\-]/g, '');
    if (!/freq|rate|hz/.test(norm)) continue;

    const value = Number(m[2]);
    if (!(value > 0)) continue;

    let unit = (m[3] || '').toLowerCase();
    if (!unit) unit = /khz/.test(norm) ? 'khz' : /mhz/.test(norm) ? 'mhz' : '';
    let hz;
    if (unit === 'khz' || unit === 'k') hz = value * 1e3;
    else if (unit === 'mhz' || unit === 'm') hz = value * 1e6;
    else if (unit === 'hz') hz = value;
    else hz = value >= 100000 ? value : value * 1e3;

    if (!(hz >= 10000 && hz <= 1e9)) continue;
    return { hz, source: 'declared', key, value, unit: unit || (hz === value ? 'hz' : 'khz'), raw: line.trim() };
  }
  return fallback;
}

function parseIni(text) {
  const out = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('[') || t.startsWith(';') || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 0) continue;
    out.set(t.slice(0, i).trim().toLowerCase(), t.slice(i + 1).trim());
  }
  return out;
}

const iniNumber = (ini, key, dflt = 0) => {
  const v = ini.get(key);
  const n = v == null ? NaN : Number(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : dflt;
};

export class DslogicCapture {
  constructor(zip, meta) {
    this.zip = zip;
    this.meta = meta;
    this.channels = meta.channels;
  }

  /**
   * 打开 .dsl。
   * @param {Uint8Array} bytes
   * @param {{inflate:(raw:Uint8Array,n:number)=>Promise<Uint8Array>}} io
   */
  static async open(bytes, io) {
    const zip = new ZipReader(bytes);
    const headerText = await zip.readText('header', io.inflate);
    if (!headerText || !/[\[#]\s*header/i.test(headerText)) {
      throw new Error('不是 DSLogic 的 .dsl：缺少 header 段');
    }
    const ini = parseIni(headerText);

    const rate = parseDslogicSampleRate(headerText);
    const sampleRate = rate.hz;

    const totalProbes = iniNumber(ini, 'total probes', 0);
    const totalBlocks = iniNumber(ini, 'total blocks', 0);
    const declaredSamples = iniNumber(ini, 'total samples', 0);
    const bytesPerSample = Math.max(1, Math.ceil(totalProbes / 8));

    // ── 各通道分块清单。条目名是 `L-<ch>/<block>`：前一个数是通道、后一个是块号 ──
    const channelEntry = new Map();
    const re = /^L-(\d+)\/(\d+)$/;
    for (const e of zip.entries) {
      const m = re.exec(e.name);
      if (!m) continue;
      const ch = Number(m[1]);
      const block = Number(m[2]);
      let c = channelEntry.get(ch);
      if (!c) { c = { channel: ch, chunks: [] }; channelEntry.set(ch, c); }
      c.chunks.push({ block, entry: e });
    }
    if (!channelEntry.size) throw new Error('不是 DSLogic 的 .dsl：没有 L-<ch>/<block> 数据条目');
    const channelList = [...channelEntry.values()].sort((a, b) => a.channel - b.channel);
    let totalSamples = declaredSamples;
    for (const c of channelList) {
      c.chunks.sort((a, b) => a.block - b.block);
      c.blockCount = c.chunks.length;
      c.totalBytes = c.chunks.reduce((s, x) => s + x.entry.uncompressedSize, 0);
      // 每块净荷是「全部探针交织」的采样点，所以本通道的采样点数 = 块字节 / 每采样点字节 × 8，
      // 而不是块字节 × 8（后者会把其它探针的点也算进来）。
      const own = Math.floor(c.totalBytes / bytesPerSample) * 8;
      c.totalSamples = totalSamples ? Math.min(totalSamples, own) : own;
    }
    if (!totalSamples) totalSamples = channelList[0]?.totalSamples || 0;

    const sessionText = await zip.readText('session', io.inflate);
    const session = safeJson(sessionText);

    return new DslogicCapture(zip, {
      source: 'dslogic',
      title: 'DSLogic · .dsl',
      protocol: 'USB PD',
      sampleRate,
      sampleRateSource: rate.source,
      sampleRateKey: rate.key,
      sampleRateRaw: rate.raw,
      samplingFrequencyRaw: rate.value,
      rawHeader: headerText,
      totalSamples,
      totalProbes,
      totalBlocks: totalBlocks || channelList[0]?.chunks.length || 0,
      bytesPerSample,
      channels: channelList,
      channelMap: new Map(channelList.map((c) => [c.channel, c])),
      channelCount: channelList.length,
      bus: [],
      busLabels: [],
      session,
      sessionTitle: session?.Title ?? null,
      entryCount: zip.entries.length,
    });
  }

  get durationSec() { return this.meta.totalSamples / this.meta.sampleRate; }

  /**
   * 读取某通道某块的位流（已解压、已抽成「每字节 8 采样点、LSB 优先」）。
   *
   * .dsl 的块内布局是「采样点交织」：第 k 个采样点占 `bytesPerSample` 字节，
   * 通道 ch 落在其中第 `floor(ch/8)` 个字节的第 `ch%8` 位。抽出来之后按 .atkcc
   * 的口径重新打包 —— **一个输出字节装 8 个连续采样点，bit0 是最早的那个**，
   * 这样下游的 EdgeExtractor / BMC 一行都不用改（probes ≤ 8 时 bytesPerSample=1，
   * 且通道落在 bit0，直接就是整块原样，走快路径）。
   */
  readChunk(channel, chunkIdx, inflate) {
    const c = this.meta.channelMap.get(channel);
    const item = c?.chunks[chunkIdx];
    if (!item) return null;
    const { bytesPerSample } = this.meta;
    const subByte = Math.floor(channel / 8);
    const bitBase = channel % 8;
    const plain = bytesPerSample === 1 && bitBase === 0;
    const n = item.entry.uncompressedSize;
    // plain 路径：块内一字节本来就是「8 个采样点、LSB 优先」，与原块等长。
    // 其余情形：一个采样点占 bytesPerSample 字节、只取其中 1 位，再按 8 采样点/字节重打包。
    const out = new Uint8Array(plain ? n : Math.ceil(Math.floor(n / bytesPerSample) / 8));
    return Promise.resolve(this.zip.read(item.entry.name, inflate)).then((raw) => {
      if (!raw) return null;
      if (plain) {
        // 与 .atkcc 的 chunk 完全同形，直接整块拿过来（不做逐位循环）
        out.set(raw.subarray(0, Math.min(out.length, raw.length)));
        return out;
      }
      const samples = Math.floor(n / bytesPerSample);
      const mask = 1 << bitBase;
      for (let k = 0; k < samples; k++) {
        const bit = (raw[k * bytesPerSample + subByte] & mask) >> bitBase;
        if (bit) out[k >> 3] |= 1 << (k & 7);
      }
      return out;
    });
  }

  /** 本通道实际可解的采样点数（已按声明总数与自身块字节裁剪，两者取小） */
  effectiveSampleLimit(channel) {
    const c = this.meta.channelMap.get(channel);
    if (!c) return 0;
    return this.meta.totalSamples ? Math.min(this.meta.totalSamples, c.totalSamples) : c.totalSamples;
  }

  static trimTrailingZeros(data) {
    let end = data.length;
    while (end > 0 && data[end - 1] === 0) end--;
    return end;
  }
}

function safeJson(text) {
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * 只看 ZIP 条目名判断是不是 DSLogic .dsl —— 不依赖扩展名。
 * 特征：有 `header`，且有 `L-<block>/<ch>` 形态的数据条目。
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function sniffDslogic(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4) return false;
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;      // "PK"
  try {
    const zip = new ZipReader(bytes);
    if (!zip.has('header')) return false;
    const re = /^L-\d+\/\d+$/;
    return zip.entries.some((e) => re.test(e.name));
  } catch {
    return false;
  }
}

/**
 * 通道活动度扫描（与 atkcc.js 的同名函数语义一致）。
 * @returns {Promise<{channel:number, activity:number, bytes:number, scannedChunks:number,
 *                    idleRatio:number, liveRatio:number, edgeLike:number}>}
 */
export async function scanDslogicChannelActivity(capture, channel, inflate, maxChunks = 4, onProgress) {
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
      if (b !== 0xff) activity++;
      if (b === 0xff) idle++;
      else if (b === 0x00) live++;
      else edgeLike++;
    }
    bytes += d.length;
    onProgress?.(channel, i + 1, n);
    if (nowMs() - lastYield > DSL_SCAN_YIELD_MS) {
      await yieldToMain();
      lastYield = nowMs();
    }
  }
  return {
    channel, activity, bytes, scannedChunks: n,
    idleRatio: bytes ? idle / bytes : 0,
    liveRatio: bytes ? live / bytes : 0,
    edgeLike: bytes ? edgeLike / bytes : 0,
  };
}
