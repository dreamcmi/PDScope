# 自检

```bash
# 版本号 / 语法 / 协议层（纯 Node，秒级）
node tools/version-check.mjs              # 版本号是否一致（最便宜，先跑它）
node tools/syntax.mjs                     # 全量语法检查（几秒；界面脚本错一个字符就是白屏）
node tools/selftest.js                    # 合成用例 91 项：4B5B / PD / CRC + 采样率 + plug 信令 + POWER-Z / UFCS 路径 + CSV 导出
node tools/ackcheck.js                    # GoodCRC 配对（跨 5 份真实抓包）
node tools/powerz-inspect.mjs             # POWER-Z（.sqlite，PD 与 UFCS）全样本体检（需要样本文件，非 0 退出即异常）

# 界面 66 项（ATK-C，含 1 项跳过）/ 73 项（POWER-Z·PD）/ 75 项（多份抓包，第一份是 .atkcc）/ 73 项 + 1 跳过（UFCS）
# （走系统已装的 Chrome/Edge，不下载浏览器）
npm run e2e                               # 单文件版，自包含（**不重建 dist** —— 改了 src/ui/ 先跑 npm run build）
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

# 桌面版命令行导出 CSV（不开窗口；样本现造，无需私有抓包）
npm run app:csv                           # exe --csv 导出的 CSV 必须与 tools/cli.js --csv 逐字节相同
npm run app:csv:self                      # 只验参考侧（不跑 exe，没有 Rust 工具链也能跑）

# 一把梭（= npm test + app:test + app:test:open + app:csv；不含 perf:* 与 powerz:inspect）
npm run check
```

> 自检需要根目录上一级存在抓包样本文件（`.atkcc` / `.sqlite`）；`--drop` / `--open` 都是相对 `PDScope/` 的路径。

## version-check.mjs

把版本号在五个文件里对一遍：`package.json`、`src-tauri/tauri.conf.json`、
`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src/ui/app.js`，外加文档里写着的安装包产物名。
这几处分别被 npm、打包器、Cargo、锁文件、界面「关于」读走，只改一处不会报错，
只会悄悄装出一个「文件名 0.4.0、关于里写 0.3.1」的包 —— 所以放在自检链最前面拦。

## ackcheck.js

校验 `linkGoodCrc()`：配对覆盖率、是否自指、方向是否相反、
**双方 CRC 完好时 MessageID 是否相同**（PD 规范的硬约束）、配对距离。
当前 5 份抓包共 1141 条有效 GoodCRC **100% 配对成功**，1100 条可校验的配对
**MessageID 全部一致**，最远距离恒为 1 条报文。

## selftest.js

用例共 **91 项**，分七组。

* **第一组（8 项）** 在合成报文的**字段级**校验 4B5B / PD / CRC 语义。
* **第二组（4 项）** 把同一串报文按 **1.5 / 2.5 / 4 / 6 MHz** 重新采样一遍，检查：用真实采样率能解出全部报文、
  波形反推的采样率误差 < 1%、按反推值解码同样得到全部报文，并确认「采样率写错一倍就一条也解不出来」——
  这正是采样率必须动态解析的原因。
* **第三组（6 项）** 专测 **plug 信令与扩展消息**：SOP' 上 e-Marker 的 Discover Identity 全线缆 VDO、
  端口侧的 UFP + Padding + DFP 三件套、EPR_Source_Capabilities 的 PDO 列表、
  **分块扩展消息的跨块 PDO 拼接**（拼不回来要标注而不是猜）、BIST 模式在 PD 2.0 与 3.x 下的不同含义、
  Discover SVIDs 的两两成对。
* **第四组（6 项）** 只测 `channel.ini` 的**采样率声明解析**：多键名（`SamplingFrequency` /
  `SampleRate` / 小写下划线写法）、多单位（裸数字 = kHz、`MHz`、`kHz`）、
  以及「只有 `Resolution` 或整个键都缺」时退回默认值。
* **第五组（18 项）** 专测 **POWER-Z 的 `.sqlite` 路径（USB PD）**：Raw blob 的插入/拔出/包裹报文拆帧与
  「拼不通要如实标截断」、`decodeWire` 的语义等价与「CRC 未记录 ≠ 通过」、SQLite 页/记录读取、
  `PowerzCapture` 的端到端，以及「不是 POWER-Z 的 SQLite 要判为不支持」。
* **第六组（34 项）** 专测 **UFCS**（见下）。
* **第七组（15 项）** 专测 **CSV 导出格式**（`src/js/core/csv.js`，见下）。

第五、第六两组都用**手搓的最小 SQLite 库**做输入，不依赖任何真实样本，CI 上也能跑；
第七组连容器都不用，喂的是手搓的报文对象。

### UFCS 那一组（34 项）测什么

CRC-8 与一份**表驱动**参照实现随机比对 400 组（写法不同，两边必须一致，防转录错误）；
消息头四段位域；控制 / 数据 / 厂家自定义三类消息；
`Output_Capabilities` / `Request` / `Cable_Information` / `Sink_Information_Extended` / `Refuse`
的**逐字段**取值；CRC 错误被识别但其余字段不受影响；数据长度不符要报出来；
方向与规范单向命令表不符要告警；容器前缀定位的四种情形——**4B 时间戳 + 带 CRC**、
**时间戳 + 链路字节**、**不存 CRC**、**一行两帧**；
以及**实测归纳的那套 9 字节容器布局**：前缀/游标/长度域/Training 四个字段逐一校验，
外加三条**反证**（长度域不符、Training 字节不是 `0xAA`、`flag` 越界 —— 都不许硬认）；
状态事件行 `ts │ code │ 00 00 │ 0x40` 能被单独认出、且不与报文混淆。

最后手搓一个含 5 条真实 UFCS 帧（其中 1 条故意打坏 CRC）+ 1 行状态事件 + 1 行残行的 SQLite，
走 `PowerzCapture` **端到端**校验：报文顺序与类型、方向与链路（D+/SRC … D-/SNK）、
**方向全部有硬依据（`ufcsDirInferred === 0`）**、报文仍带容器来源字段（供自动化与排查取用，
**但详情面板里一个字都不出现** —— 有专门一条断言盯着，防止将来又被放回界面）、ACK 与被确认报文配对、
状态事件单独统计不计入报文、统计口径（`badCrc=1 / crcUnknown=0 / 残行=1`）、
以及模拟量可用且**不再标注「未实现」**。

### CSV 那一组（15 项）测什么

CSV 有**三个出口**（界面「另存为」、桌面版命令行 `--csv`、`node tools/cli.js --csv`），
三处都只调 `src/js/core/csv.js`，所以这一组盯的就是「三个出口共同承诺的那点格式」，
喂的是**手搓的报文对象**（不碰容器与解码，格式回归与解析路径解耦）：

带 BOM / CRLF 行尾 / 结尾不留空行、`bom: false` 时前三个字节干净、字段一律加引号且内部引号翻倍、
**每行列数与表头一致**（将来加列漏填会立刻发现）、同一列在两种协议下的不同含义
（第 6 列 PD 是 `Objects`、UFCS 是 `Bytes` 且取 `dataLen`）、**CRC 三态**（`OK` / `BAD` / 空 ——
「未记录」不许写成 `OK`）、时标两列（`hh:mm:ss.mmm` 与裸毫秒）、默认文件名 `-ch<通道>.csv`、
零报文时仍输出表头，以及导出件 `csvExport()` 那一整包：建议文件名 / 通道 / 协议 / 来源、
`limit` 只截行数不动报文总数、摘要里如实报「CRC 未记录 / 自动选道 / 已截断」、采样率按量级取单位。

## pd-regress.mjs / pd-inspect.mjs

**`pd-regress.mjs`** 把重构前的解码器从 `git HEAD` 取出来，与新库在同一份抓包上
**逐包逐字段对比**（sop / msgType / header / crcOk / nObjects / dataWords）。
当前 7 份抓包共 2414 条报文，**报文条数逐样本完全一致**，除「扩展消息新增了 hex 回填」
这一处预期差异外**零字段差异**。`pd-inspect.mjs` 则单独抽取线缆链路与扩展消息的解析详情，
并在每个样本前打一行「报文 / 线缆链路 / 扩展 / 坏 CRC / 警告」汇总，便于人工核对与全样本体检。

## e2e.mjs

直接走 Chrome DevTools Protocol（用系统已装的 Chrome/Edge，不下载浏览器），
**66 项**校验：页面骨架、抓包解码、虚拟滚动、方向过滤、关键字搜索、时间轴绘制、主题切换、
采样率来源标注、**详情面板拖拽改宽**（用真实鼠标事件走一遍 pointer capture，验证加宽 / 落盘 /
收起还原 / 超限夹紧 / 双击复位）、**收起后右缘出现展开把手**、
**标签栏出现 / 顶栏文件 chip 跟随当前标签 / 关闭全部后标签栏收起并回到引导页**、
**横轴时间刻度**（见下）、**曲线区可拖高**（见下）、**时间轴纵轴的缩放 / 平移**（见下）、
无控制台异常，最后自动截图。
加 `--drop <文件>` 可注入真实抓包；`--eval "<js>"` 进调试模式，在页面里跑任意表达式并打印结果。

### 横轴时间刻度那一组（4 项）

时间轴底下那条 18px 的带子原本是留白，整张图只有左右两个值刻度、读不出时间。这一组守着它别空回去：
刻度是**五等分**且每格都有字、**首格是 0、末格等于整段时长**、**单位随时长自适应**
（不到 1s 用 `ms`，不到 60s 用 `s`，更长用 `m:ss`；短抓包若写死「0.00s」五格全是同一个数）、
以及**直接数底部那条带子的像素**（`axisBandTop` 以下 > 200 个非空像素）——
不看 DOM、只看画布，空回去就立刻失败。读的是 `PDScope.timeline()` 的 `xTicks / axisBandTop`。

### 曲线区高度那一组（15 项）

底部那块曲线区以前是写死的 `height:158px`，这一组守着它「能拖到半个屏以上」：
初始是默认高度、**上限确实 ≥ 中间栏的一半**（同时保证报文表至少留得下几行）、
**用真实鼠标事件往上拖分隔条**（走 pointer capture）后**拖 260px 就正好长 260px**（±6px ——
早先只断言「涨了 200 就行」，于是「位移被反复累加、一拖就顶到上限」的 bug 溜了过去）、
**原地单击不改变高度**、**反向拖也 1:1**、画布跟着变高（曲线真的画大了，不是留白）、
拉高后曲线区仍然画满、**高度落盘** `localStorage.pdscope.tlH`、
**拖过头被夹在上限**、聚焦分隔条后 `↓` 微调 24px、`Home` 到最矮、**双击恢复默认**并落盘。
最后两项盯「窗口临时变小」：用 CDP 把视口压矮，**渲染被夹住但 `localStorage` 不许被改写**，
视口恢复后用户调的高度要**自动还原**（否则把窗口缩一下再放大，自己调好的高度就永久丢了）。
读的是 `PDScope.timeline()` 里的 `paneH / paneMin / paneMax`，同样不碰 DOM 结构。

### 时间轴纵轴那一组（18 项）

时间轴以前把纵轴量程钉死在「数据最大值 ×1.12」，这一组守着它变成可调之后别再退回去：
初始是自适应（`zoom=1 / offset=0`）、**Ctrl+滚轮放大**（以光标处为锚点，动画布真的重绘 —— 用画布像素
指纹比对，不是只看状态；普通滚轮在曲线上不做任何事）、**按行报数的滚轮也认**
（`deltaMode=1`，Firefox 就是这么给的；不归一的话一格只放大 1.005 倍，等于没反应）、
放大后可见量程收窄、「复位视图」按钮点亮、**Shift 上下拖动平移**
（往下拖 = 视野往高值走）且不影响缩放、**不在曲线上乱改时间窗口**、**左右刻度栏里拖也能平移**、
**两档各记一套**（切到差分线是它自己的默认值，切回来还是调过的样子）、**双击曲线区复位**、
按钮回普通态、「复位视图」一键回到自适应、**悬停提示框贴着光标**（画布顶上还有一格表头，
坐标算错会飘高约 28px），以及两条反向保护：**曲线区里的普通左键拖动仍然是横向刷选时间**
（这条当年是坏的 —— `drawTimeline` 重建 `TL` 对象时把 `TL.drag` 抹掉了，预览那一步还会读
`TL.drag.x` 抛异常）、**按键已松开的移动事件不许继续改视图**（mouseup 丢了也能自己收尾，
不会永久卡在拖动态）。
读的是 `PDScope.timeline()` 这个纯数据接口，不碰 canvas 内部结构。

拖进去的若是 `.sqlite`，**另外再跑 7 项**（6 项分析仪专属 + 1 项「差分线档」启用 —— ATK-C 的 `bus.ini`
只有两路，那一档在那边是跳过），共 **73 项**：来源标注为 POWER-Z、
CRC 统计口径、插拔事件计数、差分线视图可切换（PD 是 CC1/CC2、UFCS 是 DP/DM，档名与标题跟着文件走）
且切换后重绘并换标题、切回电压/电流。所以 `e2e:powerz` 是 POWER-Z 路径的界面级回归。

这份样本是 PD 还是 UFCS 由顶栏「来源」chip 判定，几处断言的措辞跟着换：PD 的 CRC 恒为
「未记录（分析仪不存）」；**UFCS 存不存 CRC 由容器决定**，断言只要求「未记录 / 全通过 /
错误 N」三者之一、且不谎报。PD 的「插拔」chip 必须有；UFCS 容器一般不带连接/断开标记，
没有就跳过而不判失败（**有却不显示**才算错 —— 判据是「如实」，不是「必须有」）。
同理「首行内容合理」与「头位域块与协议匹配」也不能共用一套词表：前者的类型名
（`Source_Capabilities` / `Output_Capabilities`）与后者的块名（`报文头` / `消息头`）
两种协议各不相同，两个分支都必须**只出现其一**。

UFCS 还额外断言一条：**方向全部有硬依据、无靠地址推断的**。读的是给自动化用的稳定接口
`PDScope.tabs()` 里那份 `ufcs` 摘要（`dirFromLine` / `dirInferred` / `frames`），
不碰 DOM 结构 —— 断言「`dirInferred === 0`」。猜出来的方向在双向命令（`Request` / `ACK`）
上会直接反，是肉眼最难发现的一类错，所以值得单独派一条断言盯着。

若这份样本**一行报文都没定位出来**（容器格式对不上，或本来就没有报文），依赖「列表里有行」的
11 项断言会**显式跳过**并计入汇总（`.sqlite` 还会再跳过 CRC 口径 / 插拔计数两项），而不是判失败 ——
那些断言在这份样本上本就无从谈起。同时改测「零报文路径」本身：提示条说清原因、
统计行 / 空态用的是「没有一行能认出」而非「筛选后为空」、时间轴照常绘制、把手能重开详情面板。
跳过数会打进汇总行，避免「全绿」被误读成「所有断言都跑过了」。
这一档的具体条数取决于样本走到哪一步（有没有提示条、有没有差分线档），所以这里只写口径、
不写死汇总数字 —— 顺带说明 e2e 判断「零报文」的依据是**状态行没有条数 + 页面给出了提示条**，
两个条件缺一不可（本机合成样本只满足前者，所以那组断言不会被认成零报文档）。

加 `--drop2 <文件>` 则进入**多份抓包**模式（`npm run e2e:multi`，共 **75 项**：
66 项基线 + 多份专属 8 项 + 「关掉一个标签后另一个接上」1 项。注意**第一份是 `.atkcc`**，
所以「分析仪专属」那 6 项与差分线档那 1 项不跑 —— 想让它们也跑就把 `.sqlite` 放在第一份，那是 73 项）：
先按普通路径注入第一份、**故意改掉它的筛选**（关掉 SNK）并记下条数，再注入第二份，然后断言
标签栏由一条变两条、两份是**不同来源**（`.atkcc` 与 `.sqlite` 各记各的）、报文条数**各自独立**、
**新标签的筛选是默认值**（没有被上一份污染）、切回第一份后筛选面板已还原且条数与切走前一致；
最后用 `×` 关掉一个标签验证另一个平滑接管，`PDScope.closeAll()` 验证标签栏收起并回到打开引导页。
这些断言读的是 `window.PDScope.tabs()` 返回的**纯数据数组**（名字 / 状态 / 来源 / 条数 / 是否激活），
不碰标签栏的 DOM 结构 —— 外观再改，测试也不会跟着碎。

## perf-probe.mjs

回答的是另一类问题：「打开这个文件要多久、卡在谁身上」。
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

## make-test-atkcc.mjs

用来造压力样本，因为**真实抓包复现不出卡顿**：

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

## tauri-e2e.mjs

连的是 Tauri 真正在跑的那个 WebView2（靠
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

## 命令行解析（不起界面，适合脚本里用）

```bash
node tools/cli.js "../制糖40w-ip18pro.atkcc"                   # 表格
node tools/cli.js "../绿联70w-ip18pro.atkcc" --json           # JSON
node tools/cli.js "../苹果40w-ip18pro.atkcc" --csv            # CSV（与界面导出同款，无 BOM）
node tools/cli.js "../苹果40w-ip18pro.atkcc" --csv --limit 20  # 只导前 20 条
node tools/cli.js "../apple_40w_avs_iphone_air.atkcc" --scan  # 各通道活动度
node tools/cli.js "../绿联70w-ip18pro.atkcc" --rate 2400000    # 强制指定采样率（排查用）
node tools/cli.js "../山泽60w-ip18pro.sqlite"                  # POWER-Z 导出，自动识别
node tools/cli.js "../ufcs_vivo_x300u.sqlite"                  # UFCS：解出 UFCS 报文表（.sqlite 自动分流）
```

`--csv` 与桌面版命令行导出走**同一个函数**（`csvExport`），所以它同时是那条路的
「不装桌面版也能跑的等价物」和「改了 CSV 之后最快的回归手段」：不放心就在两边各导一次对比。

## 桌面版的命令行导出（`--csv`）

解析全在前端，所以这条路的**验证面就是前端的验证面**：它和 `cli.js --csv` 共用
`src/js/core/csv.js`，差别只在「谁去读文件、谁去写文件」（见 [桌面版](desktop.md)）。
验证分三层，从便宜到贵：

```bash
# ① Rust 侧纯逻辑（不需要 WebView、不需要图形环境，CI 也能跑）
cd src-tauri && cargo test --release          # 9 项：参数解析 / BOM 策略 / 分块落盘 / 帮助文本

# ② exe 的命令行层（不需要 WebView：--help/--version/用法报错都在建窗口之前返回）
pdscope.exe --help ; pdscope.exe --version ; pdscope.exe 不存在.atkcc --csv   # 退出码 0 / 0 / 2

# ③ 端到端导出（需要 WebView 运行时；这条才是真正的验收）
npm run app:exe            # 先出可执行文件（桌面版自检都需要它）
npm run app:csv            # 命令行导出自检：17 项
npm run app:csv:self       # 只验参考侧（2 项，不跑 exe，没有 Rust 工具链也能跑）
node tools/tauri-cli-check.mjs --file "../制糖40w-ip18pro.atkcc"     # 换真实抓包
```

**① 测什么**：`parse` 的各种写法与错误分支（`--csv [路径]` / `--csv=路径` / `--out 路径` /
`--out -`、开关写在抓包前后的两种顺序、`--limit` `--channel` `--bom` 的取值、
以及「没给 `--csv` 时这些开关必须报错」）、BOM 策略（落盘带、管道不带、显式开关优先）、
分块落盘（块序错了要报错、拼出来的字节与页面给的完全一致、头三个字节是 `EF BB BF`、
`Auto` 时按页面建议名落在输入同目录）、帮助文本里该有的开关与编码说明。
**这批用例不碰窗口**，所以沙箱里/CI 上都能跑 —— 出问题不用等到有图形环境才发现。

**③ 的判据只有一条，但足够硬**：同一个抓包（同一条通道），exe 导出的 CSV 必须与
`node tools/cli.js --csv` 的参考结果逐字节相同。围绕它还补了几条边界：
默认输出名 `<主干>-ch<通道>.csv`（通道从摘要里读回来，单/多通道样本都成立）、
`--limit 3` 只出表头 + 3 行、`--help` / `--version` 退出码 0、输入不存在退出码 2、
非抓包文件退出码 1 **且不留半截 CSV**，以及**编码那三条**：`--out -` 接管道不带 BOM、
`--out -` 被重定向到磁盘文件时**自动补 BOM**（用真实文件句柄当 stdout 来测，
等价于 `cmd /c "... --out - > 出.csv"`）、`--bom` / `--no-bom` 能强制两种行为。
产物落在 `artifacts/cli-check/`（留着方便人工翻一眼、也方便直接拿 Excel 打开验编码）。

默认用的是现造的 UFCS 样本（`tools/make-test-ufcs.mjs`），所以**手上没有私有抓包也能跑**。
`tools/tauri-e2e.mjs` 测的是界面那两条路（`--drop` / `--open`），命令行导出是**不开窗口**的，
所以它不并进那份自检 —— 这一份就是它的回归。

只想验**页面那一侧**（改了 `csv.js` / `pdscopeExportCsv`，但手边没有 Rust 工具链）也行：
`tools/e2e.mjs --eval "<js>"` 就是浏览器里的一个 REPL，在里头调 `PDScope.exportCsv(...)` 即可。
e2e 启动 Chrome 时带了 `--allow-file-access-from-files`，所以页面自己
`fetch('file:///…/artifacts/_ufcs_synth.sqlite')` 能取到样本字节。

## 实测样本

`.atkcc` → 报文数 / CRC 错误：

| 文件                       | 通道 | 报文 | CRC 错误 |
| -------------------------- | ---- | ---- | -------- |
| 制糖40w-ip18pro            | 1    | 44   | 0        |
| 安可60w-ip18pro            | 1    | 44   | 0        |
| 绿联70w-ip18pro            | 1    | 348  | 0        |
| 苹果40w-ip18pro            | 1    | 738  | 6        |
| apple_40w_avs_iphone_air   | 24   | 1048 | 5        |

`.sqlite`，USB PD → 报文数 / 线缆链路 / 插拔 / 拆帧自检：

| 文件                  | 协议   | 表行  | 报文 | 线缆链路 | 扩展 | 插拔 | 时长     | 拆帧自检 |
| --------------------- | ------ | ----: | ---: | -------: | ---: | ---: | -------- | -------- |
| 山泽60w-ip18pro       | USB PD | 45    | 44   | 4        | 3    | 1 / 0 | 9.91 s   | ✔ 0 坏包 / 0 截断 |
| 酷泰科6u-18pro        | USB PD | 77    | 76   | 4        | 7    | 1 / 0 | 8.50 s   | ✔ 0 坏包 / 0 截断 |

`.sqlite`，UFCS：

| 文件                  | 协议 | 表行  | 报文  | 状态事件 | 未定位 | 时长      | 方向依据 |
| --------------------- | ---- | ----: | ----: | -------: | -----: | --------- | -------- |
| ufcs_vivo_x300u       | UFCS | 26099 | 26094 | 5        | 0      | 2493.98 s | 容器链路 26094 / 推断 0 |

这份样本的容器是**实测归纳**的那套 9 字节布局（见 [`.sqlite` 格式](format-powerz.md)
的「UFCS 的 Raw blob 里是什么」），解析器认得它就直取链路字节 ——
于是 26094 条报文的**方向全部有硬依据、零推断**，CRC-8 也 26094/26094 全通过。
对不上的导出实现会落回穷举定位，跑一遍就知道：

```bash
npm run powerz:inspect                  # 汇总行给出：报文 / UFCS 帧 / 未定位行 / CRC 口径
npm run e2e:ufcs                        # 界面级：报文表、详情面板、差分线视图
```

汇总行里的「UFCS 帧」是容器里定位到的帧数，「未定位行」是既不是 UFCS 报文、
也不是状态事件的行数 —— 两者都会进 `PowerzCapture.decode()` 的 `stats`，
**不写死预期值**：容器格式各家实现不一，与其在文档里钉一个没验证过的数字，
不如让工具如实报出来。（上表那几个数就是这么跑出来的；文档里的静态数字只作参照。）

（`npm run powerz:inspect` 会把上表连同代表性报文的完整字段一起打出来；PD 的 `pd_table`
一律不存 CRC，所以那一栏恒为「未记录」；**UFCS 存不存 CRC 由容器决定**，未记录 / 全通过 / 错误 N
都如实列出来。）

---

相关：[CI 里跑哪些自检](ci.md) · [界面功能](ui.md) · [已知限制](limits.md)
