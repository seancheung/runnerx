import { useMemo, useState } from "react";
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
          <span>runnerx</span>
          <div style={{ display: "flex", gap: 4 }}>
            <button
              title="AI 创建脚本"
              onClick={onOpenAiGenerate}
              style={{ padding: "2px 8px", fontSize: 11 }}
            >
              AI
            </button>
            <button title="刷新" onClick={onRefresh} style={{ padding: "2px 8px", fontSize: 11 }}>↻</button>
            <button title="设置" onClick={onOpenSettings} style={{ padding: "2px 8px", fontSize: 11 }}>⚙</button>
          </div>
        </div>
        <input
          className="sidebar-search"
          placeholder="搜索脚本..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
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
              {items.map((s) => (
                <div
                  key={s.id}
                  className={"sidebar-item" + (s.id === selectedId ? " active" : "")}
                  onClick={() => onSelect(s.id)}
                >
                  <IconBlock script={s} />
                  <div className="sidebar-item-name">{s.manifest.name}</div>
                  {!s.installed && s.manifest.lifecycle?.install && (
                    <span className="sidebar-item-tag">未安装</span>
                  )}
                </div>
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
