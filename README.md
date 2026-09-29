# PDScope

**USB Power Delivery 抓包解析上位机**

直接打开抓包文件，把 PD 报文还原出来并逐字段溯源。三种来源**按文件内容自动分流**：

| 来源 | 文件 | 存的是什么 | 解析路径 |
| ---- | ---- | ---------- | -------- |
| 正点原子 **ATK-C** | `.atkcc` | CC 线的原始电平采样（ZIP + 1bit/采样） | 分块 → 边沿 → BMC → 4B5B → PD 报文 |
| **POWER-Z**（ChargerLAB） | `.sqlite` | 分析仪**已经解好的逻辑字节** + ADC 采样序列 | SQLite 读表 → Raw blob 拆事件 → 同一套 PD 语义解析 |
| **POWER-Z**（录制 UFCS） | `.sqlite` | 同上，但录的是 **D+/D- 上的 UFCS**（融合快速充电） | SQLite 读表 → 定位 UFCS 帧 → 独立 UFCS 解析库（UART/消息头/CRC-8） |

`.sqlite` 再按表名细分：有 `pd_table` 走 USB PD，有 `ufcs_table` 走 UFCS。
两条路径解出来的报文对象**同形**，所以界面、筛选、详情、时间轴、导出只有「协议相关的那几处」分叉。

解析与界面全部在前端完成 —— **零依赖、零网络、不上传任何数据**。支持 **Windows / macOS / Linux**。

## 能做什么

* **多份抓包同开**：每份一个标签，各记各的筛选条件、时间窗口、选中行与通道号，来回切不串味。
* **方向一眼分得清**：`Source` / `Sink` / `Plug` 三色徽章；UFCS 还能标出物理链路 `D+ / D-`。
* **想屏蔽什么就屏蔽什么**：按方向、报文类型、类别、时间窗口、关键字任意组合过滤，
  一键屏蔽 GoodCRC 心跳包、只看 CRC 错误、只看功率协商。
* **逐位溯源**：右侧面板展开报文头每一位与每个数据对象（PDO / RDO / VDM / 扩展消息）的全部字段。
* **CRC 如实报**：分析仪没存 CRC 就写「未记录」，不替对方的数据背书。
* **底部时间轴**：VBUS / IBUS（分析仪还多一路差分线）可拖拽刷选区间，表格立即联动。
* **导出**：CSV（当前筛选结果）或 JSON（全部报文，含原始位域与配对序号）。
  桌面版还能**不开界面**从命令行导 CSV：`pdscope.exe 抓包.atkcc --csv`（见 [桌面版](doc/desktop.md)）。

截图与功能全表见 [doc/ui.md](doc/ui.md)。

## 快速开始

**只想看看效果** —— 不用装任何东西：

```bash
node tools/build-standalone.mjs         # 生成 dist/PDScope.html
# 双击 dist/PDScope.html，把 .atkcc / .sqlite 拖进窗口（可以一次拖好几份）
```

**想要一个真正的桌面应用**：

```bash
npm install        # 只装 tauri-cli（几 MB），不会下载浏览器内核
npm run app:exe    # 只出可执行文件（绿色版，完全离线）
npm run app:build  # 出当前平台的安装包（Windows: PDScope_0.3.1_x64-setup.exe）
```

命令行解析（不起界面）：

```bash
# 装了桌面版：同一个 exe，不开窗口直接导 CSV（与界面「另存为」逐字节同款）
pdscope.exe "D:\抓包\绿联70w.atkcc" --csv          # 输出到同目录的 绿联70w-ch0.csv
pdscope.exe "D:\抓包\山泽60w.sqlite" --csv 出.csv   # 也可以指定输出路径 / --channel / --limit / --out -

# 只有 Node、没装桌面版：
node tools/cli.js "../制糖40w-ip18pro.atkcc"            # 表格
node tools/cli.js "../山泽60w-ip18pro.sqlite" --csv     # .sqlite 自动识别，CSV 到标准输出
node tools/cli.js "../ufcs_vivo_x300u.sqlite"           # UFCS 导出，自动识别
```

## 文档

README 只留入口，细节按主题分在 `doc/` 下：

| 想看什么 | 去哪 |
| -------- | ---- |
| 两种交付形态、各平台怎么用、浏览器要求 | [doc/delivery.md](doc/delivery.md) |
| 桌面版构建、菜单、标签栏 | [doc/desktop.md](doc/desktop.md) |
| CI 构建（10 个目标、产物体积） | [doc/ci.md](doc/ci.md) |
| 界面功能逐条说明 | [doc/ui.md](doc/ui.md) |
| `.atkcc` 容器格式（逆向结论） | [doc/format-atkcc.md](doc/format-atkcc.md) |
| POWER-Z `.sqlite` 与 UFCS 容器格式 | [doc/format-powerz.md](doc/format-powerz.md) |
| PD / UFCS 解析库怎么复用 | [doc/lib-pd.md](doc/lib-pd.md) · [doc/lib-ufcs.md](doc/lib-ufcs.md) |
| 目录结构、改图标 | [doc/structure.md](doc/structure.md) |
| 自检与实测样本统计 | [doc/testing.md](doc/testing.md) |
| 已知限制 | [doc/limits.md](doc/limits.md) |
| 环境准备 | [doc/env.md](doc/env.md) |

## 目录结构

```
src/js/pd/      USB PD 解析库（零依赖，可整目录复用）
src/js/ufcs/    UFCS 解析库（零依赖，可整目录复用）
src/js/core/    容器与波形内核（ZIP / SQLite / BMC / 编排 / CSV 导出）
src/ui/         界面（三种形态共用同一份）
src-tauri/      Tauri 桌面外壳（三平台同一份 Rust）
dist/           前端产物：只有 PDScope.html 一个文件
artifacts/      自检截图与报告（不入库）
doc/            文档（本目录）
tools/          构建、自检、排查脚本
```

完整树与逐文件说明见 [doc/structure.md](doc/structure.md)。

## 自检

```bash
node tools/version-check.mjs     # 版本号一致（先跑它，最便宜）
node tools/syntax.mjs            # 全量语法检查（几秒）
node tools/selftest.js           # 协议层合成用例 91 项（含 CSV 导出格式 15 项）
node tools/ackcheck.js           # GoodCRC 配对（跨真实抓包）
npm run e2e                      # 界面 30 项（ATK-C）；36 项（.sqlite）；39 项（多份）
npm run app:csv                  # 桌面版命令行导出：exe 的 CSV 与 node CLI 逐字节比（需先 app:exe）
npm run perf:worst               # 「打开卡不卡」探针
npm run check                    # 上面全部
```

自检需要上一级目录里有抓包样本。全部工具、各项测什么、实测样本统计见 [doc/testing.md](doc/testing.md)。

## 已知限制（摘）

* 桌面版**不交叉编译**：哪个系统构建就出哪个系统的包（各平台的包由 [CI](doc/ci.md) 一次出齐）。
* 桌面版依赖系统自带 WebView；没有就退回单文件版。命令行的 `--csv` 导出同样要它，
  而且要有图形环境（解析跑在前端）；纯服务器上用 `node tools/cli.js --csv`。
  导出的 CSV **一律是 UTF-8**（与终端/控制台类型无关，落盘带 BOM 供 Excel 直接打开）；
  Windows 上 shell 不会等 GUI 程序，脚本里请用 `start /wait`（详见 [桌面版](doc/desktop.md)）。
* POWER-Z 的 PD 报文**不含 CRC**，界面写「未记录」而不是「全通过」。
* UFCS 的容器（Raw blob）格式是**从真实抓包逐字节反推**的，没有规范背书；认不出就退回穷举定位。
* UFCS 状态事件行的语义未确证，界面只报条数，不硬起「插入 / 拔出」这种名字。

完整清单见 [doc/limits.md](doc/limits.md)。

> 本项目由作者主导，**使用 AI 编程助手 DeepSeek V4.1 Flash 辅助开发**。
