import type { PlatformId } from "../types/manifest";

const LABELS: Record<PlatformId, string> = {
  macos: "macOS",
  windows: "Win",
};

interface Props {
  platforms: PlatformId[];
  /** Show even when the script supports just one platform. Default: only multi. */
  always?: boolean;
}

export function PlatformBadge({ platforms, always = false }: Props) {
  if (!always && platforms.length < 2) return null;
  if (platforms.length === 0) return null;
  return (
    <span className="platform-badge" title={`支持平台：${platforms.map((p) => LABELS[p]).join(" / ")}`}>
      {platforms.map((p) => (
        <span key={p} className="platform-badge-chip">{LABELS[p]}</span>
      ))}
    </span>
  );
}
