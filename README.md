# PDScope

**USB Power Delivery 抓包解析上位机** —— 直接打开正点原子 ATK-C 的 `.atkcc` 抓包文件，把 CC 线上的
BMC 波形还原成逐条 PD 报文，并逐字段溯源。

跨平台：**Windows / macOS / Linux** 都能跑，解析层零依赖、零网络。
Windows 上另有 1.5 MB 的原生单文件 exe（界面走系统自带的 WebView2）。

---

## 四种打开方式

### 1) Windows 原生应用（推荐给 Windows 日常使用）

```bash
npm run shell:win:publish     # 产出 shell-win/bin/Release/net9.0-windows/win-x64/publish/PDScope.exe
```

产物是**单个 1.5 MB 的 exe**，双击即用，不需要 Node、不需要装运行时——界面用系统自带的
**WebView2** 渲染（Windows 10/11 基本都内置）。界面代码与其它三种方式**完全同一套**，
外壳只提供原生窗口 + 中文菜单 + 「用 PDScope 打开」的文件关联能力：

```bash
PDScope.exe "D:\抓包\绿联70w.atkcc"     # 也可以直接带文件启动
```

用 .NET 9 + Windows Forms 承载 WebView2。单文件版 HTML 以资源形式嵌进 exe，首次运行解到
`%LOCALAPPDATA%\PDScope\ui\`，再用虚拟主机映射当站点提供。

### 2) 单文件版（最省事，任何系统都能用）

```bash
node tools/build-standalone.mjs     # 生成 dist/PDScope.html
```

`dist/PDScope.html` 是一个 **自包含 HTML**（CSS + JS 全部内联，约 155 KB）。
双击它 → 用系统默认浏览器打开 → 把 `.atkcc` 拖进窗口。不需要装 Node、不需要联网。

### 3) 本地服务（开发/调试用，功能最全）

```bash
node tools/serve.mjs                # 默认 http://127.0.0.1:5188
```

会自动打开浏览器。这个模式多一个「**载入示例**」按钮（自动扫描 `PDScope/` 和它上一级目录里的
`.atkcc`），其余与单文件版完全一致。

### 4) 桌面应用（Electron，跨平台）

```bash
npm install                         # 首次需要能访问网络下载 Electron 二进制（约 100 MB）
npm start                           # 自动先打包单文件版，再开原生窗口
npm run dist:mac                    # 在 macOS 上出 dmg / zip
npm run dist:win                    # 出 nsis 安装包 / 免安装 exe
npm run dist:linux                  # 出 AppImage
```

Electron 外壳只负责开窗口 + 原生菜单（打开抓包 / 切换主题 / 折叠筛选栏 / 关于），
解析和界面完全复用同一套前端代码，所以四种方式表现一致。

> 本机网络访问 GitHub Release 被阻断，Electron 二进制**没能下载成功**（`npm install` 会
> 以 ECONNRESET 失败），因此 Electron 这条路**尚未实测**，仅代码就绪。项目里的 `.npmrc`
> 已配好 npmmirror 镜像，网络允许时直接 `npm install` 即可；实测可用的桌面方案是上面第 1 种。

---

## 界面功能

| 能力 | 说明 |
|---|---|
| **报文表** | `# / SOP / 报文类型 / ID / 方向 / Obj / 时间 / VBUS-IBUS / 数据hex / 解析详情`，虚拟滚动，几万条也不卡 |
| **方向区分** | `Source`（供电方）/ `Sink`（受电方）/ `Plug`（线缆 e-marker）三色徽章；`SOP / SOP′ / SOP″` 分别标注 |
| **GOOD CRC 配对同色** | 每条 `GOOD CRC` 自动取「它所确认的那条报文」的颜色，而不是笼统的控制色。配对依据：GoodCRC 是对报文的即时应答（实测恒为紧邻 1 条），并用 PD 规范要求的 *MessageID 相同* 交叉校验；被确认报文本身是坏包时退化为纯邻近匹配。悬停报文类型可见 `确认 #N · 类型`，详情面板「链路概览」里也有「确认的报文」一栏 |
| **选择性屏蔽** | 按方向、SOP 类型、报文类别（控制/数据/扩展/VDM/异常）、**具体报文类型**（多选，带计数）、时间窗口、关键字任意组合过滤 |
| **快捷过滤** | 一键屏蔽 GOOD CRC 心跳包 / 只看 CRC 错误 / 只看功率协商 / 只看状态切换 |
| **时间窗口** | 底部 VBUS/IBUS 时间轴可**拖拽刷选**一段区间，表格立即联动 |
| **位域详情** | 右侧面板逐位展开报文头（B15 扩展 / B14-12 对象数 / B11-9 MsgID / B8 PowerRole / B7-6 Rev / B5 DataRole / B4-0 类型）、扩展头、每个数据对象（PDO/RDO/VDM）的全部字段 |
| **导出** | CSV（当前筛选结果）或 JSON（全部报文，含原始位域字段与 `ackOf` 配对序号） |
| **其它** | 明/暗主题、紧凑/舒适行高、上一条/下一条（↑↓）、`/` 聚焦搜索、`Ctrl/⌘+O` 打开、`T` 切主题、`G` 切 GOOD CRC 屏蔽、折叠筛选栏 |

界面截图见 `dist/e2e-screenshot.png`（自检时自动生成），配对同色的效果见 `dist/ack-colors.png`。

---

## `.atkcc` 格式（逆向结论，已与官方 ATK-C 输出逐字段比对一致）

`.atkcc` 本质就是一个 **ZIP**（`PK\x03\x04`）：

```
channel.ini            SamplingFrequency=2500      ← 单位 kHz，即 2.5 MHz 数字采样率
bus.ini                sample=N,vbus=14.651,ibus=1.274   ← 模拟量轨迹，sample 与数字采样同域
0/channel.ini          第 1 行 = 通道组号；第 2 行 = 总采样点数
0/<ch>-<idx>.bin       通道 <ch> 的第 <idx> 块，每块固定 1 MiB（deflate 压缩）
```

位流约定：

* **每个采样点 1 bit，LSB 优先**——一个字节里 `bit0` 是时间上**最早**的那一个采样。
* `0xFF` = 这 8 个采样点全为高；`0x00` = 全为低（空闲/末块尾部补齐）。
* 分块序号按**数值**排序（`0-9` 在 `0-10` 之前）。
* 多通道文件每个通道块数相同，尾部用 `0x00` 补齐，需要按最后一个非零字节裁剪。

解码链：

```
1 bit/采样 ──► 游程/边沿提取 ──► BMC 双相标记码状态机 ──► 4B5B 符号 ──► PD 报文（SOP/报文头/数据对象/CRC32）
```

* 采样率 2.5 MHz，BMC 时钟 600 kHz → `UI = 1.6667 µs ≈ 4.167 采样点`；**1 bit = 2 UI**。
  * `'1'` 位：位周期内两次跳变 → 两段 ~1 UI 的短游程
  * `'0'` 位：位周期内一次跳变 → 一段 ~2 UI 的长游程
* 判决门限 `1.5 UI = 2.5 µs`（≈6 采样点），空闲门限 `3 UI = 5 µs`（≈13 采样点）。
* 4B5B 表、SOP/SOP′/SOP″ 有序集、报文头字段、PDO/RDO/VDM/扩展报文解析，全部对齐 libsigrok
  `usb_power_delivery` 解码器语义。

> **关键坑**：位序必须用 **LSB 优先**。用 MSB 解出来的游程长度会散落在 1~3 个采样点，
> 只能得到一堆 CRC 全错的假包；换成 LSB 后游程干净地聚在 4/8 采样点，报文头的 SOP 前导
> 立刻呈现规整的 `1010…`，CRC 全部通过。

---

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
│  └─ ui/                 界面（index.html / styles.css / app.js）
├─ electron/              主进程 + preload（跨平台桌面外壳）
├─ shell-win/             Windows 原生外壳（.NET 9 + Windows Forms + WebView2）
│  ├─ Program.cs          入口与命令行解析
│  ├─ MainForm.cs         窗口、原生菜单、界面装载、文件喂入
│  ├─ MainForm.SelfTest.cs  外壳无头自检（含自渲染截图）
│  └─ ShellLog.cs         落盘日志（WinExe 没有控制台）
├─ build/                 icon.png / icon.ico（两个外壳与打包共用）
├─ tools/
│  ├─ cli.js              命令行解析（table / --json / --csv）
│  ├─ selftest.js         协议层合成用例自检（8 条）
│  ├─ ackcheck.js         GOOD CRC 配对校验（跨全部真实抓包）
│  ├─ e2e.mjs             无头浏览器端到端自检 + 截图
│  ├─ serve.mjs           本地静态服务 + 示例文件接口
│  ├─ build-standalone.mjs  打包单文件 dist/PDScope.html
│  ├─ make-icon.py        生成应用图标（PIL 画方波 + PD 字样）
│  └─ _explore/           逆向过程留档（位序/门限扫描、波形渲染，已被上面工具取代）
└─ dist/                  产物：PDScope.html、截图
```

---

## 自检

```bash
node tools/selftest.js                                  # 协议层 8/8（合成报文，验证 4B5B/PD/CRC 语义）
node tools/ackcheck.js                                  # GOOD CRC 配对（5 份真实抓包，1141 条全部配对）
node tools/e2e.mjs --port 5188                          # 界面 18 项（http 模式）
node tools/e2e.mjs --file dist/PDScope.html \
     --drop "../制糖40w-ip18pro.atkcc"                   # 单文件版 + 真实抓包拖拽解码
npm test                                                # = selftest + ackcheck + e2e

npm run shell:win:test                                  # Windows 外壳自检 14 项（真实 WebView2）
```

`ackcheck.js` 校验 `linkGoodCrc()`：配对覆盖率、是否自指、方向是否相反、
**双方 CRC 完好时 MessageID 是否相同**（PD 规范的硬约束）、配对距离。
当前 5 份抓包共 1141 条有效 GOOD CRC **100% 配对成功**，1100 条可校验的配对
**MessageID 全部一致**，最远距离恒为 1 条报文。

`e2e.mjs` 直接说 Chrome DevTools Protocol（用系统已装的 Chrome/Edge，不下载浏览器），
会校验：页面骨架、抓包解码、虚拟滚动、方向过滤、关键字搜索、时间轴绘制、主题切换、无控制台异常，
最后自动截图。加 `--drop <文件>` 可注入真实抓包；`--eval "<js>"` 进调试模式，
在页面里跑任意表达式并打印结果（此时 `--drop` 依然生效，便于就地排查界面问题）。

**Windows 外壳自检**（`PDScope.exe --selftest`）在真实 WebView2 里跑完整链路：
内嵌界面是否加载、宿主桥是否注入、原生菜单、样式、喂入抓包 → 解码 → 表格渲染 →
配色区分 → 时间轴 → 主题切换 → 关键字筛选 → 页面是否有异常，
最后用 WebView2 自带的 `CapturePreviewAsync` **抓一张渲染结果截图**
（不依赖系统截屏 API）。结果写到 `--report <txt>`，失败会带日志路径，退出码非 0。

```bash
PDScope.exe --selftest --wait 25 \
  --report dist/shell-selftest.txt --shot dist/shell-shot.png "../制糖40w-ip18pro.atkcc"
```

启动阶段的问题会记到 `%LOCALAPPDATA%\PDScope\shell.log`（WinExe 没有控制台，
出问题时这是唯一的线索）。

命令行解析：

```bash
node tools/cli.js "../制糖40w-ip18pro.atkcc"              # 表格
node tools/cli.js "../绿联70w-ip18pro.atkcc" --json      # JSON
node tools/cli.js "../苹果40w-ip18pro.atkcc" --csv       # CSV
node tools/cli.js "../apple_40w_avs_iphone_air.atkcc" --scan   # 各通道活动度
```

实测样本（`.atkcc` → 报文数 / CRC 错误）：

| 文件 | 通道 | 报文 | CRC 错误 |
|---|---|---|---|
| 制糖40w-ip18pro | 1 | 44 | 0 |
| 安可60w-ip18pro | 1 | 44 | 0 |
| 绿联70w-ip18pro | 1 | 348 | 0 |
| 苹果40w-ip18pro | 1 | 738 | 6 |
| apple_40w_avs_iphone_air | 24 | 1048 | 5 |

---

## 已验证的一致性

以 `制糖40w-ip18pro.atkcc` 第 0 条为例，本工具输出与官方 ATK-C 截图**逐字节一致**：

```
#0  SOP  SRC  ID 0  00:00:02.858  1.458V / 0.004A
2C 91 01 28 2C D1 02 00 2C C1 03 00 0A B1 04 00 C8 40 06 00 32 32 40 C9 C8 28 04 E0
[Fixed] 5V 3A (15W) · [Fixed] 9V 3A (27W) · [Fixed] 12V 3A (36W) · [Fixed] 15V 2.66A (39.9W)
· [Fixed] 20V 2A (40W) · [PPS] 5/16V 2.5A [limited] · [SPR_AVS] 9~20V 15V:2.66A 20V:2A
```

时标、VBUS/IBUS、数据 hex、解析备注全部对得上。

---

## 已知限制

* **Windows 外壳依赖 WebView2 运行时**。Windows 10/11 基本自带（本机为 154.x），
  缺失时外壳会给出提示并附下载地址；此时也可直接用单文件版。
* **受限环境会自动降级启动**。远程桌面、虚拟机、或装了行为管控类安全软件的机器上，
  WebView2 的 GPU 与沙箱辅助进程可能起不来，现象是「窗口出来了但内容空白」。
  外壳检测到这种进程失败风暴会**自动带 `--disable-gpu --no-sandbox` 重启一次**
  （只重试一次，不会循环）。也可手动指定：

  ```bash
  PDScope.exe --browser-args "--disable-gpu --no-sandbox"     # 或用环境变量
  set PDSCOPE_BROWSER_ARGS=--disable-gpu --no-sandbox
  ```
* **Electron 二进制需联网下载，本机未跑通**。访问 GitHub Release 被阻断，`npm install`
  会以 ECONNRESET 失败，所以第 4 种方式**代码就绪但未实测**。项目 `.npmrc` 已配 npmmirror
  镜像，网络允许时可直接安装；日常建议走第 1 种（Windows 原生）或第 2 种（单文件版）。
* **macOS / Linux 桌面版未实测**。目前只验证了 Windows 外壳；跨平台请走单文件版
  （任何系统都能跑），或补齐 Electron 依赖后自行打包。
* **macOS 打包未签名**。`npm run dist:mac` 产出的是未公证的 dmg，首次打开需要右键 →「打开」。
  想彻底绕开这一步，直接用单文件 `dist/PDScope.html`。
* **CRC 错误不是 bug**。`苹果40w`（6/738）、`apple_40w_avs`（5/1048）里少数报文本身就是坏包
  （真实链路干扰 / 抓包窗口切在报文中间），工具会在表格里标红并在时间轴上加高亮竖线。
* `bus.ini` 里的 VBUS/IBUS 是阶梯保持采样，时间轴按最近邻取值，不做插值。
