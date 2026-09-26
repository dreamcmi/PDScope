# PDScope

**USB Power Delivery 抓包解析上位机**

直接打开正点原子 ATK-C 的 `.atkcc` 抓包文件，把 CC 线上的 BMC 波形还原成逐条 PD 报文，
并逐字段溯源。解析与界面全部在前端完成 —— **零依赖、零网络、不上传任何数据**。

支持 **Windows / macOS / Linux**。

> 本项目由作者主导，**使用 AI 编程助手 DeepSeek V4.1 Flash 辅助开发**，

---

## 目录

* [一份代码，两种交付形态](#一份代码两种交付形态)
* [快速开始](#快速开始)
* [形态一：单文件 HTML 版](#形态一单文件-html-版)
* [形态二：Tauri 桌面版](#形态二tauri-桌面版)
* [形态三：本地服务（开发调试用）](#形态三本地服务开发调试用)
* [界面功能](#界面功能)
* [`.atkcc` 格式（逆向结论）](#atkcc-格式逆向结论)
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
| 产物           | `dist/PDScope.html`（约 160 KB，自包含） | `pdscope.exe`（约 3.1 MB）              |
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
# 双击 dist/PDScope.html，把 .atkcc 拖进窗口
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
| **Windows** | 双击 `PDScope.html` → 用默认浏览器（通常是 Edge）打开 → 把 `.atkcc` 拖进窗口。想固定入口就右键「发送到 → 桌面快捷方式」。 |
| **macOS**   | 双击即可。若默认浏览器是 Safari，需要 **Safari 16.4+**；老系统请右键 →「打开方式」→ Chrome/Edge。 |
| **Linux**   | 双击（部分桌面环境会问用什么程序打开，选浏览器），或终端 `xdg-open dist/PDScope.html`。   |

不管哪个平台，都有两种喂文件的方式：**把 `.atkcc` 拖进窗口**，或点界面上的「选择文件」
（快捷键 `Ctrl/⌘+O`）。

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
Linux 要链 WebKitGTK + GTK。想要三平台的包，就得在三个系统上各跑一次
（或者用 CI 矩阵，比如 GitHub Actions 的三个 runner）。

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
| **Windows** | `npm run app:exe`     | `npm run app:win`    | `bundle/nsis/PDScope_0.1.0_x64-setup.exe`           |
| **macOS**   | `npm run app:exe`     | `npm run app:mac`    | `bundle/dmg/PDScope_0.1.0_x64.dmg` + `bundle/macos/PDScope.app` |
| **Linux**   | `npm run app:exe`     | `npm run app:linux`  | `bundle/appimage/PDScope_0.1.0_amd64.AppImage` + `bundle/deb/PDScope_0.1.0_amd64.deb` |

产物都在 `src-tauri/target/release/` 下。三个平台的依赖见[附录 B](#附录-b环境准备)。

> **安装包需要联网，可执行文件不需要。** `--no-bundle`（即 `app:exe`）只调用本机已有的
> 编译器，完全离线；而打安装包时 Tauri 会去 GitHub Releases 下载打包辅助程序
> （NSIS、appimage 工具等）。**本机网络访问 GitHub 被阻断**，所以
> `app:exe` 已实测通过，`app:win` 这条**未实测**。网络通畅的机器上直接可用。

### 怎么打开一个抓包文件

四种方式，任选：

1. **菜单**：文件 → 打开抓包…（`Ctrl/⌘+O`）
2. **拖拽**：把 `.atkcc` 拖进窗口（`dragDropEnabled: false` 就是为这个设的 ——
   否则 Tauri 会吞掉 HTML5 拖放事件）
3. **命令行**：
   ```bash
   pdscope.exe "D:\抓包\绿联70w.atkcc"
   ```
4. **拖到 exe 图标上**，或装了安装包后**双击 `.atkcc`**（`tauri.conf.json` 里声明了 `.atkcc` 文件关联）

第 3、4 种走的是同一条路：外壳读文件字节 → 通过 IPC 交给页面 → 页面交给解析内核。
为什么绕这一圈？因为浏览器的安全模型不允许页面读任意本地路径；这样前端对「文件从哪来」完全无感，
换成单文件版后照样能跑。

### 桌面版专属的菜单

| 菜单项                      | 快捷键          | 作用                           |
| --------------------------- | --------------- | ------------------------------ |
| 文件 → 打开抓包…            | `Ctrl/⌘+O`      | 弹系统文件对话框               |
| 文件 → 关闭抓包             | `Ctrl/⌘+W`      | 重新载入界面（等于清空当前抓包）|
| 文件 → 另存为（当前筛选）   | `Ctrl/⌘+S`      | 导出 CSV / JSON                |
| 文件 → 退出                 | —               | 关窗退出                       |
| 查看 → 搜索报文             | `Ctrl/⌘+F`      | 聚焦搜索框                     |
| 查看 → 切换主题             | `Ctrl/⌘+T`      | 明 / 暗                        |
| 查看 → 折叠 / 展开筛选栏    | `Ctrl/⌘+B`      | 收起左侧筛选栏                 |
| 查看 → 紧凑 / 舒适行高      | —               | 切换行高                       |
| 查看 → 全屏                 | `F11`           | 全屏 / 还原                    |
| 查看 → 开发者工具           | `F12`           | 打开 DevTools                  |
| 帮助 → 关于 PDScope         | —               | 版本 / 平台信息                |

---

## 形态三：本地服务（开发调试用）

```bash
node tools/serve.mjs        # 默认 http://127.0.0.1:5188，会自动开浏览器
```

与前两种的唯一区别：多一个「**载入示例**」按钮 —— 它会扫描 `PDScope/` 和它上一级目录里的
所有 `.atkcc`，一键载入。这个按钮依赖 `serve.mjs` 提供的 `api/samples` 接口，
所以另外两种形态下它不显示。

改界面时用这个形态最舒服：浏览器里刷新即可，不用重新打包。

---

## 界面功能

| 能力                | 说明                                                                                         |
| ------------------- | -------------------------------------------------------------------------------------------- |
| **报文表**          | `# / SOP / 报文类型 / ID / 方向 / Obj / 时间 / VBUS-IBUS / 数据hex / 解析详情`，虚拟滚动，几万条也不卡 |
| **采样率来源标注**  | 顶栏显示实际采用的采样率并标出来源：`文件声明` / `波形实测` / `默认值`。声明与波形不一致时改按实测解码，并弹出提示；鼠标悬停可见 `channel.ini` 原文或原因 |
| **方向区分**        | `Source`（供电方）/ `Sink`（受电方）/ `Plug`（线缆 e-marker）三色徽章；`SOP / SOP′ / SOP″` 分别标注 |
| **GOOD CRC 配对同色** | 每条 `GOOD CRC` 自动取「它所确认的那条报文」的颜色，而不是笼统的控制色。配对依据：GoodCRC 是对报文的即时应答（实测恒为紧邻 1 条），并用 PD 规范要求的 *MessageID 相同* 交叉校验；被确认报文本身是坏包时退化为纯邻近匹配。悬停报文类型可见 `确认 #N · 类型`，详情面板「链路概览」里也有「确认的报文」一栏 |
| **选择性屏蔽**      | 按方向、SOP 类型、报文类别（控制/数据/扩展/VDM/异常）、**具体报文类型**（多选，带计数）、时间窗口、关键字任意组合过滤 |
| **快捷过滤**        | 一键屏蔽 GOOD CRC 心跳包 / 只看 CRC 错误 / 只看功率协商 / 只看状态切换                        |
| **CRC 错误标注**    | 校验未通过的报文在表格里整行标红，并在时间轴对应位置画一条贯穿的高亮竖线；配合「只看 CRC 错误」可一键筛出来 |
| **时间窗口**        | 底部 VBUS/IBUS 时间轴可**拖拽刷选**一段区间，表格立即联动                                     |
| **位域详情**        | 右侧面板逐位展开报文头（B15 扩展 / B14-12 对象数 / B11-9 MsgID / B8 PowerRole / B7-6 Rev / B5 DataRole / B4-0 类型）、扩展头、每个数据对象（PDO/RDO/VDM）的全部字段 |
| **导出**            | CSV（当前筛选结果）或 JSON（全部报文，含原始位域字段与 `ackOf` 配对序号）                     |
| **其它**            | 明/暗主题、紧凑/舒适行高、上一条/下一条（↑↓）、`/` 聚焦搜索、`Ctrl/⌘+O` 打开、`T` 切主题、`G` 切 GOOD CRC 屏蔽、折叠筛选栏 |

界面截图见 `artifacts/e2e-screenshot.png`（跑 `npm run e2e` 时自动生成），
GOOD CRC 配对同色的效果见 `artifacts/ack-colors.png`。

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


## 目录结构

```
PDScope/
├─ src/
│  ├─ js/core/            纯 JS 解析内核（浏览器 + Node 通用，零依赖）
│  │   ├─ zip.js          ZIP 读取（含 ZIP64 / EOCD 定位）
│  │   ├─ inflate.js      deflate-raw 解压（浏览器 DecompressionStream / Node zlib）
│  │   ├─ atkcc.js        .atkcc 容器解析
│  │   ├─ bmc.js          游程提取 + BMC 状态机
│  │   ├─ pd_tables.js    4B5B 表 / SOP / 报文类型 / VDM 命令等常量
│  │   ├─ pd.js           PD 协议层（报文头、PDO/RDO、VDM、扩展报文、CRC32）
│  │   └─ pipeline.js     串起「分块 → 位流 → 边沿 → BMC → 报文」
│  └─ ui/                 界面（index.html / styles.css / app.js）—— 三种形态共用
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
└─ tools/
   ├─ cli.js              命令行解析（table / --json / --csv / --rate 强制指定采样率）
   ├─ syntax.mjs          全量语法检查（node --check，几秒，自检链第一步）
   ├─ selftest.js         协议层合成用例自检
   ├─ ackcheck.js         GOOD CRC 配对校验（跨全部真实抓包）
   ├─ e2e.mjs             无头浏览器端到端自检 + 截图（测单文件版 / 本地服务版）
   ├─ tauri-e2e.mjs       真实 Tauri 窗口里的端到端自检 + 截图（测桌面版）
   ├─ serve.mjs           本地静态服务 + 示例文件接口
   ├─ build-standalone.mjs  打包单文件 dist/PDScope.html
   ├─ make-icon.py        生成图标源图 assets/icon.png（PIL 画方波 + PD 字样）
   └─ make-tauri-icons.py 由源图派发各平台打包图标（PNG 各尺寸 + ICO + 手写 ICNS 容器）
```

**两个目录名说清楚**（都曾经或容易被误解）：

* `assets/` —— 放的是**图标源素材**，不是构建产物。它以前叫 `build/`，那个名字既不准确
  （这里没有任何东西是被「构建」出来的），又容易和 `cargo build`、构建脚本混在一起，所以改了。
* `dist/` —— 这里是真正的**构建产物**，但**只有 `PDScope.html` 一个文件**。
  两份形态共用它，没有第二个入口页。自检产生的截图和报告刻意放在 `artifacts/`：
  Tauri 会把 `frontendDist` 整个目录打进可执行文件，混进 `dist/` 会白胖将近 1 MB。

改图标：`python tools/make-icon.py` → 再 `python tools/make-tauri-icons.py`
（`.icns` 是手写容器 —— Pillow 只能读不能写；不用 `tauri icon` 是为了让 Rust 侧能脱离 Node 独立构建）。

---

## 自检

```bash
# 协议层与配对（纯 Node，秒级）
node tools/syntax.mjs                     # 全量语法检查（几秒，先跑它）
node tools/selftest.js                    # 合成用例 18 项：4B5B / PD / CRC 语义 + 多种采样率
node tools/ackcheck.js                    # GOOD CRC 配对（跨 5 份真实抓包）

# 界面 19 项（走系统已装的 Chrome/Edge，不下载浏览器）
npm run e2e                               # 单文件版，自包含；会先重建 dist
npm run e2e:serve                         # 本地服务模式（需另开 node tools/serve.mjs）
node tools/e2e.mjs --file dist/PDScope.html --drop "../制糖40w-ip18pro.atkcc"

# 桌面版（在真实 Tauri 窗口里跑）
npm run app:exe                           # 先出可执行文件
npm run app:test                          # 路径一：页面内注入（≡ 点「打开」选文件）
npm run app:test:open                     # 路径二：命令行打开（≡ 双击 .atkcc 关联）

# 一把梭（上面全部）
npm run check
```

> 自检需要根目录上一级存在 `.atkcc` 样本文件；`--drop` / `--open` 都是相对 `PDScope/` 的路径。

**`ackcheck.js`** 校验 `linkGoodCrc()`：配对覆盖率、是否自指、方向是否相反、
**双方 CRC 完好时 MessageID 是否相同**（PD 规范的硬约束）、配对距离。
当前 5 份抓包共 1141 条有效 GOOD CRC **100% 配对成功**，1100 条可校验的配对
**MessageID 全部一致**，最远距离恒为 1 条报文。

**`selftest.js`** 先用合成报文凭字段校验 4B5B / PD / CRC 语义（8 项），再把同一串报文按
**1.5 / 2.5 / 4 / 6 MHz** 重新采样一遍（10 项），检查：用真实采样率能解出全部报文、
波形反推的采样率误差 < 1%、按反推值解码同样得到全部报文，并确认「采样率写错一倍就一条也解不出来」——
这正是采样率必须动态解析的原因。

**`e2e.mjs`** 直接走 Chrome DevTools Protocol（用系统已装的 Chrome/Edge，不下载浏览器），
19 项校验：页面骨架、抓包解码、虚拟滚动、方向过滤、关键字搜索、时间轴绘制、主题切换、
采样率来源标注、无控制台异常，最后自动截图。加 `--drop <文件>` 可注入真实抓包；`--eval "<js>"` 进调试模式，
在页面里跑任意表达式并打印结果。

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
```

实测样本（`.atkcc` → 报文数 / CRC 错误）：

| 文件                       | 通道 | 报文 | CRC 错误 |
| -------------------------- | ---- | ---- | -------- |
| 制糖40w-ip18pro            | 1    | 44   | 0        |
| 安可60w-ip18pro            | 1    | 44   | 0        |
| 绿联70w-ip18pro            | 1    | 348  | 0        |
| 苹果40w-ip18pro            | 1    | 738  | 6        |
| apple_40w_avs_iphone_air   | 24   | 1048 | 5        |

---

## 已知限制

* **桌面版不交叉编译**。想在 macOS 上用桌面版，就得在 macOS 上构建（或直接用单文件版）。
  本机只实测了 Windows 产物。
* **安装包未实测**。打安装包时 Tauri 需要从 GitHub Releases 下载打包辅助程序，
  本机网络访问 GitHub 被阻断，因此 `app:exe`（不联网）已实测、`app:win` / `app:mac` / `app:linux`
  未实测。相应地，**双击 `.atkcc` 的文件关联要装包后才生效**；不装包时可用
  「命令行传路径」或「把 `.atkcc` 拖到 exe 图标上」达到同样效果（这条已实测）。
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

---

## 附录 A：三种形态能力对照

| 能力                                  | 单文件 HTML | Tauri 桌面 | 本地服务 |
| ------------------------------------- | :---------: | :--------: | :------: |
| 拖入 `.atkcc`                         | ✔           | ✔          | ✔        |
| 「选择文件」按钮 / `Ctrl+O`            | ✔           | ✔          | ✔        |
| 解码 / 表格 / 详情 / 时间轴 / 筛选     | ✔           | ✔          | ✔        |
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

### 网络：国内镜像

仓库里已经配好两处镜像，clone 下来即可用，不需要额外设置：

* `.npmrc` —— npm 走 npmmirror
* `src-tauri/.cargo/config.toml` —— crates 走 USTC 稀疏索引

`tauri build --no-bundle` 完全走本地，不碰外网。只有打安装包时需要访问 GitHub Releases。
