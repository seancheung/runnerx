import { useEffect, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";

interface Props {
  initialRoot: string | null;
  onClose: () => void;
  onSave: (root: string) => void;
  onReset: () => void;
}

export function SettingsModal({ initialRoot, onClose, onSave, onReset }: Props) {
  const [root, setRoot] = useState(initialRoot ?? "");
  const [defaultRoot, setDefaultRoot] = useState<string | null>(null);

  useEffect(() => {
    api.defaultScriptsRoot().then(setDefaultRoot).catch(() => setDefaultRoot(null));
  }, []);

  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setRoot(picked);
  };

  const isAtDefault = defaultRoot != null && root.trim() === defaultRoot;

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
            根目录下的每个子目录如果包含 <code>manifest.yaml</code> 就会被识别为一个脚本。
            {defaultRoot && (
              <>
                {" 默认位置："}
                <code>{defaultRoot}</code>。
              </>
            )}
          </div>
        </div>
        <div className="modal-actions">
          <button
            type="button"
            onClick={onReset}
            disabled={isAtDefault}
            title={
              isAtDefault
                ? "当前已是默认位置"
                : "清除自定义路径，回到默认位置（直接生效，无需保存）"
            }
            style={{ marginRight: "auto" }}
          >
            恢复默认
          </button>
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary"
            onClick={() => onSave(root.trim())}
            disabled={!root.trim() || root.trim() === (initialRoot ?? "")}
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
