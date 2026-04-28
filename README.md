# runnerx

按目录加载用户脚本，根据 `manifest.yaml` 的声明在 GUI 里渲染表单、跑命令、显示进度和结构化结果的跨平台桌面应用。

技术栈：**Tauri 2 + React + TypeScript**。目标平台：macOS、Windows。

---

## 目录

- [启动开发模式](#启动开发模式)
- [脚本目录约定](#脚本目录约定)
- [manifest.yaml 速查](#manifestyaml-速查)
- [脚本 ↔ 应用通信协议](#脚本--应用通信协议)
- [生命周期](#生命周期)
- [参数传递模式](#参数传递模式)
- [示例脚本](#示例脚本)

---

## 启动开发模式

需要 Node 18+ 和 Rust 工具链 (rustup)。当前机器上 cargo 在 `/opt/homebrew/opt/rustup/bin/`，
确保它在 `PATH` 里：

```bash
export PATH="/opt/homebrew/opt/rustup/bin:$PATH"
```

第一次启动：

```bash
npm install
npm run tauri dev
```

第一次会编译大量 Rust 依赖，约 1-3 分钟；之后增量编译只需几秒。

类型检查（不启动应用）：

```bash
npx tsc --noEmit                            # 前端
( cd src-tauri && cargo check )             # Rust
```

打包构建（生成可分发的 `.app` / `.dmg` / `.msi`）：

```bash
npm run tauri build
```

---

## 脚本目录约定

默认根目录是 `~/.runnerx/scripts`（首次启动会自动创建）；可以在 ⚙ 设置里改成任意路径。根目录下的每个**直接子目录**如果包含 `manifest.yaml`（或 `.yml`）就被识别为一个脚本。

```
<scripts_root>/
  ffmpeg-extract-audio/
    manifest.yaml      # 必需
    run.sh             # 入口
    install.sh         # 可选
    icon.png           # 可选（PNG/SVG/JPG/WebP，<512KB）
    README.md          # 可选，详情页里有 README 标签页
  python-batch-rename/
    manifest.yaml
    install.sh
    run.py
    requirements.txt
    .venv/             # install 之后会出现
```

成功安装的脚本会在自己的目录里出现一个 `.runnerx-installed` 标记文件——存在即视为已安装。
点详情页右上的"重置"会删除这个标记，然后下次需要再点"安装"。

---

## manifest.yaml 速查

最小结构：

```yaml
# yaml-language-server: $schema=../../schema/manifest.schema.json
name: 我的脚本
description: 一句话说明
entry:
  command: ./run.sh
inputs:
  - id: msg
    type: string
    required: true
```

完整 schema 见 [`schema/manifest.schema.json`](./schema/manifest.schema.json)。在 manifest 顶部加上 `# yaml-language-server: $schema=...` 即可在 VS Code 里得到补全和校验（先安装 [YAML 扩展](https://marketplace.visualstudio.com/items?itemName=redhat.vscode-yaml)）。

支持的输入类型：

| type        | 说明                                                          |
|-------------|---------------------------------------------------------------|
| `string`    | 单/多行文本，支持 `pattern` / `minLength` / `maxLength`       |
| `number`    | 数字，支持 `min` / `max` / `step` / `integer`                 |
| `boolean`   | 复选框                                                        |
| `enum`      | 单选下拉 / 多选 chip（设 `multiple: true`）                   |
| `file`      | 单文件，`accept` 限制扩展名                                   |
| `files`     | 多文件                                                        |
| `directory` | 目录选择                                                      |
| `password`  | 文本框，输入掩盖                                              |
| `date`      | `YYYY-MM-DD`                                                  |
| `json`      | JSON 文本框，提交前会校验语法                                 |

字段联动：`when: { other_id: value }` 或 `when: { other_id: [v1, v2] }`，仅当其它字段命中条件时显示。

输出（`outputs`）：

```yaml
outputs:
  - id: output_file
    type: file        # file | directory | text
    save: true        # 在运行前弹保存对话框，让用户选路径
    accept: [".mp3"]
```

`save: true` 的输出会在表单里显示为路径选择器；选好的路径会和 inputs 一起传给脚本（前缀 `RUNNERX_OUT_`）。

---

## 脚本 ↔ 应用通信协议

每行以 `@@runnerx ` 开头都会被应用解析；其它行原样进入控制台。脚本独立运行（不通过应用）时这些行就是普通 stdout，不影响。

```
@@runnerx progress {"value": 0.5, "message": "encoding..."}
@@runnerx log      {"level": "info|warn|error", "message": "..."}
@@runnerx result   {"type": "table",  "title": "...", "columns": [...], "rows": [[...]]}
@@runnerx result   {"type": "image",  "path": "/abs/preview.png", "label": "..."}
@@runnerx result   {"type": "file",   "path": "/abs/output.mp3",  "label": "..."}
@@runnerx result   {"type": "json",   "data": {...}, "label": "..."}
@@runnerx result   {"type": "text",   "data": "...", "label": "..."}
```

`progress.value` 是 0–1 的小数。

---

## 生命周期

```yaml
lifecycle:
  install:   { command: ./install.sh }   # 一次性安装；成功后写 .runnerx-installed 标记
  uninstall: { command: ./uninstall.sh } # 卸载；成功后清除 .runnerx-installed 标记
  preRun:    { command: ./check.sh }     # 每次运行前同步执行；失败则阻断
```

`install` / `uninstall` 在前端有进度视图（和普通运行共用），输出走同一套 `@@runnerx` 协议。`preRun` 静默执行，stderr 在失败时反馈给用户。

详情页右上的按钮组：

- **安装 / 重新安装** — 跑 `lifecycle.install`，exit 0 才写入 `.runnerx-installed` 标记。
- **卸载** — 跑 `lifecycle.uninstall`（若 manifest 定义了），exit 0 才清除标记；卸载失败时标记保留，便于诊断后重试。
- **清除标记** — 不跑任何脚本，只删掉 `.runnerx-installed`。用作"我手动清干净了，让应用重新认为它没装"的兜底操作。

可针对平台覆盖：

```yaml
platform:
  windows:
    entry: { command: run.ps1, shell: true }
  macos:
    entry: { command: ./run.sh }
```

---

## 参数传递模式

`entry.argsMode` 可选：

- `env`（默认）：每个输入字段以 `RUNNERX_<ID>` 形式存入环境变量；输出字段为 `RUNNERX_OUT_<ID>`。布尔值传 `1` / `0`，多文件用平台路径分隔符（`:` / `;`），多选 enum 用 `,`。
- `argv`：以 `--<id-kebab-case>=<value>` 形式追加到命令行；boolean 仅在 true 时传 `--<id>`。
- `stdin-json`：把 `{"inputs": {...}, "outputs": {...}}` 一次性写到子进程 stdin 然后关闭。

---

## 示例脚本

仓库自带 `examples/` 目录，**可以直接把它当作 scripts root 使用**：

- `echo-demo` — 演示所有输入类型 + when 联动 + 完整协议输出。
- `ffmpeg-extract-audio` — 真实可用：调 ffmpeg 解码音轨，按 ffmpeg 的 `-progress` 流推进进度条。
- `python-batch-rename` — 演示 `install` lifecycle（创建 venv）+ `argsMode: stdin-json`。
- `pwsh-file-stats` — PowerShell 入门：演示 `platform` 字段差异化（Windows 用自带 `powershell.exe`，其它平台用 `pwsh`），以及手动构造 JSON 协议（绕开 PS 5.1 `ConvertTo-Json` 的嵌套数组限制）。
- `archive-folder` — 真跨平台示例：**同一个 manifest，macOS 走 `run.sh` + `zip`，Windows 走 `run.ps1` + `Compress-Archive`**。两套独立实现，相同输入产出等价的 zip。

启动应用后在设置里把脚本目录指到本仓库的 `examples/` 即可立即试用。
