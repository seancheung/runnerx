import { convertFileSrc } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { ResultPayload } from "../types/manifest";

export function ResultRenderer({ payloads }: { payloads: ResultPayload[] }) {
  if (payloads.length === 0) return null;
  return (
    <div className="results">
      {payloads.map((p, i) => (
        <ResultCard key={i} payload={p} />
      ))}
    </div>
  );
}

function ResultCard({ payload }: { payload: ResultPayload }) {
  switch (payload.type) {
    case "table":
      return (
        <div className="result-card">
          {payload.title && <div className="label">{payload.title}</div>}
          <table>
            <thead>
              <tr>{payload.columns.map((c, i) => <th key={i}>{c}</th>)}</tr>
            </thead>
            <tbody>
              {payload.rows.map((row, i) => (
                <tr key={i}>{row.map((cell, j) => <td key={j}>{String(cell)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "image":
      return (
        <div className="result-card">
          <div className="label">{payload.label ?? "图片"}</div>
          <img src={convertFileSrc(payload.path)} alt="" />
        </div>
      );
    case "file":
      return (
        <div className="result-card">
          <div className="label">{payload.label ?? "输出文件"}</div>
          <FileRow path={payload.path} />
        </div>
      );
    case "json":
      return (
        <div className="result-card">
          <div className="label">{payload.label ?? "JSON"}</div>
          <pre>{JSON.stringify(payload.data, null, 2)}</pre>
        </div>
      );
    case "text":
      return (
        <div className="result-card">
          <div className="label">{payload.label ?? "文本"}</div>
          <pre>{payload.data}</pre>
        </div>
      );
  }
}

function FileRow({ path }: { path: string }) {
  const reveal = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      await revealItemInDir(path);
    } catch (err) {
      console.error("revealItemInDir failed", err);
    }
  };
  return (
    <a
      className="file-link"
      href="#"
      onClick={reveal}
      title="在文件管理器中显示"
    >
      {path}
    </a>
  );
}
