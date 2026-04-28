import type { ScriptInfo } from "../types/manifest";

const PALETTE = [
  "#4dabf7", "#74c0fc", "#9775fa", "#da77f2", "#f783ac",
  "#ff8787", "#ffa94d", "#ffd43b", "#a9e34b", "#69db7c",
  "#38d9a9", "#3bc9db",
];

function colorFor(id: string): string {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

export function IconBlock({ script }: { script: ScriptInfo }) {
  if (script.iconDataUrl) {
    return (
      <div className="icon-block" style={{ background: "transparent" }}>
        <img src={script.iconDataUrl} alt="" />
      </div>
    );
  }
  const letter = (script.manifest.name || script.id).trim().charAt(0).toUpperCase() || "?";
  return (
    <div className="icon-block" style={{ background: colorFor(script.id) }}>
      {letter}
    </div>
  );
}
