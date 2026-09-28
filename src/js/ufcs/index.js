/**
 * index.js — `src/js/ufcs/` 独立 UFCS 解析库的聚合入口
 *
 * 用法（浏览器 / Node 通用）：
 *   import { UfcsDecoder, ufcsLocateFrames } from './js/ufcs/index.js';
 *   const ufcs = new UfcsDecoder({ sampleRate: 1000 });
 *   const located = ufcsLocateFrames(blob);            // 在未知容器里定位报文
 *   const pkt = ufcs.decodeFrame(located.frames[0]....);// 逐条解
 *
 * 设计约定与 `src/js/pd/` 完全一致：
 *   • 只依赖本目录内的模块，零外部依赖，不引入 Node 专有 API；
 *   • 为便于「单文件打包」（把 ES Module 拍平进一个 IIFE 作用域），
 *     所有本库的顶层名字统一带 `ufcs` / `UFCS_` 前缀，避免与宿主工程或 pd/ 库重名。
 *
 * 目录结构（对应规范章节）：
 *   crc.js       CRC-8（附录 A）
 *   tables.js    消息头 / 控制命令 / 数据命令 / 输出模式 / 拒绝原因等常量表
 *   format.js    大端位域取值与格式化（ufcs* 前缀）
 *   frame.js     数据包切帧：消息头 + 主体 + CRC（7.6 / 8.2）
 *   payload.js   各类消息的载荷逐字段解析（8.2.4 / 8.2.5）
 *   decoder.js   主解码器 UfcsDecoder（8.2 / 7.2 方向还原）
 */

export { UfcsDecoder, ufcsResolveDirection, ufcsLinkAck } from './decoder.js';

/* CRC */
export { ufcsCrc8, UFCS_CRC8_POLY } from './crc.js';

/* 切帧 */
export {
  ufcsHeaderInfo, ufcsFrameBodySize, ufcsFrameScore,
  ufcsSplitFrames, ufcsLocateFrames,
} from './frame.js';

/* 常量表 */
export * from './tables.js';

/* 位域 / 格式化工具 */
export * from './format.js';

/* 载荷解析器（可单独复用） */
export { ufcsDataPayload, ufcsCustomPayload, ufcsDumpBytes } from './payload.js';
