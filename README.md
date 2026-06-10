# runnerx

按目录加载用户脚本，根据 `manifest.yaml` 的声明在 GUI 里渲染表单、跑命令、显示进度和结构化结果的跨平台桌面应用。

技术栈：**Tauri 2 + React + TypeScript**。目标平台：macOS、Windows。

---

## 目录

- [启动开发模式](#启动开发模式)
- [数据目录与配置](#数据目录与配置)
- [脚本目录约定](#脚本目录约定)
- [manifest.yaml 速查](#manifestyaml-速查)
- [脚本 ↔ 应用通信协议](#脚本--应用通信协议)
- [生命周期](#生命周期)
- [参数传递模式](#参数传递模式)
- [环境变量文件（.env）](#环境变量文件env)
- [沙盒模式 (Docker)](#沙盒模式-docker)
- [AI 创建脚本](#ai-创建脚本)
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

## 数据目录与配置

应用的数据目录由环境变量 `RUNNERX_HOME` 决定，默认为 `~/.runnerx`。目录结构：

```
$RUNNERX_HOME/          # 默认 ~/.runnerx
  config.yaml           # 所有配置（脚本目录、主题、沙盒网络、AI 模型等）
  scripts/              # 默认脚本根目录
```

`config.yaml` 可手动编辑，完整示例：

```yaml
scriptsRoot: /path/to/your/scripts   # 不填则用 $RUNNERX_HOME/scripts
theme: dark                          # dark | light | 不填跟随系统
sandbox:
  network: bridge                    # bridge | none | host
llm:
  provider: openai
  apiKey: sk-xxxx
  baseUrl: https://api.openai.com
  model: gpt-4o-mini
```

如需将数据目录迁移到其他位置，设置环境变量 `RUNNERX_HOME` 即可。

---

## 脚本目录约定

默认根目录是 `$RUNNERX_HOME/scripts`（首次启动会自动创建）；可以在 ⚙ 设置里改成任意路径。根目录下的每个**直接子目录**如果包含 `manifest.yaml`（或 `.yml`）就被识别为一个脚本。

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
    .env               # 可选，自动注入环境变量
    .venv/             # install 之后会出现
```

成功安装的脚本会在自己的目录里出现一个 `.runnerx-installed` 标记文件——存在即视为已安装。
点详情页右上的"重置"会删除这个标记，然后下次需要再点"安装"。

---

## manifest.yaml 速查

最小结构（顶层是平台无关元信息 + 一个或两个平台块；至少要声明 `macos` 或 `windows` 之一）：

```yaml
# yaml-language-server: $schema=../../schema/manifest.schema.json
name: 我的脚本
description: 一句话说明

macos:
  entry:
    command: ./run.sh

inputs:
  - id: msg
    type: string
    required: true
```

平台块的字段是平铺的：`entry` 必填，`install` / `uninstall` / `preRun` 可选。当前应用只发布 macOS 和 Windows 版本，所以平台键只有这两个。运行时按当前 OS 选对应块；如果当前 OS 没声明对应块，脚本在侧栏会被灰显标记为"不支持当前平台"，无法安装/运行。

跨平台脚本就同时写两个块：

```yaml
macos:
  entry:
    command: ./run.sh
    argsMode: env

windows:
  entry:
    command: powershell.exe
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "run.ps1"]
    argsMode: env
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
    type: file        # file | directory
    required: true    # 默认 true；为 false 时允许用户留空，脚本可走自己的默认路径
    accept: [".mp3"]
```

每个 output 都会在表单里显示为路径选择器（文件 → 保存对话框；目录 → 选目录对话框）。选好的路径会和 inputs 一起传给脚本（前缀 `RUNNERX_`，和输入共用同一前缀）。`required` 默认 `true`，必填项的标签会带 `*`；设为 `false` 表示可选，用户没填时环境变量为空字符串，脚本需自行兜底。如果脚本完全自己决定输出位置（写死路径或基于 input 推算），就不要声明 output——直接通过 `@@runnerx result` 把最终路径反馈给 UI 即可。

---

## 分发清单（`files`）

类似 npm `package.json#files`，在 manifest 顶层显式列出脚本分发的所有文件：

```yaml
files:
  - run.sh
  - lib/utils.sh
  - README.md
```

- **路径**：相对脚本目录，禁止 `..` 和绝对路径
- **不支持 glob**：逐个写文件名
- **`manifest.yaml` 自动包含**：不需要写它（写了也不会报错）
- **AI 修改的上下文**：`AI 修改` 按钮把这个清单里的文件喂给模型作为上下文。**没声明 `files` 的脚本，AI 修改按钮会被禁用**
- **AI 创建的脚本会自动写好这个字段**；之后用户增删文件时记得手动同步，否则 AI 修改时看不到新文件

仍然受 64 KB 单文件 / 256 KB 总量限制（防止超大文件爆 prompt）。

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

`install` / `uninstall` / `preRun` 直接写在平台块内，和 `entry` 同级：

```yaml
macos:
  entry:     { command: ./run.sh }
  install:   { command: ./install.sh }    # 一次性安装；成功后写 .runnerx-installed 标记
  uninstall: { command: ./uninstall.sh }  # 卸载；成功后清除 .runnerx-installed 标记
  preRun:    { command: ./check.sh }      # 每次运行前同步执行；失败则阻断
```

`install` / `uninstall` 在前端有进度视图（和普通运行共用），输出走同一套 `@@runnerx` 协议。`preRun` 静默执行，stderr 在失败时反馈给用户。

详情页右上的按钮组：

- **安装 / 重新安装** — 跑当前平台块的 `install`，exit 0 才写入 `.runnerx-installed` 标记。
- **卸载** — 跑当前平台块的 `uninstall`（若声明了），exit 0 才清除标记；卸载失败时标记保留，便于诊断后重试。
- **清除标记** — 不跑任何脚本，只删掉 `.runnerx-installed`。用作"我手动清干净了，让应用重新认为它没装"的兜底操作。

跨平台脚本可以在两个平台块里各自声明独立的 `install` / `uninstall`，例如 macOS 用 `./install.sh`、Windows 用 `powershell.exe -File install.ps1`。各平台的安装/卸载逻辑互相独立、不共享。

---

## 参数传递模式

`entry.argsMode` 可选：

- `env`（默认）：每个输入和输出字段都以 `RUNNERX_<ID>` 形式存入环境变量（输入和输出共用同一前缀，所以 inputs / outputs 的 id 不能重名）。布尔值传 `1` / `0`，多文件用平台路径分隔符（`:` / `;`），多选 enum 用 `,`。
- `argv`：以 `--<id-kebab-case>=<value>` 形式追加到命令行；boolean 仅在 true 时传 `--<id>`。
- `stdin-json`：把 `{"inputs": {...}, "outputs": {...}}` 一次性写到子进程 stdin 然后关闭。

---

## 环境变量文件（.env）

如果脚本目录下（与 `manifest.yaml` 同级）存在 `.env` 文件，应用会在**所有执行操作**（run、install、uninstall、preRun）前自动读取并注入其中的环境变量。

```
# .env 示例
API_KEY=sk-xxxx
BASE_URL="https://api.example.com"
export DEBUG=1
```

支持的语法：

- `KEY=VALUE`
- `KEY="quoted value"` / `KEY='quoted value'`（去除外层引号）
- `export KEY=VALUE`（`export` 前缀会被忽略）
- `#` 开头的行视为注释
- 空行自动跳过

`.env` 中的变量先于 `RUNNERX_*` 变量注入，因此用户在表单里填写的输入值（`RUNNERX_<ID>`）会覆盖 `.env` 中的同名变量。

沙盒模式同样生效：`.env` 中的变量会作为 `-e` 参数传给 `docker run` / `docker exec`。

典型用途：存放 API Key、服务地址等脚本需要但不适合让用户每次填写的配置。

---

## 沙盒模式 (Docker)

在 manifest 顶部加 **`sandbox.image`** 一个字段，整个脚本就跑在 Docker 容器里——不影响其它字段写法（平台块里的 entry / install / uninstall / preRun 以及 inputs / outputs 都和 host 模式一样）。

```yaml
sandbox:
  image: python:3.11-slim   # 必填，唯一的沙盒字段
```

### 行为约定

| 阶段 | runnerx 做的事 |
|---|---|
| **install** | `docker pull <base>` → 启临时容器 → 把脚本目录 cp 到容器内 `/runnerx/work` → cwd=`/runnerx/work` 跑 install.sh → `docker commit` 到 `runnerx-script-<id>:installed` |
| **run** | 从 installed image 启 `--rm` 容器 → 自动挂载 `file`/`files`/`directory` 输入到 `/runnerx/in/<id>` (**强制 ro**) → output 临时目录挂到 `/runnerx/out/<id>` (rw, 完成后搬回用户选的 host 路径) → `--network=<setting>`、cwd=`/runnerx/work` → entry 走 `sh -c` |
| **uninstall** | 跑用户的 uninstall.sh（在容器里）→ `docker rmi` installed image。**base image 不会被删**——多个脚本可能共享同一 base，要清理用 `docker rmi <base>` 自己处理 |
| **cancel** | `docker rm -f` 容器 |

### 关键约束

- **mount 全部 ro**，没有 `writable: true` 选项。要让脚本"产出"文件，用 `outputs` 声明（output 会挂 rw 临时目录中转）。
- **网络**：install 阶段恒为 bridge（要拉镜像 / pip / apt）；run 阶段从全局配置读，默认 `bridge`。设置面板可改成 `none`（完全隔离）或 `host`（共享宿主机网络）。配置写到 `$RUNNERX_HOME/config.yaml`，可手动编辑。
- **路径环境变量自动翻译**：脚本看到的是容器路径（`/runnerx/in/foo`），不是 host 路径。这是隔离的目的。
- **改源代码要 reinstall**：image 是状态。脚本目录改了不会自动同步进容器，必须再点一次安装来 commit 新 image。

### 前置

需要 Docker daemon 在跑（macOS / Windows 装 Docker Desktop，Linux 原生 docker 或 colima 都行）。runnerx 通过命令行 `docker` 调用，没有走 socket SDK，所以装哪个 docker daemon 都行。

### 何时不用沙盒模式

- 自己写的脚本、自己机器上跑——纯 host 模式更轻、改一行立即生效。
- 沙盒主要用在：**接收别人的脚本**、**怕脚本写坏 host fs**、**不同脚本依赖冲突想完全隔离**。

## AI 创建脚本

侧栏顶部的 **AI** 按钮可以直接让大模型按照本文档的 manifest / 协议规范，在脚本根目录里创建一个新脚本。

### 配置

⚙ 设置 → **AI 模型** → 勾选启用，填四项：

| 字段 | 说明 |
|---|---|
| 服务商 | OpenAI / Anthropic / Google Generative AI / DeepSeek |
| API Key | 本地保存到 `$RUNNERX_HOME/config.yaml`，调用时由本应用直连厂商 API，不经任何中转 |
| Base URL | 选默认服务商时已自动填好；想接 OpenRouter / Together / Groq / 本地 Ollama 等 OpenAI 兼容服务，选 OpenAI 后改 Base URL 即可 |
| 模型 | 如 `gpt-4o-mini`、`claude-sonnet-4-5`、`gemini-2.5-flash`、`deepseek-chat` |

### 流程

1. 在描述框里说明脚本要做什么、有哪些输入、用什么工具实现，越具体越好。
2. 点 "生成" 后右侧会**流式**显示 AI 输出（XML 风格的 `<file>` 块）。
3. 输出完成后切到预览面板，逐个文件查看；如果不满意可"重新生成"。
4. 确认无误点 "写入脚本目录"，应用会在脚本根目录下创建 `<id>/` 子目录，写入所有文件，shell 脚本自动设 `0755`。
5. 写完后侧栏自动选中新脚本，可直接安装/运行。

### 注意

- 路径合法性由后端 `write_script_files` 校验：拒绝绝对路径、`..`、空 id；目录已存在时要勾选"覆盖"才会写入。
- AI 输出会嵌入完整的 manifest 规范、输入类型、`@@runnerx` 协议、`argsMode` 三种模式作为 system prompt，所以无需手动粘贴文档片段给 AI。
- 第一次跑出来的脚本可能需要小修——把它当起点而非终点。

## 示例脚本

仓库自带 `examples/` 目录，**可以直接把它当作 scripts root 使用**：

- `echo-demo` — 演示所有输入类型 + when 联动 + 完整协议输出。
- `ffmpeg-extract-audio` — 真实可用：调 ffmpeg 解码音轨，按 ffmpeg 的 `-progress` 流推进进度条。
- `python-batch-rename` — 演示平台块里的 `install` 钩子（创建 venv）+ `argsMode: stdin-json`。
- `pwsh-file-stats` — PowerShell 入门：演示在两个平台块里分别配置 PowerShell 解释器（macOS 用 `pwsh`、Windows 用自带 `powershell.exe`），以及手动构造 JSON 协议（绕开 PS 5.1 `ConvertTo-Json` 的嵌套数组限制）。
- `archive-folder` — 真跨平台示例：**同一个 manifest 里写 macos 和 windows 两个平台块，macOS 走 `run.sh` + `zip`，Windows 走 `run.ps1` + `Compress-Archive`**。两套独立实现，相同输入产出等价的 zip。
- `archive-folder-sandboxed` — 沙盒模式示例：和 `archive-folder` 同样把目录打包为 zip，但跑在 `alpine:3.20` 容器里，install 时 `apk add zip`。这个场景天然契合沙盒（输入 ro 读取 + 输出 rw 中转）。

启动应用后在设置里把脚本目录指到本仓库的 `examples/` 即可立即试用。
