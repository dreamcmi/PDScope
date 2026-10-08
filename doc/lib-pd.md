# PD 协议解析库

`src/js/pd/` 是零外部依赖的 USB Power Delivery 解析库，浏览器和 Node 共用。
`src/js/core/pd.js` 保留兼容转发；BMC 波形解码位于 `src/js/core/bmc.js`。

```js
import { PdDecoder } from './src/js/pd/index.js';
const pd = new PdDecoder({ sampleRate: 2_500_000 });
const packet = pd.decode(bmcPacket, channel);

// 已知规范时指定版本；含义对应 doc 中的四份 PDF。
const modern = new PdDecoder({ sampleRate: 2_500_000, specRevision: '3.2' });
const logical = modern.decodeWire(bytes, { sop: 'SOP', timeMs: 12.5 });
```

`specRevision` 可选 `null`（默认）、`'2.0'`、`'3.0'`、`'3.1'`、`'3.2'`。
Header 的 `10b` 只能说明 3.x，不能确定具体规范版本。默认模式识别现行消息族，
对已知歧义给出旧版/新版说明；指定版本后，消息类型、APDO、字段布局和长度约束按对应 PDF 解释。
PD 2.0 Header 始终使用旧版布局，`00b` 按兼容规则处理。

三个文件入口都支持同一配置：波形 `decodeChannel(atk, ch, {specRevision: '3.1'})`，
SQLite/记录流的 `source.decode({specRevision: '3.1'})`。Node CLI 使用
`node tools/cli.js capture.pdStream --json --spec 3.1`；`--spec auto` 恢复默认。
这里的版本对应四份本地 PDF，并非所有历史发布版的完整兼容清单。

网页侧栏的「PD 规范基线」按文件保存选择，改变后重新解码当前文件，UFCS 文件禁用此项。
自动化入口 `PDScope.setSpecRevision('3.1')` 返回重新解码任务；
`PDScope.exportCsv(bytes, {specRevision: '3.1'})` 支持独立导出配置。
详细规则、当前代码和证据见 [四版本 HTML 审计报告](pd-standards-audit.html)。

## 输入和返回值

`decode(raw, channel)` 接收 `{bits, edges, startSample, endSample, bitrate}`。
`bits` 是 BMC 解码后的位流，包含 SOP 有序集及后续编码内容，可带前导码。
每个符号的 bit0 最先接收；字节、16/32 位对象均按线上低位先行还原。

`decodeWire(wire, options)` 接收 Header 和数据的逻辑字节，输入不含 SOP/EOP/CRC。
`timeMs` 按实例的 `sampleRate` 换算采样位置。若有实收 CRC，可传 `crc: number`；
未提供时 `crc`、`crcOk`、`frameValid` 返回 `null`，内部补算 CRC 仅用于复用解析流程。
`crcRecorded: true` 本身不能证明 CRC 通过。码率与编码时长为标称估算。

| 返回字段 | 含义 |
| --- | --- |
| `sop / msgType / msgKind / role / revText` | 链路、类型、类别、角色、Header 修订号 |
| `header / extHeader / msgTypeRaw / dataWords / dataBytes / dataHex` | 原始数据；非法符号/截断字节保留未知标记 |
| `details / summary / text / warnings` | 逐字段解释、概要、文本、诊断；`details` 以 `Object` 分组 |
| `crc / crcCalc / crcOk / frameValid` | CRC 证据及帧完整性；分析仪未记录时为未知 |
| `isRetry / specProfile / roleInferred` | 重传标记、显式规范、线缆端口方向是否推断 |
| `extended / reassembly` | 扩展头与重组状态；完整可信重组才提供 `reassembly.bytes` |
| `bist` | PD 2.0 原始测试帧位数、错误位、累计错误位；此帧没有 Header/CRC/EOP |
| `request / epr` | 请求字段与有效性；SOP 端口的被动 EPR 模式、阶段、合同、待确认请求与 Keep Alive 记录 |

## 已实现的解析

| 内容 | 模块 |
| --- | --- |
| 16 个 4B5B 数据符号、全部 SOP/Debug/Reset、CRC32、EOP、截断诊断 | `symbols.js / crc.js / decoder.js` |
| 控制/数据/扩展 Header、全部标准控制消息、保留消息原始值 | `tables.js / decoder.js` |
| Fixed/Battery/Variable/PPS/SPR AVS/EPR AVS PDO；按能力表或 EPR 副本解释 RDO | `pdo.js` |
| BIST、Battery Status、Alert、Country Code、Enter USB、EPR Mode、Source Info、Revision | `data.js` |
| 结构化/非结构化 VDM；端口/线缆/VPD/旧 AMA Identity；SVID/Mode/Attention | `vdm.js` |
| 全部标准扩展数据块、Request Chunk、26 字节分块、最多 260 字节完整重组 | `extended.js / decoder.js` |
| PD 2.0 BIST 1024 位 PRBS-8 测试帧、连续序列和错误计数 | `decoder.js` |
| EPR Enter/Ack/Succeeded/Failed/Exit、请求/Accept/PS_RDY、Keep Alive、复位/交换边界 | `epr.js / decoder.js` |

覆盖条目及版本差异详见 [PD 规范覆盖表](pd-spec-coverage.md)。

## 跨报文状态

状态按通道和 SOP 链路隔离，扩展传输进一步按发送方和消息类型隔离。
GoodCRC 不清能力表；新能力报文替换整个列表。普通 Request 和 EPR_Request 分别引用最近 SPR/EPR 广告，
当前相反电源角色的 DRP 能力查询回复不替换正在供电端的参考表。EPR_Request 副本不改能力表；有广告上下文时按广告校验。
CRC/EOP/符号/长度错误帧不会改变已建立的解析状态；精确重复报文标为重传，不重复提交状态。
分块缺失、乱序或损坏时只展示该块原始字节，完整重组后才解析数据块、登记 EPR PDO。

Hard Reset 清理该通道所有链路；Cable Reset 清理线缆链路；Soft Reset 清理当前链路协议传输状态；
Data Reset 清理 Alt Mode 关联。POWER-Z 插拔事件清理状态，避免下一次连接引用旧 PDO。
主动切换输入会话时调用 `pd.reset()`；容器内插拔可用 `pd.reset({preserveSequence: true})` 保留序号连续。

`epr.mode` 为 `unknown/spr/epr`；从中途开始的输入保留未知合同。
EPR 模式与合同引用的功率范围分开记录，EPR 模式可使用 SPR PDO/APDO。
Soft Reset 保留已进入的 EPR 模式/合同，清未完成的协商；Hard Reset 退出 EPR。
FR_Swap 在两个 PS_RDY 顺序完整后退出 EPR。Keep Alive 只记录与校验已捕获消息，不主动判定超时。
详见 [EPR/AVS 专项复核](epr-avs-review.md)。

## 外部格式

PD 规范只定义 Security/Firmware Update 的 PD 消息封装，内部结构分别交给
`[USBC Auth]`、`[PDFU]`；本库完整保留重组字节并注明规范来源。
厂商 VDM、Vendor Defined Extended、SVID 的 Mode/Attention 私有内容同样完整展示原始值。
未提供这些外部标准时，不假设其内部格式。

库内工具函数使用 `pd` 前缀，避免单文件构建拍平 ES Module 时顶层符号冲突。

相关：[UFCS 解析库](lib-ufcs.md) · [目录结构](structure.md) · [自检](testing.md)
