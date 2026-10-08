# EPR / AVS 专项复核

复核日期：2026-10-08。依据本地 PD 3.1 v1.4 与 PD 3.2 v1.2 原文；版本配置对应具体 PDF。

| 检查项 | 发现的问题 | 本次处理 |
| --- | --- | --- |
| EPR 会话 | 原来只解释 EPR_Mode 字段，没有进入/退出/合同关联 | 增加按通道和 SOP 隔离的被动观察器，详情展示模式、阶段与最近确认合同 |
| 能力缓存 | EPR 能力查询会替换普通 Request 的 SPR 参考表；DRP 回复可能覆盖正在供电端的能力 | SPR/EPR 分别缓存，仅当前 Source 广告更新请求参考表 |
| EPR_Request | PDO 副本可以放宽已广告电流/功率，未提供槽位也可能被当作有效请求 | 已捕获的最近 EPR 广告优先；副本不一致/空槽标为无效，副本不改能力表 |
| 请求确认 | 未区分请求、Accept 和 PS_RDY，其他 AMS 的 PS_RDY 可能误确认合同 | 只在有效 Sink 请求、Source Accept、Source PS_RDY 顺序完整时确认合同；Reject/Wait 保留原合同 |
| EPR 复位/交换 | 缺少 EPR 复位边界；FR_Swap 在 Accept 过早清状态 | Soft Reset 保留模式/合同，Hard Reset 退出；PR_Swap 在 EPR 中报警；FRS 等 New Sink / New Source 两个 PS_RDY 后清旧合同与能力 |
| EPR AVS 电流 | 只用 PDP/V，漏掉 5A 上限；浮点尾差会误报 3.55A 边界 | `floor(min(5A, PDP/V) / 50mA) × 50mA`；比较忽略换算尾差 |
| EPR AVS Source | 只检查宽泛的 15–48V 范围 | Source 最低必须 15V、最高必须 28/36/48V；最高电压匹配最高 EPR Fixed；检查 EPR 排序和 AVS 数量 |
| EPR AVS Sink | 未对照 Sink_Capabilities_Extended 的 Maximum PDP | Sink 使用自己的电压范围与 Maximum Power；已捕获有效 SKEDB 时检查 Maximum Power ≤ EPR Sink Maximum PDP，支持两种到达次序 |
| SPR AVS | 仅支持到 15V 时概览仍写 9–20V，缺少与 Fixed PDO 的电流一致性检查 | 正确显示 9–15V；Source 15V/20V 电流与相应 Fixed PDO 对照，15V 用低段、超过 15V 用高段 |
| AVS RDO | 3.2 的 B27 字段标签仍使用 3.1 的 Reserved | 3.1 标为 Reserved、3.2 标为 Deprecated Giveback，均忽略；保留 25mV 编码、100mV 有效步长、50mA 电流单位 |
| EPR 字段/长度 | Enter Data 的 8 位值被误限为 240；3.1 能力消息上限与 RDO 引用域混淆 | Enter Data 按 00h–FFh 解析并对照有效 SKEDB；显式 3.1/3.2 能力消息上限均为 11 PDO，3.1 RDO 字段仍允许到 13 |

## 被动状态边界

| 观察到的消息 | 结果 |
| --- | --- |
| Enter → Enter Acknowledged → Enter Succeeded | 进入 EPR 模式，原 SPR 合同保留，等待 EPR 能力 |
| 完整 EPR_Source_Capabilities | 登记 EPR 能力；在 EPR 模式中等待 EPR_Request；SPR/未知模式中的查询响应不自动进入 EPR |
| EPR_Request → Accept → PS_RDY | 确认 EPR 模式下的新合同，可选 SPR 或 EPR PDO/APDO |
| EPR_Keep_Alive / Ack | 检查 Sink/Source 方向并记录确认；不替代模式进入消息 |
| Enter Failed | 保持 SPR 模式与原合同 |
| Exit | 退出到 SPR；若最近确认合同仍引用 EPR PDO/APDO，提示应 Hard Reset |
| Soft Reset | 清未完成的 Enter/请求/分块/交换关联；保留已进入模式与已确认合同 |
| Hard Reset / 插拔 / 重建输入会话 | 清旧能力、合同与传输关联；Hard Reset 明确回到 SPR |
| Cable Reset / Data Reset / DR_Swap | 保留端口 EPR 供电状态；线缆/数据状态按各自规则清理 |
| FR_Swap → Accept → New Sink PS_RDY → New Source PS_RDY | 完成快速交换并隐式退出 EPR，旧显式合同和能力失效 |

初始模式与合同可能未知，不能仅凭抓到 EPR 能力响应断言已经进入 EPR。
没有 CRC 的分析仪输入继续标记 `crcOk=null`；状态关联基于记录的结构化消息，不声称验证线上 CRC。
坏 CRC、缺 EOP、截断、非法对象数量、未完成能力分块和重传不重复推进状态。
无效 Action/方向不会推进 EPR_Mode 状态；未捕获 cable discovery 不直接推断线缆不支持 EPR。

这是抓包观察器，没有实现设备 Policy Engine 或电气状态检测。
Keep Alive 记录方向和确认；缺少完整通信/GoodCRC 时间基准时不自动断言定时器超时。
FRS 缺少任一步时保留最后可信状态并标注交换阶段，不把单独 Accept 当成完成。中途插入其他消息（含扩展消息）时标注序列中断，后续 PS_RDY 不再确认该交换。
Power Rules、电气约束和 USB-IF 认证需要另外的完整检查，不能由这些解析回归替代。

## 依据与验证

- PD 3.2 Table 6.15–6.17、6.22、6.28；§4.1.3.2.4、§6.5.18–19、§7.30、§9.2.26.3、Ch.10。
- PD 3.1 Table 6-14、6-20、6-26、6-50；§6.4.10、§6.5.15。
- PD 3.1 §6.4.2.1 的 RDO 引用域允许 8–13，而 §6.5.15 明确能力消息首 PDO 后最多另 10 个，两者分别处理。
- 规范回归增加 40 组，合计 121 组：包含合法流程、坏帧/重传、SOP/通道隔离、查询/DRP、15V 分段、PDP/5A/50mA 边界及 FRS 完成/中断边界。
- 浏览器新增 EPR/AVS `.pdStream` 真实导入案例，检查各阶段详情、PDO/RDO 单位与 CLI CSV 一致。
- 现有自检 99 项、解析回归 11 组、浏览器检查 11 个案例全部通过。EPR 流程使用规范合成抓包；现有真实抓包没有 EPR 样本。

实现：[状态观察器](../src/js/pd/epr.js) · [主解码器](../src/js/pd/decoder.js) · [PDO/RDO](../src/js/pd/pdo.js)

相关：[PD 规范覆盖表](pd-spec-coverage.md) · [库接口](lib-pd.md) · [自检](testing.md)
