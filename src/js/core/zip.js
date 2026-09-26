/**
 * zip.js — 最小化、零依赖的 ZIP 读取器（支持 ZIP64）
 *
 * .atkcc 抓包文件本质上是一个普通 ZIP 压缩包：
 *   channel.ini           采样率配置
 *   bus.ini               VBUS / IBUS 模拟量轨迹
 *   0/channel.ini         通道元数据（含总采样点数）
 *   0/0-0.bin ...         各通道的数字采样数据，每块固定 1 MiB
 *
 * 这里只实现「读取」所需的最小集合：
 *   中央目录 -> 目录项 -> 本地文件头 -> raw deflate 解压
 */

const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_EOCD64_LOC = 0x07064b50;
const SIG_CDIR = 0x02014b50;
const SIG_LOCAL = 0x04034b50;

/** 在尾部 64 KiB + 22 字节范围内反向查找 EOCD 签名。 */
function findEocd(view, bytes) {
  const min = Math.max(0, bytes.length - (0xffff + 22));
  for (let i = bytes.length - 22; i >= min; i--) {
    if (view.getUint32(i, true) === SIG_EOCD) {
      // 注释长度必须与剩余字节吻合，避免误命中
      const commentLen = view.getUint16(i + 20, true);
      if (i + 22 + commentLen === bytes.length) return i;
    }
  }
  return -1;
}

export class ZipEntry {
  constructor(o) { Object.assign(this, o); }
}

export class ZipReader {
  /**
   * @param {Uint8Array} bytes 整个 .atkcc / .zip 文件内容
   */
  constructor(bytes) {
    this.bytes = bytes;
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    this.entries = [];
    this.byName = new Map();
    this._parse();
  }

  _parse() {
    const { view, bytes } = this;
    const eocd = findEocd(view, bytes);
    if (eocd < 0) throw new Error('不是有效的 ZIP 文件：未找到 EOCD 记录');

    let entryCount = view.getUint16(eocd + 10, true);
    let cdSize = view.getUint32(eocd + 12, true);
    let cdOffset = view.getUint32(eocd + 16, true);

    // ZIP64 升级
    if (entryCount === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = eocd - 20;
      if (loc >= 0 && view.getUint32(loc, true) === SIG_EOCD64_LOC) {
        const z64 = Number(view.getBigUint64(loc + 8, true));
        if (view.getUint32(z64, true) === SIG_EOCD64) {
          entryCount = Number(view.getBigUint64(z64 + 32, true));
          cdSize = Number(view.getBigUint64(z64 + 40, true));
          cdOffset = Number(view.getBigUint64(z64 + 48, true));
        }
      }
    }

    let p = cdOffset;
    const end = Math.min(cdOffset + cdSize, bytes.length);
    while (p + 46 <= end && view.getUint32(p, true) === SIG_CDIR) {
      const flags = view.getUint16(p + 8, true);
      const method = view.getUint16(p + 10, true);
      const dosTime = view.getUint16(p + 12, true);
      const dosDate = view.getUint16(p + 14, true);
      const crc32 = view.getUint32(p + 16, true);
      let compressedSize = view.getUint32(p + 20, true);
      let uncompressedSize = view.getUint32(p + 24, true);
      const nameLen = view.getUint16(p + 28, true);
      const extraLen = view.getUint16(p + 30, true);
      const commentLen = view.getUint16(p + 32, true);
      let localOffset = view.getUint32(p + 42, true);

      const name = new TextDecoder('utf-8').decode(bytes.subarray(p + 46, p + 46 + nameLen));

      // 解析 ZIP64 扩展字段
      let ep = p + 46 + nameLen;
      const extraEnd = ep + extraLen;
      while (ep + 4 <= extraEnd) {
        const hid = view.getUint16(ep, true);
        const hsz = view.getUint16(ep + 2, true);
        if (hid === 0x0001) {
          let q = ep + 4;
          const limit = ep + 4 + hsz;
          if (uncompressedSize === 0xffffffff && q + 8 <= limit) { uncompressedSize = Number(view.getBigUint64(q, true)); q += 8; }
          if (compressedSize === 0xffffffff && q + 8 <= limit) { compressedSize = Number(view.getBigUint64(q, true)); q += 8; }
          if (localOffset === 0xffffffff && q + 8 <= limit) { localOffset = Number(view.getBigUint64(q, true)); q += 8; }
        }
        ep += 4 + hsz;
      }

      const e = new ZipEntry({
        name, method, flags, crc32, compressedSize, uncompressedSize,
        localOffset, dosTime, dosDate,
        isDirectory: name.endsWith('/'),
      });
      this.entries.push(e);
      this.byName.set(name, e);
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name) { return this.byName.has(name); }

  /** 返回该目录项的原始压缩数据切片（不解压）。 */
  raw(e) {
    const { view, bytes } = this;
    const lo = e.localOffset;
    if (view.getUint32(lo, true) !== SIG_LOCAL) throw new Error('本地文件头损坏：' + e.name);
    const nameLen = view.getUint16(lo + 26, true);
    const extraLen = view.getUint16(lo + 28, true);
    const start = lo + 30 + nameLen + extraLen;
    return bytes.subarray(start, start + e.compressedSize);
  }

  /**
   * 解压单个条目。
   * @param {string} name
   * @param {(raw:Uint8Array)=>Promise<Uint8Array>|Uint8Array} inflateRaw
   */
  async read(name, inflateRaw) {
    const e = this.byName.get(name);
    if (!e) return null;
    if (e.isDirectory) return new Uint8Array(0);
    const raw = this.raw(e);
    if (e.method === 0) return raw.slice();
    if (e.method !== 8) throw new Error(`不支持的压缩方式 ${e.method}（${name}）`);
    return await inflateRaw(raw, e.uncompressedSize);
  }

  /** 解压为文本（用于解析 ini）。 */
  async readText(name, inflateRaw) {
    const b = await this.read(name, inflateRaw);
    return b ? new TextDecoder('utf-8').decode(b) : null;
  }
}
