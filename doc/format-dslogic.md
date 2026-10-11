# `.dsl` 格式（梦源 DSLogic 逆向结论）

梦源（DreamSourceLab）DSView 上位机导出的 `.dsl` 同样是一个 **ZIP**（`PK\x03\x04`），
里面装的是**逻辑分析仪采到的原始电平** —— 和 `.atkcc` 的定位一样，都要先解 BMC 才能拿到 PD 报文，
只是多通道的组织方式不同。

```
header          INI 文本，声明采样率 / 探针数 / 块数 / 总采样点数
session         JSON，头部标题等信息（解析不依赖它）
decoders        JSON，软件里挂的解码器配置（解析不用）
L-<ch>/<block>  通道 <ch> 的第 <block> 块数据，每块固定 2 MiB（deflate 压缩）
```

实测样本（`rawdata/DSLogic U2Pro16-la-261011-232853.dsl`，112 MB）：

```
samplerate = 100 MHz
total probes = 3
total blocks = 116
total samples = 1930205824
Enable RLE Compress: 0        ← 没开 RLE，块内就是纯采样点流
```

## 条目名怎么读：`L-<通道>/<块号>`

**前一个数是通道、后一个是块号** —— 这里是唯一容易读反的地方，读反了会把 116 个块号
当成 116 个通道，然后每个通道一块都取不到（症状是 `readChunk` 一律返回 null）。
本样本是通道 `0..2` × 块 `0..115`。

块大小固定 **2 MiB（2097152 B）**，与 `.atkcc` 的 1 MiB 不同。

## 位流约定：与 `.atkcc` 的差异就在这一层

| | `.atkcc` | `.dsl` |
| -- | -------- | ------ |
| 每个采样点的字节数 | 固定 **1** 字节（一个通道一个文件） | `ceil(total probes / 8)` 字节 |
| 通道怎么摆 | 各通道各自成文件 | **多探针交织**在同一批字节里 |
| 通道落在哪一位 | 整个字节就是它 | 第 `floor(ch/8)` 字节的第 `ch%8` 位 |
| 每字节装几个采样点 | 8 个（LSB 在前） | 同左（抽出后按此重打包） |

也就是说 `.dsl` 的第 k 个采样点占 `bytesPerSample` 字节，通道 `ch` 是其中
第 `floor(ch/8)` 字节的第 `ch%8` 位。

`DslogicCapture#readChunk()` 负责**跨步抽出单通道、再按 `.atkcc` 口径重打包**
（一字节 8 采样点、`bit0` 最早），所以下游的 `pipeline.js` / `bmc.js` / PD 解析
**一行都不用改** —— 换容器没有带来第二套解码逻辑。

当 `bytesPerSample === 1` 且通道落在 `bit0` 时走**直通快路径**（整块原样拿过来，
不做逐位循环）。这里有个坑：直通路径的输出长度**必须等于原始块长度**，
不能按 `ceil(samples/8)` 收缩 —— 一旦收缩，解码结果会静默变化
（边沿数从 21802416 掉到 2731635、时长 19.29 s 变 2.41 s），而且不报任何错。

## 采样率怎么定

`header` 里写的是 **`samplerate = 100 MHz`**（带单位后缀），与 `.atkcc` 的
`SamplingFrequency=2500`（纯数字、单位 kHz）写法不同。三者都认：

| 优先 | 来源 | 何时启用 | 界面标记 |
| :--: | ---- | -------- | -------- |
| ① | **文件声明** —— `header` 的 `samplerate`（单位 `Hz` / `kHz` / `MHz` 都认） | 声明存在，且与波形实测相差不超过 ±25% | `文件声明` |
| ② | **波形自检** —— 用 BMC 游程分布反推 | 文件没声明，或声明值与波形差得离谱 | `波形实测` |
| ③ | **兜底 100 MHz** | 波形也认不出来 | `默认值` |

这条三级策略与 `.atkcc` **共用同一个实现**（`pipeline.js#resolveSampleRate`），
所以 ±25% 容差、只在最前面几个块上测一次、结果缓存到容器上这些行为完全一致。

判定出采样率之后，`UI = 1.6667 µs`、门限 `1.5 UI` / `3 UI` 等全部**按采样率换算成采样点**
再比，与 `.atkcc` 共用同一套逻辑（见 [`.atkcc` 格式](format-atkcc.md) 的「采样率怎么定」）。
100 MHz 下 `1 UI ≈ 166.67 采样点`。

## 各通道采样点数

每块净荷是**全部探针交织**的采样点，所以本通道的采样点数 = `块字节 / bytesPerSample × 8`，
**不能**直接用 `块字节 × 8`（后者会把其它探针的点也算进来）。
最终再与 `header` 声明的 `total samples` 取小 —— 声明值与块字节都由文件给出，两者对齐。

## 怎么认出它

`sniffDslogic()` 三重自证，缺一不可：

1. 文件以 ZIP 魔数 `PK` 开头；
2. 包里**有 `header` 条目**（`.atkcc` 没有这个条目名）；
3. **有条目名匹配 `L-<数字>/<数字>`** —— 普通 ZIP 不满足这一条。

只看内容、不看扩展名，所以改名的文件照样能打开。

## 界面表现

`.dsl` 只记录**数字电平，没有 VBUS / IBUS 模拟量**（`.atkcc` 的 `bus.ini` 那种）。
所以：

* 时间轴**没有曲线可画**，标题显示「报文时间轴（无模拟量）」，画布上写明原因；
  横轴时间刻度照常铺开，刷选时间窗口、点选报文、筛选与导出都不受影响；
* 顶栏「来源」chip 显示 `DSLogic · .dsl`，采样率 chip 的悬停提示写 `取自 header：…`；
* 通道卡列的是「探针 N」而不是「N 块」—— `.dsl` 每个通道都指向同一批交织块，
  报块数会让人误以为各自独立存储；
* 没有差分线，所以时间轴顶部那排「电压 / 电流 ↔ 差分线」切换按钮**整个隐藏**。

## 逐条核对

```bash
node tools/cli.js "rawdata/DSLogic U2Pro16-la-261011-232853.dsl"          # 表格：解出 1 条 Cable Reset
node tools/cli.js "rawdata/DSLogic U2Pro16-la-261011-232853.dsl" --scan   # 各通道活动度
```

自检里 `.dsl` 那一组用**手搓的最小 ZIP**（`stored` 方式）做回归，不依赖真实样本，
覆盖：采样率解析、嗅探正例与负例、容器元信息、以及最关键的
**「多探针块内按字节跨步抽出并重打包」**。真实样本 112 MB，不在仓库里。

实现见 `src/js/core/dslogic.js`；解析入口与 `.atkcc` 同构
（`DslogicCapture.open()` / `readChunk()` / `effectiveSampleLimit()` / `scanDslogicChannelActivity()`）。

---

相关：[`.atkcc` 格式](format-atkcc.md) · [POWER-Z `.sqlite` 格式](format-powerz.md) ·
[PD 解析库](lib-pd.md) · [已知限制](limits.md)
