/**
 * tables.js — UFCS 协议常量表
 *
 * 全部取自 T/CCSA 393—2024 / T/TAF 083—2024《移动终端融合快速充电技术要求》
 * （以下简称「规范」）第 7 章物理层、第 8 章协议层。每张表都在注释里写明出处，
 * 便于日后核对版本（本工程参考的是 2024-04-01 发布、2024-04-08 实施的那一版）。
 *
 * 命名统一带 `UFCS_` 前缀：单文件打包器会把整个库拍平进同一个作用域，
 * 不带前缀会和 pd/ 库里的同名表互相覆盖。
 */

/* ══════════════ 消息头（规范 8.2.2 表 13）══════════════ */

/**
 * 设备地址（Header bit15…13）—— 注意这是**接收方**的地址，
 * 不是发送方；方向要结合物理链路（D+/D- 谁在发）才能还原，见 decoder.js。
 */
export const UFCS_DEV_ADDR = {
  0b001: '供电设备（Source）',
  0b010: '充电设备（Sink）',
  0b011: '线缆电子标签（Cable）',
};

/** 设备地址 → 短名（与 PD 侧的 SRC / SNK / Plug 口径对齐，界面配色直接复用） */
export const UFCS_ADDR_ROLE = { 0b001: 'SRC', 0b010: 'SNK', 0b011: 'Plug' };
export const UFCS_ROLE_ADDR = { SRC: 0b001, SNK: 0b010, Plug: 0b011 };

/** 消息类型（Header bit2…0） */
export const UFCS_MSG_TYPE = {
  0b000: '控制消息',
  0b001: '数据消息',
  0b010: '自定义消息',
};

/** 协议版本编号（Header bit8…3）→ 文本 */
export const UFCS_VERSION = {
  0b000001: '1.0.0',
  0b010001: '1.0.1',
  0b001001: '1.2.0',
};

/**
 * 消息头里的版本号是 6 bit，按规范 8.2.2 注 c 拆成三段：
 * **低 2bit 大版本、中 2bit 中版本、高 2bit 小版本**。
 * 即 V1.0.1 的编号是 010001b（高 2bit=01 小版本 1，中 2bit=00 中版本 0，低 2bit=01 大版本 1）。
 */
export function ufcsVersionText(code) {
  const major = code & 0b11;
  const minor = (code >> 2) & 0b11;
  const patch = (code >> 4) & 0b11;
  return `${major}.${minor}.${patch}`;
}

/* ══════════════ 控制命令（规范 8.2.3 表 14）══════════════ */

/**
 * `dir` 按规范表 14 的「发送者 → 接收者」记，`req` 是规范给的强制等级。
 * `sum` 是一句话说明，界面表格的「解析详情」列直接用它。
 */
export const UFCS_CTRL_CMD = {
  0x00: { name: 'Ping', dir: 'SRC/SNK → 任意', req: '必选', sum: '探测目标设备是否存在，或测试传输是否正常' },
  0x01: { name: 'ACK', dir: '任意 → 任意', req: '必选', sum: '消息已被正确接收（CRC 校验通过）' },
  0x02: { name: 'NCK', dir: '任意 → 任意', req: '必选', sum: '消息已被接收，但 CRC 校验失败' },
  0x03: { name: 'Accept', dir: 'SRC/SNK → SRC/SNK', req: '必选', sum: '同意对方的请求，随后按请求调整输出' },
  0x04: { name: 'Soft_Reset', dir: 'SRC/SNK → 任意', req: '必选', sum: '软复位：不退出 UFCS，收发状态机与缓存清零' },
  0x05: { name: 'Power_Ready', dir: 'SRC → SNK', req: '必选', sum: '输出已调整到请求的电压/电流值' },
  0x06: { name: 'Get_Output_Capabilities', dir: 'SNK → SRC', req: '必选', sum: '请求供电设备的电压/电流输出能力' },
  0x07: { name: 'Get_Source_Info', dir: 'SNK → SRC', req: '必选', sum: '请求供电设备当前工作状态（输出、温度等）' },
  0x08: { name: 'Get_Sink_Info', dir: 'SRC → SNK', req: '必选', sum: '请求充电设备当前工作状态（电池、温度等）' },
  0x09: { name: 'Get_Cable_Info', dir: 'SRC/SNK → Cable', req: '必选', sum: '请求线缆电子标签信息（阻抗、承载能力）' },
  0x0A: { name: 'Get_Device_Info', dir: 'SRC/SNK → SRC/SNK', req: '必选', sum: '请求对端的硬件与软件信息' },
  0x0B: { name: 'Get_Error_Info', dir: 'SRC/SNK → SRC/SNK', req: '必选', sum: '请求对端的异常状态信息' },
  0x0C: { name: 'Detect_Cable_Info', dir: 'SRC/SNK → SRC/SNK', req: '可选', sum: '命令对端去读线缆信息并把结果回报过来' },
  0x0D: { name: 'Start_Cable_Detect', dir: 'SRC/SNK → SRC/SNK', req: '可选', sum: '请对方停止发送并释放 TX 总线，以便与线缆通信' },
  0x0E: { name: 'End_Cable_Detect', dir: 'SRC/SNK → SRC/SNK', req: '可选', sum: '通知对方可重新使用 D+/D- 总线通信' },
  0x0F: { name: 'Exit_UFCS_Mode', dir: 'SRC/SNK → SRC/SNK', req: '必选', sum: '退出 UFCS 快充模式，回到初始状态' },
  0x10: { name: 'Get_Sink_Info_Extended', dir: 'SRC → SNK', req: '可选', sum: '请求充电设备更多状态（最大充电功率、电池电量）' },
};

/* ══════════════ 数据命令（规范 8.2.4 表 15）══════════════ */

/**
 * `len` 是规范规定的「数据长度」字段取值：
 *   • 定长 → 数字；
 *   • 变长 → `{ unit, min, max }`，即「每项 unit 字节、1…max 项」。
 */
export const UFCS_DATA_CMD = {
  0x01: { name: 'Output_Capabilities', dir: 'SRC → SNK', req: '必选', len: { unit: 8, min: 1, max: 7 }, sum: '供电设备的能力清单（每种输出模式 8 字节，最多 7 种）' },
  0x02: { name: 'Request', dir: 'SNK → SRC', req: '必选', len: 8, sum: '充电设备请求某个输出模式下的具体电压与电流' },
  0x03: { name: 'Source_Information', dir: 'SRC → SNK', req: '必选', len: 8, sum: '供电设备当前状态：输出电压/电流、内部与接口温度' },
  0x04: { name: 'Sink_Information', dir: 'SNK → SRC', req: '必选', len: 8, sum: '充电设备当前状态：充电电压/电流、电池与接口温度' },
  0x05: { name: 'Cable_Information', dir: 'Cable/SRC/SNK → SRC/SNK', req: '必选', len: 10, sum: '线缆信息：厂家识别码、阻抗、最大承载电压与电流' },
  0x06: { name: 'Device_Information', dir: 'SRC/SNK → SRC/SNK', req: '必选', len: 8, sum: '设备信息：厂家识别码、硬/软件版本号' },
  0x07: { name: 'Error_Information', dir: 'SRC/SNK → SRC/SNK', req: '必选', len: 4, sum: '异常状态：D+ / D- / CC 过压标志' },
  0x08: { name: 'Config_Watchdog', dir: 'SNK → SRC', req: '必选', len: 2, sum: '配置供电设备的看门狗溢出时间（0 = 关闭看门狗）' },
  0x09: { name: 'Refuse', dir: '任意 → SRC/SNK', req: '必选', len: 4, sum: '拒绝某条消息，并给出被拒消息的编号/类型/命令与原因' },
  0x0A: { name: 'Verify_Request', dir: 'SRC/SNK → 任意', req: '可选', len: 17, sum: '索要鉴权：指定密钥编号并给出 16 字节随机数' },
  0x0B: { name: 'Verify_Response', dir: '任意 → SRC/SNK', req: '可选', len: 48, sum: '鉴权应答：32 字节加密数据 + 回送 16 字节随机数' },
  0x0C: { name: 'Power_Change', dir: 'SRC → SNK', req: '可选', len: { unit: 3, min: 1, max: 7 }, sum: '供电设备主动通知最大输出电流能力发生了变化' },
  0x0D: { name: 'Sink_Information_Extended', dir: 'SNK → SRC', req: '可选', len: { unit: 3, min: 1, max: 15 }, sum: '充电设备扩展状态：电池电量、最大充电功率（每项 3 字节）' },
  0xFF: { name: 'Test_Request', dir: '测试设备 → 任意', req: '必选', len: 2, sum: '测试用：命令被测设备按指定设备地址/消息类型/命令发一条消息' },
};

/* ══════════════ 输出模式（规范 8.2.4.1 表 16 / 8.2.4.12 表 25）══════════════ */

/** 电流调节步进（表 16 bit59…57） */
export const UFCS_CURRENT_STEP = { 0: '10 mA', 1: '20 mA', 2: '30 mA', 3: '40 mA', 4: '50 mA' };

/** 电压调节步进（表 16 bit56） */
export const UFCS_VOLTAGE_STEP = { 0: '10 mV', 1: '20 mV' };

/* ══════════════ Refuse 拒绝原因（规范 8.2.4.9 表 24）══════════════ */

export const UFCS_REFUSE_REASON = {
  0x01: '无法识别的命令或数据',
  0x02: '不支持的命令或数据',
  0x03: '设备忙，暂无法响应',
  0x04: '请求的输出电压、电流或功率超出范围',
  0x05: '其它原因',
};

/* ══════════════ Sink_Information_Extended 状态类型（规范 8.2.4.13 表 26）══════════════ */

export const UFCS_EXT_STATUS_TYPE = {
  0b0001: '电池电量',
  0b0010: '最大充电功率',
};

/* ══════════════ 异常信息位（规范 8.2.4.7 表 22）══════════════ */

export const UFCS_ERROR_BITS = [
  { bit: 8, name: 'D+ OVP', text: '数据线 D+ 过压' },
  { bit: 7, name: 'D- OVP', text: '数据线 D- 过压' },
  { bit: 6, name: 'CC OVP', text: '配置通道 CC 过压' },
];

/* ══════════════ 物理链路（规范 7.4 / 7.2）══════════════ */

/**
 * 链路标签：UFCS 走 D+/D- 两条线，**供电设备的 D+ 是发送方向、充电设备的 D- 是发送方向**，
 * 所以「消息跑在哪条线上」= 「谁在发」：
 *   D+ → 供电设备或线缆在发；D- → 充电设备或线缆在发。
 * 与 PD 的 SOP/SOP'/SOP'' 同处一栏展示（界面按协议自适应换名字）。
 */
export const UFCS_LINE = { SRC: 'D+', SNK: 'D-', Plug: 'D±' };

/** 波特率基准档位（规范 7.4.6）：115200 为缺省支持档位 */
export const UFCS_BAUD = [115200, 57600, 38400];

/** 一个数据帧 = 1 起始位 + 8 数据位 + 1 结束位（规范 7.4.1） */
export const UFCS_BITS_PER_BYTE = 10;

/* ══════════════ 单向命令表（方向还原的硬依据）══════════════ */

/**
 * 规范表 14 / 表 15 里**只有唯一发送方**的命令。有了它，「谁发给谁」就不必猜：
 * 接收方地址（消息头）必须与下表推出的接收方一致，发送方也随之唯一确定，
 * 物理链路（D+/D-）转而变成一道**交叉校验**而不是前提。
 *
 * 键 = `${消息类型}:${命令编号}`，值 = 发送方角色。
 * 双向命令（Ping / ACK / NCK / Accept / Soft_Reset / Refuse / Get_Device_Info /
 * Get_Error_Info / Exit_UFCS_Mode / Cable_Information / Verify_* …）不在表内。
 */
export const UFCS_FIXED_DIR = {
  '0:0x05': 'SRC',   // Power_Ready                供电设备 → 充电设备
  '0:0x06': 'SNK',   // Get_Output_Capabilities    充电设备 → 供电设备
  '0:0x07': 'SNK',   // Get_Source_Info            充电设备 → 供电设备
  '0:0x08': 'SRC',   // Get_Sink_Info              供电设备 → 充电设备
  '0:0x10': 'SRC',   // Get_Sink_Info_Extended     供电设备 → 充电设备
  '1:0x01': 'SRC',   // Output_Capabilities        供电设备 → 充电设备
  '1:0x02': 'SNK',   // Request                    充电设备 → 供电设备
  '1:0x03': 'SRC',   // Source_Information         供电设备 → 充电设备
  '1:0x04': 'SNK',   // Sink_Information           充电设备 → 供电设备
  '1:0x08': 'SNK',   // Config_Watchdog            充电设备 → 供电设备
  '1:0x0C': 'SRC',   // Power_Change               供电设备 → 充电设备
  '1:0x0D': 'SNK',   // Sink_Information_Extended  充电设备 → 供电设备
};

/** 查单向命令的发送方；双向命令返回 null */
export const ufcsFixedSender = (mtype, cmd) => UFCS_FIXED_DIR[`${mtype}:0x${(cmd ?? 0).toString(16).toUpperCase().padStart(2, '0')}`] ?? null;

/** 某角色发送时，消息头里的接收方应当是谁（用于交叉校验） */
export const ufcsPeerOf = (role) => (role === 'SRC' ? 'SNK' : role === 'SNK' ? 'SRC' : null);
export const ufcsOpposite = (role) => (role === 'SRC' ? 'SNK' : role === 'SNK' ? 'SRC' : 'SRC');
