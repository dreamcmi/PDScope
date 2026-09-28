# PD 协议解析库

USB PD 的协议解析**单独成一库**：`src/js/pd/`。它只依赖自己目录内的模块，
零外部依赖，浏览器与 Node 双栈通用，**整个目录复制到别的工程即可直接复用**。
`src/js/core/pd.js` 现在只是一层兼容转发，指向这个库。

```js
import { PdDecoder } from './js/pd/index.js';

const pd = new PdDecoder({ sampleRate: 2_500_000 });
const pkt = pd.decode(bmcPacket, channel);   // bmcPacket = BMC 状态机吐出的原始比特序列
```

返回的报文对象与界面契约一致：`sop / msgType / msgKind / role / rev / header /
extHeader / nObjects / dataWords / dataHex / details / warnings / summary / crcOk / text …`。
其中 `details` 是 `{ key, value }[]`，用 `key === 'Object'` 分组成「数据对象」区块。

## 与官方上位机相比，这一版补了什么

ATK-C 自带的上位机（以及 sigrok 的 `usb_power_delivery`）对 **plug 信令**（发往线缆
e-Marker 的 SOP'/SOP'' VDM）只给了概要字符串。本库按规范把整条 VDO 链逐位还原：

| 能力 | 说明 |
| --- | --- |
| **plug 信令** | SOP'/SOP'' 的 Discover Identity：ID Header VDO + Cert Stat VDO + Product VDO，再按产品类型派发**无源线缆 VDO / 有源线缆 VDO1&VDO2 / VPD VDO / 旧 AMA VDO**；端口侧派发 UFP VDO + Padding + DFP VDO |
| **线缆字段** | 插头形态、线缆延迟档位、终止方式（是否需 VCONN）、最高 VBUS 电压、载流能力、USB 最高速率、有源线缆的工作/关断温度与 U3/CLd 功耗等 |
| **扩展消息** | 按数据块内的**绝对字节号**寻址：SCEDB / Status（SOP 与 SOP' 两种长度）/ GBCDB / 制造商 / 安全 / 固件 / PPS Status / 国家码 / SKEDB / ECDB / EPR 能力 / 厂商扩展；**分块（Chunked）** 消息的字节拼接与跨块 PDO 补全，拼不回来的如实标注「本分块不含该字段」 |
| **EPR** | EPR_Source/Sink_Capabilities 的 PDO 列表（位置 ≥8 判 EPR）、EPR_Request 的 PDO 副本、EPR_Mode 的 Action/原因码 |
| **跨版本** | BIST 模式（PD 2.0 与 3.x 同一数值含义不同，按 Header 的 Revision 选表）、线缆最高 VBUS 电压码（3.0 与 3.1+ 不同）、EPR 位的版本含义、消息类型的最低版本提示 |
| **健壮性** | SOP 有序集容错匹配（命中 3/4 个符号即认出）、CRC 校验并给出「读到值 ≠ 计算值」、缺失 EOP / 截断 / 非法 4B5B 符号均记入 `warnings` |

## 解析范围对照（与规范条目的对应关系）

| 模块 | 覆盖的规范条目（USB PD 3.2） |
| --- | --- |
| `pdo.js` | Table 6.8 … 6.22（Fixed / Battery / Variable / PPS / SPR-AVS / EPR-AVS PDO，以及四张 RDO 表） |
| `data.js` | Table 6.23 … 6.31（BIST、Battery_Status、Alert、Enter_USB、Source_Info、Revision、EPR_Mode、Country_Code） |
| `vdm.js` | Table 6.32 … 6.46（VDM Header、Discover Identity 全线缆/端口 VDO、Discover SVIDs / Modes、Enter/Exit Mode、Attention），并保留 PD 3.0 / 2.0 的旧字段 |
| `extended.js` | Chapter 6.5（Table 6.47 … 6.66） |
| `tables.js` | 各表取值；旧版差异额外取自 PD 3.0 v1.1 与 PD 2.0 v1.3 原文 |

> 库内所有工具函数统一带 `pd` 前缀（`pdField` / `pdHex` / `pdNum` …）。这不是洁癖：
> `tools/build-standalone.mjs` 会把整个 ES Module 图**拍平进一个 IIFE 作用域**，
> 顶层重名会互相覆盖，加前缀是最省事的隔离手段。

---

相关：[UFCS 解析库](lib-ufcs.md) · [目录结构](structure.md) · [自检](testing.md)
