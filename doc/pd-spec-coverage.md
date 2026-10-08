# PD 规范审查与解析覆盖

审查日期：2026-10-08。依据项目 `doc/` 中的原始文件：

逐版本实现进度、精确 PDF 物理页、当前代码片段、修复及验证边界见
[四版本 HTML 审计报告](pd-standards-audit.html)。本页保留便于开发者查阅的简表。

| 解析配置 | 规范原文 |
| --- | --- |
| `2.0` | [USB PD Revision 2.0 Version 1.3，2017-01-12](USB_PD_Revision%202.0_Version_1.3_20170112.pdf) |
| `3.0` | [USB PD Revision 3.0 Version 1.1，2017-01-12](USB_PD_Revision_3.0_Version_1.1_20170112.pdf) |
| `3.1` | [USB PD Revision 3.1 Version 1.4，2022-04](USB_PD_Revision_3.1_Version_1.4_2022-04.pdf) |
| `3.2` | [USB PD Revision 3.2 Version 1.2，2026-05-20](USB_PD_Revision_3.2_Version_1.2_2026_05_20.pdf) |

本表的“完成”指被动抓包解析：识别格式、还原规范定义的字段/单位、保留原始数据、
给出可由抓包判断的错误，并维护解析所需的关联状态。电源控制、主动协议收发、
设备 Policy Engine、电气测试和 USB-IF 认证属于不同任务。

## 规范覆盖表

表号以 PD 3.2 v1.2 为基线，旧版表号不同；版本差异另列于下一节。

| 规范条目 | 完成内容 | 实现位置 | 验证 |
| --- | --- | --- | --- |
| Ch.5 BMC、Table 5.2–5.5 | BMC 位流、全部数据/K-code、SOP/SOP'/SOP''/两个 Debug/两种 Reset、无歧义 3/4 容错 | `core/bmc.js`、`pd/symbols.js` | 各采样率、全部符号/有序集、非法符号与歧义向量 |
| Ch.5 CRC 与 EOP | CRC32 位序、EOP、丢失/截断诊断 | `pd/crc.js`、`pd/decoder.js` | 原文 GoodCRC `41 02` 的 CRC `46B50D97`；CRC 错误不提交状态 |
| Table 6.1–6.3 | 标准/扩展/线缆 Header 全字段、Revision 00b/11b、Cable Plug/保留位 | `pd/decoder.js` | 固定 Header、合法 0BAD、任意截断、线缆/版本规则 |
| Table 6.4–6.5 | 全部标准控制/数据消息类型、保留类型原始值、对象数量与 SOP 约束 | `pd/tables.js`、`pd/decoder.js` | 所有控制 ID、保留消息、四版消息集合 |
| Table 6.6–6.18 | Source/Sink 的 Fixed/Battery/Variable/PPS/SPR AVS/EPR AVS、设备标志、峰值电流、FRS | `pd/pdo.js` | 六类 PDO 单位、Sink 保留位、旧版 APDO、范围/位置/排序诊断 |
| Table 6.19–6.22 | Fixed/Variable/Battery/PPS/AVS RDO、旧 GiveBack、能力引用、电压/电流/功率限制 | `pd/pdo.js` | 四类请求格式、20/25mV 步长、SPR AVS 15V 分段限流、非法引用 |
| Table 6.23 | BIST Data Object、旧版模式与 Returned BIST Counters | `pd/data.js` | PD 2.0/3.x 同编码不同解释、16 位错误计数 |
| PD 2.0 §5.9、Fig.5-35/36 | 1024 原始 PRBS-8 位、反馈节点输出、FFh 初始化、帧间连续、错误计数、Hard Reset 退出 | `pd/decoder.js` | 连续三帧 BMC 输入、单错误位、Hard Reset；浏览器两帧展示 |
| Table 6.24–6.31 | Battery Status、Alert、Country Code、Enter USB、EPR Mode、SIDO1/2、RMDO | `pd/data.js` | 字段/单位、角色条件、保留位、Source Info 版本数量 |
| Table 6.32–6.33 | 非结构化/结构化 VDM Header、Major/Minor、对象位置、命令/响应、厂商命令 | `pd/vdm.js` | BUSY、Attention、保留字段和合法数量 |
| Table 6.34–6.39 | Identity 的 ID Header/Cert Stat/Product、产品类型派发、UFP/DFP/DRD 与 Padding | `pd/vdm.js` | DFP-only、未知线缆类型、现代/旧版布局、缺失产品对象 |
| Table 6.40–6.45 | UFP/DFP、Passive Cable、Active Cable VDO1/2、VPD；旧 AMA/线缆 VDO | `pd/vdm.js` | USB2 版本编码、有源/旧单 VDO、B1 差异、VPD 阻抗和 AMA 极性 |
| Table 6.46、Ch.8 标准 SVDM | Discover SVIDs/Modes、Enter/Exit Mode、Attention；列表终止/分次返回、模式关联 | `pd/vdm.js` | 首个零 SVID 终止、分页累计、模式进出/Data Reset |
| Table 6.47–6.48 | 扩展消息类型/头、Chunked/Unchunked、Request Chunk、填充、最大长度 | `pd/decoder.js` | NDO 保留规则、请求块两字节填充、非法组合、0–260 字节/十块 |
| Table 6.49–6.52 | SCEDB、端口/线缆 Status、峰值/电池/PDP/温度/事件/电源状态/指示灯 | `pd/extended.js` | 旧 24/新 25 字节 SCEDB、Status 长度/LED、链路派发 |
| Table 6.53–6.59 | Battery Cap/Status 请求、Battery Capabilities、Manufacturer 请求/信息、PPS Status | `pd/extended.js` | 电池引用、0.1Wh、字符串终止、20mV/50mA/未知值 |
| §6.5.8–6.5.11 | Security Request/Response、Firmware Update Request/Response 的 PD 封装和完整重组载荷 | `pd/extended.js` | 消息类型、260 字节重组、全部原始字节；内部由外部标准定义 |
| Table 6.60–6.64 | Country Info/Codes、SKEDB、Extended Control、Vendor Defined Extended | `pd/extended.js` | 国家码 Length、PDP 顺序/范围、Type/Data、完整厂商载荷 |
| §6.4.8、§6.5.18–6.5.19 | EPR Request 的独立 PDO 副本、EPR 能力列表、SPR 零填充、跨块对象、版本上限 | `pd/decoder.js`、`pd/pdo.js`、`pd/extended.js` | Byte26 跨界 PDO、坏 CRC/缺块不登记、位置 8 起 EPR、副本不污染能力表 |
| Table 6.65 | 260 字节总长、26 字节每块、最多十块 | `pd/tables.js`、`pd/decoder.js` | 最大长度、块编号/数量/总长不符负例 |
| 解析所需 Ch.7/9 状态 | 通道/SOP/发送方隔离、GoodCRC、重传、能力替换、复位、角色交换、插拔边界 | `pd/decoder.js`、`core/pipeline.js`、`core/powerz.js` | 交叉链路/发送方/消息流、缺块、坏帧/重传、重新连接 |
| §7.30、§9.2.26.3、Ch.10 | EPR 被动模式/合同/Keep Alive 关联，SPR/EPR 广告隔离，退出/复位/FRS 完成边界 | `pd/epr.js`、`pd/decoder.js` | EPR/SPR AVS 整段流程、查询/DRP、无效副本/方向、合同确认、双 PS_RDY、浏览器详情 |

## 必须区分的版本含义

`new PdDecoder({sampleRate, specRevision})` 的 `specRevision` 对应上述具体 PDF。
Header 的 `Specification Revision=10b` 无法区分 3.0/3.1/3.2，默认模式保留歧义说明。
Revision 消息表示设备支持的最高版本，不等于每条报文的精确编码基线。

| 字段/结构 | 旧版 | 新版处理 |
| --- | --- | --- |
| 消息类型集合 | PD 2.0 无 Extended/APDO；3.0 v1.1 未定义 Enter USB、Data Reset、Sink Cap Extended、EPR 等新增类型 | 指定旧版时标为 Reserved 并保留原始值 |
| APDO 类型 | 3.0 v1.1 只有 PPS；3.1 v1.4 未定义 SPR AVS | 旧版不将对应保留类型解释为 AVS |
| 固定 PDO/RDO/PPS 标志 | 旧版无 EPR 位；PPS Power Limited 在 3.0 v1.1 为 Reserved；Sink PPS 不使用 Power Limited | 按角色和版本解释 |
| RDO GiveBack/最大值 | 2.0/3.0/3.1 中最小/最大请求仍有意义 | 3.2 接收方忽略 B27；废弃的最大请求域不切换为最小值，发送方应令其等于工作值 |
| EPR 对象位置 | 3.1 v1.4 RDO 字段允许到 13，但能力消息本身最多 11 PDO（§6.5.15） | 3.2 v1.2 RDO/能力表都最多 11 |
| Source Info | 3.1 v1.4 一个 SIDO | 3.2 v1.2 两个 SIDO，新增 DPS/0.5W 字段 |
| UFP USB2 能力 B25–24 | 3.1 v1.4：01=USB2 Device，10=Billboard | 3.2 v1.2：01=Billboard，10=USB2 Device；未知 3.x 展示两种含义 |
| SVDM Minor B12–11 | 3.0 v1.1、3.1 v1.4 标准命令保留 | 3.2 定义 Version 2.0/2.1；厂商命令由 SVID 定义 |
| USB 最高速率/Enter USB Cable Speed | 3.1 v1.4 的 100b 及以上 Reserved | 3.2 定义 100b=USB4 Gen4 |
| Active Cable VDO2 B1 | 3.1 v1.4 Reserved | 3.2 USB4 Asymmetric Mode |
| 旧线缆/AMA VDO | PD 2.0 方向性位、PD 3.0 单个 Active Cable VDO、旧电压编码/AMA 极性 | 按 Header/显式规范/VDO Version 分派，未知类型保留原始值 |
| 扩展数据块长度 | SCEDB 旧 24 字节、Status 旧 5 字节；后续规范追加字段 | 指定规范时校验对应长度，完整原始字节保留 |

## 本次修正的问题

| 原问题 | 修正后 |
| --- | --- |
| `0BAD` 读失败标记与合法数据冲突 | 失败采用 `null`，严格拒绝非法 4B5B 数据符号 |
| 坏帧仍更新能力/Identity/分块 | 在状态副本中解析；CRC/EOP/长度失败或重传不提交 |
| GoodCRC 清空 Source PDO，旧列表尾部未清 | 只有能力消息替换整个表；GoodCRC 保留能力 |
| 不同 SOP/通道/发送方的 PDO/分块串用 | 按通道、SOP、发送方/扩展类型隔离 |
| Request Chunk 将填充当载荷；局部分块提前解释 PDO/字符串 | 请求块只显示请求，完整可信重组后解释数据块 |
| EPR Request 副本写进能力表 | 仅用于当前 RDO，检查与已捕获能力表的一致性 |
| 按短长度猜 Status 为线缆、指示灯掩码错 | 按 SOP 判断，读取三位 LED 编码并诊断非法值 |
| 旧 BIST/VDM/AMA、DFP-only Identity、SVID 终止及版本解释错误 | 修正布局/极性/编码/条件，新增原始 BIST Test Frame |
| POWER-Z/流对所有消息按 NDO 校验，插拔沿用旧状态 | Unchunked 使用 Data Size，插拔清理状态 |
| `decodeWire` 时间/采样率混用、缺失 CRC 当证据、600k 当数据率 | 正确换算时间，缺 CRC 为未知，数据率 300kbit/s |
| UI 对无 Header 帧显示全零头、Data Size 含 B9、Cable 角色位错 | 按实际帧/链路显示，B9 Reserved、Data Size 为 B8–0 |

## 验证与边界

`npm test` 包含版本/语法/构建、99 项 selftest、121 组规范测试、缺陷回归、ACK 和七组浏览器检查。
`npm run regression:real` 对照本地真实 SQLite/流；输出和逐项结果位于 `artifacts/`，不入库。
测试覆盖正例、字段单位、截断和跨报文负例，不声称穷举所有位组合或获得 USB-IF 认证。

Security/Firmware Update 内部结构由四份 PDF 引用的 `[USBC Auth]`/`[PDFU]` 定义；
SVID 私有 Mode/Attention、厂商 VDM 格式在 PD 标准之外。本实现保留完整载荷并明确边界。
旧 PD 2.0 BFSK 模拟信号没有对应输入解调器，当前原始波形路径是 CC 上的 BMC。
主动状态机、模拟电气测量、CRC 未记录设备的线上完整性无法通过文件解析证明。

相关：[库接口](lib-pd.md) · [测试说明](testing.md) · [已知限制](limits.md)

EPR/AVS 进一步修正与被动状态边界见 [专项复核](epr-avs-review.md)。
