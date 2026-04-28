import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import { DEFAULT_CONFIG, type AppConfig, type SandboxNetwork } from "../types/config";

interface Props {
  initialRoot: string | null;
  onClose: () => void;
  onSave: (root: string, config: AppConfig) => void;
  onReset: () => void;
}

export function SettingsModal({ initialRoot, onClose, onSave, onReset }: Props) {
  const [root, setRoot] = useState(initialRoot ?? "");
  const [defaultRoot, setDefaultRoot] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [initialConfig, setInitialConfig] = useState<AppConfig>(DEFAULT_CONFIG);

  useEffect(() => {
    api.defaultScriptsRoot().then(setDefaultRoot).catch(() => setDefaultRoot(null));
    api.getConfig().then((c) => {
      setConfig(c);
      setInitialConfig(c);
    }).catch(() => {});
  }, []);

  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setRoot(picked);
  };

  const setNetwork = (network: SandboxNetwork) => {
    setConfig((c) => ({ ...c, sandbox: { ...c.sandbox, network } }));
  };

  const isAtDefault = defaultRoot != null && root.trim() === defaultRoot;
  const rootChanged = root.trim() !== (initialRoot ?? "");
  const configChanged = JSON.stringify(config) !== JSON.stringify(initialConfig);
  const dirty = rootChanged || configChanged;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>设置</h3>

        <div className="field">
          <label className="field-label">脚本目录</label>
          <div className="field-row">
            <input
              value={root}
              onChange={(e) => setRoot(e.target.value)}
              placeholder="/path/to/your/scripts"
            />
            <button type="button" onClick={browse}>浏览…</button>
          </div>
          <div className="field-desc">
            根目录下的每个子目录如果包含 <code>manifest.yaml</code> 就被识别为一个脚本。
            {defaultRoot && (
              <>
                {" 默认位置："}
                <code>{defaultRoot}</code>。
              </>
            )}
          </div>
        </div>

        <div className="field-section-title">沙盒</div>

        <div className="field">
          <label className="field-label">运行时网络</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <RadioRow
              checked={config.sandbox.network === "bridge"}
              onChange={() => setNetwork("bridge")}
              label="Bridge — 允许沙盒脚本访问外网（默认）"
              hint="脚本能 curl / pip / npm，跟运行普通命令时一样"
            />
            <RadioRow
              checked={config.sandbox.network === "none"}
              onChange={() => setNetwork("none")}
              label="None — 完全无网络"
              hint="最严格隔离；只能跑纯计算 / 离线工具"
            />
            <RadioRow
              checked={config.sandbox.network === "host"}
              onChange={() => setNetwork("host")}
              label="Host — 共享宿主机网络"
              hint="脚本能访问 localhost 上的服务；macOS Docker Desktop 上有局限"
            />
          </div>
          <div className="field-desc">
            只影响 sandbox 模式脚本的 <code>run</code> 阶段。<code>install</code> 总是用 bridge（拉镜像 / pip 装包必须联网）。
          </div>
        </div>

        <div className="modal-actions">
          <button
            type="button"
            onClick={onReset}
            disabled={isAtDefault}
            title={
              isAtDefault
                ? "脚本目录已是默认位置"
                : "清除自定义脚本目录路径，回到默认位置（直接生效，无需保存）"
            }
            style={{ marginRight: "auto" }}
          >
            恢复默认目录
          </button>
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary"
            onClick={() => onSave(root.trim(), config)}
            disabled={!root.trim() || !dirty}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}

function RadioRow({
  checked, onChange, label, hint,
}: { checked: boolean; onChange: () => void; label: string; hint: string }) {
  return (
    <label style={{ display: "flex", gap: 8, alignItems: "flex-start", cursor: "pointer" }}>
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        style={{ width: "auto", marginTop: 3 }}
      />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 13, color: "var(--text)" }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>{hint}</div>
      </div>
    </label>
  );
}
