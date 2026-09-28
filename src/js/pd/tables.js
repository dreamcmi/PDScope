/**
 * tables.js — USB PD 协议常量表
 *
 * 依据：
 *   • USB PD Revision 3.2, Version 1.2（2026-05）—— 当前基线
 *   • USB PD Revision 3.0, Version 1.1（2017-01）与 Revision 2.0, Version 1.3（2017-01）
 *     —— 用于还原旧版字段语义（BIST 模式、线缆 VDO、最大 VBUS 电压码等）
 *
 * 表里只放「规范原文怎么写」，不做任何推导；推导逻辑在各自的解析模块里。
 */

/* ══════════════════ 消息类型 ══════════════════ */

/**
 * 控制消息（Number of Data Objects == 0）
 * PD 3.2 Table 6.4。`0` 与 `25…31` 是 Reserved（接收端应回 Not_Supported）。
 *
 * ⚠ 命名口径（全库唯一真源，界面 / 筛选 / 导出 / 分类表都读这里的字符串）：
 *   一律采用**规范原文写法**——单词首字母大写、词间用 `_`、简称保持大写
 *   （DR / PR / VCONN / FR / EPR / PPS / PS / CRC）。
 *   旧版曾对 1…8 号沿用 sigrok / ATK-C 的「空格 + 全大写」风格
 *   （`GOOD CRC`、`GET SOURCE CAP` …），与 9 号起的 `DR_Swap`
 *   `Get_Source_Cap_Extended` 混在一起，列表里一眼就是两种风格；
 *   现在统一成规范写法，`Get_Source_Cap` 正好是 `Get_Source_Cap_Extended` 的前缀。
 */
export const CTRL_TYPES = {
  0: 'Reserved',
  1: 'GoodCRC', 2: 'GotoMin', 3: 'Accept', 4: 'Reject',
  5: 'Ping', 6: 'PS_RDY', 7: 'Get_Source_Cap', 8: 'Get_Sink_Cap',
  9: 'DR_Swap', 10: 'PR_Swap', 11: 'VCONN_Swap', 12: 'Wait', 13: 'Soft_Reset',
  14: 'Data_Reset', 15: 'Data_Reset_Complete', 16: 'Not_Supported',
  17: 'Get_Source_Cap_Extended', 18: 'Get_Status', 19: 'FR_Swap',
  20: 'Get_PPS_Status', 21: 'Get_Country_Codes', 22: 'Get_Sink_Cap_Extended',
  23: 'Get_Source_Info', 24: 'Get_Revision',
};

/** 控制消息里已废弃、只能被 Not_Supported 回应的类型（键名与 CTRL_TYPES 的取值逐字一致） */
export const CTRL_DEPRECATED = {
  'GotoMin': 'PD 3.0 起废弃，接收端应回 Not_Supported',
  'Ping': 'PD 3.0 起废弃，接收端可回 Not_Supported 或忽略（线缆插头必须忽略）',
};

/** 数据消息（Number of Data Objects > 0）—— PD 3.2 Table 6.5 */
export const DATA_TYPES = {
  0: 'Reserved',
  1: 'Source_Cap', 2: 'Request', 3: 'BIST', 4: 'Sink_Cap',
  5: 'Battery_Status', 6: 'Alert', 7: 'Get_Country_Info', 8: 'Enter_USB',
  9: 'EPR_Request', 10: 'EPR_Mode', 11: 'Source_Info', 12: 'Revision',
  13: 'Reserved', 14: 'Reserved', 15: 'VDM',
};

/** 扩展消息（Header 的 Extended 位置位）—— PD 3.2 Table 6.47 */
export const EXT_TYPES = {
  0: 'Reserved',
  1: 'Source_Capabilities_Extended', 2: 'Status', 3: 'Get_Battery_Cap',
  4: 'Get_Battery_Status', 5: 'Battery_Capabilities', 6: 'Get_Manufacturer_Info',
  7: 'Manufacturer_Info', 8: 'Security_Request', 9: 'Security_Response',
  10: 'Firmware_Update_Request', 11: 'Firmware_Update_Response', 12: 'PPS_Status',
  13: 'Country_Info', 14: 'Country_Codes', 15: 'Sink_Capabilities_Extended',
  16: 'Extended_Control', 17: 'EPR_Source_Capabilities', 18: 'EPR_Sink_Capabilities',
  19: 'Reserved', 20: 'Reserved', 21: 'Reserved', 22: 'Reserved', 23: 'Reserved',
  24: 'Reserved', 25: 'Reserved', 26: 'Reserved', 27: 'Reserved', 28: 'Reserved',
  29: 'Reserved', 30: 'Vendor_Defined_Extended', 31: 'Reserved',
};

/** 消息类型 → 该类型在哪个 PD 版本才有（用于提示「对版本而言非法」） */
export const CTRL_MIN_REV = {
  14: 3.0, 15: 3.0, 16: 3.0, 17: 3.0, 18: 3.0, 19: 3.0, 20: 3.0, 21: 3.0, 22: 3.0,
  23: 3.1, 24: 3.1,
};
export const DATA_MIN_REV = {
  5: 3.0, 6: 3.0, 7: 3.0, 8: 3.0,
  9: 3.1, 10: 3.1, 11: 3.1, 12: 3.1,
};
export const EXT_MIN_REV = { 16: 3.1, 17: 3.1, 18: 3.1 };

/**
 * 「消息类型 → 界面分类」映射（给表格上色用）。
 * 归类维度：握手 / 能力 / 电源协商 / 控制 / 数据 / 厂商 / 告警 / 错误
 */
export const MSG_CATEGORY = {
  'GoodCRC': 'handshake',
  'Ping': 'handshake',
  'Source_Cap': 'capability',
  'Sink_Cap': 'capability',
  'Source_Capabilities_Extended': 'capability',
  'Sink_Capabilities_Extended': 'capability',
  'Source_Info': 'capability',
  'EPR_Source_Capabilities': 'capability',
  'EPR_Sink_Capabilities': 'capability',
  'Request': 'negotiate',
  'EPR_Request': 'negotiate',
  'Accept': 'negotiate',
  'Reject': 'negotiate',
  'PS_RDY': 'negotiate',
  'GotoMin': 'negotiate',
  'Wait': 'negotiate',
  'PPS_Status': 'negotiate',
  'EPR_Mode': 'negotiate',
  'Not_Supported': 'negotiate',
  'Soft_Reset': 'control',
  'Data_Reset': 'control',
  'Data_Reset_Complete': 'control',
  'DR_Swap': 'control',
  'PR_Swap': 'control',
  'VCONN_Swap': 'control',
  'FR_Swap': 'control',
  'Get_Source_Cap_Extended': 'control',
  'Get_Sink_Cap_Extended': 'control',
  'Get_Source_Info': 'control',
  'Get_Status': 'control',
  'Get_PPS_Status': 'control',
  'Get_Country_Codes': 'control',
  'Get_Country_Info': 'control',
  'Get_Revision': 'control',
  'Get_Battery_Cap': 'control',
  'Get_Battery_Status': 'control',
  'Battery_Capabilities': 'control',
  'Get_Manufacturer_Info': 'control',
  'Extended_Control': 'control',
  'Revision': 'control',
  'VDM': 'vendor',
  'BIST': 'data',
  'Battery_Status': 'data',
  'Status': 'data',
  'Country_Codes': 'data',
  'Country_Info': 'data',
  'Manufacturer_Info': 'data',
  'Enter_USB': 'data',
  'Alert': 'alert',
  'Security_Request': 'security',
  'Security_Response': 'security',
  'Firmware_Update_Request': 'security',
  'Firmware_Update_Response': 'security',
  'Vendor_Defined_Extended': 'vendor',
};

/* ══════════════════ 规格版本 ══════════════════ */

/**
 * Header 的 Specification Revision 域 → 版本号（PD 3.2 Table 6.1）
 * 0b00 = 1.0，0b01 = 2.0，0b10 = 3.0，0b11 = 3.1（3.2 沿用 3.1 的编码，与 3.1 端口互通）
 */
/**
 * Header 的 Specification Revision 字段（B7…6）取值。
 * 注意：规范原文是「10b - Revision 3.x」—— 3.0 / 3.1 / 3.2 共用同一个编码，
 * 因此从报文头**无法**区分 3.0 与 3.1；想知道对端的确切版本要看 Revision 数据消息（RMDO）。
 * 「11b」是 Reserved，不是 3.1/3.2。
 */
export const SPEC_REV = { 0: '1.0', 1: '2.0', 2: '3.x', 3: 'Reserved（11b）' };

/** 修订号文本 → 可比较的数值（3.x 记作 3.0，只用于「早于某版本」这类粗判） */
export function revTextNum(text) {
  if (text === '3.x') return 3;
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : 0;
}

/** 扩展消息长度参数（PD 3.2 Table 6.65） */
export const EXT_MSG_LIMITS = {
  maxLen: 260,          // MaxExtendedMsgLen：Data Size 的最大值
  chunkLen: 26,         // MaxExtendedMsgChunkLen：单个分块的数据字节数
  legacyLen: 26,        // MaxExtendedMsgLegacyLen：不分块时的最大数据字节数
};

/* ══════════════════ 数据对象 ══════════════════ */

/** BIST 测试模式 —— PD 3.2 Table 6.23（值与 PD 2.0 完全不同，见下面旧表） */
export const BIST_MODES_V3 = {
  0x5: 'BIST Carrier Mode',
  0x8: 'BIST Test Data',
  0x9: 'BIST Shared Test Mode Entry',
  0xA: 'BIST Shared Test Mode Exit',
};

/** BIST 测试模式 —— PD 2.0 旧定义（老设备仍在用，按 Revision 域选择） */
export const BIST_MODES_V2 = {
  0: 'BIST Receiver Mode', 1: 'BIST Transmit Mode', 2: 'Returned BIST Counters',
  3: 'BIST Carrier Mode 0', 4: 'BIST Carrier Mode 1', 5: 'BIST Carrier Mode 2',
  6: 'BIST Carrier Mode 3', 7: 'BIST Eye Pattern', 8: 'BIST Test Data',
  // 9…15 在 PD 2.0 里是 Reserved
};

/** Battery_Status 的充电状态（BSDO B11-10） */
export const CHARGE_STATE = { 0: 'Charging', 1: 'Discharging', 2: 'Idle', 3: 'Invalid' };

/** Enter_USB EUDO 各字段（PD 3.2 Table 6.27） */
export const USB_MODE = { 0: 'USB 2.0', 1: 'USB 3.2', 2: 'USB4' };
export const USB_MODE_UNKNOWN = 'USB4（其他取值按 USB4 处理）';
export const USB_SPEED = {
  0: 'USB 2.0 only (no SuperSpeed)', 1: 'USB 3.2 Gen1', 2: 'USB 3.2 Gen2 / USB4 Gen2',
  3: 'USB4 Gen3', 4: 'USB4 Gen4',
};
export const USB_SPEED_UNKNOWN = 'USB4 Gen4（其他取值按 Gen4 处理）';
export const CABLE_TYPE = {
  0: 'Passive', 1: 'Active Re-timer', 2: 'Active Re-driver', 3: 'Optically Isolated',
};
export const CABLE_CURRENT_EUDO = {
  0: 'VBUS not supported', 1: 'VBUS not supported（取值无效，按 00b 处理）',
  2: '3 A', 3: '5 A',
};

/** Alert 的扩展事件类型（ADO B3-0） */
export const EXT_ALERT_EVENT = {
  1: 'Power State change (DFP)',
  2: 'Power button press (UFP)',
  3: 'Power button release (UFP)',
  4: 'Controller initiated wake (UFP)',
  5: 'Source is about to reduce Source Capabilities',
};

/** EPR_Mode 的 Action / Data（PD 3.2 Table 6.28） */
export const EPR_MODE_ACTION = {
  1: 'Enter EPR Mode', 2: 'Enter Acknowledged', 3: 'Enter Succeeded',
  4: 'Enter Failed', 5: 'Exit EPR Mode',
};
export const EPR_MODE_DATA = {
  0: 'Unknown cause', 1: 'Cable not EPR capable',
  2: 'Source failed to become VCONN source',
  3: 'EPR Capable bit not set in RDO',
  4: 'Source unable to enter EPR Mode',
  5: 'EPR Capable bit not set in PDO',
};

/** 扩展控制消息类型（PD 3.2 Table 6.63） */
export const EXT_CONTROL_MSG_TYPES = {
  1: 'EPR_Get_Source_Cap', 2: 'EPR_Get_Sink_Cap',
  3: 'EPR_Keep_Alive', 4: 'EPR_Keep_Alive_Ack',
};

/** 峰值电流档位（PD 3.2 Table 6.18 / 6.5.2.2） */
export const PEAK_CURRENT_DETAILS = {
  0: { code: '00b', summary: 'IoC only / see Source_Capabilities_Extended', steps: [] },
  1: {
    code: '01b', summary: '150/125/110% IoC overload profile',
    steps: ['150% IoC for 1ms @ 5% duty', '125% IoC for 2ms @ 10% duty', '110% IoC for 10ms @ 50% duty'],
  },
  2: {
    code: '10b', summary: '200/150/125% IoC overload profile',
    steps: ['200% IoC for 1ms @ 5% duty', '150% IoC for 2ms @ 10% duty', '125% IoC for 10ms @ 50% duty'],
  },
  3: {
    code: '11b', summary: '200/175/150% IoC overload profile',
    steps: ['200% IoC for 1ms @ 5% duty', '175% IoC for 2ms @ 10% duty', '150% IoC for 10ms @ 50% duty'],
  },
};

/** 固定 PDO 的 FRS（Fast Role Swap）能力（Sink 侧 B24-23） */
export const FRS_CURRENT = {
  0: '00b Fast Role Swap not supported',
  1: '01b Default USB Port',
  2: '10b 1.5 A @ 5 V',
  3: '11b 3.0 A @ 5 V',
};

/** 电源状态（Status 报文 B6 B2-0，PD 3.2 Table 6.51） */
export const POWER_STATE = {
  0: 'Status Not Supported', 1: 'S0', 2: 'Modern Standby', 3: 'S3',
  4: 'S4', 5: 'S5 (Off with Battery)', 6: 'G3 (Off, no Battery)',
};
/** 电源指示灯（Status 报文 B6 B5-3） */
export const STATE_INDICATOR = { 0: 'Off LED', 1: 'On LED', 2: 'Blinking LED', 3: 'Breathing LED' };
/** 内部温度状态（Status 报文 Byte4 B2-1 / PPS B3 B2-1） */
export const TEMP_STATUS = { 0: 'Not Supported', 1: 'Normal', 2: 'Warning', 3: 'Over-temperature' };
/** 电池槽/电池位（SDB Byte2、GBCDB、GBSDB 索引规则一致） */
export const BATTERY_REF_TEXT = (n) => (n < 4
  ? `Fixed Battery ${n}`
  : (n < 8 ? `Hot Swappable Battery ${n - 4}` : `无效电池引用 ${n}`));

/** SCEDB / SKEDB 的负载阶跃（Load Step） */
export const LOAD_STEP = { 0: '150 mA/µs (default)', 1: '500 mA/µs', 2: '取值无效，按默认 150 mA/µs', 3: '取值无效，按默认 150 mA/µs' };
/** 接触温度标准（SCEDB Byte20 / SKEDB Byte15，两张表取值不同，分别给出） */
export const TOUCH_TEMP_SOURCE = { 0: 'IEC 60950-1 (default)', 1: 'IEC 62368-1 TS1', 2: 'IEC 62368-1 TS2' };
export const TOUCH_TEMP_SINK = {
  0: 'No applicable standard', 1: 'IEC 60950-1 (default)', 2: 'IEC 62368-1 TS1', 3: 'IEC 62368-1 TS2',
};

/* ══════════════════ VDM ══════════════════ */

/** Structured VDM Header 的命令（PD 3.2 Table 6.33） */
export const VDM_CMDS = {
  1: 'Discover Identity', 2: 'Discover SVIDs', 3: 'Discover Modes',
  4: 'Enter Mode', 5: 'Exit Mode', 6: 'Attention',
};
/** 命令 16…31 是 SVID 自定义命令 */
export const VDM_CMD_SVID_MIN = 16;
/** 命令类型 REQ / ACK / NAK / BUSY */
export const VDM_ACK = ['REQ', 'ACK', 'NAK', 'BUSY'];
/** Structured VDM Version (Major)：00b 已废弃，01b 为 2.x */
export const VDM_VER_MAJOR = { 0: 'Version 1.0 (已废弃)', 1: 'Version 2.x' };
/** Structured VDM Version (Minor)，仅在 Command ≤ 15 时有固定含义 */
export const VDM_VER_MINOR = { 0: 'Version 2.0', 1: 'Version 2.1' };

/** Discover Identity 的 ID Header VDO：产品类型（PD 3.2 Table 6.34，按链路区分含义） */
export const PRODUCT_TYPE_UFP = {
  0: 'Not a UFP', 1: 'PDUSB Hub', 2: 'PDUSB Peripheral', 3: 'PSD (Power Source Device)',
  4: '无效取值（接收端应忽略）', 5: 'AMA（已废弃，PD 3.0 的 Alternate Mode Adapter）',
  6: '无效取值（接收端应忽略）', 7: '无效取值（接收端应忽略）',
};
export const PRODUCT_TYPE_CABLE = {
  0: 'Not a Cable Plug/VPD', 1: '无效取值（接收端应忽略）', 2: '无效取值（接收端应忽略）',
  3: 'Passive Cable', 4: 'Active Cable', 5: '无效取值（接收端应忽略）',
  6: 'VCONN Powered USB Device (VPD)', 7: '无效取值（不得使用）',
};
export const PRODUCT_TYPE_DFP = {
  0: 'Not a DFP', 1: 'PDUSB Hub', 2: 'PDUSB Host', 3: 'Power Brick',
  4: 'AMC（已废弃）', 5: '无效取值（不得使用）', 6: '无效取值（不得使用）', 7: '无效取值（不得使用）',
};
/** ID Header VDO 的连接器类型（B22-21） */
export const CONNECTOR_TYPE = {
  0: 'Unknown（已废弃）', 1: '无效取值（不得使用）',
  2: 'USB Type-C Receptacle', 3: 'USB Type-C Plug',
};
/** 返回哪种 Product Type VDO（PD 3.2 Table 6.35 / 6.36 / 6.37） */
export const PRODUCT_TYPE_VDO_KIND = {
  ufp: { 0: null, 1: 'ufp', 2: 'ufp', 3: null, 5: 'ama' },
  cable: { 0: null, 3: 'passiveCable', 4: 'activeCable', 6: 'vpd' },
  dfp: { 0: null, 1: 'dfp', 2: 'dfp', 3: 'dfp' },
};

/** UFP VDO / DFP VDO 的版本域 */
export const UFP_VDO_VERSION = {
  0: '无效取值（不得使用）', 1: 'Version 1.1（已废弃）', 2: 'Version 1.2（已废弃）', 3: 'Version 1.3',
};
export const DFP_VDO_VERSION = { 0: '无效取值（不得使用）', 1: 'Version 1.1（已废弃）', 2: 'Version 1.2' };

/** UFP VDO 的 USB 2.0 能力 / USB 最高速率 */
export const UFP_USB2 = {
  0: '不具备 USB 2.0 能力', 1: '仅支持 USB 2.0 Billboard 设备', 2: '支持 USB 2.0', 3: '无效取值（按 00b 处理）',
};
export const USB_HIGHEST_SPEED = {
  0: 'USB 2.0 only（无 SuperSpeed）', 1: 'USB 3.2 Gen1', 2: 'USB 3.2 Gen2 / USB4 Gen2',
  3: 'USB4 Gen3', 4: 'USB4 Gen4',
};
/**
 * 线缆 VDO 的 USB Highest Speed（B2..0）在 PD 3.0 里只有三档，
 * 011b…111b 明确标注为 Reserved、不得使用；PD 3.1+ 才扩到 USB4 Gen3/Gen4。
 */
export const USB_HIGHEST_SPEED_V30 = {
  0: 'USB 2.0 only（无 SuperSpeed）', 1: '[USB 3.1] Gen1', 2: '[USB 3.1] Gen1 与 Gen2',
};
export const VCONN_POWER = { 0: '1 W', 1: '1.5 W', 2: '2 W', 3: '3 W', 4: '4 W', 5: '5 W', 6: '6 W', 7: '无效取值（不得使用）' };

/** 线缆 VDO 的固定字段 */
export const CABLE_CONNECTOR = {
  0: 'USB Type-A（已废弃）', 1: 'USB Type-B（已废弃）', 2: 'USB Type-C', 3: 'Captive（固线）',
};
export const CABLE_TERMINATION_PASSIVE = { 0: '不需要 VCONN', 1: '需要 VCONN', 2: '无效取值（不得使用）', 3: '无效取值（不得使用）' };
export const CABLE_TERMINATION_ACTIVE = {
  0: '无效取值（不得使用）', 1: '无效取值（不得使用）',
  2: '一端 Active、一端 Passive，需要 VCONN', 3: '两端都 Active，需要 VCONN',
};
/** 无源线缆的延迟档位（PD 3.2 Table 6.42） */
export const CABLE_LATENCY_PASSIVE = {
  0: '无效取值（不得使用）', 1: '<10ns (~1m)', 2: '10ns ~ 20ns (~2m)', 3: '20ns ~ 30ns (~3m)',
  4: '30ns ~ 40ns (~4m)', 5: '40ns ~ 50ns (~5m)', 6: '50ns ~ 60ns (~6m)', 7: '60ns ~ 70ns (~7m)',
  8: '>70ns (>~7m)', 9: '无效取值（不得使用）', 10: '无效取值（不得使用）', 11: '无效取值（不得使用）',
  12: '无效取值（不得使用）', 13: '无效取值（不得使用）', 14: '无效取值（不得使用）', 15: '无效取值（不得使用）',
};
/** 有源线缆的延迟档位（PD 3.2 Table 6.43，1000ns 以上是长线） */
export const CABLE_LATENCY_ACTIVE = {
  0: '无效取值（不得使用）', 1: '<10ns (~1m)', 2: '10ns ~ 20ns (~2m)', 3: '20ns ~ 30ns (~3m)',
  4: '30ns ~ 40ns (~4m)', 5: '40ns ~ 50ns (~5m)', 6: '50ns ~ 60ns (~6m)', 7: '60ns ~ 70ns (~7m)',
  8: '1000ns (~100m)', 9: '2000ns (~200m)', 10: '3000ns (~300m)', 11: '无效取值（不得使用）',
  12: '无效取值（不得使用）', 13: '无效取值（不得使用）', 14: '无效取值（不得使用）', 15: '无效取值（不得使用）',
};
/** 最大 VBUS 电压：PD 3.0 与 PD 3.1+ 的编码不同，按报文 Revision 选择 */
export const CABLE_VBUS_VOLTAGE_V30 = { 0: '20 V', 1: '30 V', 2: '40 V', 3: '50 V' };
export const CABLE_VBUS_VOLTAGE_V31 = {
  0: '20 V', 1: '20 V（Deprecated 码，接收端按 20V 处理）', 2: '20 V（Deprecated 码，接收端按 20V 处理）', 3: '50 V',
};
/** VBUS 载流能力 */
export const CABLE_VBUS_CURRENT = {
  0: '无效取值（按 3A 处理）', 1: '3 A', 2: '5 A', 3: '无效取值（按 3A 处理）',
};
export const CABLE_VBUS_CURRENT_ACTIVE = {
  0: '无效取值（不得使用）', 1: '3 A', 2: '5 A', 3: '无效取值（不得使用）',
};

/** 有源线缆 VDO2 的功耗档位 */
export const U3_CLD_POWER = {
  0: '>10 mW', 1: '5 ~ 10 mW', 2: '1 ~ 5 mW', 3: '0.5 ~ 1 mW',
  4: '0.2 ~ 0.5 mW', 5: '50 ~ 200 µW', 6: '<50 µW', 7: '无效取值（按 000b 处理）',
};

/** VCONN Powered USB Device VDO（PD 3.2 Table 6.45） */
export const VPD_VBUS_VOLTAGE = {
  0: '20 V', 1: '20 V（Deprecated 码，接收端按 20V 处理）',
  2: '20 V（Deprecated 码，接收端按 20V 处理）', 3: '20 V（Deprecated 码，接收端按 20V 处理）',
};

/**
 * 旧版 AMA VDO（PD 3.0 Table 6-37 / PD 2.0 Table 6-30）。
 * PD 3.2 已废弃该形态，但老设备仍在发，所以保留两套布局按 Revision 选。
 */
export const AMA_VCONN_POWER = VCONN_POWER;
export const AMA_SUPERSPEED_V30 = {
  0: 'USB 2.0 only', 1: 'USB 3.1 Gen1 + USB 2.0', 2: 'USB 3.1 Gen1/Gen2 + USB 2.0',
  3: 'USB 2.0 Billboard only', 4: '保留值（不得使用）', 5: '保留值（不得使用）',
  6: '保留值（不得使用）', 7: '保留值（不得使用）',
};

/** Alert 的告警位（ADO B31-24，按位给名字） */
export const ALERT_BITS = [
  { bit: 24, name: 'Reserved' },
  { bit: 25, name: 'Battery Status Change Event' },
  { bit: 26, name: 'OCP Event' },
  { bit: 27, name: 'OTP Event' },
  { bit: 28, name: 'Operating Condition Change Event' },
  { bit: 29, name: 'Source Input Change Event' },
  { bit: 30, name: 'OVP Event' },
  { bit: 31, name: 'Extended Alert Event' },
];

/** Status 报文 Event Flag（SDB Byte3）逐位 */
export const STATUS_EVENT_BITS = [
  { bit: 1, name: 'Overcurrent Event (OCP)' },
  { bit: 2, name: 'Overtemperature Event (OTP)' },
  { bit: 3, name: 'Overvoltage Event (OVP)' },
  { bit: 4, name: 'Current Limit (CL) Mode（仅 PPS）' },
];

/** Status 报文 Power Status（SDB Byte5）逐位 */
export const POWER_STATUS_BITS = [
  { bit: 1, name: '受线缆载流能力限制' },
  { bit: 2, name: '受其他端口供电不足限制' },
  { bit: 3, name: '受外部供电不足限制' },
  { bit: 4, name: '受 Event Flags 限制' },
  { bit: 5, name: '受温度限制' },
];
