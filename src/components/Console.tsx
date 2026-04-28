import { useEffect, useRef } from "react";

export type ConsoleLine =
  | { kind: "stdout"; text: string }
  | { kind: "stderr"; text: string }
  | { kind: "log"; level: "info" | "warn" | "error"; text: string };

export function Console({ lines }: { lines: ConsoleLine[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  if (lines.length === 0) {
    return <div className="console"><span className="console-empty">控制台输出会显示在这里…</span></div>;
  }
  return (
    <div className="console" ref={ref}>
      {lines.map((line, i) => {
        const cls =
          line.kind === "stderr" ? "stderr"
          : line.kind === "log" ? `log-${line.level}`
          : "";
        return (
          <div key={i} className={`console-line ${cls}`}>
            {line.text}
          </div>
        );
      })}
    </div>
  );
}
