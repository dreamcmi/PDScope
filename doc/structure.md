# 目录结构

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
├─ doc/                   文档：README 的详细版分册（本目录）
├─ .github/workflows/     CI：10 个目标一起构建（build.yml，见 [CI 构建](ci.md)）
└─ tools/
   ├─ cli.js              命令行解析（.atkcc / .sqlite 自动分流；table / --json / --csv / --rate）
   ├─ version-check.mjs   版本号一致性检查（外加文档里的产物名提示项；自检链第一步）
   ├─ syntax.mjs          全量语法检查（node --check，几秒）
   ├─ ci-checksum.mjs     给 CI 产物生成 .sha256 校验和（三平台同一套命令）
   ├─ selftest.js         协议层合成用例自检（含手搓最小 SQLite 的 POWER-Z 路径回归）
   ├─ ackcheck.js         GoodCRC 配对校验（跨全部真实抓包）
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

## 图标怎么改

改图标：`npm run icon` → `npm run icon:tauri` → `npm run icon:web` → `npm run build`。

* `icon:web` 这一步不能省 —— 界面里的顶栏 logo 和标签页 favicon 是**内联的 PNG data URI**
  （单文件版要能脱离同目录资源独立打开，所以不能引外部文件）。它跟打包图标同源，但物理上是
  `src/ui/index.html` 里的一份副本，改完图标不同步就会「exe 换了新图标、网页还是旧的」。
  `npm run icon:check` 可以校验这份副本是否已过期（不一致时非 0 退出，适合放进 CI）。
* 深色顶栏下图标底（深蓝）与面板色接近，`.logo` 上挂了一点点 `drop-shadow` 描边把形状提出来；
  必须用 `drop-shadow`（跟随 PNG 的 alpha 轮廓），换 `box-shadow` 会画成方框、四个角露出来。
* `.icns` 是手写容器 —— Pillow 只能读不能写；不用 `tauri icon` 是为了让 Rust 侧能脱离 Node 独立构建。

---

相关：[交付形态](delivery.md) · [桌面版构建](desktop.md) · [自检](testing.md)
