# CI 构建：10 个目标一次出齐

`.github/workflows/build.yml` —— **每次提交都自动构建**，一次出齐 10 个平台的成品。

## 怎么触发

| 方式 | 场景 |
| --- | --- |
| 往任意分支 `push`（含合并进主干） | 每次提交都跑；跑完在 Actions 页面底部 **Artifacts** 区按平台下载，保留 30 天 |
| Actions 页面点 **Run workflow** | 不想提交，也要一版包 |
| 推 `v*` 标签 | 发版：除了 Artifacts，再自动建一个**草稿** Release 汇总全部产物 |

```bash
git tag v0.3.1 && git push origin v0.3.1     # 走发版那条路
```

> Artifacts 要登录 GitHub 才能下载。想让任何人都能下，就推个标签，
> 然后去 Releases 页面点一下 **Publish** 把草稿发出去。

## 10 个目标怎么落地的

每个目标都一对一落到一台真实存在的 GitHub runner 镜像上（runner 标签已逐个核对过）。

产物**散着传、不打包**：每个安装包 / 可执行文件各自一个文件上传，文件名统一是
`PDScope-<目标>-<版本段>-<内容>`。其中「版本段」：

* 推 `v*` 标签（发版）→ 纯版本号，如 `v0.3.1`；
* 普通推送 → `v0.3.1_<8 位短 commit>_<YYYYMMDD>`，一眼能看出是哪次提交、哪天出的。

上传用 `archive: false` 直传裸文件，所以 **Actions 的 Artifacts 列表里每一项就是一个文件**，
点下载得到的也是文件本身（不再是整体 zip）。每个文件配一个同名 `.sha256`，校验和也是
逐个直传（Artifacts 里每个 `.sha256` 单独一条、与主产物名字一一对应），
`sha256sum -c <文件>.sha256` 一句校验。

| 目标 | runner | Rust target | 产物（散文件） |
| --- | --- | --- | --- |
| Windows11-x64 | `windows-2025` | `x86_64-pc-windows-msvc` | NSIS `-setup.exe` + `.msi` + `-portable.exe`（绿色版） |
| Windows11-arm64 | `windows-11-arm` | `aarch64-pc-windows-msvc` | NSIS `-setup.exe` + `-portable.exe`（绿色版） |
| macos15-arm64 | `macos-15` | `aarch64-apple-darwin` | `.dmg` |
| macos15-x64 | `macos-15-intel` | `x86_64-apple-darwin` | 同上 |
| macos26-arm64 | `macos-26` | `aarch64-apple-darwin` | 同上 |
| macos26-x64 | `macos-26-intel` | `x86_64-apple-darwin` | 同上 |
| ubuntu2404-x64 | `ubuntu-24.04` | `x86_64-unknown-linux-gnu` | `.deb` + `.AppImage.zip` |
| ubuntu2404-arm64 | `ubuntu-24.04-arm` | `aarch64-unknown-linux-gnu` | 同上 |
| ubuntu2604-x64 | `ubuntu-26.04` | `x86_64-unknown-linux-gnu` | 同上 |
| ubuntu2604-arm64 | `ubuntu-26.04-arm` | `aarch64-unknown-linux-gnu` | 同上 |

> macOS 只出 `.dmg`：dmg 挂载后里面就是 `.app` 本体 + 一个指向 `/Applications` 的软链，
> 把 `.app` 拖进 Applications 即完成安装，所以不需要再单独出一份 `.app`。
> 其余 `.deb` / `.AppImage` / `.exe` / `.msi` 都是单文件，直接传。

## 为什么 Ubuntu 的 AppImage 大一个数量级（167 ~ 180 MB，而 Windows / macOS 只有 3 ~ 4 MB）

差的不是本程序，是**浏览器内核 —— 也就是 WebView 由谁提供**：

| 平台 | WebView 来源 | 进不进包 | 包体积 |
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
  AppImage 内部本就是 squashfs 压缩，外层再压一层 zip 省不了多少，这里压 zip 纯粹是
  为了让「绿色包」和 `.deb` 一样是单文件、且不必处理 `+x` 位在下载链路里的丢失问题。
  上传前把它压成 `.AppImage.zip`，解压后记得 `chmod +x` 再运行。
* `ubuntu2604-*` 比 `ubuntu2404-*` 再大 8 ~ 9 MB：同样是 AppImage，但 26.04 自带的
  WebKitGTK 版本更新、体积也更大。

> CI 每次构建都会在**运行摘要**的「清点各 bundle 体积」一栏列出 `.deb` / `.AppImage`
> 各自的原始体积，想核对直接看那一步的表格。

> **Windows 的绿色版**：`PDScope-<目标>-<版本段>-portable.exe` 就是那个可执行文件，
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

## 为什么没有 Windows 10 的产物

GitHub 的 Windows runner 一直是 **Windows Server** 系列，从来没有过 Windows 10 的镜像；
`windows-2019` 也已下架，现在只剩 `windows-2022` 和 `windows-2025`。

早先列过一个 `windows10-x64` 目标，用 `windows-2022` 代打，现在**去掉了**：它和
`windows11-x64` 的 Rust target 是同一个 `x86_64-pc-windows-msvc`，产物完全一样、
在 Win10 上能直接跑，重复构建一份一模一样的包没有意义。

所以 **Win10 用 `windows11-x64` 那份即可**（同一份产物，Win10 / Win11 通吃）。
真要按 Windows 版本严格对应，唯一的路是自建 runner 装 Win10 —— 托管 runner 做不到。

## 几个刻意的选择

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
  把它改名为 `-portable.exe` 一起传就行，不需要额外构建一次。
* **产物散着传，靠「文件名带目标名 + 版本段」区分。** 两个原因：
  ① `actions/upload-artifact` 有个官方写明、关不掉的限制「Permission Loss」——
  上传后所有目录变 755、文件变 644，符号链接也不保留。不过我们的产物都是**单文件**
  （`.dmg` / `.deb` / `.exe` / `.msi` / `.AppImage.zip`），这个限制只影响「整个目录」的产物，
  而我们 macOS 只出 `.dmg`、Linux 把 AppImage 压成 zip（`+x` 位在下载链路里本就保不住，
  不如直接打包让用户解压后自己 `chmod +x`），所以正好避开了这一点。
  ② 各目标的出包名是按架构走的（`pdscope.exe`、`PDScope_0.3.1_x64-setup.exe` …），
  x64 与 arm64 之间、不同打包类型之间都可能撞名；而所有产物在 Release 里是平铺的，
  同名文件会互相覆盖且不报错。所以每个文件都在上传前加上
  `PDScope-<目标>-<版本段>-` 前缀，天然唯一。
  ③ 上传用 `archive: false` 直传裸文件（不打 zip），让 Artifacts 列表里每一项就是一个
  文件、下载即文件本身。`archive: false` 有两个限制：只能传单个文件、且 `name` 参数失效
  （文件名直接用作 artifact 名），所以这里每个产物类型单独一个 upload step、用
  `contains(matrix.bundles, …)` 判断该目标是否产这个文件；`.sha256` 也逐个配对直传
  （每个主产物后面紧跟它的校验和 step，`if` 条件与主产物一致，名字一一对应）。
  不整体打包成大 zip / tar.gz，是为了让每个文件能单独下载、单独校验；
  唯一的例外是 AppImage 单文件压一层 zip，让绿色包也保持单文件可独立分发。

## CI 里跑了哪些自检

```
node tools/version-check.mjs   # 版本号一致（外加文档里写的产物名提示项）
node tools/syntax.mjs          # 全量语法检查（自动带上 tools/ 下的新脚本）
node tools/selftest.js         # 协议层合成用例（91 项）
```

这三项**在 10 个目标上各跑一遍** —— 顺带验证了解析内核在 Windows / macOS / Linux
以及 x64 / arm64 上结果一致。`ackcheck.js` 与 `e2e.mjs` 要读仓库上一级的 `.atkcc`
实测样本，而那些文件按 `.gitignore` **不入库**（采样数据，体积大），CI 里没有它们 ——
想跑就在本机 `npm run check`。

## 几点要知道的

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

相关：[桌面版构建](desktop.md) · [自检](testing.md) · [环境准备](env.md)
