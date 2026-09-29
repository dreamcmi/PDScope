# PDScope 文档

README 只留「是什么、怎么跑起来」，细节都在本目录里按主题分册。

| 文件 | 内容 |
| ---- | ---- |
| [delivery.md](delivery.md) | 一份代码两种交付形态：单文件 HTML 版 / Tauri 桌面版 / 本地服务，各平台怎么用、浏览器要求、三种形态能力对照 |
| [desktop.md](desktop.md) | 桌面版构建（为何不能交叉编译）、四条打开抓包的方式、**命令行导出 CSV（`--csv`）**、多份抓包与标签栏、中文菜单表 |
| [ci.md](ci.md) | CI 构建：10 个目标怎么落地、归档体积为什么差一个数量级、为什么没有 Win10 产物、CI 里跑哪些自检 |
| [ui.md](ui.md) | 界面功能逐条说明（报文表、方向、筛选、详情面板、UFCS 视图…）与截图索引 |
| [format-atkcc.md](format-atkcc.md) | `.atkcc` 容器格式（逆向结论）、解码链、采样率「声明 → 波形自检 → 兜底」三级策略 |
| [format-powerz.md](format-powerz.md) | POWER-Z `.sqlite` 格式：`pd_table` / `ufcs_table`、Raw blob 事件结构、UFCS 容器布局、自写 SQLite 读取器 |
| [format-pdstream.md](format-pdstream.md) | POWER-Z `.pdStream` 格式：只有 `pd_table` 的二进制记录流、结构自证的识别判据、与 `.sqlite` 的差别（没有 ADC 波形） |
| [lib-pd.md](lib-pd.md) | USB PD 解析库 `src/js/pd/`：用法、比官方上位机多补了什么、规范条目对照 |
| [lib-ufcs.md](lib-ufcs.md) | UFCS 解析库 `src/js/ufcs/`：用法、覆盖的规范条目、字节序 / 方向 / CRC 三个易踩点 |
| [structure.md](structure.md) | 目录结构、`assets/` 与 `dist/` 的分工、改图标的四步 |
| [testing.md](testing.md) | 全部自检工具怎么跑、各项测什么（含 CSV 导出自检）、性能探针与压力样本、实测样本统计表 |
| [limits.md](limits.md) | 已知限制（构建打包 / 数据口径 / UFCS 专属） |
| [env.md](env.md) | 环境准备：三平台构建依赖、crates 与 npm 镜像 |
