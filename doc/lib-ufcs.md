# UFCS 协议解析库

UFCS（融合快速充电）不在 USB PD 规范内，本工程按 **T/CCSA 393—2024 / T/TAF 083—2024
《移动终端融合快速充电技术要求》**（仓库根目录有该 PDF）实现，**单独成一库** `src/js/ufcs/`。
它零外部依赖、浏览器 + Node 双栈通用，整个目录复制到别的工程即可复用。

```js
import { UfcsDecoder } from './js/ufcs/index.js';

const ufcs = new UfcsDecoder({ sampleRate: 1000 });
// bodyBytes = 消息头 + 消息主体（**不含** CRC）；
// crc 传 null 表示容器没存 CRC，此时 crcOk 记为 null（不谎报通过）
const pkt = ufcs.decode(bodyBytes, { crc, timeMs: 12, line: 'D+' });
```

返回的报文对象与 PD 侧**同形**（`sop / msgType / msgKind / role / header / msgId / rev /
revText / nObjects / crc / crcCalc / crcOk / summary / details / warnings / text /
startSample …`），所以界面、筛选、详情、时间轴、导出都不必为新协议再写一套。

## 覆盖的规范条目

| 模块 | 覆盖的内容 |
| --- | --- |
| `crc.js` | 规范 8.2 的 **CRC-8**：多项式 X⁸+X⁵+X³+1（`0x29`）、初值 `0x00`，覆盖「消息头 + 消息主体」 |
| `frame.js` | 表 13 消息头四段位域、图 13/14/15 三种帧结构（控制 / 数据 / 厂家自定义）、容器前缀定位 `ufcsLocateFrames` |
| `tables.js` | 表 14 的 **17 条控制命令**、表 15 的 **14 条数据命令**、设备地址、协议版本编号、拒绝原因、扩展状态类型、异常位、波特率档位（115200 / 57600 / 38400）、**单向命令方向表** |
| `format.js` | 大端位域取值（`ufcsBits`）与物理量格式化（电压 ×10 mV、电流 ×10 mA、温度 raw−50 ℃） |
| `payload.js` | 8.2.4 各条数据命令的逐字段解析（见下） |
| `decoder.js` | 主解码器 `UfcsDecoder`：位域 → 主体 → CRC → 方向还原 → 逐字段 → 组装报文对象；`ufcsLinkAck` 做 ACK/NCK 配对 |

**逐字段解析到的数据命令**（表 15，`payload.js` 分发）：

`Output_Capabilities`（每种输出模式 8 字节：模式编号 / 电流步进 / 电压步进 / 最大最小电压电流）、
`Request`、`Source_Information`、`Sink_Information`、`Cable_Information`、`Device_Information`、
`Error_Information`、`Config_Watchdog`、`Refuse`、`Verify_Request`、`Verify_Response`、
`Power_Change`、`Sink_Information_Extended`、`Test_Request`；控制消息的 17 条命令给出
「发送者 → 接收者」「是否必选」「语义摘要」。规范未定义的命令编号**如实列出原始字节**，不硬套结构。

## 三个容易踩的点

| 点 | 做法 | 为什么 |
| ---- | ---- | ------ |
| **字节序** | 多字节字段**高字节在前**（大端） | 规范反复强调「先发送高字节」，与 PD 的小端**正好相反**。载荷数组本身就是大端位串（`payload[0]` 是最高字节），取 `bit b` 时 `字节下标 = 长度-1-(b>>3)`、`位下标 = b&7` |
| **方向** | 「规范单向命令表 → 容器链路字节 → 接收方地址」三级还原 | 消息头里**只有接收方**地址。物理层 D+/D- 全双工、供电设备 D+ 为 TX、充电设备 D- 为 TX，配合接收方才能唯一确定发送方；纯推断出来的会标出来 |
| **CRC 覆盖范围** | 消息头 + 消息主体，**不含**容器前缀 / UART 起止位 | 容器不存 CRC 时由本工具补算并置 `crcOk = null`，绝不据此宣布「通过」 |

> 库内所有顶层名字统一带 `ufcs` / `UFCS_` 前缀，理由同 PD 库（单文件打包器会把整个 ES Module
> 图拍平进一个 IIFE 作用域，重名会互相覆盖）。

---

相关：[PD 解析库](lib-pd.md) · [`.sqlite` 里的 UFCS 容器](format-powerz.md) · [已知限制](limits.md)
