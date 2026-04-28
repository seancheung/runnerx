import { useEffect, useMemo, useRef, useState } from "react";
import * as api from "../api";
import { generateScript, type GeneratedScript } from "../api/scriptGen";
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
    setPhase({ kind: "generating", abort: ctrl });
    let buffered = "";
    try {
      const script = await generateScript(llm, description, {
        signal: ctrl.signal,
        onDelta: (chunk) => {
          buffered += chunk;
          setStreamText(buffered);
        },
      });
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
    const script = phase.script;
    setPhase({ kind: "writing" });
    try {
      const dir = await api.writeScriptFiles(
        root,
        script.id,
        script.files.map((f) => ({ path: f.path, content: f.content, executable: f.executable })),
        overwrite,
      );
      setPhase({ kind: "done", dir, id: script.id });
      onCreated(dir, script.id);
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
        style={{ minWidth: 560, maxWidth: 860, maxHeight: "85vh", overflowY: "auto" }}
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
              <PreviewBlock
                script={phase.script}
                overwrite={overwrite}
                onOverwriteChange={setOverwrite}
              />
            )}

            {phase.kind === "generating" && (
              <StreamView text={streamText} />
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

function StreamView({ text, title }: { text: string; title?: string }) {
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
          background: "#0e0f12",
          border: "1px solid var(--border)",
          borderRadius: 6,
          maxHeight: 280,
          overflow: "auto",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
        }}
      >
        {text || "等待 AI 响应…"}
        {text && <span style={{ color: "var(--accent)" }}>▍</span>}
      </pre>
    </div>
  );
}

function PreviewBlock({
  script,
  overwrite,
  onOverwriteChange,
}: {
  script: GeneratedScript;
  overwrite: boolean;
  onOverwriteChange: (v: boolean) => void;
}) {
  const [expanded, setExpanded] = useState<string | null>(script.files[0]?.path ?? null);
  return (
    <div style={{ marginTop: 8 }}>
      <div className="field-section-title" style={{ marginTop: 10 }}>
        预览 — <code>{script.id}/</code>（{script.files.length} 个文件）
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
                background: "#0e0f12",
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
