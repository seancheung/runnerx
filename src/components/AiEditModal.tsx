import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { applyTargetId, editScript, type GeneratedFile, type GeneratedScript } from "../api/scriptGen";
import { LlmError } from "../api/llm";
import type { AppConfig, LlmConfig } from "../types/config";
import { LLM_PROVIDER_LABELS } from "../types/config";
import type { ScriptInfo } from "../types/manifest";
import { isValidScriptId, ScriptIdInput, StreamView } from "./AiGenerateModal";

interface ExistingFile {
  path: string;
  content: string;
}

interface Props {
  script: ScriptInfo;
  root: string | null;
  onClose: () => void;
  onSaved: (dir: string, id: string) => void;
}

type Phase =
  | { kind: "loading" }
  | { kind: "idle"; files: ExistingFile[] }
  | { kind: "generating"; abort: AbortController; files: ExistingFile[] }
  | { kind: "preview"; script: GeneratedScript; oldFiles: ExistingFile[] }
  | { kind: "writing" }
  | { kind: "done"; dir: string; id: string }
  | { kind: "error"; message: string; partial?: string; files?: ExistingFile[] };

export function AiEditModal({ script, root, onClose, onSaved }: Props) {
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [llmReady, setLlmReady] = useState(false);
  const [instruction, setInstruction] = useState("");
  const [overwriteOnSaveAs, setOverwriteOnSaveAs] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [streamText, setStreamText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [saveAsId, setSaveAsId] = useState("");
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  const originalId = useMemo(
    () => script.dir.replace(/\\+$/, "").replace(/\/+$/, "").split(/[/\\]/).pop() ?? script.id,
    [script.dir, script.id],
  );

  useEffect(() => {
    let alive = true;
    api.getConfig().then((c: AppConfig) => {
      if (!alive) return;
      setLlm(c.llm ?? null);
      setLlmReady(true);
    }).catch(() => alive && setLlmReady(true));
    api.readScriptFiles(script.dir).then((files) => {
      if (!alive) return;
      setPhase({ kind: "idle", files: files.map((f) => ({ path: f.path, content: f.content })) });
    }).catch((e) => {
      if (!alive) return;
      setPhase({ kind: "error", message: `读取脚本文件失败：${e instanceof Error ? e.message : String(e)}` });
    });
    return () => { alive = false; };
  }, [script.dir]);

  useEffect(() => {
    return () => {
      if (phaseRef.current.kind === "generating") {
        phaseRef.current.abort.abort();
      }
    };
  }, []);

  const idleFiles = phase.kind === "idle" ? phase.files
    : phase.kind === "generating" ? phase.files
    : phase.kind === "preview" ? phase.oldFiles
    : phase.kind === "error" ? (phase.files ?? null)
    : null;

  const canGenerate = useMemo(
    () => llmReady && !!llm && !!root && idleFiles !== null && instruction.trim().length >= 5 &&
      (phase.kind === "idle" || phase.kind === "error" || phase.kind === "preview"),
    [llmReady, llm, root, idleFiles, instruction, phase.kind],
  );

  const onGenerate = async () => {
    if (!llm || !root || idleFiles === null) return;
    const files = idleFiles;
    const ctrl = new AbortController();
    setStreamText("");
    setThinkingText("");
    setPhase({ kind: "generating", abort: ctrl, files });
    let buffered = "";
    let thinking = "";
    try {
      const result = await editScript(llm, {
        originalId,
        files,
        instruction,
      }, {
        signal: ctrl.signal,
        onDelta: (chunk, kind) => {
          if (kind === "thinking") {
            thinking += chunk;
            setThinkingText(thinking);
          } else {
            buffered += chunk;
            setStreamText(buffered);
          }
        },
      });
      // Default the "save as" id to the AI's choice. If it equals originalId
      // (the common case when the AI keeps the id), suggest a -copy suffix so
      // the button is usable without forcing the user to type something.
      setSaveAsId(result.id === originalId ? `${originalId}-copy` : result.id);
      setPhase({ kind: "preview", script: result, oldFiles: files });
    } catch (e) {
      if (ctrl.signal.aborted) {
        setPhase({ kind: "idle", files });
        return;
      }
      const msg = e instanceof LlmError && e.body
        ? `${e.message}\n\n${truncate(e.body, 600)}`
        : e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message: msg, partial: buffered || undefined, files });
    }
  };

  const onOverwrite = async () => {
    if (phase.kind !== "preview" || !root) return;
    const files = applyTargetId(phase.script.files, originalId);
    setPhase({ kind: "writing" });
    try {
      const dir = await api.writeScriptFiles(
        root,
        originalId,
        files.map((f) => ({ path: f.path, content: f.content, executable: f.executable })),
        true,
      );
      setPhase({ kind: "done", dir, id: originalId });
      onSaved(dir, originalId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message: msg });
    }
  };

  const onSaveAs = async () => {
    if (phase.kind !== "preview" || !root) return;
    const newId = saveAsId.trim();
    if (!isValidScriptId(newId)) return;
    if (newId === originalId && !overwriteOnSaveAs) return;
    const files = applyTargetId(phase.script.files, newId);
    setPhase({ kind: "writing" });
    try {
      const dir = await api.writeScriptFiles(
        root,
        newId,
        files.map((f) => ({ path: f.path, content: f.content, executable: f.executable })),
        overwriteOnSaveAs,
      );
      setPhase({ kind: "done", dir, id: newId });
      onSaved(dir, newId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message: msg });
    }
  };

  const onCancel = () => {
    if (phase.kind === "generating") phase.abort.abort();
    onClose();
  };

  const trimmedSaveAsId = saveAsId.trim();
  const saveAsIdValid = isValidScriptId(trimmedSaveAsId);
  const saveAsConflict = trimmedSaveAsId === originalId;
  const canSaveAs =
    phase.kind === "preview" &&
    saveAsIdValid &&
    (!saveAsConflict || overwriteOnSaveAs);

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(820px, 92vw)", maxWidth: "none", maxHeight: "85vh", overflowY: "auto" }}
      >
        <h3>AI 修改脚本 · <code>{originalId}</code></h3>

        {!llmReady || phase.kind === "loading" ? (
          <div className="field-desc">加载中…</div>
        ) : !llm ? (
          <div className="field-desc" style={{ color: "var(--warn)" }}>
            还没有配置 LLM API。请先到 ⚙ 设置里启用 AI 模型。
          </div>
        ) : !root ? (
          <div className="field-desc" style={{ color: "var(--warn)" }}>
            脚本目录未设置。
          </div>
        ) : (
          <>
            <div className="field">
              <label className="field-label">想让 AI 怎么修改这个脚本？</label>
              <textarea
                value={instruction}
                onChange={(e) => setInstruction(e.target.value)}
                placeholder="示例：增加一个 quality 参数（low/medium/high），影响 ffmpeg 的 CRF；progress 推进按帧数计算。"
                rows={5}
                disabled={phase.kind === "generating" || phase.kind === "writing"}
              />
              <div className="field-desc">
                AI 会在原脚本基础上修改，未变的文件会原样保留。
                当前模型：<code>{LLM_PROVIDER_LABELS[llm.provider]} · {llm.model}</code>
              </div>
            </div>

            {phase.kind === "preview" && (
              <>
                <DiffPreview
                  oldFiles={phase.oldFiles}
                  newFiles={phase.script.files}
                  rationale={phase.script.rationale}
                  newId={phase.script.id}
                  originalId={originalId}
                />
                <ScriptIdInput
                  label="另存为脚本 id"
                  value={saveAsId}
                  onChange={setSaveAsId}
                  originalSuggestion={phase.script.id}
                  conflictWith={originalId}
                  hint="点'另存为'会写到 <root>/<id>/。'覆盖当前'始终用原 id，不受此输入影响。"
                />
              </>
            )}

            {phase.kind === "generating" && (
              <>
                {thinkingText && (
                  <StreamView text={thinkingText} title="AI 思考（流式）" muted />
                )}
                <StreamView
                  text={streamText}
                  placeholder={thinkingText ? "AI 思考中…" : "等待 AI 响应…"}
                />
              </>
            )}
            {phase.kind === "writing" && (
              <div className="field-desc" style={{ color: "var(--accent)" }}>
                正在写入脚本目录…
              </div>
            )}
            {phase.kind === "done" && (
              <div className="field-desc" style={{ color: "var(--ok)", whiteSpace: "pre-wrap" }}>
                ✓ 已保存：<code>{phase.dir}</code>
              </div>
            )}
            {phase.kind === "error" && (
              <>
                <div
                  className="field-desc"
                  style={{ color: "var(--danger)", whiteSpace: "pre-wrap" }}
                >
                  {phase.message}
                </div>
                {phase.partial && <StreamView text={phase.partial} title="AI 输出（部分）" />}
              </>
            )}
          </>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onCancel}>
            {phase.kind === "done" ? "关闭" : "取消"}
          </button>
          {phase.kind !== "preview" && phase.kind !== "done" && (
            <button
              type="button"
              className="primary"
              onClick={onGenerate}
              disabled={!canGenerate}
            >
              {phase.kind === "generating" ? "生成中…" : "生成修改"}
            </button>
          )}
          {phase.kind === "preview" && (
            <>
              <button type="button" onClick={() => setPhase({ kind: "idle", files: phase.oldFiles })}>
                重新生成
              </button>
              <label className="field-checkbox" style={{ marginRight: 8, fontSize: 11 }}>
                <input
                  type="checkbox"
                  checked={overwriteOnSaveAs}
                  onChange={(e) => setOverwriteOnSaveAs(e.target.checked)}
                />
                <span>目录已存在则覆盖</span>
              </label>
              <button
                type="button"
                onClick={onSaveAs}
                disabled={!canSaveAs}
                title={
                  !saveAsIdValid
                    ? "脚本 id 非法（kebab-case）"
                    : saveAsConflict && !overwriteOnSaveAs
                      ? "id 与当前脚本相同；勾选覆盖或改个新 id"
                      : `另存为：<root>/${trimmedSaveAsId || "?"}/`
                }
              >
                另存为新脚本
              </button>
              <button
                type="button"
                className="primary"
                onClick={onOverwrite}
              >
                覆盖当前
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffPreview({
  oldFiles, newFiles, rationale, newId, originalId,
}: {
  oldFiles: ExistingFile[];
  newFiles: GeneratedFile[];
  rationale: string;
  newId: string;
  originalId: string;
}) {
  const oldMap = useMemo(
    () => new Map(oldFiles.map((f) => [f.path, f.content])),
    [oldFiles],
  );
  const newMap = useMemo(
    () => new Map(newFiles.map((f) => [f.path, f.content])),
    [newFiles],
  );
  const allPaths = useMemo(() => {
    const set = new Set<string>([...oldMap.keys(), ...newMap.keys()]);
    return Array.from(set).sort();
  }, [oldMap, newMap]);
  type Status = "added" | "removed" | "modified" | "unchanged";
  const items = allPaths.map((path) => {
    const o = oldMap.get(path);
    const n = newMap.get(path);
    let status: Status;
    if (o === undefined) status = "added";
    else if (n === undefined) status = "removed";
    else if (o === n) status = "unchanged";
    else status = "modified";
    return { path, status, oldText: o ?? "", newText: n ?? "" };
  });
  const changed = items.filter((it) => it.status !== "unchanged");
  const [expanded, setExpanded] = useState<string | null>(changed[0]?.path ?? null);

  return (
    <div style={{ marginTop: 8 }}>
      <div className="field-section-title" style={{ marginTop: 10 }}>
        预览改动 — <code>{newId}/</code>
        {newId !== originalId && (
          <span style={{ marginLeft: 6, fontSize: 11, color: "var(--warn)" }}>
            id 已改名（原：{originalId}）
          </span>
        )}
      </div>
      {rationale && (
        <div className="field-desc" style={{ marginBottom: 8, whiteSpace: "pre-wrap" }}>
          {rationale}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((it) => (
          <div key={it.path} style={{
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-elev-2)",
          }}>
            <button
              type="button"
              onClick={() => setExpanded((p) => p === it.path ? null : it.path)}
              disabled={it.status === "unchanged"}
              style={{
                width: "100%",
                textAlign: "left",
                background: "transparent",
                border: "none",
                padding: "6px 10px",
                fontSize: 12,
                fontFamily: "ui-monospace, monospace",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                opacity: it.status === "unchanged" ? 0.55 : 1,
                cursor: it.status === "unchanged" ? "default" : "pointer",
              }}
            >
              <span>
                {it.status !== "unchanged" && (expanded === it.path ? "▼ " : "▶ ")}
                <StatusBadge status={it.status} /> {it.path}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {diffSummary(it)}
              </span>
            </button>
            {expanded === it.path && it.status !== "unchanged" && (
              <DiffBody status={it.status} oldText={it.oldText} newText={it.newText} />
            )}
          </div>
        ))}
      </div>
      {changed.length === 0 && (
        <div className="field-desc" style={{ color: "var(--warn)" }}>
          AI 没有产出任何改动。
        </div>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: "added" | "removed" | "modified" | "unchanged" }) {
  const color =
    status === "added" ? "var(--ok)"
    : status === "removed" ? "var(--danger)"
    : status === "modified" ? "var(--warn)"
    : "var(--text-muted)";
  const label =
    status === "added" ? "+ 新增"
    : status === "removed" ? "- 删除"
    : status === "modified" ? "~ 修改"
    : "= 未变";
  return (
    <span style={{ color, fontSize: 10, marginRight: 6 }}>{label}</span>
  );
}

function diffSummary(it: { status: string; oldText: string; newText: string }) {
  if (it.status === "unchanged") return `${it.newText.length} 字节`;
  if (it.status === "added") return `+${it.newText.split("\n").length} 行`;
  if (it.status === "removed") return `−${it.oldText.split("\n").length} 行`;
  const d = lineDiff(it.oldText, it.newText);
  let add = 0, rem = 0;
  for (const l of d) {
    if (l.type === "add") add++;
    else if (l.type === "rem") rem++;
  }
  return `+${add} −${rem}`;
}

function DiffBody({
  status, oldText, newText,
}: { status: "added" | "removed" | "modified"; oldText: string; newText: string }) {
  const lines = useMemo(() => {
    if (status === "added") {
      return newText.split("\n").map((t) => ({ type: "add" as const, text: t }));
    }
    if (status === "removed") {
      return oldText.split("\n").map((t) => ({ type: "rem" as const, text: t }));
    }
    return lineDiff(oldText, newText);
  }, [status, oldText, newText]);
  return (
    <pre style={{
      margin: 0,
      padding: 0,
      fontSize: 11,
      lineHeight: 1.45,
      background: "var(--code-bg)",
      color: "var(--code-text)",
      borderTop: "1px solid var(--border)",
      maxHeight: 360,
      overflow: "auto",
      whiteSpace: "pre",
      fontFamily: "ui-monospace, monospace",
    }}>
      {lines.map((l, i) => (
        <div key={i} style={diffLineStyle(l.type)}>
          <span style={{ display: "inline-block", width: 14, opacity: 0.7 }}>
            {l.type === "add" ? "+" : l.type === "rem" ? "-" : " "}
          </span>
          {l.text}
        </div>
      ))}
    </pre>
  );
}

function diffLineStyle(type: "eq" | "add" | "rem") {
  if (type === "add") return { background: "rgba(81, 207, 102, 0.15)", padding: "0 8px" };
  if (type === "rem") return { background: "rgba(255, 107, 107, 0.15)", padding: "0 8px" };
  return { padding: "0 8px" };
}

type DiffLine = { type: "eq" | "add" | "rem"; text: string };

// LCS-based line diff. O(N*M) time and memory; falls back to a coarse
// "remove all + add all" when either side gets too large to keep the table
// in memory comfortably.
function lineDiff(a: string, b: string): DiffLine[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const m = A.length, n = B.length;
  if (m * n > 1_000_000) {
    const out: DiffLine[] = [];
    for (const t of A) out.push({ type: "rem", text: t });
    for (const t of B) out.push({ type: "add", text: t });
    return out;
  }
  const dp: number[] = new Array((m + 1) * (n + 1)).fill(0);
  const idx = (i: number, j: number) => i * (n + 1) + j;
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (A[i] === B[j]) dp[idx(i, j)] = dp[idx(i + 1, j + 1)] + 1;
      else dp[idx(i, j)] = Math.max(dp[idx(i + 1, j)], dp[idx(i, j + 1)]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (A[i] === B[j]) {
      out.push({ type: "eq", text: A[i] });
      i++; j++;
    } else if (dp[idx(i + 1, j)] >= dp[idx(i, j + 1)]) {
      out.push({ type: "rem", text: A[i] });
      i++;
    } else {
      out.push({ type: "add", text: B[j] });
      j++;
    }
  }
  while (i < m) out.push({ type: "rem", text: A[i++] });
  while (j < n) out.push({ type: "add", text: B[j++] });
  return out;
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}
