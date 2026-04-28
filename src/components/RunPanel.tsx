import { Console, type ConsoleLine } from "./Console";
import { ResultRenderer } from "./ResultRenderer";
import type { ResultPayload } from "../types/manifest";

export interface RunSnapshot {
  runId: string | null;
  status: "idle" | "running" | "exited" | "cancelled" | "error";
  exitCode: number | null;
  progress: number;
  progressMessage: string | null;
  lines: ConsoleLine[];
  results: ResultPayload[];
  error: string | null;
  mode: "script" | "install" | "uninstall" | null;
}

export const EMPTY_RUN: RunSnapshot = {
  runId: null,
  status: "idle",
  exitCode: null,
  progress: 0,
  progressMessage: null,
  lines: [],
  results: [],
  error: null,
  mode: null,
};

interface Props {
  run: RunSnapshot;
  onCancel: () => void;
}

export function RunPanel({ run, onCancel }: Props) {
  const showProgress = run.status === "running" && run.progress > 0;
  const modeLabel =
    run.mode === "install" ? "（安装）"
    : run.mode === "uninstall" ? "（卸载）"
    : "";
  const statusEl = run.status === "idle"
    ? <span>未运行</span>
    : run.status === "running"
      ? <span className="pending">运行中…{modeLabel}</span>
      : run.status === "exited"
        ? run.exitCode === 0
          ? <span className="ok">已完成{modeLabel}（exit 0）</span>
          : <span className="err">退出码 {run.exitCode ?? "?"}{modeLabel}</span>
        : run.status === "cancelled"
          ? <span className="err">已取消{modeLabel}</span>
          : <span className="err">{run.error ?? "出错了"}</span>;

  return (
    <div>
      <div className="run-status">
        {statusEl}
        {run.status === "running" && (
          <button danger-button="" className="danger" style={{ float: "right", padding: "2px 10px", fontSize: 11 }} onClick={onCancel}>
            取消
          </button>
        )}
      </div>

      {showProgress && (
        <div className="run-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${Math.min(100, Math.max(0, run.progress * 100))}%` }} />
          </div>
          <div className="progress-text">
            {Math.round(run.progress * 100)}%{run.progressMessage ? ` — ${run.progressMessage}` : ""}
          </div>
        </div>
      )}

      <ResultRenderer payloads={run.results} />

      <Console lines={run.lines} />
    </div>
  );
}
