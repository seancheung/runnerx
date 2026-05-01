import { chat, LlmError, type ChatDeltaKind, type ChatMessage } from "./llm";
import type { LlmConfig } from "../types/config";
import SYSTEM_PROMPT from "./scriptAuthor.prompt.txt?raw";

export type Platform = "windows" | "macos";

export interface GeneratedFile {
  path: string;
  content: string;
  executable: boolean;
}

export interface GeneratedScript {
  id: string;
  files: GeneratedFile[];
  rationale: string;
  /** Paths the AI marked for deletion via `<deleted-file path="..." />`.
   *  Only meaningful for edit flows; create flow ignores this. */
  deletedPaths: string[];
}

export interface ExistingFileWithExec {
  path: string;
  content: string;
  executable: boolean;
}

export function detectPlatform(): Platform {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("windows")) return "windows";
  // 应用本身只发布 macOS 和 Windows 版；其它环境（dev on linux 等）默认按 macOS 出
  return "macos";
}

const PLATFORM_LABEL: Record<Platform, string> = {
  windows: "Windows（PowerShell）",
  macos: "macOS（bash 3.2）",
};

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
        `**只输出实际发生变更的文件**：\n` +
        `- 修改的或新增的文件用普通的 \`<file path="...">…</file>\`，写完整内容（不是 patch / diff）。\n` +
        `- 要删除的文件用自闭合标签 \`<deleted-file path="..." />\`，可写多个。\n` +
        `- **未改动的文件不要输出**，应用会自动从原脚本里继承。\n` +
        `- 如果 \`manifest.yaml\` 没改动，就不要输出它。\n` +
        `当前用户平台：${platformLabel}；如平台块的 entry 命令需调整，请适配该平台。\n` +
        `\`<script>\` 的 \`id\` **必须保留为 \`${args.originalId}\`**（除非修改请求里明确要求改名为新的 kebab-case id）。\n` +
        `**只在原脚本已经声明了多个平台块，或修改请求明确要求"跨平台"/"多平台"** 时才同时输出 \`macos\` 和 \`windows\` 两个块；` +
        `否则保持原脚本的平台支持范围（单平台就维持单平台）。\n` +
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
  return parseGeneratedScript(text, { requireManifest: false });
}

/**
 * Merge AI-edited diff with the existing scripts files. Returns the full
 * file set ready to write. Validates that `manifest.yaml` survives the merge
 * (rejects the edit if both the existing file and the new output lack it).
 *
 * Rules:
 * - Files in `parsed.deletedPaths` are dropped from the result.
 * - Files in `parsed.files` replace existing files (or get added).
 * - All other existing files are carried through unchanged.
 */
export function mergeEditWithExisting(
  existing: ExistingFileWithExec[],
  parsed: GeneratedScript,
): GeneratedFile[] {
  const deleted = new Set(parsed.deletedPaths);
  const newPaths = new Set(parsed.files.map((f) => f.path));
  const out: GeneratedFile[] = [];
  for (const e of existing) {
    if (deleted.has(e.path)) continue;
    if (newPaths.has(e.path)) continue; // overridden below
    out.push({ path: e.path, content: e.content, executable: e.executable });
  }
  for (const f of parsed.files) {
    // Defensive: ignore a path the AI both edits and marks for deletion.
    if (deleted.has(f.path)) continue;
    out.push(f);
  }
  if (!out.some((f) => f.path === "manifest.yaml" || f.path === "manifest.yml")) {
    throw new LlmError("修改后丢失 manifest.yaml — AI 标记删除或改名了 manifest，拒绝写入");
  }
  return out;
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
        `当前用户平台：${platformLabel}。如果是单平台脚本，**只输出对应的那一个平台块**（${platform === "windows" ? "windows" : "macos"}）。\n` +
        `**默认单平台**：除非上面的需求里明确要求"跨平台"/"多平台"/"Windows 和 macOS 都能跑"，否则只生成一个平台块。\n` +
        `**默认不沙盒**：除非上面的需求里明确要求"沙盒"/"docker"/"容器隔离"/"sandbox"，否则不要写 \`sandbox\` 字段。\n\n` +
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
  return upsertManifestField(yaml, "id", newId);
}

/**
 * Read a top-level scalar field from a manifest.yaml. Returns the raw value
 * (without quotes) or undefined if absent. Only matches lines starting at
 * column 0 so nested fields under `inputs:` / `outputs:` are ignored.
 */
export function getManifestField(yaml: string, field: string): string | undefined {
  const re = new RegExp(`^${field}:[ \\t]+(.*)$`, "m");
  const m = yaml.match(re);
  if (!m) return undefined;
  return m[1].trim().replace(/^["']|["']$/g, "");
}

/**
 * Insert or update a top-level scalar field. Existing field gets its value
 * replaced; otherwise the field is appended after `name:` (or at the top if
 * `name:` is missing). Same column-0 matching as `rewriteManifestId`.
 */
export function upsertManifestField(yaml: string, field: string, value: string): string {
  const re = new RegExp(`^${field}:[ \\t].*$`, "m");
  if (re.test(yaml)) {
    return yaml.replace(re, `${field}: ${value}`);
  }
  const lines = yaml.split("\n");
  const insertAt = lines.findIndex((l) => /^name:[ \t]/.test(l));
  if (insertAt >= 0) {
    lines.splice(insertAt + 1, 0, `${field}: ${value}`);
  } else {
    lines.unshift(`${field}: ${value}`);
  }
  return lines.join("\n");
}

/**
 * Stamp `appVersion: <appVersion>` into the manifest.yaml inside `files`.
 * Used when creating a new script (records the app version at creation time)
 * or when editing — to carry the original creation version over when the AI
 * re-emits the manifest. Pass `mode: "preserve"` to leave existing values
 * alone (edit flow); `"overwrite"` to force-set (create flow).
 */
export function applyAppVersion(
  files: GeneratedFile[],
  appVersion: string,
  mode: "overwrite" | "preserve",
): GeneratedFile[] {
  return files.map((f) => {
    if (f.path !== "manifest.yaml" && f.path !== "manifest.yml") return f;
    if (mode === "preserve" && getManifestField(f.content, "appVersion")) return f;
    return { ...f, content: upsertManifestField(f.content, "appVersion", appVersion) };
  });
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

export function parseGeneratedScript(
  text: string,
  opts: { requireManifest?: boolean } = {},
): GeneratedScript {
  const requireManifest = opts.requireManifest ?? true;

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

  // Self-closing or paired <deleted-file path="..." /> tags. Edit flow only.
  const deletedPaths: string[] = [];
  const deletedRe = /<deleted-file\b([^>]*?)\/?>(?:\s*<\/deleted-file>)?/gi;
  while ((m = deletedRe.exec(inner)) !== null) {
    const pathAttr = m[1].match(/\bpath\s*=\s*"([^"]+)"/i)?.[1];
    if (!pathAttr) throw new LlmError("<deleted-file> 缺少 path 属性");
    if (pathAttr.includes("..") || pathAttr.startsWith("/")) {
      throw new LlmError(`非法 deleted path：${pathAttr}`);
    }
    deletedPaths.push(pathAttr.trim());
  }

  if (requireManifest) {
    if (files.length === 0) {
      throw new LlmError("AI 输出里没有任何 <file> 块");
    }
    if (!files.some((f) => f.path === "manifest.yaml" || f.path === "manifest.yml")) {
      throw new LlmError("AI 输出缺少 manifest.yaml");
    }
  } else if (files.length === 0 && deletedPaths.length === 0) {
    throw new LlmError("AI 没有产出任何变更（既无 <file> 也无 <deleted-file>）");
  }

  return { id, files, rationale, deletedPaths };
}
