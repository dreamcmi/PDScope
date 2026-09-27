/**
 * pd.js — 【兼容转发层】USB PD 报文解码器
 *
 * PD 协议解析已抽成独立库 `src/js/pd/`（可整目录复制到别的工程复用）。
 * 本文件只做转发，保留旧路径 `src/js/core/pd.js` 的导入方式不被破坏
 * （tools/selftest.js、tools/_explore/* 仍从这里 import）。
 *
 * 新代码请直接从 `src/js/pd/index.js` 导入，或从 `../pd/decoder.js` 取 PdDecoder。
 */

export { PdDecoder } from '../pd/index.js';
export { crc32 } from '../pd/index.js';
