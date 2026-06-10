import { useEffect, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertTriangle, Circle, CircleCheck, Shield, WandSparkles } from "lucide-react";
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
  onAiEdit: () => void;
}

export function ScriptDetail({
  script, run, onStartRun, onStartInstall, onStartUninstall, onCancel, onAiEdit,
}: Props) {
  const [tab, setTab] = useState<"run" | "env" | "readme">("run");
  const [readme, setReadme] = useState<string | null>(null);
  const [envContent, setEnvContent] = useState("");
  const [envSaved, setEnvSaved] = useState("");
  const [envSaving, setEnvSaving] = useState(false);

  useEffect(() => {
    setTab("run");
    setReadme(null);
    setEnvContent("");
    setEnvSaved("");
    api.readDotenv(script.dir).then((c) => { setEnvContent(c); setEnvSaved(c); }).catch(() => {});
    if (script.readmePath) {
      api.readReadme(script.readmePath).then(setReadme).catch(() => setReadme(null));
    }
  }, [script.dir, script.readmePath]);

  const envDirty = envContent !== envSaved;
  const saveEnv = async () => {
    setEnvSaving(true);
    try {
      await api.writeDotenv(script.dir, envContent);
      setEnvSaved(envContent);
    } catch (e) {
      console.error("save .env failed", e);
    } finally {
      setEnvSaving(false);
    }
  };

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
  // 需要 install 但还没装的脚本，运行按钮要禁用（表单可以填，但点不了运行）。
  const runDisabledReason = hasInstall && !script.installed
    ? "脚本尚未安装，请先点击右上角的「安装」"
    : undefined;

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
                <AlertTriangle size={12} className="inline-icon" />
                不支持当前平台
              </span>
            )}
            {isSandbox && (
              <span title={`Sandbox image: ${m.sandbox?.image}`} style={{ color: "var(--accent)" }}>
                <Shield size={12} className="inline-icon" />
                sandbox · {m.sandbox?.image}
              </span>
            )}
            {hasInstall && (
              <span style={{ color: script.installed ? "var(--ok)" : "var(--warn)" }}>
                {script.installed ? (
                  <>
                    <CircleCheck size={12} className="inline-icon" />
                    已安装
                  </>
                ) : (
                  <>
                    <Circle size={12} className="inline-icon" />
                    未安装
                  </>
                )}
              </span>
            )}
          </div>
        </div>
        <div className="actions">
          <button
            onClick={onAiEdit}
            disabled={isRunning || !(m.files && m.files.length > 0)}
            title={
              !(m.files && m.files.length > 0)
                ? "manifest 没有声明 `files` 字段，无法启用 AI 修改"
                : "让 AI 根据自然语言修改这个脚本"
            }
            className="icon-button"
          >
            <WandSparkles size={14} />
          </button>
          {hasInstall && (
            <button
              onClick={onStartInstall}
              disabled={actionDisabled}
              title={!supports ? unsupportedTitle : undefined}
            >
              {script.installed ? "重装" : "安装"}
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
        </div>
      </header>

      <div className="detail-body">
        <div className="form-pane">
          <div className="tabs">
            <div className={"tab" + (tab === "run" ? " active" : "")} onClick={() => setTab("run")}>参数</div>
            <div className={"tab" + (tab === "env" ? " active" : "")} onClick={() => setTab("env")}>环境变量</div>
            {readme && <div className={"tab" + (tab === "readme" ? " active" : "")} onClick={() => setTab("readme")}>README</div>}
          </div>
          {tab === "run" ? (
            <DynamicForm
              manifest={m}
              disabled={formDisabled}
              runDisabledReason={runDisabledReason}
              onSubmit={onStartRun}
            />
          ) : tab === "env" ? (
            <div className="env-editor">
              <textarea
                className="env-textarea"
                value={envContent}
                onChange={(e) => setEnvContent(e.target.value)}
                placeholder={"# 每行一个 KEY=VALUE\n# 支持 \"引号\" 和 export 前缀\n# 例如：\nAPI_KEY=sk-xxxx\nBASE_URL=\"https://api.example.com\""}
                spellCheck={false}
              />
              <div className="env-actions">
                <span className="env-hint">
                  脚本目录下的 <code>.env</code> 文件，运行/安装/卸载时自动注入
                </span>
                <button
                  className="primary"
                  disabled={!envDirty || envSaving}
                  onClick={saveEnv}
                >
                  {envSaving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          ) : (
            <div className="readme">
              {readme && <ReactMarkdown remarkPlugins={[remarkGfm]}>{readme}</ReactMarkdown>}
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
