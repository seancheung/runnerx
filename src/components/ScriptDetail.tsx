import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import * as api from "../api";
import type { ScriptInfo } from "../types/manifest";
import { DynamicForm, type FormValues } from "./DynamicForm";
import { IconBlock } from "./IconBlock";
import { PlatformBadge } from "./PlatformBadge";
import { RunPanel, type RunSnapshot } from "./RunPanel";

interface Props {
  script: ScriptInfo;
  run: RunSnapshot;
  onStartRun: (values: FormValues) => void;
  onStartInstall: () => void;
  onStartUninstall: (alsoRemoveBase: boolean) => void;
  onCancel: () => void;
  onMarkUninstalled: () => void;
  onAiEdit: () => void;
}

export function ScriptDetail({
  script, run, onStartRun, onStartInstall, onStartUninstall, onCancel, onMarkUninstalled, onAiEdit,
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
  const isSandbox = !!m.sandbox;
  const supports = script.supportedOnCurrentPlatform;
  // 任意一个平台块定义了 install/uninstall 就在 UI 上把按钮露出来；
  // 实际能否点击还要看 supports（当前平台）。
  const anyInstall = !!(m.macos?.install || m.windows?.install);
  const anyUninstall = !!(m.macos?.uninstall || m.windows?.uninstall);
  // sandbox 模式总要 install (拉镜像 + commit) 和 uninstall (rmi)，
  // 即使 manifest 没写 install / uninstall。
  const hasInstall = isSandbox || anyInstall;
  const hasUninstall = isSandbox || anyUninstall;
  const isRunning = run.status === "running";
  const formDisabled = isRunning || !supports;
  const actionDisabled = isRunning || !supports;
  const unsupportedTitle = "该脚本未声明支持当前平台，无法运行/安装";

  // 卸载永远只删该脚本的 installed image，不删 base image。
  // base image 是系统级共享资源（多个脚本可能共用），UI 一键删风险高；
  // 想清理就用 `docker rmi <base>` 自己处理。
  const handleUninstall = () => onStartUninstall(false);

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
            <PlatformBadge platforms={script.supportedPlatforms} always />
            {!supports && (
              <span style={{ color: "var(--danger)" }} title={unsupportedTitle}>
                ⚠ 不支持当前平台
              </span>
            )}
            {isSandbox && (
              <span title={`Sandbox image: ${m.sandbox?.image}`} style={{ color: "var(--accent)" }}>
                🛡 sandbox · {m.sandbox?.image}
              </span>
            )}
            {hasInstall && (
              <span style={{ color: script.installed ? "var(--ok)" : "var(--warn)" }}>
                {script.installed ? "● 已安装" : "○ 未安装"}
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          <button
            onClick={onAiEdit}
            disabled={isRunning}
            title="让 AI 根据自然语言修改这个脚本"
          >
            AI 修改
          </button>
          {hasInstall && (
            <button
              onClick={onStartInstall}
              disabled={actionDisabled}
              title={!supports ? unsupportedTitle : undefined}
            >
              {script.installed ? "重新安装" : "安装"}
            </button>
          )}
          {hasUninstall && script.installed && (
            <button
              onClick={handleUninstall}
              disabled={actionDisabled}
              title={
                !supports
                  ? unsupportedTitle
                  : isSandbox
                    ? "删除该脚本的 installed image。base image 不会被删（多个脚本可能共享），需要时用 docker rmi 自行清理。"
                    : "运行 uninstall 脚本，成功后清除已安装标记"
              }
            >
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
