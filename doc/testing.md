# 自检

```bash
# 版本号 / 语法 / 协议层（纯 Node，秒级）
node tools/version-check.mjs              # 版本号是否一致（最便宜，先跑它）
node tools/syntax.mjs                     # 全量语法检查（几秒；界面脚本错一个字符就是白屏）
node tools/selftest.js                    # 合成用例 76 项：4B5B / PD / CRC + 采样率 + plug 信令 + POWER-Z / UFCS 路径
node tools/ackcheck.js                    # GoodCRC 配对（跨 5 份真实抓包）
node tools/powerz-inspect.mjs             # POWER-Z（.sqlite，PD 与 UFCS）全样本体检（需要样本文件，非 0 退出即异常）

# 界面 30 项（ATK-C）/ 36 项（POWER-Z·PD）/ 39 项（多份抓包）/ 36 项 + 1 跳过（UFCS）
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

## version-check.mjs

把版本号在五个文件里对一遍：`package.json`、`src-tauri/tauri.conf.json`、
`src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src/ui/app.js`，外加文档里写着的安装包产物名。
这几处分别被 npm、打包器、Cargo、锁文件、界面「关于」读走，只改一处不会报错，
只会悄悄装出一个「文件名 0.3.0、关于里写 0.2.0」的包 —— 所以放在自检链最前面拦。

## ackcheck.js

校验 `linkGoodCrc()`：配对覆盖率、是否自指、方向是否相反、
**双方 CRC 完好时 MessageID 是否相同**（PD 规范的硬约束）、配对距离。
当前 5 份抓包共 1141 条有效 GoodCRC **100% 配对成功**，1100 条可校验的配对
**MessageID 全部一致**，最远距离恒为 1 条报文。

## selftest.js

用例共 **76 项**，分六组。

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

后两组都用**手搓的最小 SQLite 库**做输入，不依赖任何真实样本，CI 上也能跑。

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

## pd-regress.mjs / pd-inspect.mjs

**`pd-regress.mjs`** 把重构前的解码器从 `git HEAD` 取出来，与新库在同一份抓包上
**逐包逐字段对比**（sop / msgType / header / crcOk / nObjects / dataWords）。
当前 7 份抓包共 2414 条报文，**报文条数逐样本完全一致**，除「扩展消息新增了 hex 回填」
这一处预期差异外**零字段差异**。`pd-inspect.mjs` 则单独抽取线缆链路与扩展消息的解析详情，
并在每个样本前打一行「报文 / 线缆链路 / 扩展 / 坏 CRC / 警告」汇总，便于人工核对与全样本体检。

## e2e.mjs

直接走 Chrome DevTools Protocol（用系统已装的 Chrome/Edge，不下载浏览器），
**30 项**校验：页面骨架、抓包解码、虚拟滚动、方向过滤、关键字搜索、时间轴绘制、主题切换、
采样率来源标注、**详情面板拖拽改宽**（用真实鼠标事件走一遍 pointer capture，验证加宽 / 落盘 /
收起还原 / 超限夹紧 / 双击复位）、**收起后右缘出现展开把手**、
**标签栏出现 / 顶栏文件 chip 跟随当前标签 / 关闭全部后标签栏收起并回到引导页**、
无控制台异常，最后自动截图。
加 `--drop <文件>` 可注入真实抓包；`--eval "<js>"` 进调试模式，在页面里跑任意表达式并打印结果。

拖进去的若是 `.sqlite`，**另外再跑 6 项**（共 **36 项**）：来源标注为 POWER-Z、
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
11 项断言**显式跳过**并计入汇总（`.sqlite` 还会再跳过 CRC 口径 / 插拔计数 / 方向依据三项，
合计 `23 通过, 0 失败, 14 跳过`），而不是判失败 ——
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
node tools/cli.js "../苹果40w-ip18pro.atkcc" --csv            # CSV
node tools/cli.js "../apple_40w_avs_iphone_air.atkcc" --scan  # 各通道活动度
node tools/cli.js "../绿联70w-ip18pro.atkcc" --rate 2400000    # 强制指定采样率（排查用）
node tools/cli.js "../山泽60w-ip18pro.sqlite"                  # POWER-Z 导出，自动识别
node tools/cli.js "../ufcs_vivo_x300u.sqlite"                  # UFCS：解出 UFCS 报文表（.sqlite 自动分流）
```

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
