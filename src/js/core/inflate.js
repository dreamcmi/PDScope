/**
 * inflate.js — 环境自适应的 raw deflate 解压
 *
 * 浏览器 / 桌面外壳的 WebView：DecompressionStream('deflate-raw')
 * Node：node:zlib
 *
 * 对外只暴露一个 makeInflator() -> (raw, expectedSize) => Promise<Uint8Array>
 */

/** 浏览器实现（Chrome/Edge 103+ / Safari 16.4+ / Firefox 113+；桌面外壳的 WebView 也走这条） */
export function makeBrowserInflator() {
  const supported = typeof DecompressionStream === 'function';
  return async function inflateRaw(raw, expectedSize) {
    if (expectedSize === 0) return new Uint8Array(0);
    if (!supported) throw new Error('当前环境不支持 DecompressionStream');
    // 拷贝一份，避免 subarray 视图被流式读取时被回收
    const input = raw.slice();
    const ds = new DecompressionStream('deflate-raw');
    const stream = new Blob([input]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  };
}

/** Node 实现 */
export async function makeNodeInflator() {
  const zlib = await import('node:zlib');
  return function inflateRaw(raw, expectedSize) {
    const out = zlib.inflateRawSync(Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength));
    if (expectedSize && out.length !== expectedSize) {
      // 尺寸不符时仍然返回，交由上层判断
      return new Uint8Array(out.buffer, out.byteOffset, out.length);
    }
    return new Uint8Array(out.buffer, out.byteOffset, out.length);
  };
}

/** 自动挑选实现 */
export async function makeAutoInflator() {
  const isNode = typeof process !== 'undefined' && process.versions && process.versions.node
    && typeof window === 'undefined';
  if (isNode) return await makeNodeInflator();
  return makeBrowserInflator();
}
