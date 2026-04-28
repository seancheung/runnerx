# 打包目录为 zip

跨平台示例：**同一个 manifest，两种平台两套真正不同的实现**。

| 平台    | 入口               | 实现                                      |
|---------|--------------------|-------------------------------------------|
| macOS   | `run.sh` (bash)    | `zip -r` + 解析 `adding:` 行做进度推进     |
| Windows | `run.ps1` (PS)     | `Compress-Archive` (PS 5.1+ 内置)         |

无外部依赖。两个脚本各自独立，行为对齐：相同的输入产出等价的 zip 文件。

## 这个示例顺便演示

1. **`platform.windows.entry` 完整覆盖** — 不止改 `command`，连 `args` / `argsMode` 都换了一套（macOS 走 `./run.sh`，Windows 走 `powershell.exe -File run.ps1`）。
2. **跨平台无依赖** — macOS 的 `zip` 和 Windows 的 `Compress-Archive` 都是系统原生提供，用户无需 `install` 阶段。
3. **进度推进的差异** — bash 端能逐文件推进（zip 输出 `adding:` 行可解析），PowerShell 的 `Compress-Archive` 没有 stream 回调，所以 Windows 端只能粗粒度报告。底部注释里有用 `System.IO.Compression.ZipFile` 改成逐文件进度的指引。

## 参数

- **源目录** — 必填，要打包的目录。
- **包含隐藏文件 / 点开头的文件** — 默认排除 `.git`、`.DS_Store` 等。
- **压缩级别** — 默认 / 快速 / 不压缩。
- **输出 zip 文件** — 运行前会弹保存对话框让你选路径（`output.save: true`）。

## 平台行为差异

`include_hidden = false` 在两边的"隐藏"定义略有不同：

- macOS：路径里任意一段以 `.` 开头都被排除。
- Windows：同上语义，但 NTFS 上的"hidden 属性"文件不会被特别处理（PowerShell 的 `-Force` 默认包含点开头文件，所以这里手动按路径段过滤）。

如果你的目录里没有点开头的目录/文件，两边输出几乎一致。
