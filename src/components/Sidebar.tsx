import { useEffect, useMemo, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { RefreshCw, Search, Settings, Sparkles } from "lucide-react";
import type { ScriptInfo } from "../types/manifest";
import { IconBlock } from "./IconBlock";

interface Props {
  scripts: ScriptInfo[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onOpenSettings: () => void;
  onRefresh: () => void;
  onOpenAiGenerate: () => void;
}

export function Sidebar({
  scripts,
  selectedId,
  onSelect,
  onOpenSettings,
  onRefresh,
  onOpenAiGenerate,
}: Props) {
  const [query, setQuery] = useState("");
  const [version, setVersion] = useState<string>("");

  useEffect(() => {
    getVersion().then(setVersion).catch(() => {});
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return scripts;
    return scripts.filter((s) => {
      const m = s.manifest;
      const hay = [m.name, s.id, m.description ?? "", m.category ?? "", ...(m.tags ?? [])]
        .join(" ")
        .toLowerCase();
      return hay.includes(q);
    });
  }, [scripts, query]);

  const grouped = useMemo(() => {
    const map = new Map<string, ScriptInfo[]>();
    for (const s of filtered) {
      const cat = s.manifest.category || "未分类";
      const arr = map.get(cat) ?? [];
      arr.push(s);
      map.set(cat, arr);
    }
    return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [filtered]);

  return (
    <aside className="sidebar">
      <div className="sidebar-header">
        <div className="sidebar-title">
          <span>
            runnerx
            {version && <span className="sidebar-version">v{version}</span>}
          </span>
          <div style={{ display: "flex", gap: 4 }}>
            <button className="icon-button" title="AI 创建脚本" onClick={onOpenAiGenerate}>
              <Sparkles size={14} />
            </button>
            <button className="icon-button" title="刷新" onClick={onRefresh}>
              <RefreshCw size={14} />
            </button>
            <button className="icon-button" title="设置" onClick={onOpenSettings}>
              <Settings size={14} />
            </button>
          </div>
        </div>
        <div className="sidebar-search-wrap">
          <Search size={13} className="sidebar-search-icon" />
          <input
            className="sidebar-search"
            placeholder="搜索脚本..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="sidebar-list">
        {scripts.length === 0 ? (
          <div className="sidebar-empty">
            还没有脚本。在设置里指定一个目录，然后把脚本目录放进去。
          </div>
        ) : filtered.length === 0 ? (
          <div className="sidebar-empty">没有匹配的脚本。</div>
        ) : (
          grouped.map(([cat, items]) => (
            <div key={cat}>
              <div className="sidebar-category">{cat}</div>
              {items.map((s) => {
                const supports = s.supportedOnCurrentPlatform;
                const hasInstallOnCurrent =
                  (s.manifest.macos?.install || s.manifest.windows?.install) != null;
                return (
                  <div
                    key={s.id}
                    className={
                      "sidebar-item"
                      + (s.id === selectedId ? " active" : "")
                      + (!supports ? " disabled" : "")
                    }
                    onClick={() => onSelect(s.id)}
                    title={!supports ? "该脚本不支持当前平台" : undefined}
                  >
                    <IconBlock script={s} />
                    <div className="sidebar-item-name">{s.manifest.name}</div>
                    {supports && !s.installed && hasInstallOnCurrent && (
                      <span className="sidebar-item-tag">未安装</span>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
