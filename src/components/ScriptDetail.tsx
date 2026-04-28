import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import * as api from "../api";
import type { ScriptInfo } from "../types/manifest";
import { DynamicForm, type FormValues } from "./DynamicForm";
import { IconBlock } from "./IconBlock";
import { RunPanel, type RunSnapshot } from "./RunPanel";

interface Props {
  script: ScriptInfo;
  run: RunSnapshot;
  onStartRun: (values: FormValues) => void;
  onStartInstall: () => void;
  onStartUninstall: () => void;
  onCancel: () => void;
  onMarkUninstalled: () => void;
}

export function ScriptDetail({
  script, run, onStartRun, onStartInstall, onStartUninstall, onCancel, onMarkUninstalled,
}: Props) {
  const [tab, setTab] = useState<"run" | "readme">("run");
  const [readme, setReadme] = useState<string | null>(null);

  useEffect(() => {
    setTab("run");
    setReadme(null);
    if (script.readmePath) {
      api.readReadme(script.readmePath).then(setReadme).catch(() => setReadme(null));
    }
  }, [script.dir, script.readmePath]);

  const m = script.manifest;
  const hasInstall = !!m.lifecycle?.install || !!m.platform?.macos?.lifecycle?.install || !!m.platform?.windows?.lifecycle?.install;
  const hasUninstall = !!m.lifecycle?.uninstall || !!m.platform?.macos?.lifecycle?.uninstall || !!m.platform?.windows?.lifecycle?.uninstall;
  const isRunning = run.status === "running";
  const formDisabled = isRunning;

  return (
    <section className="detail">
      <header className="detail-header">
        <IconBlock script={script} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2>{m.name}</h2>
          {m.description && <div className="desc">{m.description}</div>}
          <div className="meta">
            {m.version && <span>v{m.version}</span>}
            {m.category && <span>· {m.category}</span>}
            {(m.tags ?? []).map((t) => <span key={t}>#{t}</span>)}
            {hasInstall && (
              <span style={{ color: script.installed ? "var(--ok)" : "var(--warn)" }}>
                {script.installed ? "● 已安装" : "○ 未安装"}
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          {hasInstall && (
            <button onClick={onStartInstall} disabled={isRunning}>
              {script.installed ? "重新安装" : "安装"}
            </button>
          )}
          {hasUninstall && script.installed && (
            <button onClick={onStartUninstall} disabled={isRunning} title="运行 lifecycle.uninstall 脚本，成功后清除已安装标记">
              卸载
            </button>
          )}
          {hasInstall && script.installed && (
            <button
              onClick={onMarkUninstalled}
              disabled={isRunning}
              title="只删除 .runnerx-installed 标记，不运行任何脚本（用于强制重装）"
            >
              清除标记
            </button>
          )}
        </div>
      </header>

      <div className="detail-body">
        <div className="form-pane">
          <div className="tabs">
            <div className={"tab" + (tab === "run" ? " active" : "")} onClick={() => setTab("run")}>参数</div>
            {readme && <div className={"tab" + (tab === "readme" ? " active" : "")} onClick={() => setTab("readme")}>README</div>}
          </div>
          {tab === "run" ? (
            <DynamicForm manifest={m} disabled={formDisabled} onSubmit={onStartRun} />
          ) : (
            <div className="readme">
              {readme && <ReactMarkdown>{readme}</ReactMarkdown>}
            </div>
          )}
        </div>
        <div className="run-pane">
          <RunPanel run={run} onCancel={onCancel} />
        </div>
      </div>
    </section>
  );
}
