//! cli.rs — 桌面版的「命令行导出 CSV」这一半（`PDScope.exe <抓包> --csv [输出]`）。
//!
//! ## 为什么这件事落在外壳上
//!
//! 解析全在前端（`dist/PDScope.html` 里那套 PD / UFCS 解析库），Rust 侧一行协议代码都没有，
//! 所以命令行导出**不去重写一套解析**，而是把窗口藏起来、把页面跑起来、让页面把 CSV 算出来：
//!
//! ```text
//!   PDScope.exe 抓包.atkcc --csv 出.csv
//!        │
//!        ├─ ① 解析参数（本文件）：认 --csv / --out / --channel / --limit
//!        ├─ ② 开一个**不显示**的窗口把页面加载起来（main.rs 的 setup）
//!        ├─ ③ 页面就绪后注入 export_js()：读文件字节 → PDScope.exportCsv() → 分块回传
//!        ├─ ④ cli_write 把每块追加落盘，cli_finish 打摘要并按成功/失败退出
//!        └─ ⑤ 完事直接退出进程，一帧界面都不给用户看
//! ```
//!
//! 这么绕一圈换来的是：**命令行导出的 CSV 与界面「另存为 → CSV」是同一份代码算出来的**
//! （`src/js/core/csv.js` 是唯一定义，`tools/cli.js --csv` 也调它）。
//! 代价是命令行模式也需要系统里有 WebView 运行时 —— 与界面形态的要求一致，写进 doc/limits.md 了。
//!
//! ## 两条容易踩的线
//!
//! * **隐藏窗口里的 JS 不会因为「看不见」就停摆**：解码过程让出主线程用的是 MessageChannel
//!   （见 `src/js/core/bmc.js` 里那段实测：`setTimeout` 在后台会被钳到约 1 秒，MessageChannel 不会），
//!   所以这里敢把窗口一直藏着。保险起见还是给 WebView2 补了三个「别因为窗口不可见就降级」的开关。
//! * **Windows 上这是 GUI 子系统的 exe**（没有控制台）：`println!` 打在空气里，而且句柄无效时
//!   还会 panic。所以进来第一件事是挂到父进程的控制台（`win_console`），挂不上就闭嘴不说话。

use std::ffi::{OsStr, OsString};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use tauri::AppHandle;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// 解析与落盘之间一次都不许有的停顿：解码最贵的样本也就几百毫秒一块，
/// 两分钟没动静基本就是卡死了（页面崩了 / 渲染进程被挂起）。命令行没有窗口也没有取消按钮，
/// 不给它一条自尽的退路就只能干等。
const STALL_LIMIT_MS: u64 = 120_000;
/// **页面还没开过口**时的上限：这时候卡的通常是「页面根本没加载起来」
/// （dist 缺失、WebView 运行时装不上）。给足冷启动 + 读大文件的时间 ——
/// 页面一开口（`cli_log` / `cli_write`）就换成下面的 STALL_LIMIT_MS。
const START_LIMIT_MS: u64 = 90_000;
/// 回传分块的行数。行长大致 100~200 字节 → 每块约 100~200 KB，
/// 既躲开大字符串走 IPC 的开销，又不至于把一次导出拆成上千次调用。
const CHUNK_LINES: usize = 1000;

/* ═══════════════════════ 命令行解析 ═══════════════════════ */

/// 输出到哪里
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Out {
    /// 没给 `--out`：与输入同目录的 `<名字>-ch<通道>.csv`（名字由页面按界面那套规则算好）
    Auto,
    /// 落盘到指定路径
    File(PathBuf),
    /// `--out -`：CSV 直接打到标准输出（提示语让位到标准错误）
    Stdout,
}

#[derive(Clone, Debug)]
pub struct Request {
    pub input: PathBuf,
    pub out: Out,
    /// 强制指定通道（多通道 .atkcc）；None = 由页面自动挑
    pub channel: Option<i64>,
    /// 只导前 N 条；0 = 全部
    pub limit: u64,
    /// 要不要 UTF-8 BOM。None = 自动：落盘要（Excel 认它），管道不要（碍着下游工具）
    pub bom: Option<bool>,
}

/// 命令行要说的事
pub enum Action {
    /// 没有命令行导出相关的参数 —— 走原来的界面路径
    None,
    Help,
    Version,
    Export(Request),
}

/// 这个参数看起来是不是一个抓包文件（用于 `--csv` 后面那个词到底是「输出路径」还是「输入文件」）
fn looks_like_capture(s: &str) -> bool {
    match Path::new(s).extension().and_then(|e| e.to_str()) {
        Some(ext) => matches!(
            ext.to_ascii_lowercase().as_str(),
            "atkcc" | "sqlite" | "db" | "bin" | "zip"
        ),
        None => false,
    }
}

/// `-` 后面那些开关只影响「CSV 写成什么样」，不影响解析结果。
fn help_encoding() -> &'static str {
    "\
     CSV 一律是 **UTF-8**，与终端/控制台类型无关：程序自己开文件、自己写字节，\n\
     从不经过控制台的代码页转换（切 65001 只影响屏幕显示）。\n\
     · 写文件（`--csv <路径>` / 默认名）：UTF-8 **带 BOM** —— Excel / WPS 双击即正确；\n\
     · 打到标准输出（`--out -`）且被重定向到文件时：同样自动补 BOM（Windows 用\n\
     \x20 GetFileType 判断是不是磁盘文件）；接到管道里则不带 BOM。\n\
     · `--bom` / `--no-bom` 可以强制这两种行为。\n\
     ⚠ 别用 PowerShell 的 `>` 接 CSV：那是 PowerShell 在解码再重编码（5.1 默认写 UTF-16LE，\n\
     \x20 控制台代码页是 GBK 时还会把中文弄坏）。要落盘就直接给路径，或用 cmd 的 `>`（字节级）。\n"
}

pub fn help_text() -> String {
    format!(
        "PDScope {ver} · USB PD / UFCS 抓包解析\n\
         \n\
         用法：\n\
         \x20 PDScope.exe <抓包文件> --csv [输出路径| -] [选项]     命令行导出 CSV（不开界面）\n\
         \x20 PDScope.exe <抓包文件>                                打开界面看这份抓包\n\
         \n\
         选项：\n\
         \x20 --csv [路径]      导出 CSV。省略路径 = 与输入同目录的 <名字>-ch<通道>.csv；\n\
         \x20                   `-` = 打到标准输出（此时提示语走标准错误）\n\
         \x20 --out <路径>      同 `--csv <路径>`，写全一点更清楚\n\
         \x20 --channel <N>     指定通道（多通道 .atkcc 默认自动挑「像 CC 线」的那条）\n\
         \x20 --limit <N>       只导前 N 条报文（取样 / 排查用）\n\
         \x20 --bom / --no-bom 强制带 / 不带 UTF-8 BOM（默认：写文件带、走管道不带）\n\
         \x20 -h, --help        显示本帮助\n\
         \x20 -V, --version     显示版本\n\
         \n\
         抓包格式按**文件内容**自动分流，不看扩展名：\n\
         \x20 · 正点原子 ATK-C 的 .atkcc（CC 线原始电平采样 → BMC → 4B5B → PD 报文）\n\
         \x20 · POWER-Z 分析仪导出的 .sqlite（USB PD 或 UFCS，按表名分流）\n\
         \n\
         退出码：0 成功 · 1 导出失败（文件坏了 / 写不进去） · 2 用法不对\n\
         \n\
         {enc}\
         \n\
         注意：Windows 上本程序是 GUI 子系统的可执行文件，从命令行启动时 shell 不会等它。\n\
         脚本里请用 `start /wait PDScope.exe …`（cmd）或 `Start-Process -Wait`（PowerShell），\n\
         或者把输出接一下管道（`PDScope.exe … | Out-Null`），否则下一条命令可能先于 CSV 落盘。\n",
        enc = help_encoding(),
        ver = env!("CARGO_PKG_VERSION")
    )
}

pub fn version_text() -> String {
    format!(
        "PDScope {ver}（{os}）",
        ver = env!("CARGO_PKG_VERSION"),
        os = std::env::consts::OS
    )
}

/// 解析命令行。`args` 是**不含 argv[0]** 的参数。
///
/// 只在「带了 --csv / --out / --help / --version」时才认这些开关 —— 不带开关的
/// `PDScope.exe 抓包.atkcc` 仍然按老样子开界面（文件关联、拖到 exe 图标上也是这条路）。
pub fn parse(args: &[OsString]) -> Result<Action, String> {
    let mut file: Option<PathBuf> = None;
    let mut extra: Option<PathBuf> = None;
    let mut csv = false;
    let mut out: Option<PathBuf> = None;
    let mut channel: Option<i64> = None;
    let mut limit: u64 = 0;
    let mut bom: Option<bool> = None;
    let mut help = false;
    let mut version = false;

    let mut i = 0;
    while i < args.len() {
        let tok = &args[i];
        let s = tok.to_string_lossy().into_owned();
        match s.as_str() {
            "-h" | "--help" | "-?" => help = true,
            "-V" | "--version" => version = true,
            "--bom" => bom = Some(true),
            "--no-bom" => bom = Some(false),
            "--csv" => {
                csv = true;
                // `--csv 出.csv` 这种写法也认：紧跟其后、不以 `-` 开头、又**不像抓包文件**的词
                // 当输出路径。判「像不像抓包」是为了让 `PDScope.exe --csv 抓包.atkcc`（开关写在
                // 前面）也能正常工作 —— 否则那个抓包会被当成输出名吃掉。
                // 单独一个 `-` 是「打到标准输出」，与 `--out -` 同义。
                if let Some(next) = args.get(i + 1) {
                    let n = next.to_string_lossy();
                    if n == "-" {
                        out = Some(PathBuf::from("-"));
                        i += 1;
                    } else if !n.starts_with('-') && !looks_like_capture(&n) {
                        out = Some(PathBuf::from(next));
                        i += 1;
                    }
                }
            }
            _ if s.starts_with("--csv=") => {
                csv = true;
                out = Some(PathBuf::from(&s["--csv=".len()..]));
            }
            "--out" => {
                i += 1;
                let v = args.get(i).ok_or("--out 后面要跟输出路径（`-` 表示标准输出）")?;
                out = Some(PathBuf::from(v));
            }
            "--channel" => {
                i += 1;
                let v = args.get(i).ok_or("--channel 后面要跟通道号")?;
                channel = Some(
                    v.to_string_lossy()
                        .parse::<i64>()
                        .map_err(|_| format!("--channel 要的是通道号，收到的是「{}」", v.to_string_lossy()))?,
                );
            }
            "--limit" => {
                i += 1;
                let v = args.get(i).ok_or("--limit 后面要跟条数")?;
                limit = v
                    .to_string_lossy()
                    .parse::<u64>()
                    .map_err(|_| format!("--limit 要的是条数，收到的是「{}」", v.to_string_lossy()))?;
            }
            _ if s.starts_with("--out=") => out = Some(PathBuf::from(&s["--out=".len()..])),
            _ if s.starts_with('-') && s.len() > 1 => return Err(format!("不认识的选项：{s}")),
            _ => {
                // 第一个位置参数是抓包；第二个（如果不像抓包）留作输出路径的候选 ——
                // 这样 `--csv 抓包.atkcc 出.csv`（开关写在最前）也能按用户想的走，
                // 而不是把 `出.csv` 悄悄咽掉。像抓包的第二个位置参数一律不认，
                // 免得 `a.atkcc b.atkcc --csv` 把 b 那份抓包当成输出文件覆盖掉。
                if file.is_none() {
                    file = Some(PathBuf::from(tok));
                } else if extra.is_none() {
                    extra = Some(PathBuf::from(tok));
                }
            }
        }
        i += 1;
    }

    if help {
        return Ok(Action::Help);
    }
    if version {
        return Ok(Action::Version);
    }
    if !csv {
        // 没提导出就是普通的「打开界面看这份抓包」
        if out.is_some() || channel.is_some() || limit > 0 || bom.is_some() {
            return Err("「--out / --channel / --limit / --bom」只有在 --csv 下才有意义".into());
        }
        return Ok(Action::None);
    }

    // 输出路径的第三个来源：第二个位置参数（见上面那段注释）
    if out.is_none() {
        let usable = extra
            .as_ref()
            .is_some_and(|e| !looks_like_capture(&e.to_string_lossy()));
        if usable {
            out = extra.take();
        }
    }

    let input = file.ok_or("--csv 要指定抓包文件")?;
    // 早点判：文件不存在就别白开一个 WebView 再报错
    if !input.is_file() {
        return Err(format!("找不到抓包文件：{}", input.display()));
    }
    let out = match out {
        None => Out::Auto,
        // 空路径（`--csv=` / `--out ""`）在这里就拦下，别拖到第一块数据才报「建不了文件」
        Some(p) if p.as_os_str().is_empty() => return Err("输出路径是空的".into()),
        // 单独一个 `-` 就是「打到标准输出」（cmd / PowerShell 里的 `> 出.csv` 靠它）
        Some(p) if p.as_os_str() == OsStr::new("-") => Out::Stdout,
        Some(p) => Out::File(p),
    };
    Ok(Action::Export(Request { input, out, channel, limit, bom }))
}

/**
 * CSV 要不要带 BOM？
 *
 * 默认规则：**要落盘就带，走管道就不带**。BOM 是给 Excel 认 UTF-8 用的；
 * 管道那头是 `grep` / `python` 之类的工具时，那三个字节只会碍事。
 *
 * `--out -` 时还要再分一次：`exe --csv --out - > 出.csv`（cmd 的重定向是字节级的）
 * 其实就是在写文件，该带；而 `exe --csv --out - | more` 是管道，不该带。
 * 句柄类型是唯一能分辨这两者的线索 —— Windows 用 `GetFileType`，
 * Unix 上看 `/dev/stdout` 指向的是不是普通文件（没有它就保守地当管道）。
 */
fn want_bom(req: &Request) -> bool {
    if let Some(b) = req.bom {
        return b;
    }
    match &req.out {
        Out::Stdout => stdout_is_file(),
        // 写文件（含 Auto 的默认名）—— 程序自己写盘，永远按 UTF-8 写，带 BOM
        Out::File(_) | Out::Auto => true,
    }
}

#[cfg(windows)]
fn stdout_is_file() -> bool {
    win_console::stdout_is_file()
}

#[cfg(not(windows))]
fn stdout_is_file() -> bool {
    // Unix 上重定向与管道都是裸字节，没有代码页问题；这里只决定要不要 BOM。
    // 拿不到 /dev/stdout（某些容器）就当管道处理 —— 宁可少一个 BOM，也不污染管道。
    std::fs::metadata("/dev/stdout").map(|m| m.is_file()).unwrap_or(false)
}

/* ═══════════════════════ 运行状态（进程里只有一份） ═══════════════════════ */

#[derive(Clone, Debug)]
enum Sink {
    File(PathBuf),
    Stdout,
}

struct Run {
    req: Request,
    /// 输出目标。第一块回传时才定下来 —— `Auto` 的默认文件名要用页面算出来的通道号
    sink: Option<Sink>,
    /// 下一块该收到的序号：乱序 / 丢块宁可报错，也别悄悄拼出一份错位的 CSV
    next_seq: u32,
    bytes: u64,
}

static RUN: Mutex<Option<Run>> = Mutex::new(None);
/// 最近一次「有动静」的时刻（Unix 毫秒），看门狗据此判断是不是卡死了
static BEAT: AtomicU64 = AtomicU64::new(0);
/// 页面有没有开过口（回过进度或数据）—— 起步阶段的看门狗盯得更紧
static ANSWERED: AtomicBool = AtomicBool::new(false);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn beat() {
    BEAT.store(now_ms(), Ordering::Relaxed);
}

/// 页面回话（进度或数据）—— 看门狗据此从「起步上限」切到「卡死上限」
fn answered() {
    ANSWERED.store(true, Ordering::Relaxed);
    beat();
}

/// 登录命令行模式（main.rs 解析出 `Export` 后调用一次）
pub fn begin(req: Request) {
    beat();
    if let Ok(mut slot) = RUN.lock() {
        *slot = Some(Run { req, sink: None, next_seq: 0, bytes: 0 });
    }
}

/// 当前是不是命令行导出模式（main.rs 用它决定「窗口显示还是藏着」）
pub fn active() -> bool {
    RUN.lock().map(|g| g.is_some()).unwrap_or(false)
}

/* ═══════════════════════ 输出：说到哪儿去 ═══════════════════════ */

/// 往一条流写一行，**失败算了**。
///
/// 这里刻意不用 `println!`：它写不进去就 panic（本程序 release 下 `panic = "abort"`，
/// 直接整个进程没了）。输出只是附带的，绝不能因为终端没了就把导出带崩。
fn emit(to_stderr: bool, text: &str) {
    if to_stderr {
        if win_console::err_ok() {
            let mut err = std::io::stderr();
            let _ = err.write_all(text.as_bytes());
            let _ = err.flush();
        }
    } else if win_console::out_ok() {
        let mut out = std::io::stdout();
        let _ = out.write_all(text.as_bytes());
        let _ = out.flush();
    }
}

/// CSV 自己要走标准输出时，人看的提示语必须让位到标准错误 —— 否则提示语会混进管道里的 CSV。
fn csv_on_stdout() -> bool {
    RUN.lock()
        .ok()
        .and_then(|g| g.as_ref().map(|r| matches!(r.req.out, Out::Stdout)))
        .unwrap_or(false)
}

/// 打一行给人看的字（CSV 在标准输出时走标准错误）
fn say(line: &str) {
    emit(csv_on_stdout(), &format!("{line}\n"));
}

/// 报错：先标准错误，退而求其次才是标准输出（Windows 上可能只有一条流能用）
pub fn say_err(line: &str) {
    let text = format!("{line}\n");
    if win_console::err_ok() {
        emit(true, &text);
    } else if !csv_on_stdout() {
        // CSV 正占着标准输出时**不许**退到它那儿去：报错混进 CSV 比不报还糟
        emit(false, &text);
    }
}

/// 往标准输出整段打印（`--help` / `--version` 用；没有可用的标准输出就安静丢掉）
pub fn print_out(text: &str) {
    emit(false, text);
}

fn fmt_size(bytes: u64) -> String {
    if bytes >= 1024 * 1024 {
        format!("{:.1} MB", bytes as f64 / 1048576.0)
    } else {
        format!("{:.1} KB", bytes as f64 / 1024.0)
    }
}

fn fmt_duration(sec: f64) -> String {
    if sec >= 60.0 {
        format!("{:.2} min", sec / 60.0)
    } else {
        format!("{sec:.3} s")
    }
}

/* ═══════════════════════ 注入页面的一段脚本 ═══════════════════════ */

/// 命令行导出脚本。
///
/// 页面里**没有**一行 `__TAURI__` 调用（这是本项目的硬规矩：同一份 dist 丢进浏览器也要能跑），
/// 所以「取字节、分块回传、报告结果」这些与外壳打交道的事全部由这段注入脚本做，
/// 页面只暴露一个与外壳无关的 `PDScope.exportCsv({name, bytes, channel, limit, onProgress})`。
fn export_js(req: &Request) -> String {
    let name = req
        .input
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "capture.atkcc".to_string());
    let path = req.input.to_string_lossy().into_owned();
    let channel = req.channel.map(|c| c.to_string()).unwrap_or_else(|| "null".into());
    let limit = if req.limit > 0 { req.limit.to_string() } else { "null".into() };
    // BOM 由 Rust 这边定（它才知道 CSV 最终是落盘还是进管道），页面只管照做
    let bom = if want_bom(req) { "true" } else { "false" };

    let tpl = r#"
(function () {
  var core = window.__TAURI__.core;
  var name = __NAME__, path = __PATH__, channel = __CHANNEL__, limit = __LIMIT__, bom = __BOM__;
  var deadline = Date.now() + 15000;    // 兜底：注入时页面通常已就绪，这一步几乎不会等
  var done = false;

  function log(text) { try { core.invoke('cli_log', { text: text }).catch(function () {}); } catch (e) {} }

  // 只许收一次尾：正常结束与异常路径都可能走到这儿。
  // 这里把字段补齐（失败路径只带 ok/error）：Rust 那边每个参数都是必填的，
  // 缺一个连命令体都进不去，异常就被 IPC 吞掉、只剩看门狗在那儿干等。
  function finish(p) {
    if (done) return;
    done = true;
    try {
      core.invoke('cli_finish', {
        ok: !!p.ok, error: p.error || '',
        packets: p.packets || 0, rows: p.rows || 0, channel: p.channel || 0,
        protocol: p.protocol || '', source: p.source || '', rateText: p.rateText || '',
        durationSec: p.durationSec || 0, decodeMs: p.decodeMs || 0, notes: p.notes || [],
      }).catch(function (e) { log('收尾失败：' + String((e && e.message) || e)); });
    } catch (e) {}
  }

  (function wait() {
    if (window.PDScope && window.PDScope.ready && window.PDScope.exportCsv) { run(); return; }
    // 时间盒按真实时钟算：窗口是隐藏的，浏览器对定时器的节流不该影响这里
    if (Date.now() > deadline) { finish({ ok: false, error: '页面 15 秒内没有就绪（PDScope.ready 一直没上来）' }); return; }
    setTimeout(wait, 25);
  })();

  function run() {
    var lastLog = 0;
    // 先报一声「开始读了」：大文件光读字节 + 解析容器就可能花上十几秒，
    // 这一句同时也告诉看门狗「页面已经开口」，免得它把正常的大文件当成卡死。
    log('  · 读取 ' + name + ' …');
    core.invoke('read_capture', { path: path })
      .then(function (bytes) {
        return window.PDScope.exportCsv({
          name: name, bytes: bytes, channel: channel, limit: limit, bom: bom,
          onProgress: function (ratio, text) {
            var now = Date.now();
            if (now - lastLog < 400) return;      // 解码进度很密，终端里刷太快反而看不清
            lastLog = now;
            log('  · ' + text);
          },
        });
      })
      .then(function (res) {
        // CSV 按行切块回传。切在行边界上，块与块之间补回 CRLF，
        // 所以拼起来的字节与页面算出来的**完全一致**（包括最后一个字节）。
        var lines = String(res.csv).split('\r\n');
        var CHUNK = __CHUNK__;
        var seq = 0;
        (function step(i) {
          if (i >= lines.length) {
            finish({
              ok: true, error: '', packets: res.packets, rows: res.rows,
              channel: res.channel, protocol: res.protocol, source: res.source,
              rateText: res.sampleRateText, durationSec: res.durationSec,
              decodeMs: res.decodeMs, notes: res.notes || [],
            });
            return;
          }
          var part = lines.slice(i, i + CHUNK).join('\r\n');
          if (i + CHUNK < lines.length) part += '\r\n';    // 补回被切掉的分隔符
          core.invoke('cli_write', { seq: seq++, name: res.fileName, text: part })
            .then(function () { step(i + CHUNK); })
            .catch(function (e) { finish({ ok: false, error: String((e && e.message) || e) }); });
        })(0);
      })
      .catch(function (e) { finish({ ok: false, error: String((e && e.message) || e) }); });
  }
})();
"#;
    tpl.replace("__NAME__", &crate::js_str(&name))
        .replace("__PATH__", &crate::js_str(&path))
        .replace("__CHANNEL__", &channel)
        .replace("__LIMIT__", &limit)
        .replace("__BOM__", bom)
        .replace("__CHUNK__", &CHUNK_LINES.to_string())
}

/// 页面加载完成时由 main.rs 注入的那段导出脚本（不在命令行模式时返回 `None`）。
///
/// 这里只把脚本交出去，**由 main.rs 自己 `eval`** —— 与它推抓包给界面走的是同一条路，
/// 也就不必在这里关心回调给的是 `Webview` 还是 `WebviewWindow`。
pub fn export_script() -> Option<String> {
    RUN.lock().ok().and_then(|g| g.as_ref().map(|r| export_js(&r.req)))
}

/* ═══════════════════════ 看门狗 ═══════════════════════ */

/// 卡死兜底：命令行模式没有窗口、没有进度条、也没有取消按钮，
/// 一旦页面那边出事（渲染进程被挂起、脚本异常），进程就会静静地挂着。
/// 每两秒看一眼「最近有没有动静」，超时就报错退出。
pub fn spawn_watchdog(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let idle = now_ms().saturating_sub(BEAT.load(Ordering::Relaxed));
        let limit = if ANSWERED.load(Ordering::Relaxed) { STALL_LIMIT_MS } else { START_LIMIT_MS };
        if idle > limit {
            say_err(&format!(
                "[PDScope] 导出中止：{} 秒没有任何进展（抓包可能过大、文件坏了，或页面异常）",
                idle / 1000
            ));
            win_console::restore();
            app.exit(1);
            return;
        }
    });
}

/* ═══════════════════════ 给页面的三个命令 ═══════════════════════ */

/// 进度 / 提示：页面把一句话交过来，这里打到终端（命令行模式没有左侧的进度条可看）
#[tauri::command]
pub(crate) fn cli_log(text: String) {
    answered();
    say(&text);
}

/// 落一块 CSV。
///
/// 分块而不是一次性把整个 CSV 塞进一次 IPC：一件抓包动辄几万条报文、CSV 十几 MB，
/// 大字符串过 IPC 又慢又容易踩到平台的隐性上限。块序在这里校验（`seq` 必须连续），
/// 顺序错了宁可失败，也不能默默拼出一份错位的 CSV。
///
/// `name` 是页面按界面那套规则算好的默认文件名（`<主干>-ch<通道>.csv`），
/// 只在**用户没给 `--out`** 时用来拼默认路径 —— 命名规则因此只有前端一处定义。
///
/// 参数名从 JS 的 camelCase 映射过来（Tauri 的默认规则），这几个都是单个词，写法一致。
///
/// `async`：这个命令每收一块就要写一次盘，慢的时候（比如 `--out -` 后面接了个慢消费者）
/// 不能占着主线程不放 —— 丢到工作线程上去，界面/事件循环那边照常转。
#[tauri::command(async)]
pub(crate) fn cli_write(seq: u32, name: String, text: String) -> Result<(), String> {
    answered();
    // 注意：`say()` 里还要拿一次 RUN 的锁，所以先把话攒下来，出这个作用域再说 ——
    // 标准库的 Mutex 不可重入，抱着锁打印会直接死给自己看。
    let announce = {
        let mut guard = RUN.lock().map_err(|_| "内部状态异常".to_string())?;
        let run = guard.as_mut().ok_or_else(|| "当前不是命令行导出模式".to_string())?;

        let mut announce = None;
        if run.sink.is_none() {
            if seq != 0 {
                return Err(format!("分块顺序不对：期望第 0 块，收到第 {seq} 块"));
            }
            let sink = match &run.req.out {
                Out::Stdout => Sink::Stdout,
                Out::File(p) => Sink::File(p.clone()),
                Out::Auto => {
                    // 与输入同目录；文件名只取 file_name（页面给的名字里不该有路径，防一手）
                    let dir = run.req.input.parent().unwrap_or_else(|| Path::new("."));
                    let safe = Path::new(&name)
                        .file_name()
                        .map(PathBuf::from)
                        .unwrap_or_else(|| PathBuf::from("pdscope.csv"));
                    Sink::File(dir.join(safe))
                }
            };
            if let Sink::File(p) = &sink {
                // 先建/清空：同名文件就是覆盖（与界面导出同语义），半截失败也好清理
                std::fs::File::create(p).map_err(|e| format!("建不了输出文件 {}：{e}", p.display()))?;
                announce = Some(format!("  输出    {}", p.display()));
            }
            run.sink = Some(sink);
        } else if seq != run.next_seq {
            return Err(format!("分块顺序不对：期望第 {} 块，收到第 {seq} 块", run.next_seq));
        }
        run.next_seq = seq + 1;

        let bytes = text.as_bytes();
        match run.sink.as_ref().expect("上面刚赋值") {
            Sink::File(p) => {
                let mut f = std::fs::OpenOptions::new()
                    .append(true)
                    .open(p)
                    .map_err(|e| format!("写不了 {}：{e}", p.display()))?;
                f.write_all(bytes).map_err(|e| format!("写 {} 出错：{e}", p.display()))?;
            }
            Sink::Stdout => {
                let mut out = std::io::stdout();
                out.write_all(bytes).map_err(|e| format!("写标准输出出错：{e}"))?;
                out.flush().ok();
            }
        }
        run.bytes += bytes.len() as u64;
        announce
    };
    if let Some(line) = announce {
        say(&line);
    }
    Ok(())
}

/// 收尾：成功打摘要（退出码 0），失败报错（退出码 1）。
///
/// 参数名照样从 camelCase 映射过来：`rateText` / `durationSec` / `decodeMs`。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn cli_finish(
    ok: bool,
    error: String,
    packets: u64,
    rows: u64,
    channel: i64,
    protocol: String,
    source: String,
    rate_text: String,
    duration_sec: f64,
    decode_ms: f64,
    notes: Vec<String>,
    app: AppHandle,
) {
    beat();
    // 收尾只许有一次：RUN 已经被取走还再叫一次（重复收尾 / 迟到的回调），
    // 说明状态已经乱了 —— 宁可报错退出，也不能打一份空摘要还报「成功」。
    let Some(run) = RUN.lock().ok().and_then(|mut g| g.take()) else {
        say_err("[PDScope] 内部状态异常：收尾时找不到正在进行的导出任务");
        win_console::restore();
        app.exit(1);
        return;
    };
    let input = run.req.input.clone();
    let sink = run.sink.clone();
    let bytes = run.bytes;

    if !ok {
        // 失败：把半截文件删掉，别留一个看起来像导出成功的 CSV
        if let Some(Sink::File(p)) = &sink {
            if p.exists() {
                let _ = std::fs::remove_file(p);
            }
        }
        let line = format!("[PDScope] 导出失败：{error}");
        say_err(&line);
        // 没有控制台时（双击 exe、从资源管理器启动）只剩弹窗这一条路
        if !win_console::any_ok() {
            let app2 = app.clone();
            std::thread::spawn(move || {
                app2.dialog()
                    .message(line.as_str())
                    .title("PDScope · 命令行导出失败")
                    .kind(MessageDialogKind::Error)
                    .blocking_show();
                win_console::restore();
                app2.exit(1);
            });
            return;
        }
        win_console::restore();
        app.exit(1);
        return;
    }

    let src = match source.as_str() {
        "powerz" => "POWER-Z 分析仪导出",
        _ => "ATK-C 原始采样",
    };
    say("");
    say(&format!("PDScope {} · 命令行导出", env!("CARGO_PKG_VERSION")));
    say(&format!("  输入    {}", input.display()));
    say(&format!("  来源    {src} · {protocol} · ch{channel}"));
    if !rate_text.is_empty() {
        say(&format!("  采样率  {rate_text}"));
    }
    say(&format!(
        "  报文    {packets} 条 → 导出 {rows} 行（{}）",
        match &sink {
            Some(Sink::File(p)) => format!("{} · {}", p.display(), fmt_size(bytes)),
            Some(Sink::Stdout) => format!("标准输出 · {}", fmt_size(bytes)),
            None => fmt_size(bytes),
        }
    ));
    say(&format!(
        "  时长    {} · 解码 {:.0} ms",
        fmt_duration(duration_sec),
        decode_ms
    ));
    if !notes.is_empty() {
        say("  ── 备注 ──");
        for n in &notes {
            say(&format!("  · {n}"));
        }
    }
    say("");
    win_console::restore();
    app.exit(0);
}

/* ═══════════════════════ 控制台（Windows 专属） ═══════════════════════ */

/// Windows 上本程序是 GUI 子系统的可执行文件：从命令行启动时不会自带控制台，
/// 输出打在空气里。所以要主动挂到**父进程的**控制台上去。
///
/// 三条规矩：
/// * 只在「本来就没有可用句柄」时才接管 —— 用户已经重定向了输出（`> out.csv`）时
///   必须原样保留，抢过来会把管道里的内容写到屏幕上；
/// * 挂上之后把控制台输出代码页设成 UTF-8，否则中文在 GBK 控制台上是乱码（退出前还原）；
/// * 这几个函数是 kernel32 里最老的几个，直接声明，不为此拉一个 windows-sys 依赖。
mod win_console {
    use std::sync::atomic::{AtomicBool, Ordering};
    #[cfg(windows)]
    use std::sync::atomic::AtomicU32;

    /// 标准输出 / 标准错误能不能写（Windows 上 GUI 子系统的 exe 可能两条都没有）
    static OUT_OK: AtomicBool = AtomicBool::new(false);
    static ERR_OK: AtomicBool = AtomicBool::new(false);
    /// 被改过的控制台代码页（0 = 没改过，退出时不用还原）
    #[cfg(windows)]
    static OLD_CP: AtomicU32 = AtomicU32::new(0);

    /// 非 Windows 平台一定有可用的标准流，恒真
    pub fn out_ok() -> bool {
        cfg!(not(windows)) || OUT_OK.load(Ordering::Relaxed)
    }
    pub fn err_ok() -> bool {
        cfg!(not(windows)) || ERR_OK.load(Ordering::Relaxed)
    }
    pub fn any_ok() -> bool {
        out_ok() || err_ok()
    }

    #[cfg(windows)]
    const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;
    #[cfg(windows)]
    const STD_OUTPUT_HANDLE: u32 = 0xFFFF_FFF5; // (DWORD)-11
    #[cfg(windows)]
    const STD_ERROR_HANDLE: u32 = 0xFFFF_FFF4; // (DWORD)-12
    #[cfg(windows)]
    const GENERIC_READ: u32 = 0x8000_0000;
    #[cfg(windows)]
    const GENERIC_WRITE: u32 = 0x4000_0000;
    #[cfg(windows)]
    const FILE_SHARE_READ: u32 = 0x0000_0001;
    #[cfg(windows)]
    const FILE_SHARE_WRITE: u32 = 0x0000_0002;
    #[cfg(windows)]
    const OPEN_EXISTING: u32 = 3;
    #[cfg(windows)]
    const CP_UTF8: u32 = 65001;

    // kernel32 里这几个从 Win2000 起就没变过。声明放在模块级，attach / restore 共用。
    #[cfg(windows)]
    #[link(name = "kernel32")]
    extern "system" {
        fn GetStdHandle(n_std_handle: u32) -> *mut core::ffi::c_void;
        fn SetStdHandle(n_std_handle: u32, h_handle: *mut core::ffi::c_void) -> i32;
        fn AttachConsole(dw_process_id: u32) -> i32;
        fn CreateFileW(
            lp_file_name: *const u16,
            dw_desired_access: u32,
            dw_share_mode: u32,
            lp_security_attributes: *mut core::ffi::c_void,
            dw_creation_disposition: u32,
            dw_flags_and_attributes: u32,
            h_template_file: *mut core::ffi::c_void,
        ) -> *mut core::ffi::c_void;
        fn GetConsoleOutputCP() -> u32;
        fn SetConsoleOutputCP(w_code_page_id: u32) -> i32;
        fn GetFileType(h_file: *mut core::ffi::c_void) -> u32;
    }

    /// 标准输出是不是被重定向到了**磁盘文件**（cmd 的 `exe > 出.csv` 就是这样；
    /// PowerShell 的 `>` 对它而言是管道，Unix 上的 `>` 也一样）。
    ///
    /// 这个判断只用来决定「CSV 要不要带 BOM」：写文件带（Excel 认它），进管道不带。
    #[cfg(windows)]
    pub fn stdout_is_file() -> bool {
        const FILE_TYPE_DISK: u32 = 0x0001; // 磁盘文件；管道 3、字符设备 2、未知 0
        let h = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        if h.is_null() || h as isize == -1 {
            return false;
        }
        unsafe { GetFileType(h) == FILE_TYPE_DISK }
    }

    /// 退出前把控制台代码页还回去（改了人家的控制台，走的时候要还）
    pub fn restore() {
        #[cfg(windows)]
        {
            let cp = OLD_CP.swap(0, Ordering::Relaxed);
            if cp != 0 {
                unsafe { SetConsoleOutputCP(cp) };
            }
        }
    }

    #[cfg(not(windows))]
    pub fn attach() {}

    #[cfg(windows)]
    pub fn attach() {
        use std::ffi::OsStr;
        use std::os::windows::ffi::OsStrExt;

        /// 句柄有没有：NULL 与 INVALID_HANDLE_VALUE 都算没有
        fn valid(h: *mut core::ffi::c_void) -> bool {
            !h.is_null() && h as isize != -1
        }

        let out_h = unsafe { GetStdHandle(STD_OUTPUT_HANDLE) };
        let err_h = unsafe { GetStdHandle(STD_ERROR_HANDLE) };
        let (mut out_ok, mut err_ok) = (valid(out_h), valid(err_h));

        // 已经有可用的流（重定向到文件 / 管道，或本来就在控制台里）就不动它
        if !out_ok || !err_ok {
            // AttachConsole 失败是常态（父进程没有控制台 / 已经挂着），不当错误看
            if unsafe { AttachConsole(ATTACH_PARENT_PROCESS) } != 0 {
                let name: Vec<u16> = OsStr::new("CONOUT$").encode_wide().chain(Some(0)).collect();
                let h = unsafe {
                    CreateFileW(
                        name.as_ptr(),
                        GENERIC_READ | GENERIC_WRITE,
                        FILE_SHARE_READ | FILE_SHARE_WRITE,
                        std::ptr::null_mut(),
                        OPEN_EXISTING,
                        0,
                        std::ptr::null_mut(),
                    )
                };
                if valid(h) {
                    // Rust 的 stdout 每次写都重新取句柄（1.77 起明确如此），所以这里是即时生效的
                    if !out_ok {
                        unsafe { SetStdHandle(STD_OUTPUT_HANDLE, h) };
                        out_ok = true;
                    }
                    if !err_ok {
                        unsafe { SetStdHandle(STD_ERROR_HANDLE, h) };
                        err_ok = true;
                    }
                }
            }
        }

        OUT_OK.store(out_ok, Ordering::Relaxed);
        ERR_OK.store(err_ok, Ordering::Relaxed);

        // 控制台输出代码页 → UTF-8：不设的话中文在 GBK 控制台上全是乱码。
        // 输出被重定向时没有控制台，GetConsoleOutputCP 会返回 0，跳过即可。
        let cp = unsafe { GetConsoleOutputCP() };
        if cp != 0 && cp != CP_UTF8 && unsafe { SetConsoleOutputCP(CP_UTF8) } != 0 {
            OLD_CP.store(cp, Ordering::Relaxed);
        }
    }
}

/// 进程启动第一步（main.rs 调用）：Windows 上把标准流接到父进程的控制台。
/// 其它平台什么都不做 —— 命令行里本来就有输出。
pub fn init_console() {
    win_console::attach();
}

/// 退出前把控制台还回去（代码页）。`cli_finish` 会调，`main.rs` 在
/// `--help` / `--version` / 用法报错那几条直接 `process::exit` 的路上也要调。
pub fn restore_console() {
    win_console::restore();
}

/// 起不来时的一句话解释（App 建不出来时用；原因通常是没有 WebView 运行时 / 没有图形环境）。
///
/// 注意：Tauri 在**建窗口**失败时是自己 `panic!` 的（`app.rs` 里那句 "Failed to setup app"），
/// release 档 `panic = "abort"` 之下接不住，只能让它带着那句英文信息中止 ——
/// 所以这里只负责「`build()` 返回 Err」这条分支，别指望它接管所有启动失败。
pub fn startup_hint() -> String {
    "界面与命令行导出都需要系统里的 WebView 运行时（Windows 是 WebView2，macOS / Linux 用系统自带），\
     命令行导出还要求有能创建窗口的图形环境。没有这些条件时请改用：node tools/cli.js <抓包> --csv"
        .to_string()
}

/* ═══════════════════════ 主线程要的两件小事 ═══════════════════════ */

/// 界面模式启动时把「隐藏窗口」亮出来；命令行模式保持隐藏。
///
/// 窗口在 `tauri.conf.json` 里配成 `visible: false`：先建好、再决定显不显示，
/// 这样命令行导出全程不会有窗口闪一下，界面模式也只是晚几十毫秒出现（少了一次白屏）。
pub fn reveal_window(app: &AppHandle) {
    if active() {
        return;
    }
    let Some(win) = tauri::Manager::get_webview_window(app, "main") else {
        // 窗口是 tauri.conf.json 里配的，找不到说明配置被改坏了 —— 别静默
        say_err("[PDScope] 找不到主窗口（tauri.conf.json 的 app.windows 里应该有 label=main）");
        return;
    };
    // 失败别再吞掉：双击后「什么都没发生」是最难排查的一种现象
    if let Err(e) = win.show() {
        say_err(&format!("[PDScope] 显示窗口失败：{e}"));
    }
    let _ = win.set_focus();
}

/// 命令行模式：给 WebView2 补上「别因为窗口不可见就降级」的开关。
///
/// 解码过程让出主线程走的是 MessageChannel（不是定时器，见 `src/js/core/bmc.js` 的实测），
/// 所以隐藏窗口里本来就能跑；这几个开关是保险 —— 万一某版 WebView2 把不可见窗口的
/// 定时器/渲染一起降级，命令行导出就会莫名其妙地变慢。
///
/// 变量是**追加**而不是覆盖：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 已经被设过时
/// （tools/tauri-e2e.mjs 就是靠它开调试端口的）要原样保留。
pub fn tune_webview2() {
    #[cfg(windows)]
    {
        if !active() {
            return;
        }
        let extra = "--disable-background-timer-throttling --disable-backgrounding-occluded-windows \
                     --disable-renderer-backgrounding";
        let cur = std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap_or_default();
        let mut val = cur.trim().to_string();
        for flag in extra.split_whitespace() {
            if !val.contains(flag) {
                if !val.is_empty() {
                    val.push(' ');
                }
                val.push_str(flag);
            }
        }
        // wry 自己会给 WebView2 设一份默认参数；用这个环境变量顶上时得把默认那几条带上，
        // 否则会顺手把关掉 Edge 自带 UI 的开关一起丢了
        if !val.contains("--disable-features") {
            val.push_str(" --disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection");
        }
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", val);
    }
}

/* ═══════════════════════ 单元测试 ═══════════════════════ */

/// 命令行这一层不依赖窗口，可以直接 `cargo test` 跑 —— 这条自检的意义在于：
/// 真正跑一遍 `--csv` 需要系统里的 WebView 运行时（沙箱 / CI 里往往没有），
/// 而**参数解析与分块落盘**是纯逻辑，出了问题不该等到有图形环境才发现。
///
/// 注意：`RUN` 是进程级全局状态，所以凡是碰它的断言都塞进同一个测试里（测试默认并行跑）。
#[cfg(test)]
mod tests {
    use super::*;

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    /// 测试用的临时目录：放在 `target/` 下，**刻意不碰 `%TEMP%`**。
    ///
    /// 为什么不用 `std::env::temp_dir()`：企业策略 / 受限环境里 TEMP 未必可写
    /// （本机实测：同一路径 pwsh 能写，cargo 起的测试进程却被拒 os error 5），
    /// 而 `target/` 一定可写 —— 编译本来就在往里写。`target/` 也在 .gitignore 里。
    fn ut_dir() -> PathBuf {
        let d = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("ut-tmp");
        std::fs::create_dir_all(&d).expect("建测试临时目录");
        d
    }

    /// 造一个真的抓包文件（`parse` 会检查它存在）：只用到扩展名，内容无所谓
    fn temp_capture(tag: &str) -> PathBuf {
        let p = ut_dir().join(format!("pdscope-ut-{tag}.atkcc"));
        std::fs::write(&p, b"not a real capture").expect("写临时文件");
        p
    }

    fn as_export(a: Action) -> Request {
        match a {
            Action::Export(r) => r,
            _ => panic!("期望是导出请求"),
        }
    }

    #[test]
    fn no_flags_means_gui() {
        // 不带任何导出开关 = 老样子开界面（双击 .atkcc / 拖到 exe 图标上都是这条路）
        assert!(matches!(parse(&args(&["a.atkcc"])).unwrap(), Action::None));
        assert!(matches!(parse(&args(&[])).unwrap(), Action::None));
        assert!(matches!(parse(&args(&["a.atkcc", "b.sqlite"])).unwrap(), Action::None));
    }

    #[test]
    fn export_only_flags_need_csv() {
        // --channel/--limit/--bom 单拎出来没有意义，宁可报错也别装作没看见
        for bad in [vec!["a.atkcc", "--channel", "1"], vec!["a.atkcc", "--limit", "5"], vec!["a.atkcc", "--bom"]] {
            assert!(parse(&args(&bad)).is_err(), "{bad:?} 应该报错");
        }
    }

    #[test]
    fn parse_errors() {
        assert!(parse(&args(&["--csv"])).is_err(), "--csv 没给输入文件");
        assert!(parse(&args(&["--csv", "--limit", "abc", "a.atkcc"])).is_err(), "--limit 不是数字");
        assert!(parse(&args(&["a.atkcc", "--csv", "--channel", "x"])).is_err(), "--channel 不是数字");
        assert!(parse(&args(&["a.atkcc", "--csv", "--wat"])).is_err(), "不认识的选项");
    }

    #[test]
    fn parse_help_and_version_win() {
        assert!(matches!(parse(&args(&["--help"])).unwrap(), Action::Help));
        assert!(matches!(parse(&args(&["-h"])).unwrap(), Action::Help));
        assert!(matches!(parse(&args(&["--version"])).unwrap(), Action::Version));
        // 帮助优先于导出：`--csv --help` 也该给帮助
        assert!(matches!(parse(&args(&["--csv", "--help"])).unwrap(), Action::Help));
    }

    #[test]
    fn parse_output_forms() {
        let cap = temp_capture("forms");
        let cap_s = cap.to_string_lossy().into_owned();

        // ① 不给输出 → Auto（默认名由页面按 <主干>-ch<通道>.csv 算）
        assert!(matches!(as_export(parse(&args(&[&cap_s, "--csv"])).unwrap()).out, Out::Auto));
        // ② 紧跟其后的路径
        match as_export(parse(&args(&[&cap_s, "--csv", "out.csv"])).unwrap()).out {
            Out::File(p) => assert_eq!(p, PathBuf::from("out.csv")),
            other => panic!("期望 File，得到 {other:?}"),
        }
        // ③ --out / --out= / --csv= 三种写法等价
        for form in [vec![&cap_s, "--csv", "--out", "o.csv"], vec![&cap_s, "--csv=o.csv"], vec![&cap_s, "--csv", "--out=o.csv"]] {
            match as_export(parse(&args(&form)).unwrap()).out {
                Out::File(p) => assert_eq!(p, PathBuf::from("o.csv"), "{form:?}"),
                other => panic!("{form:?} 期望 File，得到 {other:?}"),
            }
        }
        // ④ `-` 是标准输出（`--csv -` 与 `--out -` 同义）
        assert!(matches!(as_export(parse(&args(&[&cap_s, "--csv", "-"])).unwrap()).out, Out::Stdout));
        assert!(matches!(as_export(parse(&args(&[&cap_s, "--csv", "--out", "-"])).unwrap()).out, Out::Stdout));
        // ⑤ 开关写在抓包前面的写法：`--csv 抓包.atkcc 出.csv`
        let r = as_export(parse(&args(&["--csv", &cap_s, "out2.csv"])).unwrap());
        assert_eq!(r.input, cap);
        assert!(matches!(r.out, Out::File(p) if p == PathBuf::from("out2.csv")));

        let _ = std::fs::remove_file(&cap);
    }

    #[test]
    fn parse_limit_channel_bom() {
        let cap = temp_capture("lcb");
        let cap_s = cap.to_string_lossy().into_owned();
        let r = as_export(parse(&args(&[&cap_s, "--csv", "--limit", "7", "--channel", "3", "--no-bom"])).unwrap());
        assert_eq!(r.limit, 7);
        assert_eq!(r.channel, Some(3));
        assert_eq!(r.bom, Some(false));
        // 不给 --bom 时是「自动」，由 want_bom 按出口决定
        let r2 = as_export(parse(&args(&[&cap_s, "--csv"])).unwrap());
        assert_eq!(r2.bom, None);
        assert_eq!(r2.limit, 0);
        let _ = std::fs::remove_file(&cap);
    }

    #[test]
    fn bom_policy() {
        let req = |out: Out, bom: Option<bool>| Request {
            input: PathBuf::from("x.atkcc"),
            out,
            channel: None,
            limit: 0,
            bom,
        };
        // 落盘一律带 BOM（Excel 双击能用）；显式开关优先
        assert!(want_bom(&req(Out::Auto, None)));
        assert!(want_bom(&req(Out::File(PathBuf::from("o.csv")), None)));
        assert!(!want_bom(&req(Out::File(PathBuf::from("o.csv")), Some(false))));
        assert!(want_bom(&req(Out::Stdout, Some(true))));
        // Stdout 且没指定：看句柄是文件还是管道（测试进程里是管道 → 不带）
        assert_eq!(want_bom(&req(Out::Stdout, None)), stdout_is_file());
    }

    #[test]
    fn help_text_covers_encoding_and_flags() {
        let h = help_text();
        for needle in ["--csv", "--out", "--channel", "--limit", "--bom", "--no-bom", "UTF-8", "BOM", "退出码"] {
            assert!(h.contains(needle), "帮助里缺少 {needle}");
        }
        assert!(version_text().contains("PDScope"));
    }

    /// 分块落盘：块序、拼接结果、默认输出名 —— 这几条只有跑一遍才知道
    #[test]
    fn write_chunks_to_file() {
        let cap = temp_capture("chunks");
        let out = ut_dir().join("chunks-out.csv");
        let _ = std::fs::remove_file(&out);
        begin(Request {
            input: cap.clone(),
            out: Out::File(out.clone()),
            channel: Some(0),
            limit: 0,
            bom: None,
        });
        assert!(active());

        // 第一块：表头；第二块：两行数据。CRLF 由页面切好，这里只管照着写
        cli_write(0, "whatever.csv".into(), "\u{FEFF}\"#\",\"SOP\"\r\n".into()).expect("第一块");
        cli_write(1, "whatever.csv".into(), "\"0\",\"SOP\"\r\n\"1\",\"SOP\"".into()).expect("第二块");
        // 乱序必须报错（不然会拼出一份错位的 CSV）
        assert!(cli_write(5, "x.csv".into(), "乱序".into()).is_err());

        let got = std::fs::read(&out).expect("读回产物");
        assert_eq!(String::from_utf8(got).unwrap(), "\u{FEFF}\"#\",\"SOP\"\r\n\"0\",\"SOP\"\r\n\"1\",\"SOP\"");
        // 头部 BOM 落成 UTF-8 的 EF BB BF —— Excel 认的就是这三个字节
        let raw = std::fs::read(&out).unwrap();
        assert_eq!(&raw[0..3], &[0xEF, 0xBB, 0xBF]);

        // Auto：文件名用页面给的建议名（`<主干>-ch<通道>.csv`），落在输入同目录
        let auto_out = cap.parent().unwrap().join("pdscope-ut-auto-ch2.csv");
        let _ = std::fs::remove_file(&auto_out);
        let mut g = RUN.lock().unwrap();
        let run = g.as_mut().unwrap();
        run.req.out = Out::Auto;
        run.sink = None;
        run.next_seq = 0;
        drop(g);
        cli_write(0, "pdscope-ut-auto-ch2.csv".into(), "x".into()).expect("Auto 落盘");
        assert!(auto_out.exists(), "Auto 模式应该落在输入同目录，文件名用页面给的建议名");

        // 收尾：把状态清掉，别影响其它测试
        *RUN.lock().unwrap() = None;
        let _ = std::fs::remove_file(&cap);
        let _ = std::fs::remove_file(&out);
        let _ = std::fs::remove_file(&auto_out);
    }
}
