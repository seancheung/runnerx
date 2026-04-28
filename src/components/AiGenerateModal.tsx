import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { applyTargetId, generateScript, type GeneratedScript } from "../api/scriptGen";
import { LlmError } from "../api/llm";
import type { AppConfig, LlmConfig } from "../types/config";
import { LLM_PROVIDER_LABELS } from "../types/config";

interface Props {
  root: string | null;
  onClose: () => void;
  onCreated: (scriptDir: string, scriptId: string) => void;
}

type Phase =
  | { kind: "idle" }
  | { kind: "generating"; abort: AbortController }
  | { kind: "preview"; script: GeneratedScript }
  | { kind: "writing" }
  | { kind: "done"; dir: string; id: string }
  | { kind: "error"; message: string; partial?: string };

export function AiGenerateModal({ root, onClose, onCreated }: Props) {
  const [llm, setLlm] = useState<LlmConfig | null>(null);
  const [llmReady, setLlmReady] = useState(false);
  const [description, setDescription] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [streamText, setStreamText] = useState("");
  const [thinkingText, setThinkingText] = useState("");
  const [editedId, setEditedId] = useState("");
  const phaseRef = useRef<Phase>(phase);
  phaseRef.current = phase;

  useEffect(() => {
    api.getConfig().then((c: AppConfig) => {
      setLlm(c.llm ?? null);
      setLlmReady(true);
    }).catch(() => setLlmReady(true));
  }, []);

  useEffect(() => {
    return () => {
      if (phaseRef.current.kind === "generating") {
        phaseRef.current.abort.abort();
      }
    };
  }, []);

  const canGenerate = useMemo(
    () => llmReady && !!llm && !!root && description.trim().length >= 5 &&
      (phase.kind === "idle" || phase.kind === "error" || phase.kind === "preview"),
    [llmReady, llm, root, description, phase.kind],
  );

  const onGenerate = async () => {
    if (!llm || !root) return;
    const ctrl = new AbortController();
    setStreamText("");
    setThinkingText("");
    setPhase({ kind: "generating", abort: ctrl });
    let buffered = "";
    let thinking = "";
    try {
      const script = await generateScript(llm, description, {
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
      setEditedId(script.id);
      setPhase({ kind: "preview", script });
    } catch (e) {
      if (ctrl.signal.aborted) {
        setPhase({ kind: "idle" });
        return;
      }
      const msg = e instanceof LlmError && e.body
        ? `${e.message}\n\n${truncate(e.body, 600)}`
        : e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message: msg, partial: buffered || undefined });
    }
  };

  const onWrite = async () => {
    if (phase.kind !== "preview" || !root) return;
    const id = editedId.trim();
    if (!isValidScriptId(id)) return;
    const script = phase.script;
    setPhase({ kind: "writing" });
    try {
      const aligned = applyTargetId(script.files, id);
      const dir = await api.writeScriptFiles(
        root,
        id,
        aligned.map((f) => ({ path: f.path, content: f.content, executable: f.executable })),
        overwrite,
      );
      setPhase({ kind: "done", dir, id });
      onCreated(dir, id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setPhase({ kind: "error", message: msg });
    }
  };

  const onCancel = () => {
    if (phase.kind === "generating") phase.abort.abort();
    onClose();
  };

  return (
    <div className="modal-backdrop" onClick={onCancel}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(820px, 92vw)", maxWidth: "none", maxHeight: "85vh", overflowY: "auto" }}
      >
        <h3>AI 创建脚本</h3>

        {!llmReady ? (
          <div className="field-desc">加载配置中…</div>
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
              <label className="field-label">描述脚本要做什么</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="示例：批量将一个目录里所有 PNG 转成 JPEG，可以选择质量；用 ImageMagick 实现。"
                rows={6}
                disabled={phase.kind === "generating" || phase.kind === "writing"}
              />
              <div className="field-desc">
                越具体越好，列出输入参数、输出形式、用到的工具（ffmpeg / python / curl …）等。
                当前模型：<code>{LLM_PROVIDER_LABELS[llm.provider]} · {llm.model}</code>
              </div>
            </div>

            {phase.kind === "preview" && (
              <>
                <ScriptIdInput
                  value={editedId}
                  onChange={setEditedId}
                  originalSuggestion={phase.script.id}
                />
                <PreviewBlock
                  script={phase.script}
                  displayId={editedId.trim() || phase.script.id}
                  overwrite={overwrite}
                  onOverwriteChange={setOverwrite}
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
              <div
                className="field-desc"
                style={{ color: "var(--ok)", whiteSpace: "pre-wrap" }}
              >
                ✓ 已创建脚本：<code>{phase.dir}</code>
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
              {phase.kind === "generating" ? "生成中…" : "生成"}
            </button>
          )}
          {phase.kind === "preview" && (
            <>
              <button type="button" onClick={() => setPhase({ kind: "idle" })}>
                重新生成
              </button>
              <button
                type="button"
                className="primary"
                onClick={onWrite}
                disabled={!isValidScriptId(editedId.trim())}
                title={!isValidScriptId(editedId.trim()) ? "脚本 id 非法（kebab-case，纯小写字母/数字/连字符）" : undefined}
              >
                写入脚本目录
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export function StreamView({
  text,
  title,
  placeholder,
  muted = false,
}: {
  text: string;
  title?: string;
  placeholder?: string;
  muted?: boolean;
}) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Stick to bottom while streaming so the user sees the latest chunk.
    el.scrollTop = el.scrollHeight;
  }, [text]);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="field-section-title" style={{ marginTop: 10 }}>
        {title ?? "AI 输出（流式）"}
      </div>
      <pre
        ref={ref}
        style={{
          margin: 0,
          padding: "8px 10px",
          fontSize: 11,
          lineHeight: 1.45,
          background: "var(--code-bg)",
          color: "var(--code-text)",
          border: "1px solid var(--border)",
          borderRadius: 6,
          maxHeight: muted ? 200 : 280,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          opacity: muted ? 0.7 : 1,
          fontStyle: muted ? "italic" : "normal",
        }}
      >
        {text || placeholder || "等待 AI 响应…"}
        {text && <span style={{ color: "var(--accent)" }}>▍</span>}
      </pre>
    </div>
  );
}

function PreviewBlock({
  script,
  displayId,
  overwrite,
  onOverwriteChange,
}: {
  script: GeneratedScript;
  displayId?: string;
  overwrite: boolean;
  onOverwriteChange: (v: boolean) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(script.files[0]?.path ?? null);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="field-section-title" style={{ marginTop: 10 }}>
        预览 — <code>{displayId ?? script.id}/</code>（{script.files.length} 个文件）
      </div>
      {script.rationale && (
        <div className="field-desc" style={{ marginBottom: 8, whiteSpace: "pre-wrap" }}>
          {script.rationale}
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {script.files.map((f) => (
          <div key={f.path} style={{
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-elev-2)",
          }}>
            <button
              type="button"
              onClick={() => setExpanded((p) => p === f.path ? null : f.path)}
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
              }}
            >
              <span>
                {expanded === f.path ? "▼" : "▶"} {f.path}
                {f.executable && (
                  <span style={{ marginLeft: 8, fontSize: 10, color: "var(--text-muted)" }}>
                    +x
                  </span>
                )}
              </span>
              <span style={{ fontSize: 10, color: "var(--text-muted)" }}>
                {f.content.length} 字节
              </span>
            </button>
            {expanded === f.path && (
              <pre style={{
                margin: 0,
                padding: "8px 10px",
                fontSize: 11,
                lineHeight: 1.45,
                background: "var(--code-bg)",
                color: "var(--code-text)",
                borderTop: "1px solid var(--border)",
                maxHeight: 320,
                overflow: "auto",
                whiteSpace: "pre",
              }}>
                {f.content}
              </pre>
            )}
          </div>
        ))}
      </div>
      <label className="field-checkbox" style={{ marginTop: 10 }}>
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(e) => onOverwriteChange(e.target.checked)}
        />
        <span>目录已存在时覆盖（按文件覆盖；旧目录里的其它文件保留）</span>
      </label>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length <= n ? s : s.slice(0, n) + "…";
}

const SCRIPT_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

export function isValidScriptId(id: string): boolean {
  return SCRIPT_ID_RE.test(id);
}

export function ScriptIdInput({
  value,
  onChange,
  label = "脚本 id",
  hint,
  originalSuggestion,
  conflictWith,
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
  hint?: string;
  /** Show a "AI 建议: <x>" reset shortcut when value diverges from it. */
  originalSuggestion?: string;
  /** If set, warn when value equals this (e.g. another script's id). */
  conflictWith?: string;
}) {
  const trimmed = value.trim();
  const valid = isValidScriptId(trimmed);
  const conflict = conflictWith != null && trimmed === conflictWith;
  return (
    <div className="field" style={{ marginTop: 10 }}>
      <label className="field-label">{label}</label>
      <div className="field-row">
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="kebab-case-id"
          spellCheck={false}
          autoComplete="off"
          style={{
            fontFamily: "ui-monospace, monospace",
            borderColor: !trimmed
              ? undefined
              : !valid
                ? "var(--danger)"
                : conflict
                  ? "var(--warn)"
                  : undefined,
          }}
        />
        {originalSuggestion && trimmed !== originalSuggestion && (
          <button type="button" onClick={() => onChange(originalSuggestion)} title="恢复 AI 建议的 id">
            ↺ {originalSuggestion}
          </button>
        )}
      </div>
      <div className="field-desc">
        {!trimmed ? (
          "请输入 id"
        ) : !valid ? (
          <span style={{ color: "var(--danger)" }}>非法：必须是 kebab-case（小写字母 / 数字 / 连字符，且首字符不能是 -）。</span>
        ) : conflict ? (
          <span style={{ color: "var(--warn)" }}>与现有脚本 id 相同，会写到同一目录（如选"另存为"，需勾选覆盖）。</span>
        ) : (
          hint ?? "脚本会写入 <root>/<id>/。kebab-case：小写字母 / 数字 / 连字符。"
        )}
      </div>
    </div>
  );
}
