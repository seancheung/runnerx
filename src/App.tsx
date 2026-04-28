import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "./App.css";
import * as api from "./api";
import { Sidebar } from "./components/Sidebar";
import { SettingsModal } from "./components/SettingsModal";
import { AiGenerateModal } from "./components/AiGenerateModal";
import { ScriptDetail } from "./components/ScriptDetail";
import { EMPTY_RUN, type RunSnapshot } from "./components/RunPanel";
import { clearScriptsRoot, getScriptsRoot, setScriptsRoot } from "./store";
import type { FormValues } from "./components/DynamicForm";
import type { RunEvent, ScriptInfo } from "./types/manifest";

function App() {
  const [root, setRoot] = useState<string | null>(null);
  const [scripts, setScripts] = useState<ScriptInfo[]>([]);
  const [scanErrors, setScanErrors] = useState<{ dir: string; message: string }[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showAiGenerate, setShowAiGenerate] = useState(false);
  const [pendingSelectId, setPendingSelectId] = useState<string | null>(null);
  const [run, setRun] = useState<RunSnapshot>(EMPTY_RUN);
  const runRef = useRef<RunSnapshot>(EMPTY_RUN);
  runRef.current = run;

  const refresh = useCallback(async () => {
    if (!root) {
      setScripts([]);
      setScanErrors([]);
      return;
    }
    try {
      const result = await api.listScripts(root);
      setScripts(result.scripts);
      setScanErrors(result.errors);
    } catch (e) {
      setScripts([]);
      setScanErrors([{ dir: root, message: String(e) }]);
    }
  }, [root]);

  // Initial load: prefer the user-configured root, fall back to ~/.runnerx/scripts
  // (created on demand by the backend). The default is *not* persisted, so if
  // we ever change the default path, existing setups follow along.
  useEffect(() => {
    (async () => {
      const stored = await getScriptsRoot();
      const initial = stored ?? (await api.defaultScriptsRoot());
      setRoot(initial);
    })();
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-select first script when list changes (or honor a pending selection
  // requested by the AI generate flow).
  useEffect(() => {
    if (pendingSelectId && scripts.find((s) => s.id === pendingSelectId)) {
      setSelectedId(pendingSelectId);
      setPendingSelectId(null);
      return;
    }
    if (scripts.length > 0 && !scripts.find((s) => s.id === selectedId)) {
      setSelectedId(scripts[0].id);
    } else if (scripts.length === 0) {
      setSelectedId(null);
    }
  }, [scripts, selectedId, pendingSelectId]);

  const handleRunEvent = useCallback((evt: RunEvent) => {
    setRun((prev) => {
      // Ignore events for old runs
      if (prev.runId && evt.runId !== prev.runId && evt.kind !== "started") return prev;
      switch (evt.kind) {
        case "started":
          return { ...EMPTY_RUN, runId: evt.runId, status: "running", mode: evt.mode };
        case "progress":
          return { ...prev, progress: evt.value, progressMessage: evt.message ?? null };
        case "log":
          return { ...prev, lines: [...prev.lines, { kind: "log", level: evt.level, text: evt.message }] };
        case "stdout":
          return { ...prev, lines: [...prev.lines, { kind: "stdout", text: evt.line }] };
        case "stderr":
          return { ...prev, lines: [...prev.lines, { kind: "stderr", text: evt.line }] };
        case "result":
          return { ...prev, results: [...prev.results, evt.payload] };
        case "exit":
          return {
            ...prev,
            status: evt.cancelled ? "cancelled" : "exited",
            exitCode: evt.code,
            progress: evt.code === 0 ? 1 : prev.progress,
          };
      }
    });
    // After install/uninstall completes successfully, refresh script list to update installed flag
    if (
      evt.kind === "exit" &&
      !evt.cancelled &&
      evt.code === 0 &&
      (evt.mode === "install" || evt.mode === "uninstall")
    ) {
      refresh();
    }
  }, [refresh]);

  // Keep the latest handler in a ref so the (one-time) Tauri event subscription
  // never closes over a stale `refresh` (which captures `root`).
  const handlerRef = useRef(handleRunEvent);
  handlerRef.current = handleRunEvent;

  // Subscribe to run events once. The closure deliberately reads handlerRef.current
  // at call time so updates to `refresh` / `root` propagate.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    api.onRunEvent((evt) => handlerRef.current(evt)).then((u) => {
      if (cancelled) u();
      else unlisten = u;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  const selected = useMemo(
    () => scripts.find((s) => s.id === selectedId) ?? null,
    [scripts, selectedId],
  );

  const startRun = useCallback(async (values: FormValues) => {
    if (!selected) return;
    setRun({ ...EMPTY_RUN, status: "running", mode: "script" });
    try {
      await api.runScript(selected.dir, values.inputs, values.outputs);
    } catch (e) {
      setRun((prev) => ({ ...prev, status: "error", error: String(e) }));
    }
  }, [selected]);

  const startInstall = useCallback(async () => {
    if (!selected) return;
    setRun({ ...EMPTY_RUN, status: "running", mode: "install" });
    try {
      await api.runInstall(selected.dir);
    } catch (e) {
      setRun((prev) => ({ ...prev, status: "error", error: String(e) }));
    }
  }, [selected]);

  const startUninstall = useCallback(async (alsoRemoveBase: boolean) => {
    if (!selected) return;
    setRun({ ...EMPTY_RUN, status: "running", mode: "uninstall" });
    try {
      await api.runUninstall(selected.dir, alsoRemoveBase);
    } catch (e) {
      setRun((prev) => ({ ...prev, status: "error", error: String(e) }));
    }
  }, [selected]);

  const cancel = useCallback(async () => {
    const id = runRef.current.runId;
    if (id) await api.cancelRun(id);
  }, []);

  const handleMarkUninstalled = useCallback(async () => {
    if (!selected) return;
    await api.markUninstalled(selected.dir);
    refresh();
  }, [selected, refresh]);

  const saveSettings = useCallback(async (newRoot: string, newConfig: import("./types/config").AppConfig) => {
    await setScriptsRoot(newRoot);
    await api.setConfig(newConfig);
    setRoot(newRoot);
    setShowSettings(false);
  }, []);

  const resetSettings = useCallback(async () => {
    await clearScriptsRoot();
    const def = await api.defaultScriptsRoot();
    setRoot(def);
    setShowSettings(false);
  }, []);

  return (
    <div className="app-shell">
      <Sidebar
        scripts={scripts}
        selectedId={selectedId}
        onSelect={(id) => {
          setSelectedId(id);
          setRun(EMPTY_RUN);
        }}
        onOpenSettings={() => setShowSettings(true)}
        onRefresh={refresh}
        onOpenAiGenerate={() => setShowAiGenerate(true)}
      />
      <main style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {scanErrors.length > 0 && (
          <div className="scan-errors">
            {scanErrors.map((e, i) => (
              <div key={i}>⚠ {e.dir}: {e.message}</div>
            ))}
          </div>
        )}
        {selected ? (
          <ScriptDetail
            script={selected}
            run={run}
            onStartRun={startRun}
            onStartInstall={startInstall}
            onStartUninstall={startUninstall}
            onCancel={cancel}
            onMarkUninstalled={handleMarkUninstalled}
          />
        ) : (
          <div className="detail-empty">
            {root ? "选择左侧的脚本以开始" : "请在设置里指定脚本目录"}
          </div>
        )}
      </main>
      {showSettings && (
        <SettingsModal
          initialRoot={root}
          onClose={() => setShowSettings(false)}
          onSave={saveSettings}
          onReset={resetSettings}
        />
      )}
      {showAiGenerate && (
        <AiGenerateModal
          root={root}
          onClose={() => setShowAiGenerate(false)}
          onCreated={(_dir, id) => {
            setPendingSelectId(id);
            refresh();
          }}
        />
      )}
    </div>
  );
}

export default App;
