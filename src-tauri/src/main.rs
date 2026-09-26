// Windows release 构建下不额外弹出控制台窗口
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! PDScope 的 Tauri 外壳 —— Windows / macOS / Linux 共用这一份代码。
//!
//! 设计取舍：解析与界面 100% 跑在前端（`dist/PDScope.html`），Rust 侧刻意保持极薄，
//! 只做四件事：
//!   1. 开一个原生窗口
//!   2. 挂一份中文原生菜单，把菜单项翻译成页面里的 DOM 操作
//!   3. 原生「关于」对话框
//!   4. 把命令行的 / 文件关联带上来的 `.atkcc` 交给页面
//!
//! 这样换取两个好处：
//!   · 前端零改动即可复用（浏览器里怎么跑，桌面版就怎么跑）——
//!     页面里没有一行 `__TAURI__` 调用，所有与外壳的交互都收敛到
//!     `src/ui/app.js` 末尾「外壳桥」一节的 `pdscopeOpenBytes / pdscopeOpenUrl`。
//!   · 不打包浏览器内核 —— Windows 用系统 WebView2、macOS 用 WKWebView、
//!     Linux 用 WebKitGTK，成品只有几 MB，而不是上百 MB。

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

/// 页面里本来就有这些元素，菜单只需「替用户点一下」，避免前端维护两套入口。
const JS_OPEN: &str = "document.querySelector('#fileInput')?.click();";
const JS_RELOAD: &str = "location.reload();";
const JS_EXPORT: &str = "document.querySelector('#btnExport')?.click();";
const JS_SEARCH: &str = "document.querySelector('#fSearch')?.focus();";
const JS_THEME: &str = "document.querySelector('#btnTheme')?.click();";
const JS_SIDE: &str = "document.querySelector('#btnToggleSide')?.click();";
const JS_DENSE: &str = "document.querySelector('#btnDense')?.click();";

/// 启动时命令行带上来的抓包文件先寄存在这里，等页面加载完再推。
///
/// 为什么不直接在 `setup` 里喂给页面：那时 WebView 还没开始加载这个文档，
/// `eval` 注入的脚本会落在错误的宿主文档里，静默丢失。等 `PageLoadEvent::Finished`
/// 是唯一有保证的时机。
static PENDING: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 把「用 PDScope 打开某个抓包」这件事翻译成一段注入脚本。
///
/// 脚本自己会等 `window.PDScope.ready`（见 src/ui/app.js 末尾），因此不依赖任何时序假设；
/// 拿到就绪信号后用 IPC 取文件字节，再交给页面的外壳桥。
/// 走 IPC 而不是让页面直接读路径：浏览器安全模型不允许页面读任意本地路径，
/// 而且这样前端对「文件从哪来」完全无感。
const JS_PUSH_FILE: &str = r#"
(function () {
  var name = __NAME__, path = __PATH__, tries = 0;
  (function wait() {
    if (window.PDScope && window.PDScope.ready) {
      window.__TAURI__.core
        .invoke('read_capture', { path: path })
        .then(function (bytes) { return window.pdscopeOpenBytes(name, bytes); })
        .catch(function (e) { console.error('[PDScope] 打开抓包失败：' + e); });
      return;
    }
    if (++tries < 400) setTimeout(wait, 25);   // 最多等 10 秒
  })();
})();
"#;

/// 把任意字符串安全地嵌进 JS 字符串字面量。
/// Windows 路径含反斜杠、中文文件名含非 ASCII，都不能直接拼。
fn js_str(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' => out.push_str("\\u2028"),   // JS 里算换行符，必须转义
            '\u{2029}' => out.push_str("\\u2029"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

fn push_file_js(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "capture.atkcc".to_string());
    let full = path.to_string_lossy().into_owned();
    JS_PUSH_FILE
        .replace("__NAME__", &js_str(&name))
        .replace("__PATH__", &js_str(&full))
}

fn eval_in_main(app: &AppHandle, js: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(js);
    }
}

/// 从命令行参数里挑出要打开的抓包文件。
///
/// 三种启动方式都落在这里：`PDScope.exe D:\抓包\绿联70w.atkcc`、
/// 双击关联的 `.atkcc`（Windows/Linux），以及把文件拖到 exe 图标上。
/// macOS 双击文件走的是 `RunEvent::Opened` 而不是命令行参数，见 `main()` 末尾。
fn capture_from_args() -> Option<PathBuf> {
    let args: Vec<PathBuf> = std::env::args_os().skip(1).map(PathBuf::from).collect();
    // 优先认后缀，避免把 `--xxx` 之类的开关当成文件
    args.iter()
        .find(|p| {
            p.extension()
                .is_some_and(|e| e.eq_ignore_ascii_case(OsStr::new("atkcc")))
        })
        .cloned()
        // 后缀不匹配时退一步：第一个真实存在的文件也认（用户可能改了扩展名）
        .or_else(|| args.iter().find(|p| p.is_file()).cloned())
}

/// 读取抓包文件字节，交给页面。
///
/// 只由本应用自己注入的脚本调用；页面加载的全是随包发布的本地资源，
/// 没有远程内容，所以这里不做路径白名单 —— 用户本来就该能打开任意位置的抓包。
#[tauri::command]
fn read_capture(path: String) -> Result<tauri::ipc::Response, String> {
    std::fs::read(&path)
        .map(tauri::ipc::Response::new)   // 原始字节直传，不做 base64，几十 MB 也不虚
        .map_err(|e| format!("{path}：{e}"))
}

fn build_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    // ── 文件 ────────────────────────────────────────────────
    let i_open = MenuItem::with_id(app, "open", "打开抓包…", true, Some("CmdOrCtrl+O"))?;
    let i_reload = MenuItem::with_id(app, "reload", "关闭抓包", true, Some("CmdOrCtrl+W"))?;
    let i_export = MenuItem::with_id(app, "export", "另存为（当前筛选）", true, Some("CmdOrCtrl+S"))?;
    let f_sep1 = PredefinedMenuItem::separator(app)?;
    let f_sep2 = PredefinedMenuItem::separator(app)?;
    let i_quit = PredefinedMenuItem::quit(app, Some("退出"))?;
    let file = Submenu::with_items(
        app,
        "文件",
        true,
        &[&i_open, &i_reload, &f_sep1, &i_export, &f_sep2, &i_quit],
    )?;

    // ── 查看 ────────────────────────────────────────────────
    let i_search = MenuItem::with_id(app, "search", "搜索报文", true, Some("CmdOrCtrl+F"))?;
    let i_theme = MenuItem::with_id(app, "theme", "切换主题", true, Some("CmdOrCtrl+T"))?;
    let i_side = MenuItem::with_id(app, "side", "折叠 / 展开筛选栏", true, Some("CmdOrCtrl+B"))?;
    let i_dense = MenuItem::with_id(app, "dense", "紧凑 / 舒适行高", true, None::<&str>)?;
    let v_sep1 = PredefinedMenuItem::separator(app)?;
    let v_sep2 = PredefinedMenuItem::separator(app)?;
    let i_full = MenuItem::with_id(app, "fullscreen", "全屏", true, Some("F11"))?;
    let i_dev = MenuItem::with_id(app, "devtools", "开发者工具", true, Some("F12"))?;
    let view = Submenu::with_items(
        app,
        "查看",
        true,
        &[&i_search, &i_theme, &i_side, &i_dense, &v_sep1, &i_full, &v_sep2, &i_dev],
    )?;

    // ── 帮助 ────────────────────────────────────────────────
    let i_about = MenuItem::with_id(app, "about", "关于 PDScope", true, None::<&str>)?;
    let help = Submenu::with_items(app, "帮助", true, &[&i_about])?;

    Menu::with_items(app, &[&file, &view, &help])
}

fn on_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => eval_in_main(app, JS_OPEN),
        "reload" => eval_in_main(app, JS_RELOAD),
        "export" => eval_in_main(app, JS_EXPORT),
        "search" => eval_in_main(app, JS_SEARCH),
        "theme" => eval_in_main(app, JS_THEME),
        "side" => eval_in_main(app, JS_SIDE),
        "dense" => eval_in_main(app, JS_DENSE),
        "fullscreen" => {
            if let Some(win) = app.get_webview_window("main") {
                let cur = win.is_fullscreen().unwrap_or(false);
                let _ = win.set_fullscreen(!cur);
            }
        }
        "devtools" => {
            if let Some(win) = app.get_webview_window("main") {
                win.open_devtools();
            }
        }
        "about" => show_about(app),
        _ => {}
    }
}

fn show_about(app: &AppHandle) {
    let body = format!(
        "USB Power Delivery 抓包解析上位机\n\n\
         直接解析正点原子 ATK-C 的 .atkcc 抓包文件：\n\
         · 1 bit/采样 LSB 优先 → BMC → 4B5B → PD 报文\n\
         · Source / Sink / 线缆方向自动区分\n\
         · 按方向 / SOP / 报文类型 / 时间窗口筛选屏蔽\n\
         · Source_Cap、Request、PPS、AVS、VDM、扩展报文逐字段溯源\n\n\
         版本 {}  ·  Tauri {}  ·  {}",
        env!("CARGO_PKG_VERSION"),
        tauri::VERSION,
        std::env::consts::OS,
    );
    app.dialog()
        .message(body)
        .title("关于 PDScope")
        .kind(MessageDialogKind::Info)
        .show(|_| {});
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_capture])
        .setup(|app| {
            let handle = app.handle().clone();
            let menu = build_menu(&handle)?;
            handle.set_menu(menu)?;

            // 命令行带了抓包就先寄存，等页面加载完由 on_page_load 推过去
            if let Some(path) = capture_from_args() {
                if let Ok(mut slot) = PENDING.lock() {
                    *slot = Some(path);
                }
            }
            Ok(())
        })
        .on_page_load(|webview, payload| {
            // Started 时文档还没有，注入会被丢掉；Finished 才是能安全 eval 的时机
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            let pending = PENDING.lock().ok().and_then(|mut slot| slot.take());
            if let Some(path) = pending {
                let _ = webview.eval(push_file_js(&path));
            }
        })
        .on_menu_event(|app, event| {
            let id: &str = event.id().as_ref();
            on_menu(app, id);
        })
        .build(tauri::generate_context!())
        .expect("PDScope 启动失败");

    app.run(|_handle, event| {
        // macOS 上「用 PDScope 打开」走的是 Apple Event，不会出现在命令行参数里
        #[cfg(target_os = "macos")]
        {
            if let tauri::RunEvent::Opened { urls } = event {
                for url in urls {
                    match url.to_file_path() {
                        Ok(path) => eval_in_main(_handle, &push_file_js(&path)),
                        Err(_) => eprintln!("[PDScope] 无法识别的文件 URL：{url}"),
                    }
                }
            }
        }
        // 其它平台：命令行参数已在 setup 里寄存，这里无事可做
        #[cfg(not(target_os = "macos"))]
        {
            let _ = event;
        }
    });
}
