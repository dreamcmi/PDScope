# PDScope

**USB Power Delivery 抓包解析上位机**

直接打开抓包文件，把 PD 报文还原出来并逐字段溯源。两种来源都支持，**按文件内容自动分流**：

| 来源 | 文件 | 存的是什么 | 解析路径 |
| ---- | ---- | ---------- | -------- |
| 正点原子 **ATK-C** | `.atkcc` | CC 线的原始电平采样（ZIP + 1bit/采样） | 分块 → 边沿 → BMC → 4B5B → PD 报文 |
| **POWER-Z**（ChargerLAB） | `.sqlite` | 分析仪**已经解好的逻辑字节** + ADC 采样序列 | SQLite 读表 → Raw blob 拆事件 → 同一套 PD 语义解析 |
| **POWER-Z**（录制 UFCS） | `.sqlite` | 同上，但录的是 **D+/D- 上的 UFCS**（融合快速充电） | SQLite 读表 → 定位 UFCS 帧 → 独立 UFCS 解析库（UART/消息头/CRC-8） |

`.sqlite` 再按表名细分：有 `pd_table` 走 USB PD，有 `ufcs_table` 走 **UFCS（T/TAF 083—2024）
独立解析库**（`src/js/ufcs/`）；两条路径解出来的报文对象**同形**，所以界面、筛选、详情、
时间轴、导出只有「协议相关的那几处」分叉。

一次可以打开**多份**抓包：窗口顶栏下方会出现标签栏，逐份切换。**每份文件各记各的**
筛选条件、时间窗口、选中行与通道号，来回切不串味 —— 拿着两份不同充电器 / 线缆的抓包
对着看时，不必反复关掉再打开。

解析与界面全部在前端完成 —— **零依赖、零网络、不上传任何数据**。

支持 **Windows / macOS / Linux**。

> 本项目由作者主导，**使用 AI 编程助手 DeepSeek V4.1 Flash 辅助开发**，

---

## 目录

* [一份代码，两种交付形态](#一份代码两种交付形态)
* [快速开始](#快速开始)
* [形态一：单文件 HTML 版](#形态一单文件-html-版)
* [形态二：Tauri 桌面版](#形态二tauri-桌面版)
* [形态三：本地服务（开发调试用）](#形态三本地服务开发调试用)
* [CI 构建：](#ci-构建10-个目标一次出齐)
* [界面功能](#界面功能)
* [`.atkcc` 格式（逆向结论）](#atkcc-格式逆向结论)
* [`.sqlite` 格式（POWER-Z 导出）](#sqlite-格式power-z-导出)
* [PD 协议解析库](#pd-协议解析库)
* [UFCS 协议解析库](#ufcs-协议解析库)
* [目录结构](#目录结构)
* [自检](#自检)
* [已知限制](#已知限制)
* [开发说明](#开发说明)
* [附录 A：三种形态能力对照](#附录-a三种形态能力对照)
* [附录 B：环境准备](#附录-b环境准备)

---

## 一份代码，两种交付形态

**同一个 `dist/PDScope.html` 同时供给两种形态**，没有第二份前端代码：

|                | **单文件 HTML 版**              | **Tauri 桌面版**                        |
| -------------- | ------------------------------- | --------------------------------------- |
| 产物           | `dist/PDScope.html`（约 320 KB，自包含） | `pdscope.exe`（约 3.1 MB）              |
| 怎么运行       | 双击，用系统默认浏览器打开      | 双击 exe                                |
| 需要先装什么   | **什么都不用装**                | 系统自带的 WebView 即可，别无其他       |
| 原生菜单       | 无（用页面内快捷键）            | 有（中文菜单 + F11 全屏 / F12 开发者工具） |
| 双击 `.atkcc` 直接打开 | —                       | 装了安装包后支持（文件关联）            |
| 跨平台方式     | 一个文件三平台通吃              | 每个平台各出各的包，代码同一份          |
| 适合场景       | 随手看看、发给别人、临时机器    | 日常使用                                |

形态不是构建期定死的，而是**页面在运行期自己认出来的**（看地址协议 + 有没有 Tauri 注入的全局对象）。
所以外壳可以根本没有，前端也不会坏。识别结果挂在 `window.PDScope.env`，
按 `F12` 打开控制台敲 `PDScope.env` 就能看到。

> **同一份文件在桌面外壳里会不会「串味」？** 不会。差异只有两处，都在 `src/ui/app.js` 的
> `ENV` 里显式判定：桌面版的原生菜单已经接管了 `Ctrl+O`，页面就不再绑一次
> （否则会弹出两个文件对话框）；「载入示例」按钮依赖本地服务接口，没有服务时直接不显示，
> 也不去发那个注定失败的请求。
>
> 反过来，桌面外壳也**没有要求前端配合什么**：`src/ui/` 里找不到一行 `__TAURI__` 调用，
> 外壳与页面的全部接触面就是 `app.js` 末尾「外壳桥」一节暴露的两个函数。

---

## 快速开始

**只想看看效果** → 走形态一，不用装任何东西：

```bash
node tools/build-standalone.mjs         # 生成 dist/PDScope.html
# 双击 dist/PDScope.html，把 .atkcc / .sqlite 拖进窗口（可以一次拖好几份）
```

**想要一个真正的桌面应用** → 走形态二：

```bash
npm install        # 只装 tauri-cli（几 MB），不会下载浏览器内核
npm run app:exe    # 产出 src-tauri/target/release/pdscope.exe
```

---

## 形态一：单文件 HTML 版

`dist/PDScope.html` 是一个**自包含 HTML** —— CSS 与全部 JS 都内联在里面，
不引用任何外部文件、不联网、不需要 Node。

```bash
node tools/build-standalone.mjs
```

### 各平台怎么用

| 平台        | 操作                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------- |
| **Windows** | 双击 `PDScope.html` → 用默认浏览器（通常是 Edge）打开 → 把抓包文件拖进窗口。想固定入口就右键「发送到 → 桌面快捷方式」。 |
| **macOS**   | 双击即可。若默认浏览器是 Safari，需要 **Safari 16.4+**；老系统请右键 →「打开方式」→ Chrome/Edge。 |
| **Linux**   | 双击（部分桌面环境会问用什么程序打开，选浏览器），或终端 `xdg-open dist/PDScope.html`。   |

不管哪个平台，都有两种喂文件的方式：**把抓包文件拖进窗口**，或点界面上的「选择文件」
（快捷键 `Ctrl/⌘+O`）。`.atkcc` 与 `.sqlite` 都认。

两种方式都支持**一次给多份**：拖拽时把多个文件一起拖进窗口，或在文件对话框里多选
（`#fileInput` 带 `multiple`）。每份抓包各占一个标签，先打开的那份自动激活，其余在后台
依次解码 —— 不会因为第二份文件大就把界面卡在第 0 帧。

### 浏览器要求

解压 `.atkcc` 里的 deflate 块用的是标准 `DecompressionStream('deflate-raw')`：

| 浏览器     | 最低版本          |
| ---------- | ----------------- |
| Chrome / Edge | 103（2022-06） |
| Safari     | 16.4（2023-03）   |
| Firefox    | 113（2023-05）    |

2023 年之后的浏览器都满足。桌面版不用操心这个 —— 它用的是系统自带的 WebView，
本机实测 WebView2 154。

---

## 形态二：Tauri 桌面版

外壳刻意做得极薄（`src-tauri/src/main.rs` 约 240 行），只做四件事：
**开原生窗口、挂中文菜单、弹「关于」、「把命令行/文件关联带上来的抓包交给页面」**。
解析与界面 100% 复用前端那一套，所以桌面版和浏览器版表现完全一致。

### 先说清楚：不能一次构建出三个平台

Tauri（和 Electron 一样）**不支持交叉编译**。在哪个系统上打包，就只能出那个系统的产物。

原因在最后一步链接：Windows 要链 WebView2 loader + MSVC 运行库，macOS 要链 WKWebView + Cocoa，
Linux 要链 WebKitGTK + GTK。想要各平台的包，就得在对应架构的系统上各跑一次 ——
本仓库把这件事交给 [CI 矩阵](#ci-构建10-个目标一次出齐)，10 个目标一起出，见下一节。

**但代码本身是跨平台的**：`src-tauri/` 那一份 Rust 在三个平台直接编译，
唯一的平台分支是 —— macOS 通过 `RunEvent::Opened` 接收「用 PDScope 打开」事件，
Windows / Linux 走命令行参数。这个差异已经写在 `main.rs` 里，不需要使用者关心。

### 三条构建命令（在**对应平台**上执行）

```bash
npm install             # 只装 @tauri-apps/cli
npm run app             # 开发模式：开原生窗口，改前端即时生效
npm run app:exe         # 只出可执行文件，跳过安装包（最快，完全离线）
npm run app:build       # 出当前平台的全部安装包
```

| 平台        | 只出可执行文件        | 出安装包             | 安装包产物                                          |
| ----------- | --------------------- | -------------------- | --------------------------------------------------- |
| **Windows** | `npm run app:exe`     | `npm run app:win`    | `bundle/nsis/PDScope_0.2.0_x64-setup.exe`（NSIS）<br>`npm run app:build` 还多出 `bundle/msi/PDScope_0.2.0_x64_zh-CN.msi` |
| **macOS**   | `npm run app:exe`     | `npm run app:mac`    | `bundle/dmg/PDScope_0.2.0_x64.dmg` + `bundle/macos/PDScope.app` |
| **Linux**   | `npm run app:exe`     | `npm run app:linux`  | `bundle/appimage/PDScope_0.2.0_amd64.AppImage` + `bundle/deb/PDScope_0.2.0_amd64.deb` |

产物在 `src-tauri/target/<三元组>/release/` 下 —— **显式传 `--target` 时路径里会多一层三元组目录**，
不传才是 `target/release/`。三个平台的依赖见[附录 B](#附录-b环境准备)。

> **`app:exe` 产出的那个可执行文件就是绿色版**：拷到任何同架构的机器上双击即用，
> 不安装、不写注册表（Windows 上需要系统有 WebView2 运行时）。`app:build` 才是「绿色版 + 安装包」。
> CI 会把绿色版单独压成 `PDScope-<目标>-portable.zip` 供下载。

> **MSI 的码页跟着语言走，这一项不能省。** `tauri.conf.json` 里配了
> `bundle.windows.wix.language: "zh-CN"`：MSI 数据库默认是 1252（en-US）码页，而本项目的
> 文件关联描述是中文，不改这一项 `light.exe` 会以 `LGHT0311`（字符串含码页外字符）直接拒绝出包。
> 所以 MSI 文件名带 `_zh-CN` 后缀，安装界面也是中文的。

> **安装包需要联网一次，可执行文件不需要。** `--no-bundle`（即 `app:exe`）只用本机已有的编译器，
> 完全离线；打安装包时 Tauri 会去 GitHub Releases 下载打包辅助程序（NSIS、WiX、appimage 工具，
> 下载完校验哈希）。不想在本机装这一堆、或者要别的平台的包，交给
> [CI](#ci-构建10-个目标一次出齐)。

### 怎么打开一个抓包文件

四种方式，任选（`.atkcc` 与 POWER-Z 的 `.sqlite` 都可以）：

1. **菜单**：文件 → 打开抓包…（`Ctrl/⌘+O`）
2. **拖拽**：把抓包文件拖进窗口（`dragDropEnabled: false` 就是为这个设的 ——
   否则 Tauri 会吞掉 HTML5 拖放事件）
3. **命令行**：
   ```bash
   pdscope.exe "D:\抓包\绿联70w.atkcc"
   pdscope.exe "D:\抓包\山泽60w.sqlite"
   ```
4. **拖到 exe 图标上**，或装了安装包后**双击 `.atkcc`**（`tauri.conf.json` 里声明了 `.atkcc` 文件关联；
   `.sqlite` 是通用扩展名，没有抢来当关联，走前三种方式即可）

第 3、4 种走的是同一条路：外壳读文件字节 → 通过 IPC 交给页面 → 页面交给解析内核。
为什么绕这一圈？因为浏览器的安全模型不允许页面读任意本地路径；这样前端对「文件从哪来」完全无感，
换成单文件版后照样能跑。**格式判定也在页面里做**（看文件内容，不看扩展名），
所以外壳不需要知道这次打开的是哪一种抓包。

**每次都新开一个标签**，不会顶掉已经打开的那份 —— 上面四种方式可以反复用，想同时看几份就开几次。
（同一份文件重复打开也会各占一个标签：拿到「改动前 / 改动后」两个版本时，正好左右切着对比。）
一次失败不会牵连别的：坏文件只让**它自己**那个标签变红，其它抓包照常可用。

### 多份抓包与标签栏

打开第一份文件后，顶栏下方长出标签栏（`#tabBar`），每份抓包一个标签：

| 标签上的东西 | 含义 |
| ------------ | ---- |
| **状态圆点** | 灰空心=还没解码 · 蓝呼吸=正在解码 · 绿=解码完成 · 黄=有告警（例如采样率声明与波形不符、协议未实现）· 红=这份文件打不开 |
| 文件名       | 太长时中间省略；悬停看完整名与状态文字 |
| 条数徽章     | 该份文件解出的报文条数（未解码时不显示） |
| `×`          | 关掉这一份 |
| 末尾 `+`     | 再打开一份（可多选） |

**怎么操作**

* **切标签**：点标签，或按 `Alt+1` … `Alt+9` 直接跳到第 n 份。
* **关标签**：点 `×`，或**中键**点标签。关掉当前标签后会接管它的邻居（先右后左）。
* **右键标签**：弹出菜单 —— 关闭 / 关闭其它 / 全部关闭。
* 标签栏在**只开着空白页**时整条收起，回到中间的「拖入抓包文件」引导。

**为什么要 lazy 解码**：拖 5 份文件进来时，5 份**同时**解码会互相抢 `S`、抢进度条、
还可能在第一份画出来之前先卡住几秒。所以容器加载（读字节 → 认格式 → 选通道）是每份都立即做的，
真正的报文解码推迟到**该标签第一次被激活**时，并且全部走同一条串行队列 ——
先打开的那份先解，界面立刻可用，其余在后台排队。

**状态是各份自己的**：筛选集合、时间窗口、选中行、通道选择、排序、时间轴档位（电压/电流 ↔ CC 线）
都存在标签对象上，切回来原样还原。只有**行高**和**详情面板宽度**是全局偏好（那是「我怎么看」，
不是「这份数据是什么」），切标签不影响。

> 实现上把原来那个单例状态对象 `S` 保留成「**当前激活标签**」的别名，
> 所以几百处 `S.packets` / `S.filters` 一字未改，多文档是在它外面套了一层。

### 桌面版专属的菜单

| 菜单项                      | 快捷键          | 作用                           |
| --------------------------- | --------------- | ------------------------------ |
| 文件 → 打开抓包…            | `Ctrl/⌘+O`      | 弹系统文件对话框（可多选，每份各开一个标签）|
| 文件 → 关闭当前标签         | `Ctrl/⌘+W`      | 关掉正在看的这一份，邻居接管   |
| 文件 → 关闭全部抓包         | —               | 一次收掉所有标签，回到打开引导页|
| 文件 → 另存为（当前筛选）   | `Ctrl/⌘+S`      | 导出 CSV / JSON                |
| 文件 → 退出                 | —               | 关窗退出                       |
| 查看 → 搜索报文             | `Ctrl/⌘+F`      | 聚焦搜索框                     |
| 查看 → 切换主题             | `Ctrl/⌘+T`      | 明 / 暗                        |
| 查看 → 折叠 / 展开筛选栏    | `Ctrl/⌘+B`      | 收起左侧筛选栏                 |
| 查看 → 紧凑 / 舒适行高      | —               | 切换行高                       |
| 查看 → 全屏                 | `F11`           | 全屏 / 还原                    |
| 查看 → 开发者工具           | `F12`           | 打开 DevTools                  |
| 帮助 → 关于 PDScope         | —               | 版本 / 平台信息                |

> 「关闭当前标签」只动**一个**标签（页面里的 `PDScope.closeActive()`），不再整页 `location.reload()` ——
> 以前那么写会把别的标签一起清掉。只开着一份时两者效果一样，所以纯属行为升级。
> 带修饰键的这几项都交给原生菜单，页面那边主动让位，避免两套入口抢同一个键。

---

## CI 构建：10 个目标一次出齐

`.github/workflows/build.yml` —— **每次提交都自动构建**，一次出齐 10 个平台的成品。

**怎么触发**

| 方式 | 场景 |
| --- | --- |
| 往任意分支 `push`（含合并进主干） | 每次提交都跑；跑完在 Actions 页面底部 **Artifacts** 区按平台下载，保留 30 天 |
| Actions 页面点 **Run workflow** | 不想提交，也要一版包 |
| 推 `v*` 标签 | 发版：除了 Artifacts，再自动建一个**草稿** Release 汇总全部产物 |

```bash
git tag v0.2.0 && git push origin v0.2.0     # 走发版那条路
```

> Artifacts 要登录 GitHub 才能下载。想让任何人都能下，就推个标签，
> 然后去 Releases 页面点一下 **Publish** 把草稿发出去。

**10 个目标怎么落地的**

每个目标都一对一落到一台真实存在的 GitHub runner 镜像上（runner 标签已逐个核对过）。

| 目标 | runner | Rust target | Artifacts 里的归档 | 归档里是什么 |
| --- | --- | --- | --- | --- |
| Windows11-x64 | `windows-2025` | `x86_64-pc-windows-msvc` | `PDScope-windows11-x64.zip`<br>`PDScope-windows11-x64-portable.zip` | 安装包版：NSIS `-setup.exe` + `.msi`<br>绿色版：单个 `PDScope.exe` |
| Windows11-arm64 | `windows-11-arm` | `aarch64-pc-windows-msvc` | `PDScope-windows11-arm64.zip`<br>`PDScope-windows11-arm64-portable.zip` | 安装包版：NSIS `-setup.exe`<br>绿色版：单个 `PDScope.exe` |
| macos15-arm64 | `macos-15` | `aarch64-apple-darwin` | `PDScope-macos15-arm64.tar.gz` | `PDScope.app` + `.dmg` |
| macos15-x64 | `macos-15-intel` | `x86_64-apple-darwin` | `PDScope-macos15-x64.tar.gz` | 同上 |
| macos26-arm64 | `macos-26` | `aarch64-apple-darwin` | `PDScope-macos26-arm64.tar.gz` | 同上 |
| macos26-x64 | `macos-26-intel` | `x86_64-apple-darwin` | `PDScope-macos26-x64.tar.gz` | 同上 |
| ubuntu2404-x64 | `ubuntu-24.04` | `x86_64-unknown-linux-gnu` | `PDScope-ubuntu2404-x64.tar.gz` | `.deb` + `.AppImage` |
| ubuntu2404-arm64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | `PDScope-ubuntu2404-arm64.tar.gz` | 同上 |
| ubuntu2604-x64 | `ubuntu-26.04` | `x86_64-unknown-linux-gnu` | `PDScope-ubuntu2604-x64.tar.gz` | 同上 |
| ubuntu2604-arm64 | `ubuntu-26.04-arm` | `aarch64-unknown-linux-gnu` | `PDScope-ubuntu2604-arm64.tar.gz` | 同上 |

每个归档都配一个同名的 `.sha256`（例如 `PDScope-windows11-x64.zip.sha256`），校验一句就够：
`sha256sum -c PDScope-windows11-x64.zip.sha256`（macOS 用 `shasum -a 256 -c`）。

**为什么 Ubuntu 的归档大一个数量级（167 ~ 180 MB，而 Windows / macOS 只有 3 ~ 4 MB）**

差的不是本程序，是**浏览器内核 —— 也就是 WebView 由谁提供**：

| 平台 | WebView 来源 | 进不进归档 | 归档体积 |
| --- | --- | --- | --- |
| Windows | 系统 **WebView2**（Win10 / 11 基本内置） | 不进 | 2.4 ~ 4 MB |
| macOS | 系统 **WKWebView**（10.15+ 随系统走） | 不进 | 3.4 ~ 3.6 MB |
| Linux | 没有等价的「系统自带且保证存在」的 WebView | **AppImage 必须自带** | 167 ~ 180 MB |

* `.deb` **只有几 MB**：它把 `libwebkit2gtk-4.1-0` 声明成依赖（见 `tauri.conf.json` 的
  `bundle.linux.deb.depends`），装的时候由 `apt` 从系统仓库解决。
* `.AppImage` 是那 **~165 MB**：AppImage 的设计目标就是「不依赖系统包、拷过来就能跑」，
  于是必须把 WebKitGTK 整套塞进 squashfs 镜像 —— `libwebkit2gtk-4.1.so.0` 单个文件就约
  130 MB，再加 glib / libsoup3 / ICU / GStreamer 一串，**未压缩超过 500 MB**。
  Tauri 官方文档也直说 AppImage 会把体积从 2 ~ 6 MB 拉到「70+ MB」，且
  **没有缩小它的办法**（维护者的原话：这是 AppImage 的工作方式，不带全依赖反而更容易出事）。
* 归档里这两份是**装在一起**的，所以下载 167 ~ 180 MB 才有那个几 MB 的 `.deb`。
* `ubuntu2604-*` 比 `ubuntu2404-*` 再大 8 ~ 9 MB：同样是 AppImage，但 26.04 自带的
  WebKitGTK 版本更新、体积也更大。

> CI 每次构建都会在**运行摘要**的「清点各 bundle 体积」一栏列出 `.deb` / `.AppImage`
> 各自的原始体积，想核对直接看那一步的表格。

> **Windows 的绿色版**：`PDScope-windows11-x64-portable.zip` 解压后就是一个 `PDScope.exe`，
> 双击即用、不写注册表、不需要安装。它依赖系统的 **WebView2 运行时**（Win11 与新版 Win10
> 自带）；想要「双击 `.atkcc` 直接打开」的文件关联，就装安装包版。
>
> 机器上确实没有 WebView2 时（LTSC / Server / 精简镜像），绿色版不会自愈：双击后弹一个
> **标题为 `Error`** 的英文提示框，正文指向微软的 WebView2 下载页（链接可点），
> **点掉之后既不出窗口、也不会退出** —— 进程留在任务管理器里（实测 CPU `0:00:00`、
> 内存约 23 MB、stdout/stderr 全空），只能手动结束。这层提示来自 Tauri 的运行时
> （`tauri-runtime-wry` 的 `create_webview`：查不到运行时就 `dialog::error(...)` 再返回错误），
> 而这个失败发生在事件循环内部，程序接着跑的是一个「零窗口」的空循环。
> **安装包版（NSIS / MSI）不受影响** —— 默认的 `downloadBootstrapper` 会在安装时
> 把 WebView2 一并装好（需要联网）。

**为什么没有 Windows 10 的产物**

GitHub 的 Windows runner 一直是 **Windows Server** 系列，从来没有过 Windows 10 的镜像；
`windows-2019` 也已下架，现在只剩 `windows-2022` 和 `windows-2025`。

早先列过一个 `windows10-x64` 目标，用 `windows-2022` 代打，现在**去掉了**：它和
`windows11-x64` 的 Rust target 是同一个 `x86_64-pc-windows-msvc`，产物完全一样、
在 Win10 上能直接跑，重复构建一份一模一样的包没有意义。

所以 **Win10 用 `windows11-x64` 那份即可**（同一份产物，Win10 / Win11 通吃）。
真要按 Windows 版本严格对应，唯一的路是自建 runner 装 Win10 —— 托管 runner 做不到。

**几个刻意的选择**

* **arm64 一律用原生 runner，不做交叉编译。** Windows 上交叉编 `aarch64-pc-windows-msvc`
  需要额外装 VS 的「MSVC v143 ARM64 构建工具」组件，原生 runner 自带；
  Linux 上交叉编 `aarch64` 要自己扛一份多架构的 webkit2gtk，麻烦且容易出错。
  Tauri 官方的 AppImage 文档也建议 ARM 包直接在 ARM 机器上出。
* **macOS 四个目标各用各的机器，不做 universal 双架构合并。** 合并出来的包体积翻倍，
  而四个目标分开下载、各取所需更实用。
* **Windows arm64 只出 NSIS，不出 MSI。** 不是 WiX 不支持 arm64（Tauri 的模板里本来
  就有 arm64 分支），而是手上没有 arm64 机器可验 —— 没验过的产物不塞进矩阵。
  要的话把矩阵里那行的 `bundles` 改成 `nsis,msi` 即可。
* **Windows 额外出一个绿色版。** 构建时 `--bundles` 产出的
  `target/<三元组>/release/pdscope.exe` 本身就是完整可运行的程序（前端已经编进二进制里），
  把它单独压成 `-portable.zip` 就行，不需要额外构建一次。
* **每个目标的产物都先收拢成一个「带目标名」的归档再上传。** 两个原因：
  ① `actions/upload-artifact` 有个官方写明、关不掉的限制「Permission Loss」——
  上传后所有目录变 755、文件变 644，符号链接也不保留；而 macOS 的 `.app` 内部全是
  符号链接与可执行位、Linux 的 `.AppImage` 必须带 `+x`，散着上传会得到一个
  「解压后打不开」的包。`tar` 能把权限和链接原样保住，所以 macOS / Linux 用 `.tar.gz`。
  ② 各目标的出包名是按架构走的（`pdscope.exe`、`PDScope_0.2.0_x64-setup.exe` …），
  x64 与 arm64 之间、不同打包类型之间都可能撞名；而所有产物在 Release 里是平铺的，
  同名文件会互相覆盖且不报错。必须靠「归档名带目标名」区分开。
  Windows 用 `.zip`（没有可执行位这回事，zip 就够，也更合 Windows 用户的习惯）。

**CI 里跑了哪些自检**

```
node tools/version-check.mjs   # 版本号六处一致（外加 README 里的产物名提示项）
node tools/syntax.mjs          # 全量语法检查（自动带上 tools/ 下的新脚本）
node tools/selftest.js         # 协议层合成用例（64 项）
```

这三项**在 10 个目标上各跑一遍** —— 顺带验证了解析内核在 Windows / macOS / Linux
以及 x64 / arm64 上结果一致。`ackcheck.js` 与 `e2e.mjs` 要读仓库上一级的 `.atkcc`
实测样本，而那些文件按 `.gitignore` **不入库**（采样数据，体积大），CI 里没有它们 ——
想跑就在本机 `npm run check`。

**几点要知道的**

* **产物没有签名。** macOS 首次打开要「右键 → 打开」（或
  `xattr -dr com.apple.quarantine PDScope.app`），Windows 会弹 SmartScreen，
  点「仍要运行」即可。要签名就在「构建可执行文件与安装包」那步补 `env`
  （workflow 里留了注释掉的完整写法；注意别塞空值 —— Tauri 见到空字符串的
  `APPLE_CERTIFICATE` 会当成「有证书」去解析，反而直接报错）。
* **glibc 下限跟着构建机走。** 在哪个 Ubuntu 上编，产物的 glibc 下限就是那个版本：
  `ubuntu2404-*` 要 glibc ≥ 2.39，`ubuntu2604-*` 要 ≥ 2.42。
  **要发给老系统就用 2404 那份**，26.04 那份不要在 24.04 及更老的系统上跑
  （会报 `GLIBC_2.42 not found`）。
* **国内网络不用管。** 仓库里的 `src-tauri/.cargo/config.toml` 是给国内开发机用的
  USTC 镜像，而 runner 在海外，走官方源更快更稳，所以 CI 会先把这个文件删掉。
  如果哪天换成自建 runner 且在国内，把「切回 crates.io 官方源」那步删掉或加个
  `if` 即可。
* **arm64 runner 公开仓库和私有仓库都能用**（私有仓库自 2026 年 1 月起支持标准
  arm64 runner，只是 vCPU 从 4 降到 2）。用不了的话，把那几行的 `os` 换掉即可。
* **第一次跑会比较慢**（每个目标都要把 Tauri 的几百个 crate 从零编一遍，macOS 的
  3 核 M1 尤其慢），之后有 `Swatinem/rust-cache` 缓存会快很多。
  缓存只在默认分支上回写，避免 10 个目标把仓库 10 GB 的配额挤爆。

---

## 形态三：本地服务（开发调试用）

```bash
node tools/serve.mjs        # 默认 http://127.0.0.1:5188，会自动开浏览器
```

与前两种的唯一区别：多一个「**载入示例**」按钮 —— 它会扫描 `PDScope/` 和它上一级目录里的
所有 `.atkcc` / `.sqlite`，一键载入（默认挑体积最小的那份）。这个按钮依赖 `serve.mjs` 提供的
`api/samples` 接口，所以另外两种形态下它不显示。

改界面时用这个形态最舒服：浏览器里刷新即可，不用重新打包。

---

## 界面功能

| 能力                | 说明                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| **两种来源自动分流** | 打开文件只看**内容**（SQLite 魔数 + `pd_table` / `ufcs_table` 表名；ZIP 魔数）不看扩展名，`.atkcc` / `.sqlite` 拖进来都能解。顶栏「来源」chip 明示本份数据出自哪种设备 |
| **多份抓包 · 标签栏** | 拖拽 / 文件对话框都能一次给多份，每份占一个标签。标签带状态圆点（灰未解码 / 蓝呼吸解码中 / 绿完成 / 黄有告警 / 红打不开）与报文条数徽章；点选或 `Alt+1`…`Alt+9` 切换，`×` / 中键 / 右键菜单关闭（关闭 / 关闭其它 / 全部关闭）。**每份的筛选、时间窗口、选中行、通道、时间轴档位各自独立**，切回来原样还原；容器加载立即做，报文解码推迟到标签首次激活并走串行队列，拖一批进来不会被某一份大文件拖住 |
| **报文表**          | `# / SOP / 报文类型 / ID / 方向 / Obj / 时间 / VBUS-IBUS / 数据hex / 解析详情`，虚拟滚动，几万条也不卡 |
| **采样率来源标注**  | 顶栏显示实际采用的采样率并标出来源：`文件声明` / `波形实测` / `默认值`。声明与波形不一致时改按实测解码，并弹出提示；鼠标悬停可见 `channel.ini` 原文或原因。分析仪导出只有毫秒时间戳（`1.00 kHz`，标 `分析仪时间戳`），量级不同也能读 |
| **方向区分**        | `Source`（供电方）/ `Sink`（受电方）/ `Plug`（线缆 e-marker）三色徽章；PD 标注 `SOP / SOP′ / SOP″`，UFCS 标注物理链路 `D+ / D- / D±`（供电设备 D+ 为 TX、充电设备 D- 为 TX）。UFCS 的消息头里只有**接收方**地址，发送方按「规范单向命令表 → 容器链路字节 → 接收方地址」三级还原，纯推断出来的会在详情里写明「推断」 |
| **GOOD CRC 配对同色** | 每条 `GOOD CRC` 自动取「它所确认的那条报文」的颜色，而不是笼统的控制色。配对依据：GoodCRC 是对报文的即时应答（实测恒为紧邻 1 条），并用 PD 规范要求的 *MessageID 相同* 交叉校验；被确认报文本身是坏包时退化为纯邻近匹配。悬停报文类型可见 `确认 #N · 类型`，详情面板「链路概览」里也有「确认的报文」一栏 |
| **选择性屏蔽**      | 按方向、SOP 类型、报文类别（控制/数据/扩展/VDM/异常）、**具体报文类型**（多选，带计数）、时间窗口、关键字任意组合过滤 |
| **快捷过滤**        | 一键屏蔽 GOOD CRC 心跳包 / 只看 CRC 错误 / 只看功率协商 / 只看状态切换                        |
| **CRC 错误标注**    | 校验未通过的报文在表格里整行标红，并在时间轴对应位置画一条贯穿的高亮竖线；配合「只看 CRC 错误」可一键筛出来。分析仪导出**可能没存 CRC**（PD 的 `pd_table` 一律不存），此时统计行写「**CRC 未记录（分析仪不存）**」而不是「全通过」，详情面板也单列一行说明。UFCS 存不存 CRC 由容器定位阶段判定：存了就照实给「通过 / 失败」，没存才写「未记录」 |
| **时间窗口**        | 底部 VBUS/IBUS 时间轴可**拖拽刷选**一段区间，表格立即联动                                     |
| **两档模拟量视图**  | 分析仪导出除了 VBUS / IBUS 还录了第三、第四路模拟量（POWER-Z 的 **CC1 / CC2**，UFCS 的 **DP / DM**）。量程与 VBUS 差一个数量级，叠在一起会糊，所以做成标题旁的 `电压/电流 ↔ 差分线` 两档切换（档名跟着文件走：PD 显示「CC 线」、UFCS 显示「DP / DM」）：纵轴刻度、悬停读数、曲线配色全部跟着换。ATK-C 的 `bus.ini` 只有两路，这一档自动隐藏 |
| **插拔事件**        | 分析仪会把 DFP/UFP 的插入 / 拔出记成独立事件（ATK-C 只存波形，看不到这个）。顶栏「插拔」chip 给出计数 |
| **位域详情**        | 右侧面板逐位展开报文头（B15 扩展 / B14-12 对象数 / B11-9 MsgID / B8 PowerRole / B7-6 Rev / B5 DataRole / B4-0 类型）、扩展头、每个数据对象（PDO/RDO/VDM）的全部字段。分析仪来源的报文会在标题旁标「分析仪逻辑字节」，并把「实测码率」改称「BMC 码率」、「报文时长」改称「线上时长」—— 那是按 600 kbps 标称时钟折算的，不是量出来的 |
| **分组配色**        | 每个数据对象（VDO / PDO / RDO / 扩展消息的数据块）单独成组，**相邻分组换色相**（8 色循环）并带左侧色条；`Source_Capabilities` 这种七八个 PDO 的长报文，不用读标题也能一眼看出边界。分组标题**滚动吸顶**，长列表翻到哪都知道自己在看第几个对象 |
| **详情宽度可拖 / 可收起** | 详情面板与表格之间的分隔条可**拖拽改宽**（下限 280 / 上限 900，且始终给中间表格留 420px，窄窗口下自动收紧），双击分隔条或按 `Enter` 回到 390 默认；也可聚焦分隔条后用 `← →` 微调（`Shift` 加大步长，`Home/End` 到最窄/最宽）。宽度存 `localStorage`，下次打开还在。按 `Esc` 或点右上 `×` 收起，**收起后窗口右缘出现一条 22px 的「详情」竖栏**，点它就能展开 —— 没有报文可点时（一行也没定位出报文的抓包）也回得来 |
| **UFCS 融合快充解析** | POWER-Z 录的 UFCS（`ufcs_table`）走**独立解析库**：UART 起止位 → 消息头四段位域（设备地址 / 消息编号 / 协议版本 / 消息类型）→ 控制 / 数据 / 厂家自定义三类消息 → **CRC-8（多项式 0x29，初值 0x00）**。17 条控制命令、14 条数据命令逐字段展开（`Output_Capabilities` 的每种输出模式、`Request`、`Source / Sink / Cable / Device / Error Information`、`Config_Watchdog`、`Refuse`、`Verify_*`、`Power_Change`、`Sink_Information_Extended`、`Test_Request`…）。方向按「规范单向命令表 → 容器链路字节 → 接收方地址」三级还原，`ACK / NCK` 与被确认报文配对。容器前缀（4B 时间戳 / 再带一个链路字节）与「存不存 CRC」都用消息头合法性 + CRC-8 反证定位，**不假设结构** |
| **认不出的行如实说明** | UFCS 导出里有的行既定位不出报文、也不像插拔事件（容器格式各家实现不一）：界面不装作解析失败，统计行写「已读入 N 行，但没有一行能认出 UFCS 报文」、表格空态换专门话术，模拟量轨迹照常可用 |
| **导出**            | CSV（当前筛选结果）或 JSON（全部报文，含原始位域字段与 `ackOf` 配对序号）                     |
| **其它**            | 明/暗主题、紧凑/舒适行高、上一条/下一条（↑↓）、`/` 聚焦搜索、`Ctrl/⌘+O` 打开、`Alt+1..9` 切标签、`T` 切主题、`G` 切 GOOD CRC 屏蔽、折叠筛选栏 |

界面截图见 `artifacts/e2e-screenshot.png`（跑 `npm run e2e` 时自动生成），
多份抓包时的标签栏见 `artifacts/e2e-multi.png`（`npm run e2e:multi`，一份 `.atkcc` + 一份 `.sqlite`），
POWER-Z 的 `.sqlite` 拖进来后的样子见 `artifacts/e2e-powerz.png`（`npm run e2e:powerz`），
UFCS 抓包解出报文后的样子见 `artifacts/e2e-ufcs.png`（`npm run e2e:ufcs`），
手上没有私有抓包时也能看：`npm run e2e:ufcs:synth` 会现造一份 UFCS 导出再截图到
`artifacts/e2e-ufcs-synth.png`，走的界面路径与上面完全相同，
GOOD CRC 配对同色的效果见 `artifacts/ack-colors.png`，
分组配色见 `artifacts/group-colors-srcap.png`（Source_Cap 七个 PDO）、
`artifacts/group-colors-vdm.png`（线缆 e-Marker 的 VDO 链）、
`artifacts/group-colors-dark.png`（暗色主题），
详情面板拖宽后的样子见 `artifacts/detail-resize-wide.png`，
收起后的右缘「详情」把手见 `artifacts/detail-rail-light.png` 与放大特写 `artifacts/detail-rail-zoom.png`。

---

## `.atkcc` 格式（逆向结论）

已与官方 ATK-C 输出**逐字段比对一致**。`.atkcc` 本质就是一个 **ZIP**（`PK\x03\x04`）：

```
channel.ini            SamplingFrequency=2500      ← 单位 kHz，即数字采样率 2.5 MHz（时标按它换算）
bus.ini                sample=N,vbus=14.651,ibus=1.274   ← 模拟量轨迹，sample 与数字采样同域
0/channel.ini          第 1 行 = 通道组号；第 2 行 = 总采样点数
0/<ch>-<idx>.bin       通道 <ch> 的第 <idx> 块，每块固定 1 MiB（deflate 压缩）
```

位流约定：

* **每个采样点 1 bit，LSB 优先** —— 一个字节里 `bit0` 是时间上**最早**的那个采样。
* `0xFF` = 这 8 个采样点全为高；`0x00` = 全为低（空闲 / 末块尾部补齐）。
* 分块序号按**数值**排序（`0-9` 在 `0-10` 之前）。
* 多通道文件每个通道块数相同，尾部用 `0x00` 补齐，需要按最后一个非零字节裁剪。

解码链：

```
1 bit/采样 ──► 游程/边沿提取 ──► BMC 双相标记码状态机 ──► 4B5B 符号 ──► PD 报文（SOP/报文头/数据对象/CRC32）
```

* **采样率取自文件**（`channel.ini` 的 `SamplingFrequency`，实测都是 2500 kHz）。BMC 时钟 600 kHz
  是 PD 协议规定的、与采样率无关 → `UI = 1.6667 µs`；在 2.5 MHz 下 `1 UI ≈ 4.167 采样点`，**1 bit = 2 UI**。
  * `'1'` 位：位周期内两次跳变 → 两段 ~1 UI 的短游程
  * `'0'` 位：位周期内一次跳变 → 一段 ~2 UI 的长游程
* 判决门限 `1.5 UI = 2.5 µs`、空闲门限 `3 UI = 5 µs`，都是**按采样率换算成采样点**之后再比
  （2.5 MHz 下约 6 / 13 个采样点；换个采样率的文件门限跟着变，不是写死的常数）。
* 4B5B 表、SOP/SOP′/SOP″ 有序集、报文头字段、PDO/RDO/VDM/扩展报文解析，全部对齐 libsigrok
  `usb_power_delivery` 解码器语义。

### 采样率怎么定：声明 → 波形自检 → 兜底

采样率决定「采样点序号 → 时间」的换算，所以它必须来自文件，不能写死。三级策略：

| 优先 | 来源 | 何时启用 | 界面标记 |
| :--: | ---- | -------- | -------- |
| ① | **文件声明** —— `channel.ini` 里的采样率（认 `SamplingFrequency` / `SampleRate` / `Frequency` 等键名，kHz / Hz / MHz 单位都认） | 声明存在，且与波形实测相差不超过 ±25% | `文件声明` |
| ② | **波形自检** —— 用 BMC 游程分布反推：每个游程非 1 UI 即 2 UI，于是 `Σ游程采样点数 = UI × (nShort + 2 × nLong)`，解出「1 UI 等于几个采样点」，再乘 600 kHz | 文件没声明，或声明值与波形差得离谱（单位写错、少写一位…） | `波形实测` |
| ③ | **兜底 2.5 MHz** | 波形也认不出来（通道是空的、或者根本不是 PD 数据） | `默认值` |

阈值为什么放宽到 ±25%：波形反推用的是 PD **标称**的 600 kHz 时钟，而实测 5 份不同厂商的抓包，
反推值都稳定比声明的 2.5 MHz 低约 4%（器件时钟的正常离散）。只要两者量级相符就以文件声明为准 ——
用它换算出来的时标与官方 ATK-C 完全一致（见上一节的逐字节比对）。

反推只读最前面 1~2 个块（几十毫秒），同一份文件切换通道时不重复测。命令行可以强制指定：
`node tools/cli.js <file.atkcc> --rate 2400000`（排查异常文件时用）。

> **关键坑**：位序必须用 **LSB 优先**。用 MSB 解出来的游程长度会散落在 1~3 个采样点，
> 只能得到一堆 CRC 全错的假包；换成 LSB 后游程干净地聚在 4/8 采样点，报文头的 SOP 前导
> 立刻呈现规整的 `1010…`，CRC 全部通过。


## `.sqlite` 格式（POWER-Z 导出）

POWER-Z（ChargerLAB KM 系列）的 Windows 上位机导出的是**一个普通 SQLite 数据库**，
里面的报文**已经被分析仪解到逻辑字节**了 —— 不需要（也没有）BMC 波形可解。
实测样本是三张普通表、无索引、无视图、无触发器、无 WAL：

```sql
CREATE TABLE pd_chart(Time real, VBUS real, IBUS real, CC1 real, CC2 real)   -- ADC 采样序列
CREATE TABLE pd_table(Time real, Vbus real, Ibus real, Raw Blob)              -- 事件流
CREATE TABLE pd_table_key(key integer)                                       -- 会话密钥（导出文件里为空）
```

UFCS 抓包（国产快充协议）结构完全一样，只是表名换成 `ufcs_chart` / `ufcs_table` / `ufcs_table_key`，
模拟量换 `DP` / `DM`。**识别方式**就是看有没有 `pd_table` / `ufcs_table`。

### Raw blob 里的事件

一行 `Raw` 是**若干事件首尾相接**（样本里恰好每行一个）：

```
┌ 连接 / 断开事件：固定 6 字节 ──────────────────────────────┐
│ 45 │ ts(3B 小端, 毫秒) │ 00 │ code     （0x11=连接 0x12=断开）│
└──────────────────────────────────────────────────────────┘
┌ 包裹的 PD 报文：变长 ─────────────────────────────────────┐
│ marker │ ts(4B 小端, 毫秒) │ sop │ wire（逻辑字节，无 CRC） │
└──────────────────────────────────────────────────────────┘
```

* `marker ∈ 0x80…0xBF`：低 6 位 = 段总长 − 1（总长含 marker 自身），高 2 位未用；
* `sop`：`0` = SOP，`1` = SOP′，`2` = SOP″；
* `wire` = `[Header 2B 小端][Data Object ×N，各 4B 小端]`，**不含 CRC、不含 SOP/EOP**。

拼不通的字节**如实标记**并停止，不硬猜长度 —— 一个错的长度会把后面所有事件读歪。

### UFCS 的 Raw blob 里是什么

UFCS 导出（`ufcs_table`）的表结构与 PD 完全一样，但**一行的 Raw 是另一套帧结构**：
4 字节毫秒时间戳打头、后面直接跟一条（或多条）UFCS 报文，**没有 PD 那种 marker 字节**；
各家实现「存不存 CRC」也不一致。本工程手上没有该格式的公开资料，因此**不假设结构**，
改用「穷举前缀长度（0…16 B）× 两种 CRC 读法 + 消息头合法性 + CRC-8 反证」定位
（`src/js/ufcs/frame.js#ufcsLocateFrames`），按三级择优：

| 级别 | 含义 | 处理 |
| ---- | ---- | ---- |
| A | 带 CRC，且每一帧 CRC-8 都对得上 | 最可信（正常抓包的绝大多数行） |
| B | 带 CRC，但有帧对不上 | 真·坏包照解，`crcOk = false` |
| C | 不存 CRC（只到消息主体为止） | 本工具补算 CRC，`crcOk = null` |

同级内比「消息头字段 + 命令编号是否合法」，再比特前缀长短（越短越像真的容器头）。
这样无论前缀是 0 / 4 字节时间戳 / 「时间戳 + 链路字节」，都落回同一条解析路径。
前缀 ≥5 字节时，紧邻报文的那一个字节按「`0` = 供电侧(D+) / `1` = 充电侧(D−)」解读为链路标记
—— 这也是「方向」的三级判据之一。

时间基准取 SQLite 的 `Time` 列（与 `ufcs_chart` 的 ADC 采样同一套时基，×1000 得毫秒），
容器前缀里那 4 字节时间戳只作诊断信息 —— 保证报文与模拟量曲线对得上。

### 怎么复用同一套 PD 语义

报文已经是逻辑字节了，但**不想抄第二份解析**。于是把它**反向铺回成一份 1bit/采样数组**：
SOP 有序集符号 → 各字节（低半字节先行）→ 按规范算出的 CRC-32 → EOP。
这份 bits 与 `BmcDecoder` 的输出格式完全等价（`_sym()` 就是它的逆），
`PdDecoder#decodeWire()` 之后直接复用 `decode()` ——
报文头、VDM、PDO/RDO、扩展消息、跨报文状态（PDO 登记表、SOP 电源角色）**全都一致**，
不会出现「两条路径慢慢跑偏」。

> **UFCS 不套用这条路径**。UFCS 的物理层是 UART（1 起始位 + 8 数据位 + 1 结束位），
> 报文结构与 PD 完全不同（没有 4B5B、没有 32 位报文头、没有 PDO 表）。
> 强行复用只会两败俱伤，所以它**单独成一库** `src/js/ufcs/`，只在
> **报文对象契约**（`sop / msgType / role / details / crcOk / startSample …`）这一层与 PD 对齐 ——
> 界面、筛选、详情、时间轴、导出照旧共用同一段渲染代码。

三个必须守住的细节：

| 细节 | 做法 | 为什么 |
| ---- | ---- | ------ |
| **位序** | 符号值先查 `DEC4B5B` 的**逆**得到查表下标，再按位展开 | `DEC4B5B` 的下标才是「按时间排的 5 个采样位」，值是语义符号。直接拿值当位序列会得到镜像线路码 |
| **CRC** | 按规范补算 CRC 让流程走通，但置 `crcOk = null` | 分析仪不存 CRC。默认「通过」等于替对方的数据背书 |
| **时间** | `1 采样点 = 1 ms`（`POWERZ_RATE = 1000`） | POWER-Z 只有毫秒时间戳。映射之后 `totalSamples / sampleRate` 仍是秒、`startSample` 仍是时间轴坐标，**界面所有换算不必为新格式开分支** |

### SQLite 读取器

`src/js/core/sqlite.js` 是**自己写的只读 SQLite 读取器**（约 340 行，零依赖）。
不引 sql.js 是为了守住本工程的三条硬约定：零第三方依赖、浏览器/Node 双栈、
单文件双击可跑（sql.js 要 WASM 体积 + fetch 同目录 `.wasm` + Node 侧 fs，三条全破）。
覆盖面按需裁剪：

* 数据库头 100 字节（页大小 / 保留区 / 文本编码 / 页数）、`sqlite_master` 建表语句；
* 表 B-tree：叶子页 + 内部页（多级递归下钻）；
* 记录格式：varint 头 + serial type → int / float / text / blob / NULL；
* 溢页链（payload 超过一页时按规范公式算「页内字节数」再顺链取完）。

**明确不支持**（读不到，遇到会显式报错而不是静默乱码）：索引页（只顺序读全表，用不上）、
未 checkpoint 的 WAL 内容（导出文件都是回滚日志模式）、加密库、UTF-16 文本编码、虚拟表。

> **两个反直觉的坑**：① 记录的「头长度」是**绝对字节数、含它自己那个 varint**，
> 数据区起点就直接是它（写成 `size + value` 会整体后移，症状是列名被啃掉头两个字符）；
> ② 内部页的 cell 是「分隔键 + 左子页指针」，**本身不是一行**，统计行数只能累加叶子页。

### 逐条核对

```bash
npm run powerz:inspect              # 全样本体检（默认读仓库上一级的 .sqlite），PD 与 UFCS 都认
npm run powerz:inspect -- --packets # 连类型分布一起打
npm run e2e:powerz                  # 端到端：拖拽 .sqlite（USB PD）进单文件版，36 项断言 + 截图
npm run e2e:ufcs                    # 端到端：拖拽真实 UFCS 导出，报文表 / 详情面板 / 差分线视图 + 截图
npm run e2e:ufcs:synth              # 同上，但样本是现造的（无需私有抓包，CI 可跑）→ 35 项 + 1 跳过
```

`e2e:ufcs` 与 `e2e:ufcs:synth` 走的是同一条界面路径，只差样本来源：
前者拖的是真实 `ufcs_vivo_x300u.sqlite`（**不在仓库里**，理由见「CI 构建」一节的样本说明），
后者先用 `tools/make-test-ufcs.mjs` 现造一份最小的 UFCS 导出再拖进去 ——
那份样本里 8 帧覆盖控制 / 数据 / 自定义三类、故意掺 1 条坏 CRC，
所以「解出报文」「CRC 统计口径」「ACK 配对」这些断言都真的跑得起来，不是空过。
```


## PD 协议解析库

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

### 与官方上位机相比，这一版补了什么

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

### 解析范围对照（与规范条目的对应关系）

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

## UFCS 协议解析库

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

### 覆盖的规范条目

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

### 三个容易踩的点

| 点 | 做法 | 为什么 |
| ---- | ---- | ------ |
| **字节序** | 多字节字段**高字节在前**（大端） | 规范反复强调「先发送高字节」，与 PD 的小端**正好相反**。载荷数组本身就是大端位串（`payload[0]` 是最高字节），取 `bit b` 时 `字节下标 = 长度-1-(b>>3)`、`位下标 = b&7` |
| **方向** | 「规范单向命令表 → 容器链路字节 → 接收方地址」三级还原 | 消息头里**只有接收方**地址。物理层 D+/D- 全双工、供电设备 D+ 为 TX、充电设备 D- 为 TX，配合接收方才能唯一确定发送方；纯推断出来的会标出来 |
| **CRC 覆盖范围** | 消息头 + 消息主体，**不含**容器前缀 / UART 起止位 | 容器不存 CRC 时由本工具补算并置 `crcOk = null`，绝不据此宣布「通过」 |

> 库内所有顶层名字统一带 `ufcs` / `UFCS_` 前缀，理由同上（单文件打包器会把整个 ES Module
> 图拍平进一个 IIFE 作用域，重名会互相覆盖）。

---

## 目录结构

```
PDScope/
├─ src/
│  ├─ js/pd/              独立 USB PD 协议解析库（零依赖、浏览器 + Node 通用，可整目录复用）
│  │   ├─ symbols.js      4B5B 表 / K-code / SOP 有序集
│  │   ├─ crc.js          CRC-32
│  │   ├─ format.js       位域取值与格式化（工具函数统一 pd* 前缀，便于单文件打包不重名）
│  │   ├─ tables.js       协议常量表（消息类型、VDO 字段取值、EPR、BIST 跨版本…）
│  │   ├─ svid.js         Standard / Vendor SVID 名称
│  │   ├─ pdo.js          PDO（Fixed/Battery/Variable/PPS/SPR-AVS/EPR-AVS）与 RDO
│  │   ├─ data.js         BIST / Battery_Status / Alert / Enter_USB / Source_Info / Revision / EPR_Mode
│  │   ├─ vdm.js          VDM（含 Discover Identity 的线缆/端口 VDO —— plug 信令）
│  │   ├─ extended.js     扩展消息数据块（SCEDB/SDB/GBCDB/制造商/安全/固件/EPR 能力…）
│  │   ├─ decoder.js      主解码器 PdDecoder（比特流 → 结构化报文对象）
│  │   └─ index.js        聚合入口（外部从这里 import）
│  ├─ js/ufcs/            独立 UFCS 解析库（零依赖、浏览器 + Node 通用，可整目录复用）
│  │   ├─ crc.js          CRC-8（多项式 0x29）
│  │   ├─ frame.js        消息头位域 / 三种帧结构 / 容器前缀定位（ufcsLocateFrames）
│  │   ├─ tables.js       控制命令表(17) / 数据命令表(14) / 设备地址 / 单向命令方向表…
│  │   ├─ format.js       大端位域取值与格式化（工具函数统一 ufcs* 前缀）
│  │   ├─ payload.js      各数据命令逐字段解析 + 厂家自定义消息
│  │   ├─ decoder.js      主解码器 UfcsDecoder（逻辑字节 → 结构化报文对象）
│  │   └─ index.js        聚合入口（外部从这里 import）
│  ├─ js/core/            容器与波形内核（浏览器 + Node 通用，零依赖）
│  │   ├─ zip.js          ZIP 读取（含 ZIP64 / EOCD 定位）
│  │   ├─ inflate.js      deflate-raw 解压（浏览器 DecompressionStream / Node zlib）
│  │   ├─ atkcc.js        .atkcc 容器解析
│  │   ├─ sqlite.js       只读 SQLite 读取器（POWER-Z 导出用的库格式，零依赖自写）
│  │   ├─ powerz.js       POWER-Z（.sqlite）适配层：嗅探 / Raw blob 拆事件 / 解码编排
│  │   ├─ bmc.js          游程提取 + BMC 状态机
│  │   ├─ pd_tables.js    4B5B / SOP 等低层符号表（供旧脚本使用）
│  │   ├─ pd.js           兼容转发层 → `src/js/pd/`（旧导入路径不破坏）
│  │   └─ pipeline.js     串起「分块 → 位流 → 边沿 → BMC → PD 解析 → 报文」
│  └─ ui/                 界面（index.html / styles.css / app.js）—— 三种形态共用
│                         app.js 里「多文档」一节：标签栏 + 每份一份状态 + 串行解码队列
├─ src-tauri/             Tauri 桌面外壳（Rust，Windows / macOS / Linux 同一份）
│  ├─ src/main.rs         原生窗口 + 中文菜单 + 「关于」+ 命令行/文件关联打开抓包
│  ├─ tauri.conf.json     窗口尺寸 / 入口页 / 打包目标 / 图标 / .atkcc 文件关联
│  ├─ Cargo.toml          Rust 依赖（tauri 2 + tauri-plugin-dialog）
│  ├─ build.rs            tauri-build 入口
│  ├─ .cargo/config.toml  crates 国内镜像（跟仓库走，clone 后直接可用）
│  └─ icons/              各平台打包图标（由 assets/icon.png 派发）
├─ assets/                品牌图标「源素材」：icon.png（1024² 主源图）+ icon.ico
├─ dist/                  前端产物：PDScope.html —— 单文件版与桌面版共用的唯一入口页
├─ artifacts/             自检产物：截图 + 报告（不入库，也不进安装包）
├─ .github/workflows/     CI：10 个目标一起构建（build.yml，见上文「CI 构建」一节）
└─ tools/
   ├─ cli.js              命令行解析（.atkcc / .sqlite 自动分流；table / --json / --csv / --rate）
   ├─ version-check.mjs   版本号五处一致性检查（自检链第一步）
   ├─ syntax.mjs          全量语法检查（node --check，几秒）
   ├─ ci-checksum.mjs     给 CI 产物生成 .sha256 校验和（三平台同一套命令）
   ├─ selftest.js         协议层合成用例自检（含手搓最小 SQLite 的 POWER-Z 路径回归）
   ├─ ackcheck.js         GOOD CRC 配对校验（跨全部真实抓包）
   ├─ pd-inspect.mjs      PD 解析抽查：线缆链路 plug 信令 + 扩展消息详情 + 全样本体检
   ├─ powerz-inspect.mjs  POWER-Z（.sqlite）全样本体检：拆帧自检 / 连接事件 / 警告 / CRC 口径
   ├─ pd-regress.mjs      与重构前解码器逐包逐字段对比（从 git HEAD 取旧版本）
   ├─ e2e.mjs             无头浏览器端到端自检 + 截图（测单文件版 / 本地服务版 / 多份抓包）
   ├─ tauri-e2e.mjs       真实 Tauri 窗口里的端到端自检 + 截图（测桌面版）
   ├─ perf-probe.mjs      「打开卡不卡」探针：阻塞间隙 + longtask + 函数级 CPU 占比
   ├─ make-test-atkcc.mjs 造 .atkcc 压力样本（逐位跳变 / 伪随机 / 真实波形重复 N 轮）
   ├─ make-test-ufcs.mjs  造最小 UFCS 的 .sqlite 导出（覆盖控制/数据/自定义 + 1 条坏 CRC），
   │                      供无私有抓包时跑 `npm run e2e:ufcs:synth`
   ├─ chunk-cost.mjs      逐块差分解码成本（cost(k) - cost(k-1)），定位贵的那一块
   ├─ serve.mjs           本地静态服务 + 示例文件接口
   ├─ build-standalone.mjs  打包单文件 dist/PDScope.html
   ├─ make-icon.py        生成图标源图 assets/icon.png（PIL 画方波 + PD 字样）
   ├─ make-tauri-icons.py 由源图派发各平台打包图标（PNG 各尺寸 + ICO + 手写 ICNS 容器）
   └─ inline-logo.mjs     把图标内联进 src/ui/index.html（顶栏 logo + favicon，`--check` 可校验）
```

**两个目录名说清楚**（都曾经或容易被误解）：

* `assets/` —— 放的是**图标源素材**，不是构建产物。它以前叫 `build/`，那个名字既不准确
  （这里没有任何东西是被「构建」出来的），又容易和 `cargo build`、构建脚本混在一起，所以改了。
* `dist/` —— 这里是真正的**构建产物**，但**只有 `PDScope.html` 一个文件**。
  两份形态共用它，没有第二个入口页。自检产生的截图和报告刻意放在 `artifacts/`：
  Tauri 会把 `frontendDist` 整个目录打进可执行文件，混进 `dist/` 会白胖将近 1 MB。

改图标：`npm run icon` → `npm run icon:tauri` → `npm run icon:web` → `npm run build`。

* `icon:web` 这一步不能省 —— 界面里的顶栏 logo 和标签页 favicon 是**内联的 PNG data URI**
  （单文件版要能脱离同目录资源独立打开，所以不能引外部文件）。它跟打包图标同源，但物理上是
  `src/ui/index.html` 里的一份副本，改完图标不同步就会「exe 换了新图标、网页还是旧的」。
  `npm run icon:check` 可以校验这份副本是否已过期（不一致时非 0 退出，适合放进 CI）。
* 深色顶栏下图标底（深蓝）与面板色接近，`.logo` 上挂了一点点 `drop-shadow` 描边把形状提出来；
  必须用 `drop-shadow`（跟随 PNG 的 alpha 轮廓），换 `box-shadow` 会画成方框、四个角露出来。
* `.icns` 是手写容器 —— Pillow 只能读不能写；不用 `tauri icon` 是为了让 Rust 侧能脱离 Node 独立构建。

---

## 自检

```bash
# 版本号 / 语法 / 协议层（纯 Node，秒级）
node tools/version-check.mjs              # 版本号五处是否一致（最便宜，先跑它）
node tools/syntax.mjs                     # 全量语法检查（几秒；界面脚本错一个字符就是白屏）
node tools/selftest.js                    # 合成用例 64 项：4B5B / PD / CRC + 采样率 + plug 信令 + POWER-Z / UFCS 路径
node tools/ackcheck.js                    # GOOD CRC 配对（跨 5 份真实抓包）
node tools/powerz-inspect.mjs             # POWER-Z（.sqlite，PD 与 UFCS）全样本体检（需要样本文件，非 0 退出即异常）

# 界面 30 项（ATK-C）/ 36 项（POWER-Z·PD）/ 39 项（多份抓包）/ 35 项 + 1 跳过（UFCS 合成样本）
# （走系统已装的 Chrome/Edge，不下载浏览器）
npm run e2e                               # 单文件版，自包含；会先重建 dist
npm run e2e:powerz                        # 同上，但拖进去的是 POWER-Z 的 .sqlite（USB PD）
npm run e2e:ufcs                          # 同上，但拖进去的是真实 UFCS 导出（解出 UFCS 报文）
npm run e2e:ufcs:synth                    # 同上，但样本现造（make-test-ufcs.mjs），无需私有抓包
npm run e2e:multi                         # 连续拖两份（.atkcc + .sqlite），测标签栏与各份状态隔离
npm run e2e:all                           # 上面四种样本依次跑一遍（npm test 用的就是它；需私有抓包）
npm run e2e:serve                         # 本地服务模式（需另开 node tools/serve.mjs）
node tools/e2e.mjs --file dist/PDScope.html --drop "../制糖40w-ip18pro.atkcc"
node tools/e2e.mjs --file dist/PDScope.html --drop "../山泽60w-ip18pro.sqlite"
node tools/e2e.mjs --file dist/PDScope.html --drop "../ufcs_vivo_x300u.sqlite"
node tools/e2e.mjs --file dist/PDScope.html --drop "artifacts/_ufcs_synth.sqlite"   # UFCS，样本现造
node tools/e2e.mjs --file dist/PDScope.html \
     --drop "../制糖40w-ip18pro.atkcc" --drop2 "../山泽60w-ip18pro.sqlite"   # 多份抓包

# 性能（「打开卡不卡」）
npm run perf                              # 真实大样本，采阻塞间隙 / longtask / 函数级 CPU 占比
npm run perf:headed                       # 同上，但走真实窗口（--headed 才测得到 canvas 合成等开销）
npm run perf:fixture                      # 造压力样本到 artifacts/（18 KB 装 16 MiB，逐位跳变）
npm run perf:worst                        # 上面两步一起：造样本 + 带界面跑，专门复现/守住卡顿

# 桌面版（在真实 Tauri 窗口里跑）
npm run app:exe                           # 先出可执行文件
npm run app:test                          # 路径一：页面内注入（≡ 点「打开」选文件）
npm run app:test:open                     # 路径二：命令行打开（≡ 双击 .atkcc 关联）

# 一把梭（上面全部）
npm run check
```

> 自检需要根目录上一级存在抓包样本文件（`.atkcc` / `.sqlite`）；`--drop` / `--open` 都是相对 `PDScope/` 的路径。

**`version-check.mjs`** 把版本号在五个文件里对一遍：`package.json`、`src-tauri/tauri.conf.json`、
`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src/ui/app.js`，外加 README 里写着的安装包产物名。
这几处分别被 npm、打包器、Cargo、锁文件、界面「关于」读走，只改一处不会报错，
只会悄悄装出一个「文件名 0.3.0、关于里写 0.2.0」的包 —— 所以放在自检链最前面拦。

**`ackcheck.js`** 校验 `linkGoodCrc()`：配对覆盖率、是否自指、方向是否相反、
**双方 CRC 完好时 MessageID 是否相同**（PD 规范的硬约束）、配对距离。
当前 5 份抓包共 1141 条有效 GOOD CRC **100% 配对成功**，1100 条可校验的配对
**MessageID 全部一致**，最远距离恒为 1 条报文。

**`selftest.js`** 用例共 **64 项**，分六组。第一组先在合成报文的**字段级**校验
4B5B / PD / CRC 语义（8 项）；第二组把同一串报文按 **1.5 / 2.5 / 4 / 6 MHz**
重新采样一遍（4 项），检查：用真实采样率能解出全部报文、波形反推的采样率误差 < 1%、
按反推值解码同样得到全部报文，并确认「采样率写错一倍就一条也解不出来」——
这正是采样率必须动态解析的原因。第三组（6 项）专测 **plug 信令与扩展消息**：
SOP' 上 e-Marker 的 Discover Identity 全线缆 VDO、端口侧的 UFP + Padding + DFP 三件套、
EPR_Source_Capabilities 的 PDO 列表、**分块扩展消息的跨块 PDO 拼接**（拼不回来要标注而不是猜）、
BIST 模式在 PD 2.0 与 3.x 下的不同含义、Discover SVIDs 的两两成对。
第四组（6 项）只测 `channel.ini` 的**采样率声明解析**：多键名（`SamplingFrequency` /
`SampleRate` / 小写下划线写法）、多单位（裸数字 = kHz、`MHz`、`kHz`）、
以及「只有 `Resolution` 或整个键都缺」时退回默认值。
第五组（18 项）专测 **POWER-Z 的 `.sqlite` 路径（USB PD）**：Raw blob 的插入/拔出/包裹报文拆帧与
「拼不通要如实标截断」、`decodeWire` 的语义等价与「CRC 未记录 ≠ 通过」、SQLite 页/记录读取、
`PowerzCapture` 的端到端，以及「不是 POWER-Z 的 SQLite 要判为不支持」。
第六组（22 项）专测 **UFCS**（见下）。后两组都用**手搓的最小 SQLite 库**做输入，
不依赖任何真实样本，CI 上也能跑。

**UFCS 那一组（22 项）测的是**：CRC-8 与一份**表驱动**参照实现随机比对 400 组（写法不同，
两边必须一致，防转录错误）；消息头四段位域；控制 / 数据 / 厂家自定义三类消息；
`Output_Capabilities` / `Request` / `Cable_Information` / `Sink_Information_Extended` / `Refuse`
的**逐字段**取值；CRC 错误被识别但其余字段不受影响；数据长度不符要报出来；
方向与规范单向命令表不符要告警；容器前缀定位的四种情形——**4B 时间戳 + 带 CRC**、
**时间戳 + 链路字节**、**不存 CRC**、**一行两帧**；最后手搓一个含 5 条真实 UFCS 帧
（其中 1 条故意打坏 CRC）+ 1 行残行的 SQLite，走 `PowerzCapture` **端到端**校验：
报文顺序与类型、方向与链路（D+/SRC … D-/SNK）、ACK 与被确认报文配对、统计口径
（`badCrc=1 / crcUnknown=0 / 残行=1`）、以及模拟量可用且**不再标注「未实现」**。

**`pd-regress.mjs`** 把重构前的解码器从 `git HEAD` 取出来，与新库在同一份抓包上
**逐包逐字段对比**（sop / msgType / header / crcOk / nObjects / dataWords）。
当前 7 份抓包共 2414 条报文，**报文条数逐样本完全一致**，除「扩展消息新增了 hex 回填」
这一处预期差异外**零字段差异**。`pd-inspect.mjs` 则单独抽取线缆链路与扩展消息的解析详情，
并在每个样本前打一行「报文 / 线缆链路 / 扩展 / 坏 CRC / 警告」汇总，便于人工核对与全样本体检。

**`e2e.mjs`** 直接走 Chrome DevTools Protocol（用系统已装的 Chrome/Edge，不下载浏览器），
**30 项**校验：页面骨架、抓包解码、虚拟滚动、方向过滤、关键字搜索、时间轴绘制、主题切换、
采样率来源标注、**详情面板拖拽改宽**（用真实鼠标事件走一遍 pointer capture，验证加宽 / 落盘 /
收起还原 / 超限夹紧 / 双击复位）、**收起后右缘出现展开把手**、
**标签栏出现 / 顶栏文件 chip 跟随当前标签 / 关闭全部后标签栏收起并回到引导页**、
无控制台异常，最后自动截图。
加 `--drop <文件>` 可注入真实抓包；`--eval "<js>"` 进调试模式，在页面里跑任意表达式并打印结果。

拖进去的若是 `.sqlite`，**另外再跑 6 项**（共 **36 项**）：来源标注为 POWER-Z、
CRC 统计口径、插拔事件计数、差分线视图可切换（PD 是 CC1/CC2、UFCS 是 DP/DM，
档名与标题跟着文件走）且切换后重绘并换标题、切回电压/电流。
所以 `e2e:powerz` 是 POWER-Z 路径的界面级回归。

这份样本是 PD 还是 UFCS 由顶栏「来源」chip 判定，几处断言的措辞跟着换：PD 的 CRC 恒为
「未记录（分析仪不存）」；**UFCS 存不存 CRC 由容器决定**，断言只要求「未记录 / 全通过 /
错误 N」三者之一、且不谎报。PD 的「插拔」chip 必须有；UFCS 容器一般不带连接/断开标记，
没有就跳过而不判失败（**有却不显示**才算错 —— 判据是「如实」，不是「必须有」）。
同理「首行内容合理」与「头位域块与协议匹配」也不能共用一套词表：前者的类型名
（`Source_Capabilities` / `Output_Capabilities`）与后者的块名（`报文头` / `消息头`）
两种协议各不相同，两个分支都必须**只出现其一**。

若这份样本**一行报文都没定位出来**（容器格式对不上，或本来就没有报文），依赖「列表里有行」的
11 项断言**显式跳过**并计入汇总（`.sqlite` 还会再跳过 CRC 口径 / 插拔计数两项，
合计 `23 通过, 0 失败, 13 跳过`），而不是判失败 ——
那些断言在这份样本上本就无从谈起。同时改测「零报文路径」本身：提示条说清原因、
统计行给出「已读入 N 行」、表格空态用的是「没有一行能认出」而非「筛选后为空」、
时间轴照常绘制、把手能重开详情面板。跳过数会打进汇总行，避免「全绿」被误读成
「所有断言都跑过了」。

加 `--drop2 <文件>` 则进入**多份抓包**模式（`npm run e2e:multi`，共 **39 项**）：
先按普通路径注入第一份、**故意改掉它的筛选**（关掉 SNK）并记下条数，再注入第二份，然后断言
标签栏由一条变两条、两份是**不同来源**（`.atkcc` 与 `.sqlite` 各记各的）、报文条数**各自独立**、
**新标签的筛选是默认值**（没有被上一份污染）、切回第一份后筛选面板已还原且条数与切走前一致；
最后用 `×` 关掉一个标签验证另一个平滑接管，`PDScope.closeAll()` 验证标签栏收起并回到打开引导页。
这些断言读的是 `window.PDScope.tabs()` 返回的**纯数据数组**（名字 / 状态 / 来源 / 条数 / 是否激活），
不碰标签栏的 DOM 结构 —— 外观再改，测试也不会跟着碎。

**`perf-probe.mjs`** 回答的是另一类问题：「打开这个文件要多久、卡在谁身上」。
e2e 只判「结果对不对」，不判「过程卡不卡」，所以单靠 e2e 抓不到主线程被占住这类问题。
它一次采三样东西，缺一不可：

| 采什么 | 怎么采 | 回答什么 |
|---|---|---|
| 主线程阻塞间隙 | 页面内 `setTimeout(0)` 心跳，记实际间隔 | 「卡死」的直接体感 —— 被占住 800 ms 就记一条 ~800 ms |
| longtask | `PerformanceObserver` 的 `longtask` 条目（>50 ms） | 有多少个「超长任务」 |
| 函数级 CPU 占比 | CDP `Profiler`（采样间隔 0.4 ms），按**自身耗时**聚合 | 最终依据：到底卡在哪个函数 |

**`--headed` 不是可选项，是必须的。** 无头模式会跳过 canvas 合成、`backdrop-filter` 模糊、
字体加载这些开销，而用户就是双击 HTML 用有头窗口打开的。另外**测量期间必须让窗口保持可见**：
探针自己的心跳也是链式 `setTimeout`，而 Chrome 会把隐藏标签页里链式 `setTimeout` 钳到约 1 秒，
于是探针会自己造出 1001 ms 的「假阻塞」记录。**探针给出反常数字时，先怀疑测量环境。**

**`make-test-atkcc.mjs`** 用来造压力样本，因为**真实抓包复现不出卡顿**：

```bash
node tools/make-test-atkcc.mjs --fill 0x55  --chunks 16   --out artifacts/_worst.atkcc
node tools/make-test-atkcc.mjs --fill random --chunks 32  --out artifacts/_noise.atkcc
node tools/make-test-atkcc.mjs --src "../苹果40w-ip18pro.atkcc" --rounds 30 --out artifacts/_long.atkcc
```

`--fill 0x55` 让每块**逐位跳变**（840 万个边沿/块），deflate 后每块只剩 ~1 KB ——
于是得到「**18 KB 的文件，内里是 16 MiB 密集数据**」。这正是用户说的
「几十 KB 的文件打开却卡死」：**解码成本跟磁盘体积没有关系**，因为每块固定 1 MiB 未压缩，
空闲段（全 `0xFF`/`0x00`）几乎不产生边沿，真实抓包里大多数块都很便宜。
`--rounds N` 则是把真实文件的数据块重复 N 轮，保持真实波形不变只放大规模。

**`chunk-cost.mjs`** 做逐块差分成本（把抓包限到 k 块，量 `cost(k) - cost(k-1)`），
用来定位「是某一块特别贵，还是普遍变贵」。

用这套工具定位到的一个真实缺陷：`BmcDecoder` 只在**空闲**（边沿间隔 > maxbit）或 flush 时才吐报文，
而噪声 / 非 PD 波形**永不空闲**，于是内部 `bits` 一路涨到千万级，解码收尾时 `_scanSop()`
要在**一个同步任务里**把它全扫完 —— 界面就冻住了。修法是给「切包」补一条与空闲无关的出口
（`MAX_PACKET_BITS`，见 `src/js/core/bmc.js`），到上限即丢弃重来，
顺带给单个报文的工作量设了硬上限。效果：**7966 ms → 803 ms，单次主线程阻塞 6328 ms → 80 ms**。
同源问题还有两条：多通道自动选道时会把**浮空/噪声线**当成「最活跃」而选中它（选中后解码器空转），
以及原先「每 8 块让出一次主线程」对 1 MiB 的块来说太粗。

**`tauri-e2e.mjs`** 连的是 Tauri 真正在跑的那个 WebView2（靠
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 开调试端口），所以外壳本身也在被测范围里。
它跑两条路径：

* `--drop` —— 在页面里构造 `File` 塞进 `<input type=file>` 并派发 `change`，等价于用户点「打开」；
* `--open` —— 把文件路径作为**命令行参数**交给 exe，等价于双击关联的 `.atkcc`，
  走的是外壳的 `read_capture` 桥。

两条路径都会校验：界面挂载、**页面识别出桌面形态**（`window.PDScope.env.name === 'desktop'`）、
外壳桥就绪、解码结果、方向配色、时间轴、页面异常，并抓一张窗口截图。

```bash
node tools/tauri-e2e.mjs --open "../绿联70w-ip18pro.atkcc" \
     --shot artifacts/tauri-open.png --report artifacts/tauri-open-selftest.txt
```

报告写到 `artifacts/tauri-selftest.txt`，有失败项时退出码非 0。

命令行解析（不起界面，适合脚本里用）：

```bash
node tools/cli.js "../制糖40w-ip18pro.atkcc"                   # 表格
node tools/cli.js "../绿联70w-ip18pro.atkcc" --json           # JSON
node tools/cli.js "../苹果40w-ip18pro.atkcc" --csv            # CSV
node tools/cli.js "../apple_40w_avs_iphone_air.atkcc" --scan  # 各通道活动度
node tools/cli.js "../绿联70w-ip18pro.atkcc" --rate 2400000    # 强制指定采样率（排查用）
node tools/cli.js "../山泽60w-ip18pro.sqlite"                  # POWER-Z 导出，自动识别
node tools/cli.js "../ufcs_vivo_x300u.sqlite"                  # UFCS：解出 UFCS 报文表（.sqlite 自动分流）
```

实测样本（`.atkcc` → 报文数 / CRC 错误）：

| 文件                       | 通道 | 报文 | CRC 错误 |
| -------------------------- | ---- | ---- | -------- |
| 制糖40w-ip18pro            | 1    | 44   | 0        |
| 安可60w-ip18pro            | 1    | 44   | 0        |
| 绿联70w-ip18pro            | 1    | 348  | 0        |
| 苹果40w-ip18pro            | 1    | 738  | 6        |
| apple_40w_avs_iphone_air   | 24   | 1048 | 5        |

实测样本（`.sqlite`，USB PD → 报文数 / 线缆链路 / 插拔 / 拆帧自检）：

| 文件                  | 协议   | 表行  | 报文 | 线缆链路 | 扩展 | 插拔 | 时长     | 拆帧自检 |
| --------------------- | ------ | ----: | ---: | -------: | ---: | ---: | -------- | -------- |
| 山泽60w-ip18pro       | USB PD | 45    | 44   | 4        | 3    | 1 / 0 | 9.91 s   | ✔ 0 坏包 / 0 截断 |
| 酷泰科6u-18pro        | USB PD | 77    | 76   | 4        | 7    | 1 / 0 | 8.50 s   | ✔ 0 坏包 / 0 截断 |

被测样本（`.sqlite`，UFCS）：

| 文件                  | 协议 | 表行  | 时长      | 备注 |
| --------------------- | ---- | ----: | --------- | ---- |
| ufcs_vivo_x300u       | UFCS | 26099 | 2493.98 s | 容器结构与模拟量已确认；报文数由下面这条命令现跑现得 |

UFCS 的 Raw blob 是**另一套帧结构**（见上文「UFCS 的 Raw blob 里是什么」），且没有公开资料，
所以解析器不假设结构、改用「穷举前缀 × 两种 CRC 读法 + 消息头合法性 + CRC-8 反证」定位。
跑一遍就知道这份样本解出了多少条：

```bash
npm run powerz:inspect                  # 汇总行给出：报文 / UFCS 帧 / 未定位行 / CRC 口径
npm run e2e:ufcs                        # 界面级：报文表、详情面板、差分线视图
```

汇总行里的「UFCS 帧」是容器里定位到的帧数，「未定位行」是既不是 UFCS 报文、也不像插拔事件的行数 ——
两者都会进 `PowerzCapture.decode()` 的 `stats`，**不写死预期值**：容器格式各家实现不一，
与其在文档里钉一个没验证过的数字，不如让工具如实报出来。

（`npm run powerz:inspect` 会把上表连同代表性报文的完整字段一起打出来；PD 的 `pd_table`
一律不存 CRC，所以那一栏恒为「未记录」；**UFCS 存不存 CRC 由容器决定**，未记录 / 全通过 / 错误 N
都如实列出来。）

---

## 已知限制

* **桌面版不交叉编译**。想在 macOS 上用桌面版，就得在 macOS 上构建（或直接用单文件版）。
  本机只实测了 Windows 产物：`pdscope.exe` 3.1 MB、NSIS 安装包 `PDScope_0.2.0_x64-setup.exe` 1.2 MB。
* **安装包只验到「能打出来」**。打安装包时 Tauri 会从 GitHub Releases 下载打包辅助程序
  （NSIS / WiX / appimage 工具），本机已实测可下载并成功产出 NSIS 与 MSI；但**没有在本机执行安装**，
  所以「装完之后双击 `.atkcc` 直接打开」这条只在命令行与拖拽两条等效路径上实测过 ——
  不装包时用「命令行传路径」或「把 `.atkcc` 拖到 exe 图标上」即可，效果一样。
* **桌面版依赖系统自带的 WebView**。Windows 走 **WebView2**（Win10/11 基本内置），
  macOS 走系统 **WKWebView**（10.15+ 自带），Linux 需要 `libwebkit2gtk-4.1`。
  系统里没有 WebView 时，退回单文件版即可。
* **首次构建需要 Rust 工具链，且比较慢**。Rust 首次 `cargo build` 要编译 400+ 个依赖
  （约 1.5 ~ 10 分钟，视机器而定）；之后只改前端是秒级重建（约 1.5 分钟）。
  环境搭建见[附录 B](#附录-b环境准备)。
* **受限环境下窗口可能空白**。远程桌面 / 虚拟机 / 带行为管控安全软件的机器上，
  WebView 的 GPU 与沙箱辅助进程可能起不来。此时给 WebView2 追加启动参数即可：

  ```bash
  set WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--disable-gpu --no-sandbox
  ```

  自检脚本默认就带这两个参数，所以自检能过、手动开却白屏时，多半就是这个原因。
* **macOS 打包未签名未公证**。首次打开需要右键 →「打开」，或
  `xattr -dr com.apple.quarantine /Applications/PDScope.app`。想彻底绕开这一步，
  直接用单文件 `dist/PDScope.html`。
* **桌面版没有单实例机制**。程序开着的时候再双击一个 `.atkcc`，会再开一个窗口，而不是
  复用已有窗口。（要改成复用需要引入 `tauri-plugin-single-instance`。）
* `bus.ini` 里的 VBUS/IBUS 是阶梯保持采样，时间轴按最近邻取值，不做插值。
  POWER-Z 的 ADC 采样序列同理（也是阶梯保持）。
* **PD 的 POWER-Z 报文不含 CRC**（`pd_table`），文件里只存到数据对象为止。界面会按规范补算
  CRC 让解析走通，但绝不据此宣布「校验通过」—— 统计行写「CRC 未记录（分析仪不存）」，
  详情面板单列一行说明，也不会把这类报文算进「只看 CRC 错误」。
  UFCS 的 `ufcs_table` 存不存 CRC 各家实现不一：存了就照实给「通过 / 失败」，
  没存才走同一套「未记录」话术。
* **POWER-Z 没有波形**，所以「报文时长 / 码率」是按 PD 标称的 600 kbps BMC 时钟折算的
  线上时长，不是从电平里量出来的（详情面板对应标成「线上时长 / BMC 码率」）。
  时间轴同理：分析仪只给毫秒时间戳，按「1 采样点 = 1 ms」映射。
* **UFCS 的容器（Raw blob）格式没有公开资料**。本工程按 T/TAF 083—2024 实现的是**报文语义**
  （消息头 / 三类消息结构 / CRC-8），但分析仪把报文塞进 `ufcs_table.Raw` 时外面还套了一层
  私有前缀（时间戳、可能还有链路字节），存不存 CRC 也各家不同。所以定位这一层用的是
  「穷举前缀 × 两种 CRC 读法 + 消息头合法性 + CRC-8 反证」的**稳健推断**，而不是按某个
  已知结构硬切（详见「UFCS 的 Raw blob 里是什么」）。遇到对不上的样本，界面会如实写
  「已读入 N 行，但没有一行能认出 UFCS 报文」，模拟量照常可看 —— 不假装解析成功，也不谎报失败。
* **UFCS 的波特率是按规范缺省档位 115200 bps 折算「线上时长」的**（报文里没有速率字段），
  不是从 D+/D- 电平量出来的；详情面板把这一项标为「标称波特率」。
* **SQLite 读取器不覆盖索引页 / WAL / 加密库 / UTF-16 文本编码 / 虚拟表**。
  实测的 POWER-Z 导出都是「三张普通表 + 回滚日志模式 + UTF-8」，够用；遇到别的库会显式报错。
* **`.atkcc` 的文件关联（双击打开）没有为 `.sqlite` 注册** —— 它能被程序正常解析
  （拖拽、选择文件、命令行都行），只是没在安装包里声明关联。`.sqlite` 是通用扩展名，
  抢它当关联容易和别的软件打架。

---

## 附录 A：三种形态能力对照

| 能力                                  | 单文件 HTML | Tauri 桌面 | 本地服务 |
| ------------------------------------- | :---------: | :--------: | :------: |
| 拖入 `.atkcc` / `.sqlite`             | ✔           | ✔          | ✔        |
| 「选择文件」按钮 / `Ctrl+O`            | ✔           | ✔          | ✔        |
| 解码 / 表格 / 详情 / 时间轴 / 筛选     | ✔           | ✔          | ✔        |
| 多份抓包同开（标签栏 / `Alt+1..9`）    | ✔           | ✔          | ✔        |
| 导出 CSV / JSON                        | ✔           | ✔          | ✔        |
| 明暗主题 / 行高 / 快捷键               | ✔           | ✔          | ✔        |
| 「载入示例」按钮                       | —           | —          | ✔        |
| 原生菜单 + `F11` / `F12`               | —           | ✔          | —        |
| 命令行 / 文件关联打开                  | —           | ✔          | —        |
| 需要先装软件                           | 无          | WebView 运行时（基本自带） | Node |

---

## 附录 B：环境准备

### 只跑单文件版 / 本地服务

* **Node.js 18+**（只为跑 `tools/` 下的脚本；`dist/PDScope.html` 本身不需要 Node）

### 构建桌面版：三平台通用

* **Rust**：用 [rustup](https://rustup.rs) 安装（本机实测 rustc 1.98.1）
* **Node.js**：装 `@tauri-apps/cli` 用

### 构建桌面版：各平台额外依赖

| 平台        | 还需要装                                                                       |
| ----------- | ------------------------------------------------------------------------------ |
| **Windows** | **MSVC 链接器** —— 装 Visual Studio 2022 的「使用 C++ 的桌面开发」工作负载（含 Windows SDK），或只装 Build Tools。已验证 VS 2022 Community + MSVC 14.44 + Windows SDK 10.0.26100 可用。**WebView2 运行时** Win10/11 基本自带（本机 154）。 |
| **macOS**   | `xcode-select --install`（Command Line Tools，提供 clang 与系统框架）          |
| **Linux**   | `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf build-essential`（Debian/Ubuntu 系；打 AppImage 需要 `patchelf`） |

### 网络：镜像

* `src-tauri/.cargo/config.toml` —— crates 走 USTC 稀疏索引（给国内开发机用；海外网络删掉它即可回到官方源）。
  CI 里是自动删掉的：runner 在海外，走官方源更快更稳。
* `.npmrc` —— 预留了 npmmirror 的开关，但**默认注释着**：依赖只有 `@tauri-apps/cli` 一个，官方源直接可达，没必要绕。

`tauri build --no-bundle` 完全走本地，不碰外网；打安装包（nsis / msi / dmg / AppImage）时
才会去 GitHub Releases 下载打包辅助程序。
