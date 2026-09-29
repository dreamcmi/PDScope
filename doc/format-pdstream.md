# POWER-Z `.pdStream` 格式（逆向结论）

同一个抓包，POWER-Z 的上位机可以导出两种文件：

| 容器 | 内容 | 体积（同一份 85 分钟抓包） |
| ---- | ---- | -------------------------- |
| `.sqlite` | `pd_chart`（ADC 采样）+ `pd_table`（事件行 + `Raw` 列）+ `pd_table_key` | 21.5 MB |
| `.pdStream` | **只有 `pd_table` 那部分** | 131 KB |

所以 `.pdStream` 不是「另一种协议」：里面的报文与 `.sqlite` 的 `pd_table.Raw` **逐字节相同**，
解析照旧走 `src/js/pd/`（见 [POWER-Z `.sqlite` 格式](format-powerz.md)）。
本文只讲这层容器：字节怎么摆、怎么认出它、与 `.sqlite` 的差别在哪。

实现见 `src/js/core/pdstream.js`；造样本 / 互转见 `tools/make-test-pdstream.mjs`。

---

## 字节布局

**没有文件头、没有尾、没有索引、没有校验和** —— 整个文件就是记录首尾相接：

```
┌ u32 BE  payloadLen   payload 的字节数
├ u8[]    payload      与同名 .sqlite 的 pd_table.Raw 逐字节相同
├ f64 BE  Time         秒（相对抓包起点，单调不减）
├ f64 BE  Vbus         伏
└ f64 BE  Ibus         安
                  ↑ 重复 payloadLen 条记录，直到文件末尾
```

| 项 | 结论 | 依据 |
| -- | ---- | ---- |
| 长度字段 | **4 字节大端** `u32` | 实测取值 6 / 8 / 12 / 28 / 32，按小端读会是天文数字 |
| 三个数值 | **8 字节大端 IEEE-754**（不是 float32） | 按大端 double 读出来与 SQLite 的 REAL 列**精确相等**；SQLite 存 REAL 也是大端，两边同源 |
| 记录开销 | 每条固定 **28 字节**（4 长度 + 3×8） | 全文件平均 36.7 字节/条，净荷只占 24% |
| 结束位置 | **正好等于文件长度** | 实测 3677 条后偏移 `0x20efa` = 文件大小，一个字节不多不少 |

一份真实样本（`rawdata/DJIPOWER_VIVOX300U_PPS.pdStream`，131 KB / 3677 条）：

* 记录数与同名 `.sqlite` 的 `pd_table` **行数完全相等**（3677）；
* 逐行核对：`Raw` 逐字节相同、`Time` / `Vbus` / `Ibus` 与三个 REAL 列**精确相等**（3677 / 3677）；
* 时间跨度 2.957 s → 5103.793 s（85 分钟），单调不减；
* payload 长度分布：`8B×3057`、`12B×613`、`6B×3`、`28B×2`、`32B×2`；
* 其中 **6 字节那 3 条不是报文**，而是连接/状态事件行（与 `.sqlite` 里「有行但解不出报文」的行一一对应）。

## 与 `.sqlite` 的差别

| | `.sqlite` | `.pdStream` |
| -- | --------- | ----------- |
| 报文 | `pd_table` 3677 行 | 3677 条记录（同字节） |
| ADC 波形 | `pd_chart` 502,523 行（约 10 ms 一个点） | **没有** |
| 会话密钥 | `pd_table_key`（导出文件里为空） | 没有 |
| 时间轴总长 | `max(chart 末点, 报文末点)` | **末条记录的时间** |
| 体积 | 21.5 MB（几乎全是 `pd_chart`） | 131 KB（`pd_table` 本身在 SQLite 里也约 125 KB） |

也就是说：**时间轴没有曲线可画**。界面对此走已有的「这份抓包没有模拟量轨迹数据」分支，
但横轴时间刻度照常按事件铺开，刷选时间窗口、点选报文、筛选与导出都不受影响。

> ⚠️ 一个容易误会的连带效果：界面与 CSV 里**每条报文的 VBUS / IBUS 两列取自 ADC 采样序列**
> （`busAt()` 按时间取最近邻），不是 `pd_table` 行里那两个数。所以同一份抓包，
> `.sqlite` 导出有这两列，`.pdStream` 导出会是空的 —— 这不是解析漏了，而是容器里确实没有波形。
> 报文条数、类型、方向、时间、数据对象、CRC 口径都不受影响。

## 怎么认出它（没有魔数可用）

文件开头就是一条普通记录，所以只能**靠结构自证**。`sniffPdStream()` 走一遍并要求：

1. 每一步的 `payloadLen` 都在合理区间（非 0，且不超过上限）；
2. **走完的偏移正好等于文件长度**（多一个字节都不认）；
3. `Time` 有限、非负、**单调不减**；`Vbus` / `Ibus` 在物理量程内（PD 3.1 EPR 上限 48 V / 5 A，各留一倍余量）；
4. 至少能读出 3 条记录（太短的文件走完也可能是巧合）。

这个判据很强，也顺带排除了其它格式：ZIP（`.atkcc`）首 4 字节是 `50 4B 03 04`、SQLite 是
`SQLite format 3`，按大端 u32 读都远超长度上限。自检里把这几条负例都钉住了
（截断 / 多一字节 / 伪随机 / ZIP 头 / 时间倒退，见 [自检](testing.md) 的 POWER-Z 那一组）。

`readPdStream()` 认不出时会**报出卡在哪个偏移、为什么**，例如：

```
不是 .pdStream：偏移 0x4a 处 payload 长度 12 越过了文件末尾
```

## 代码里怎么用

```js
import { sniffPdStream, PdStreamCapture, readPdStream, writePdStream } from './pdstream.js';

if (sniffPdStream(u8)) {
  const cap = PdStreamCapture.open(u8);        // 与 PowerzCapture 同形
  const { packets, stats } = await cap.decode();  // 报文语义完全复用 PD 解码器
}
```

实现上 `PdStreamCapture` 继承 `PowerzCapture`，只做两件事：给一个**只读虚拟表**
（`hasTable` / `count` / `rows` 三个方法，形状对齐 `SqliteReader`），以及覆写
`PowerzCapture#_tableRows()` 让解码流程从二进制流取行而不是从 SQLite 取行。
所以「换容器」没有带来第二套解码逻辑 —— 这也是自检里能直接断言
「两种容器解出来的报文逐字段一致」的原因。

反过来写：`writePdStream(rows)` 接收 `{time, vbus, ibus, raw}` 的数组（与 `pd_table` 同形，
写入前按 `Time` 排序），因此 `tools/make-test-pdstream.mjs --src 抓包.sqlite` 就是一个
「`.sqlite` → `.pdStream`」的转换器（体积通常能小两个数量级）。

---

相关：[POWER-Z `.sqlite` 格式](format-powerz.md) · [ATK-C `.atkcc` 格式](format-atkcc.md) ·
[自检](testing.md) · [已知限制](limits.md)
