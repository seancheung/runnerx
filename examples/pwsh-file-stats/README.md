# 文件大小统计 (PowerShell)

列出指定目录里最大的若干个文件，按大小倒序，输出一个表格 + 一段汇总文本。

## 这个示例顺便演示

1. **PowerShell 入口** — manifest 顶层 `entry` 用 `pwsh`（PowerShell 7+，跨平台）。
2. **`platform` 字段差异化** — Windows 上覆盖为 `powershell.exe`（系统自带的 5.1），让最常见的 Win 用户开箱即用，不必额外装 PowerShell 7。
3. **手动构造 JSON 协议行** — 因为 Windows PowerShell 5.1 的 `ConvertTo-Json` 会把嵌套数组 `[[a,b],[c,d]]` 展平成 `[a,b,c,d]`，破坏 `result.rows` 结构；脚本里有一个 `ConvertTo-JsonStringLiteral` 辅助函数 + 字符串拼接来绕开。在 PS 7 上也能正常运行。

## 各平台运行所需

| 平台    | 需要                                                            |
|---------|-----------------------------------------------------------------|
| Windows | 系统自带的 `powershell.exe`（即 Windows PowerShell 5.1）即可    |
| macOS   | 需先装 PowerShell 7：`brew install --cask powershell`            |

## 参数

- **扫描目录** — 必填，目录选择器。
- **显示前 N 个** — 1–100。
- **包含子目录** — 递归扫描。
- **文件名过滤** — PowerShell 通配符（`*.log`、`IMG_*.jpg` 等），不是正则。默认 `*`。
- **仅显示大于 (KB)** — 过滤掉小文件。

## 想换成纯 5.1 / 纯 7

修改 `manifest.yaml` 的 `entry`（和/或删掉 `platform` 块）：

```yaml
# 仅 Windows PowerShell 5.1：
entry:
  command: powershell.exe
  args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "run.ps1"]

# 仅 PowerShell 7+：
entry:
  command: pwsh
  args: ["-NoProfile", "-NonInteractive", "-File", "run.ps1"]
```
