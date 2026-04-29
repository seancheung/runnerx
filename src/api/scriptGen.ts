import { chat, LlmError, type ChatDeltaKind, type ChatMessage } from "./llm";
import type { LlmConfig } from "../types/config";

export type Platform = "windows" | "macos" | "linux";

export interface GeneratedFile {
  path: string;
  content: string;
  executable: boolean;
}

export interface GeneratedScript {
  id: string;
  files: GeneratedFile[];
  rationale: string;
}

export function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  if (ua.includes("mac os x") || ua.includes("macintosh")) return "macos";
  return "linux";
}

const PLATFORM_LABEL: Record<Platform, string> = {
  windows: "Windows（PowerShell）",
  macos: "macOS（bash 3.2）",
  linux: "Linux（bash）",
};

const SYSTEM_PROMPT = `你是 runnerx 脚本作者助手。runnerx 是一个跨平台桌面应用（Tauri + React），按目录加载用户脚本，根据 \`manifest.yaml\` 渲染表单、执行命令、显示进度和结构化结果。

# 脚本目录结构

每个脚本是一个目录，必须包含 \`manifest.yaml\`。常见文件：
- \`manifest.yaml\` 必需
- \`run.sh\` / \`run.py\` / \`run.ps1\` 入口脚本
- \`install.sh\` 可选安装脚本（如装 venv、apt 包）
- \`README.md\` 可选说明文档

# manifest.yaml 字段

\`\`\`yaml
name: 显示名（必填）
id: 稳定 id（可选；默认用目录名）
description: 一句话说明
version: 版本字符串
category: 分类
tags: [标签1, 标签2]
icon: 相对路径（可选，PNG/SVG/JPG/WebP）
readme: 相对路径（默认 README.md）

entry:                     # 必填，作为脚本的默认入口（通常是用户当前平台对应的命令）
  command: ./run.sh        # 入口命令
  args: ["--foo"]          # 可选附加参数
  shell: false             # 是否走 shell 解释
  cwd: "."                 # 工作目录
  argsMode: env            # env (默认) | argv | stdin-json

# 平台覆盖（可选；只有需要跨平台时才加。每项都是对顶层 entry / lifecycle 的覆盖，不是替代）
platform:
  windows:
    entry:
      command: powershell.exe                # 或 pwsh（PowerShell 7+，需用户自行安装）
      args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "run.ps1"]
  macos:
    entry: { command: ./run.sh }

# 生命周期（可选）
lifecycle:
  install:   { command: ./install.sh }
  uninstall: { command: ./uninstall.sh }
  preRun:    { command: ./check.sh }

# 沙盒（可选；声明后整个脚本跑在 docker 容器里。默认不要加）
sandbox:
  image: python:3.11-slim

inputs:
  - id: msg                # 唯一标识（snake_case 或 camelCase 都行）
    type: string           # 见下表
    label: 显示标签
    description: 详细说明
    required: true
    default: 默认值
    placeholder: 占位文本
    when: { other_id: value }   # 条件显示，可选

outputs:
  - id: out_file
    type: file             # file | directory | text
    save: true             # 运行前弹保存对话框
    accept: [".mp3"]
\`\`\`

# 输入类型 (11 种)

| type | 说明 |
|------|------|
| string | 单行文本；multiline:true 多行；可加 pattern / minLength / maxLength |
| number | 数字；min / max / step / integer:true |
| boolean | 复选框 |
| enum | 下拉单选；multiple:true 多选 chip；options 必填 |
| file | 单文件；accept 限制扩展名 |
| files | 多文件 |
| directory | 目录选择 |
| password | 文本框输入掩盖 |
| date | YYYY-MM-DD |
| json | JSON 文本框 |

enum options 形式（任选其一）：
\`\`\`yaml
options: [a, b, c]
options:
  - { value: a, label: 选项 A }
  - { value: b, label: 选项 B }
\`\`\`

# 参数传递模式

\`entry.argsMode\`：
- **env** (默认): \`RUNNERX_<ID大写>\` 环境变量；输出是 \`RUNNERX_OUT_<ID大写>\`。布尔传 1/0；多文件用 \`:\` (Unix) 或 \`;\` (Windows) 分隔；多选 enum 用 \`,\` 分隔。
- **argv**: 以 \`--<id-kebab-case>=<value>\` 追加。
- **stdin-json**: 把 \`{"inputs": {...}, "outputs": {...}}\` 写到 stdin。

# 输出协议（@@runnerx）

脚本任意一行以 \`@@runnerx \` 开头会被解析；其它行进入控制台。

\`\`\`
@@runnerx progress {"value": 0.5, "message": "encoding..."}    # value 0-1
@@runnerx log {"level": "info|warn|error", "message": "..."}
@@runnerx result {"type": "table", "title": "...", "columns": ["a","b"], "rows": [[1,2]]}
@@runnerx result {"type": "image", "path": "/abs/preview.png", "label": "..."}
@@runnerx result {"type": "file", "path": "/abs/output.mp3", "label": "..."}
@@runnerx result {"type": "json", "data": {...}, "label": "..."}
@@runnerx result {"type": "text", "data": "...", "label": "..."}
\`\`\`

**协议行的 payload 必须是严格合法的 JSON**，否则解析失败、整行会作为普通 stdout 显示给用户：
- 数字必须带整数部分：写 \`0.5\` ✓ 而不是 \`.5\` ✗（\`bc\` 默认输出 \`scale=4; 21/100\` 会得到 \`.2100\`，**这种值不能直接塞进 JSON**）。
- 在 bash 里安全做法：用 \`printf '%.4f' "$x"\` 或 \`awk\` 格式化数字；用 \`bc\` 时先用 \`awk\` / \`printf\` 套一层补零，或用 \`echo "scale=4; ... " | bc | awk '{printf "%.4f", $1}'\`。
- 字符串里出现的双引号、反斜杠、换行要转义。bash 里推荐用 \`printf '@@runnerx progress {"value":%.4f,"message":"%s"}\\n' "$v" "$msg"\` 这种格式化输出，避免手拼 JSON 出错。
- \`value\` 必须是 0~1 的浮点数，超出范围请先 clamp。

# 平台与最佳实践

- **顶层 \`entry\` 必填**，作为脚本的默认入口；用户消息会注明当前平台，请把顶层 \`entry\` 写成在该平台原生可运行的命令。
- **默认单平台**：除非用户在需求里明确要求"跨平台"/"多平台"/"Windows 和 macOS 都能跑"等，**否则不要写 \`platform\` 字段**，只生成针对当前平台的单平台脚本。
- **默认不沙盒**：除非用户在需求里明确要求"沙盒"/"docker"/"容器隔离"/"sandbox"等，**否则不要写 \`sandbox\` 字段**，让脚本直接跑在宿主机上。
- 跨平台脚本（仅在用户明确要求时）：仍然要写顶层 \`entry\`，再用 \`platform.windows\` / \`platform.macos\` / \`platform.linux\` 覆盖其它平台；\`platform.<os>.entry\` 只是覆盖，不能替代顶层 \`entry\`，缺失顶层 \`entry\` 会导致脚本加载失败。
- bash 脚本第一行写 shebang \`#!/usr/bin/env bash\`；用 \`set -euo pipefail\`。
- Windows 平台用 \`run.ps1\`，**不要**靠 \`shell: true\` 直接把 \`.ps1\` 当 command — \`shell: true\` 在 Windows 下走的是 \`cmd /C\`，\`cmd\` 不会执行 \`.ps1\` 文件。正确写法是把 PowerShell 解释器作为 command，把脚本路径作为 \`-File\` 参数：
  \`\`\`yaml
  entry:
    command: powershell.exe                # 系统自带的 Windows PowerShell 5.1，开箱即用
    args: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", "run.ps1"]
    argsMode: env
  \`\`\`
  如果脚本里用了 PowerShell 7+ 的特性（如三元运算符 \`?:\`、\`ForEach-Object -Parallel\`），改用 \`command: pwsh\`，并在 README 里提示用户先装 PowerShell 7。
- 引用环境变量时大写，e.g. \`"\${RUNNERX_TITLE:-default}"\`（PowerShell 用 \`$env:RUNNERX_TITLE\`）。
- 推进进度条：每步打印一行 \`@@runnerx progress {"value":<0~1>,"message":"..."}\`；务必输出严格合法 JSON（特别注意 \`bc\` 的 \`.5\` 这种无前导 0 的小数会破坏 JSON，用 \`printf '%.4f'\` 套一层）。
- 写有意义的 description；分类放在 \`category\`，常见分类：媒体、数据、文件、系统、开发、示例。
- macOS 自带 bash 是 **3.2**，不要用 4.x 才有的特性。

# 输出格式 — 重要

请用以下 XML 风格输出。可以在 \`<script>\` 之前用 \`<plan>\` 标签简短说明你的设计；只允许 \`<script>\` 块内的内容被写入磁盘。

\`\`\`
<plan>
两段以内简短说明思路。
</plan>
<script id="kebab-case-id">
<file path="manifest.yaml">
... 完整 yaml 内容 ...
</file>
<file path="run.sh" executable="true">
#!/usr/bin/env bash
set -euo pipefail
... 脚本主体 ...
</file>
<file path="README.md">
# 脚本名

简短说明 + 用法。
</file>
</script>
\`\`\`

约束：
- \`id\` 必须是 kebab-case，纯小写字母 / 数字 / 连字符，且与 manifest.name 对应。
- \`<file>\` 的 \`path\` 是相对脚本目录的路径，禁止 \`..\` 和绝对路径。
- shell 脚本（\`.sh\`）必须 \`executable="true"\`。
- 不要使用 markdown code fence 包裹 \`<script>\` 块；直接写裸 XML。
- 文件内容直接写在 \`<file>\` 之间，不要做任何 escape；对 \`<\` \`>\` 等 XML 字符不要用实体。解析器靠 \`</file>\` 行匹配。`;

export interface ExistingFile {
  path: string;
  content: string;
}

export async function editScript(
  cfg: LlmConfig,
  args: {
    originalId: string;
    files: ExistingFile[];
    instruction: string;
  },
  options: {
    signal?: AbortSignal;
    onDelta?: (chunk: string, kind: ChatDeltaKind) => void;
    platform?: Platform;
  } = {},
): Promise<GeneratedScript> {
  const platform = options.platform ?? detectPlatform();
  const platformLabel = PLATFORM_LABEL[platform];
  const existingBlock = args.files
    .map((f) =>
      `<existing-file path="${f.path}">\n${f.content.replace(/\r\n/g, "\n")}\n</existing-file>`,
    )
    .join("\n\n");
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `我有一个现存的 runnerx 脚本（id=\`${args.originalId}\`），下面是它当前的所有文本文件（二进制如图标已省略）：\n\n` +
        `${existingBlock}\n\n` +
        `修改请求：\n${args.instruction.trim()}\n\n` +
        `请输出修改后**完整的 \`<script>\` 块**：所有未改动的文件也要原样写出，不要省略，也不要写"unchanged"等占位。\n` +
        `当前用户平台：${platformLabel}；如顶层 entry 命令需调整，请适配该平台。\n` +
        `\`<script>\` 的 \`id\` **必须保留为 \`${args.originalId}\`**（除非修改请求里明确要求改名为新的 kebab-case id）。\n` +
        `**只在原脚本已经使用 \`platform\` 字段，或修改请求明确要求"跨平台"/"多平台"** 时才保留/添加 \`platform\` 覆盖；` +
        `否则不要添加新的 \`platform\` 字段。\n` +
        `**只在原脚本已经使用 \`sandbox\` 字段，或修改请求明确要求"沙盒"/"docker"/"容器隔离"** 时才保留/添加 \`sandbox\`；` +
        `否则不要添加新的 \`sandbox\` 字段。\n\n` +
        `按照系统消息里的格式输出。`,
    },
  ];
  const text = await chat(cfg, messages, {
    signal: options.signal,
    onDelta: options.onDelta,
    maxTokens: 8192,
  });
  return parseGeneratedScript(text);
}

export async function generateScript(
  cfg: LlmConfig,
  description: string,
  options: {
    signal?: AbortSignal;
    onDelta?: (chunk: string, kind: ChatDeltaKind) => void;
    platform?: Platform;
  } = {},
): Promise<GeneratedScript> {
  const platform = options.platform ?? detectPlatform();
  const platformLabel = PLATFORM_LABEL[platform];
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM_PROMPT },
    {
      role: "user",
      content:
        `请帮我创建一个 runnerx 脚本，需求如下：\n\n${description.trim()}\n\n` +
        `当前用户平台：${platformLabel}。请把顶层 entry 写成该平台原生可运行的命令。\n` +
        `**不要**添加 \`platform\` 覆盖字段，除非上面的需求里明确要求"跨平台"/"多平台"/"Windows 和 macOS 都能跑"等多平台兼容；` +
        `没有明确要求多平台时，只针对当前平台生成单平台脚本即可。\n` +
        `**不要**添加 \`sandbox\` 字段，除非上面的需求里明确要求"沙盒"/"docker"/"容器隔离"/"sandbox"等；` +
        `没有明确要求时，让脚本直接在宿主机上运行。\n\n` +
        `按照系统消息里的格式输出。`,
    },
  ];
  const text = await chat(cfg, messages, {
    signal: options.signal,
    onDelta: options.onDelta,
    maxTokens: 8192,
  });
  return parseGeneratedScript(text);
}

/**
 * Rewrite the top-level `id:` field of a manifest.yaml to `newId`.
 * - Only matches lines that start at column 0, so nested `id:` fields
 *   inside `inputs:` / `outputs:` are left alone.
 * - If no top-level `id:` is present, inserts one right after `name:`
 *   (or at the top if `name:` isn't found).
 */
export function rewriteManifestId(yaml: string, newId: string): string {
  const re = /^id:[ \t].*$/m;
  if (re.test(yaml)) {
    return yaml.replace(re, `id: ${newId}`);
  }
  const lines = yaml.split("\n");
  const insertAt = lines.findIndex((l) => /^name:[ \t]/.test(l));
  if (insertAt >= 0) {
    lines.splice(insertAt + 1, 0, `id: ${newId}`);
  } else {
    lines.unshift(`id: ${newId}`);
  }
  return lines.join("\n");
}

/**
 * Apply `targetId` to the manifest.yaml inside `files`, returning a new array.
 * Files other than the manifest are left as-is.
 */
export function applyTargetId(
  files: GeneratedFile[],
  targetId: string,
): GeneratedFile[] {
  return files.map((f) => {
    if (f.path === "manifest.yaml" || f.path === "manifest.yml") {
      return { ...f, content: rewriteManifestId(f.content, targetId) };
    }
    return f;
  });
}

export function parseGeneratedScript(text: string): GeneratedScript {
  const planMatch = text.match(/<plan>([\s\S]*?)<\/plan>/i);
  const rationale = planMatch ? planMatch[1].trim() : "";

  const scriptMatch = text.match(/<script\b([^>]*)>([\s\S]*?)<\/script>/i);
  if (!scriptMatch) {
    throw new LlmError(`AI 输出里没有找到 <script> 块：\n\n${text.slice(0, 600)}`);
  }
  const attrs = scriptMatch[1];
  const inner = scriptMatch[2];

  const idAttr = attrs.match(/\bid\s*=\s*"([^"]+)"/i)?.[1]?.trim();
  if (!idAttr) {
    throw new LlmError("<script> 缺少 id 属性");
  }
  const id = idAttr;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new LlmError(`<script> id "${id}" 非 kebab-case`);
  }

  const files: GeneratedFile[] = [];
  const fileRe = /<file\b([^>]*)>([\s\S]*?)<\/file>/gi;
  let m: RegExpExecArray | null;
  while ((m = fileRe.exec(inner)) !== null) {
    const fAttrs = m[1];
    const raw = m[2];
    const pathAttr = fAttrs.match(/\bpath\s*=\s*"([^"]+)"/i)?.[1];
    if (!pathAttr) throw new LlmError("<file> 缺少 path 属性");
    const execAttr = fAttrs.match(/\bexecutable\s*=\s*"([^"]+)"/i)?.[1];
    const executable = execAttr === "true" || /\.(sh|py|rb|pl)$/i.test(pathAttr);
    if (pathAttr.includes("..") || pathAttr.startsWith("/")) {
      throw new LlmError(`非法 path：${pathAttr}`);
    }
    // Trim a single leading newline that's typical right after <file ...>
    let content = raw;
    if (content.startsWith("\r\n")) content = content.slice(2);
    else if (content.startsWith("\n")) content = content.slice(1);
    if (content.endsWith("\r\n")) content = content.slice(0, -2);
    else if (content.endsWith("\n")) content = content.slice(0, -1);
    files.push({ path: pathAttr.trim(), content, executable });
  }

  if (files.length === 0) {
    throw new LlmError("AI 输出里没有任何 <file> 块");
  }
  if (!files.some((f) => f.path === "manifest.yaml" || f.path === "manifest.yml")) {
    throw new LlmError("AI 输出缺少 manifest.yaml");
  }
  return { id, files, rationale };
}
