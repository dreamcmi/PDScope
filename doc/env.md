# 环境准备

## 只跑单文件版 / 本地服务

* **Node.js 18+**（只为跑 `tools/` 下的脚本；`dist/PDScope.html` 本身不需要 Node）

## 构建桌面版：三平台通用

* **Rust**：用 [rustup](https://rustup.rs) 安装（本机实测 rustc 1.98.1）
* **Node.js**：装 `@tauri-apps/cli` 用

### 本机已装的 Rust（2026-09-29）

用 rustup 装到了**用户级**（不是系统级、不需要管理员），装完新开的终端里 `cargo` / `rustc` 直接可用：

```powershell
rustup show                                  # 默认工具链 stable-x86_64-pc-windows-msvc
cargo --version                              # cargo 1.98.1
rustup component list --installed            # cargo / rustc / rust-std / clippy / rustfmt
rustup component add rust-docs               # 想要本地文档再加这个（可选）
```

| 装在哪 | 路径 |
| ------ | ---- |
| 工具链 | `%USERPROFILE%\.rustup\toolchains\stable-x86_64-pc-windows-msvc` |
| 命令 + registry 缓存 | `%USERPROFILE%\.cargo\`（`bin` 已加入用户 PATH 的第一位） |

装好之后最省事的验收（不需要私有抓包，也不碰图形环境）：

```powershell
cd src-tauri ; cargo test --release --offline   # 命令行导出的 9 项单元测试
npm run build ; npm run app:exe                 # 重建前端 + 出可执行文件
npm run app:csv                                 # 端到端：exe 导出的 CSV 与 node CLI 逐字节比
```

## 构建桌面版：各平台额外依赖

| 平台        | 还需要装                                                                       |
| ----------- | ------------------------------------------------------------------------------ |
| **Windows** | **MSVC 链接器** —— 装 Visual Studio 2022 的「使用 C++ 的桌面开发」工作负载（含 Windows SDK），或只装 Build Tools。已验证 VS 2022 Community + MSVC 14.44 + Windows SDK 10.0.26100 可用。**WebView2 运行时** Win10/11 基本自带（本机 154）。 |
| **macOS**   | `xcode-select --install`（Command Line Tools，提供 clang 与系统框架）          |
| **Linux**   | `sudo apt install libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev patchelf build-essential`（Debian/Ubuntu 系；打 AppImage 需要 `patchelf`） |

## 网络：镜像

* `src-tauri/.cargo/config.toml` —— crates 走 USTC 稀疏索引（给国内开发机用；海外网络删掉它即可回到官方源）。
  CI 里是自动删掉的：runner 在海外，走官方源更快更稳。
* `.npmrc` —— 预留了 npmmirror 的开关，但**默认注释着**：依赖只有 `@tauri-apps/cli` 一个，官方源直接可达，没必要绕。

`tauri build --no-bundle` 完全走本地，不碰外网；打安装包（nsis / msi / dmg / AppImage）时
才会去 GitHub Releases 下载打包辅助程序。

---

相关：[交付形态](delivery.md) · [桌面版构建](desktop.md) · [CI 构建](ci.md)
