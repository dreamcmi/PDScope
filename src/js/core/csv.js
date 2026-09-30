/**
 * csv.js — 「报文表 → CSV」的**唯一实现**（零依赖，浏览器 + Node 通用）
 *
 * 为什么单独拆一个模块：CSV 有三个出口，必须字字一样，否则「界面里导出来是好的、
 * 命令行导出来少一列」这种差异只有用户会发现。
 *
 *   ┌ 出口 ────────────────────────┬ 谁在调 ──────────────────────────────────┐
 *   │ 界面「另存为」→ CSV           │ src/ui/app.js  exportAs('csv')            │
 *   │ 桌面版命令行 `--csv`          │ src/ui/app.js  pdscopeExportCsv()         │
 *   │ node tools/cli.js --csv      │ tools/cli.js                              │
 *   └──────────────────────────────┴──────────────────────────────────────────┘
 *
 * 三处都只调 `csvText()`，列名 / 转义 / 行尾 / BOM 只有这一份定义。
 *
 * ── 格式约定（改动前先想清楚谁会读它）─────────────────────
 *   · **每个字段都加双引号**，内部的双引号翻倍（RFC 4180）。Excel 打开中文不乱码，
 *     靠的是开头那个 BOM，不是引号；
 *   · 行尾 `\r\n`（Excel 最省事），**结尾不带换行**；
 *   · 时间既给 `hh:mm:ss.mmm`（人看）也给裸毫秒（算差值用），两列都在。
 *
 * ── 列头按协议换一处 ───────────────────────────────────
 *   同名列在第 6 位含义不同：PD 是「数据对象个数」，UFCS 是「数据字节数」
 *   （UFCS 包头里本来就是长度域，没有 PD 那种 4 字节对象的概念）。列名跟着换，
 *   免得把两种口径混在一张表里还看不出来。
 */

/** UTF-8 BOM：Excel 认它才不乱码。写在 CSV 最前面，不是文件名的事 */
export const CSV_BOM = '\uFEFF';
/** 行尾：Excel / 记事本 / 命令行重定向通吃 */
export const CSV_EOL = '\r\n';

/**
 * 时标：`hh:mm:ss.mmm`。小时不截断（抓包可以跑几十小时），毫秒固定 3 位。
 * 界面顶栏、表格、详情面板与 CSV 用的是同一个（app.js 的 `fmtTime` 就是转发到这里）。
 */
export function csvClock(ms) {
  const s = (Number(ms) || 0) / 1000;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec.toFixed(3)).padStart(6, '0')}`;
}

/** 列头。`protocol` 传容器认出来的协议名（'UFCS' 换第 6 列的含义，见文件头注释） */
export function csvHead(protocol) {
  const ufcs = protocol === 'UFCS';
  return [
    '#', 'SOP', 'MsgType', 'ID', 'Direction',
    ufcs ? 'Bytes' : 'Objects',
    'Elapsed', 'Time(ms)', 'VBUS(V)', 'IBUS(A)', 'Data', 'CRC', 'Note',
  ];
}

/** 一条报文 → 一行单元格（顺序与 `csvHead` 严格对应） */
export function csvRow(p, protocol) {
  const ufcs = protocol === 'UFCS';
  const num = (v, digits) => (Number.isFinite(v) ? v : 0).toFixed(digits);
  return [
    p.index,
    p.sop ?? '',
    p.msgType ?? '',
    p.msgId ?? '',
    p.role ?? '',
    (ufcs ? p.dataLen : p.nObjects) ?? '',
    csvClock(p.timeMs),
    Number.isFinite(p.timeMs) ? p.timeMs.toFixed(4) : '',
    num(p.vbus, 4),
    num(p.ibus, 4),
    p.dataHex || '',
    // CRC 的真实口径有三种：通过 / 校验错 / **没记录**（POWER-Z 的 PD 报文就是这种）。
    // 第三种留空而不是写 OK —— 不能替分析仪的数据背书。
    p.crcOk === null || p.crcOk === undefined ? '' : (p.crcOk ? 'OK' : 'BAD'),
    p.summary || '',
  ];
}

/** CSV 字段转义：整体加引号 + 内部引号翻倍 */
const csvCell = (c) => `"${String(c ?? '').replace(/"/g, '""')}"`;

/**
 * 报文列表 → 完整 CSV 文本（含 BOM、CRLF 行尾）。
 *
 * @param {object[]} packets 报文对象数组（PD / UFCS 同形，见 doc/lib-pd.md）
 * @param {{protocol?: string, bom?: boolean}} [opts]
 *   protocol: 'USB PD' | 'UFCS'（只影响第 6 列的列名与取值，见文件头注释）
 *   bom: 默认 true。写文件保留（Excel 要它），往终端管道里吐时可以关掉
 */
export function csvText(packets, { protocol = 'USB PD', bom = true } = {}) {
  const head = csvHead(protocol);
  const lines = [head.map(csvCell).join(',')];
  for (const p of packets || []) lines.push(csvRow(p, protocol).map(csvCell).join(','));
  return (bom ? CSV_BOM : '') + lines.join(CSV_EOL);
}

/** 导出用的文件名主干：去掉抓包扩展名（`.atkcc` / `.sqlite` / `.db` / 流格式） */
export function csvBase(fileName) {
  return String(fileName || 'pdscope').replace(/\.(atkcc|sqlite|db|pdstream|ufcsstream)$/i, '');
}

/**
 * 导出文件名：`<主干>-ch<通道>.csv`。
 *
 * 带通道号是有意的：同一份多通道 .atkcc 换个通道再导一次，不该把上一份覆盖掉。
 * 命令行导出的**默认输出名**也走这里（由页面算好交给外壳），所以两处不会跑偏。
 */
export function csvFileName(fileName, channel) {
  return `${csvBase(fileName)}-ch${channel}.csv`;
}

/** 采样率按量级选单位（2.5 MHz 的原始采样与 1 kHz 的分析仪时间戳差三个数量级） */
export function fmtRate(hz) {
  if (hz >= 1e6) return (hz / 1e6).toFixed(2) + ' MHz';
  if (hz >= 1e3) return (hz / 1e3).toFixed(2) + ' kHz';
  return hz + ' Hz';
}

/**
 * 导出时该「如实告诉用户」的话。
 *
 * 命令行导出没有顶栏 chip 和提示条，这些事只能靠一句话带出去：采样率是文件声明的
 * 还是波形反推的、CRC 有没有记录、有没有报文没解出来、通道是不是自动挑的。
 * 只写**会影响这份 CSV 怎么读**的事实，不堆统计数字（想看数字的去界面）。
 */
function csvNotes(doc, total, rows) {
  const st = doc.stats || {};
  const out = [];
  const srcTag = {
    declared: '文件声明', measured: '波形实测', default: '默认值',
    override: '手动指定', powerz: '分析仪时间戳',
  }[st.sampleRateSource] || st.sampleRateSource;
  if (st.sampleRateNote) out.push(st.sampleRateNote);
  else if (srcTag) out.push(`采样率按「${srcTag}」取用：${fmtRate(doc.rate ?? 0)}，时标换算以它为准`);

  // 多通道 .atkcc 是自动挑的通道 —— 挑错了整份 CSV 都会是空的，必须说清挑的是哪个
  if (doc.channelPick) {
    const p = doc.channelPick;
    out.push(p.allNoisy
      ? `多通道文件里没找到像 CC 线的通道，仍选了活动度最高的 ch${p.picked} —— 这份 CSV 很可能没有报文`
      : `多通道文件自动选了 ch${p.picked}${p.noiseRejected ? `（跳过 ${p.noiseRejected} 条浮空/噪声线）` : ''}`);
  }
  if (st.unsupported) out.push(`${st.unsupported}（${st.unsupportedMsgs} 条原始帧未做语义解析）`);
  if (st.ufcsUnlocatedRows) out.push(`${st.ufcsUnlocatedRows} 行没能认出 UFCS 报文，已跳过（不影响其余报文）`);
  if (st.badCrc) out.push(`${st.badCrc} 条报文 CRC 校验失败（CRC 列标 BAD）`);
  // 「未记录」与「通过」是两件事：POWER-Z 的 PD 报文压根不存 CRC，不能替它写 OK
  if (st.crcUnknown) out.push(`${st.crcUnknown} 条报文的 CRC 未记录（分析仪不存，CRC 列留空 —— 不代表通过）`);
  if (st.badWire) out.push(`${st.badWire} 条报文的物理层字节与容器记录不符（拆帧自检未通过）`);
  if (st.truncatedRows) out.push(`${st.truncatedRows} 行事件被截断，拼不回完整报文`);
  if (rows < total) out.push(`只导了前 ${rows} 条（该文件共 ${total} 条）`);
  return out;
}

/**
 * 「一份抓包的解码结果」→ 导出成品（CSV 文本 + 摘要 + 该说的话）。
 *
 * 这是**命令行导出的公共下半段**：桌面版（页面里解完再调它）与 `tools/cli.js --csv`
 * 都走这一个函数，所以两边导出的字节与打出来的摘要必然一致。它不碰 DOM、不碰文件系统，
 * 只吃「像 doc 一样的数据」：
 *
 *   { fileName, channel, meta: {protocol, source, sampleRateSource}, rate,
 *     packets, stats, decodedMs, channelPick }
 *
 * @param {object} doc 解码完成的文档（界面里的 doc / 命令行里等价的一份）
 * @param {{limit?: number, bom?: boolean}} [opts]
 *   limit > 0 时只导前 N 条（截面 / 取样用）；
 *   bom 默认 true（落盘要它，Excel 才不乱码），`--out -` 那种管道出口传 false
 */
export function csvExport(doc, { limit = 0, bom = true } = {}) {
  const all = doc.packets || [];
  const rows = limit > 0 ? all.slice(0, limit) : all;
  const protocol = doc.meta?.protocol ?? 'USB PD';
  return {
    /** 可直接落盘的完整文本（含 BOM）。要写文件就用它，别再自己拼 */
    csv: csvText(rows, { protocol, bom }),
    /** 建议的导出名 —— 外壳的默认输出路径用它（`--out` 给了就用用户那个） */
    fileName: csvFileName(doc.fileName, doc.channel),
    channel: doc.channel,
    protocol,
    source: doc.meta?.source ?? 'atkcc',          // 'atkcc' | 'powerz'
    fileSize: doc.fileSize ?? 0,
    packets: all.length,
    rows: rows.length,
    decodeMs: doc.decodedMs ?? 0,
    durationSec: doc.stats?.durationSec ?? 0,
    sampleRate: doc.rate ?? 0,
    sampleRateSource: doc.stats?.sampleRateSource ?? doc.meta?.sampleRateSource ?? '',
    sampleRateText: fmtRate(doc.rate ?? 0),
    notes: csvNotes(doc, all.length, rows.length),
  };
}
