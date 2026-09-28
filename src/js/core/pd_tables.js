/**
 * pd_tables.js — USB PD 协议常量（依据 USB PD 规范 + 与 ATK-C / sigrok 解码器保持一致）
 */

// ── 4B5B 符号编码（5 bit -> 4 bit / K-code） ─────────────────────────────
export const SYM_ERR = 0x10;
export const SYNC1 = 0x11;
export const SYNC2 = 0x12;
export const SYNC3 = 0x13;
export const RST1 = 0x14;
export const RST2 = 0x15;
export const EOP_SYM = 0x16;

/** index = 5bit 原始码（bit0 最先收到），value = 4bit 数据或 K-code */
export const DEC4B5B = [
  0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x13, 0x14,
  0x10, 0x01, 0x04, 0x05, 0x10, 0x16, 0x06, 0x07,
  0x10, 0x12, 0x08, 0x09, 0x02, 0x03, 0x0A, 0x0B,
  0x11, 0x15, 0x0C, 0x0D, 0x0E, 0x0F, 0x00, 0x10,
];

export const SYM_NAME = [
  ['0x0', '0'], ['0x1', '1'], ['0x2', '2'], ['0x3', '3'],
  ['0x4', '4'], ['0x5', '5'], ['0x6', '6'], ['0x7', '7'],
  ['0x8', '8'], ['0x9', '9'], ['0xA', 'A'], ['0xB', 'B'],
  ['0xC', 'C'], ['0xD', 'D'], ['0xE', 'E'], ['0xF', 'F'],
  ['ERROR', 'X'], ['SYNC-1', 'S1'], ['SYNC-2', 'S2'], ['SYNC-3', 'S3'],
  ['RST-1', 'R1'], ['RST-2', 'R2'], ['EOP', '#'],
];

// ── 有序集（Ordered Set）────────────────────────────────────────────────
export const SOP_SEQUENCES = [
  [SYNC1, SYNC1, SYNC1, SYNC2],   // SOP
  [SYNC1, SYNC1, SYNC3, SYNC3],   // SOP'
  [SYNC1, SYNC3, SYNC1, SYNC3],   // SOP''
  [SYNC1, RST2,  RST2,  SYNC3],   // SOP' Debug
  [SYNC1, RST2,  SYNC3, SYNC2],   // SOP'' Debug
  [RST1,  SYNC1, RST1,  SYNC3],   // Cable Reset
  [RST1,  RST1,  RST1,  RST2],    // Hard Reset
];

export const START_OF_PACKETS = {
  [SOP_SEQUENCES[0].join()]: 'SOP',
  [SOP_SEQUENCES[1].join()]: "SOP'",
  [SOP_SEQUENCES[2].join()]: "SOP''",
  [SOP_SEQUENCES[3].join()]: "SOP' Debug",
  [SOP_SEQUENCES[4].join()]: "SOP'' Debug",
  [SOP_SEQUENCES[5].join()]: 'Cable Reset',
  [SOP_SEQUENCES[6].join()]: 'Hard Reset',
};

/** SOP 类型 -> 用于 UI 的稳定短名 */
export const SOP_SHORT = {
  'SOP': 'SOP',
  "SOP'": "SOP'",
  "SOP''": "SOP''",
  "SOP' Debug": "SOP'D",
  "SOP'' Debug": "SOP''D",
  'Cable Reset': 'CRST',
  'Hard Reset': 'HRST',
};

// ── 控制消息（Number of Data Objects == 0）─────────────────────────────
// ⚠ 命名口径必须与 `src/js/pd/tables.js` 逐字一致（界面 / 筛选 / 分类都读那份）。
//   这里只是给 tools/selftest.js、tools/pd-regress.mjs 留的兼容副本。
export const CTRL_TYPES = {
  0: 'Reserved', 1: 'GoodCRC', 2: 'GotoMin', 3: 'Accept', 4: 'Reject',
  5: 'Ping', 6: 'PS_RDY', 7: 'Get_Source_Cap', 8: 'Get_Sink_Cap',
  9: 'DR_Swap', 10: 'PR_Swap', 11: 'VCONN_Swap', 12: 'Wait', 13: 'Soft_Reset',
  14: 'Data_Reset', 15: 'Data_Reset_Complete', 16: 'Not_Supported',
  17: 'Get_Source_Cap_Extended', 18: 'Get_Status', 19: 'FR_Swap',
  20: 'Get_PPS_Status', 21: 'Get_Country_Codes', 22: 'Get_Sink_Cap_Extended',
  23: 'Get_Source_Info', 24: 'Get_Revision',
};

// ── 数据消息 ────────────────────────────────────────────────────────────
export const DATA_TYPES = {
  1: 'Source_Cap', 2: 'Request', 3: 'BIST', 4: 'Sink_Cap',
  5: 'Battery_Status', 6: 'Alert', 7: 'Get_Country_Info', 8: 'Enter_USB',
  9: 'EPR_Request', 10: 'EPR_Mode', 11: 'Source_Info', 12: 'Revision', 15: 'VDM',
};

// ── 扩展消息 ────────────────────────────────────────────────────────────
export const EXT_TYPES = {
  1: 'Source_Capabilities_Extended', 2: 'Status', 3: 'Get_Battery_Cap',
  4: 'Get_Battery_Status', 5: 'Battery_Capabilities', 6: 'Get_Manufacturer_Info',
  7: 'Manufacturer_Info', 8: 'Security_Request', 9: 'Security_Response',
  10: 'Firmware_Update_Request', 11: 'Firmware_Update_Response', 12: 'PPS_Status',
  13: 'Country_Info', 14: 'Country_Codes', 15: 'Sink_Capabilities_Extended',
  16: 'Extended_Control', 17: 'EPR_Source_Capabilities', 18: 'EPR_Sink_Capabilities',
  30: 'Vendor_Defined_Extended',
};

export const BIST_MODES = {
  0: 'Receiver', 1: 'Transmit', 2: 'Counters', 3: 'Carrier 0',
  4: 'Carrier 1', 5: 'Carrier 2', 6: 'Carrier 3', 7: 'Eye',
};

export const VDM_CMDS = {
  1: 'Disc Ident', 2: 'Disc SVID', 3: 'Disc Mode', 4: 'Enter Mode',
  5: 'Exit Mode', 6: 'Attention',
  16: 'DP Status', 17: 'DP Configure',
};
export const VDM_ACK = ['REQ', 'ACK', 'NAK', 'BSY'];

export const EPR_MODE_ACTION = {
  1: 'Enter', 2: 'Enter Acknowledged', 3: 'Enter Succeeded',
  4: 'Enter Failed', 5: 'Exit',
};
export const EPR_MODE_DATA = {
  0: 'Unknown cause', 1: 'Cable not EPR capable',
  2: 'Source failed to become Vconn source',
  3: 'EPR Mode Capable bit not set in RDO',
  4: 'Source unable to enter EPR Mode at this time',
  5: 'EPR Mode Capable bit not set in PDO',
};
export const EXT_CONTROL_MSG_TYPES = {
  1: 'EPR Get Source_Cap', 2: 'EPR Get Sink Cap',
  3: 'EPR KeepAlive', 4: 'EPR KeepAlive Ack',
};

export const PEAK_CURRENT_DETAILS = {
  0: { code: '00b', summary: 'IoC only / see Source_Cap_Extended', steps: [] },
  1: {
    code: '01b', summary: '150/125/110% IoC overload profile',
    steps: ['150% IoC for 1ms @ 5%', '125% IoC for 2ms @ 10%', '110% IoC for 10ms @ 50%'],
  },
  2: {
    code: '10b', summary: '200/150/125% IoC overload profile',
    steps: ['200% IoC for 1ms @ 5%', '150% IoC for 2ms @ 10%', '125% IoC for 10ms @ 50%'],
  },
  3: {
    code: '11b', summary: '200/175/150% IoC overload profile',
    steps: ['200% IoC for 1ms @ 5%', '175% IoC for 2ms @ 10%', '150% IoC for 10ms @ 50%'],
  },
};

/**
 * 「消息类型 -> UI 分类」映射，用于给表格上色。
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
