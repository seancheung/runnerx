import { useEffect, useMemo, useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../api";
import type { ThemePreference } from "../store";
import {
  DEFAULT_CONFIG,
  LLM_PROVIDER_DEFAULTS,
  LLM_PROVIDER_LABELS,
  type AppConfig,
  type LlmConfig,
  type LlmProvider,
  type SandboxNetwork,
} from "../types/config";

interface Props {
  initialRoot: string | null;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
  onClose: () => void;
  onSave: (root: string, config: AppConfig) => void;
  onReset: () => void;
}

const EMPTY_LLM: LlmConfig = {
  provider: "openai",
  apiKey: "",
  baseUrl: LLM_PROVIDER_DEFAULTS.openai.baseUrl,
  model: LLM_PROVIDER_DEFAULTS.openai.model,
};

export function SettingsModal({ initialRoot, theme, onThemeChange, onClose, onSave, onReset }: Props) {
  const [root, setRoot] = useState(initialRoot ?? "");
  const [defaultRoot, setDefaultRoot] = useState<string | null>(null);
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [initialConfig, setInitialConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llm, setLlm] = useState<LlmConfig>(EMPTY_LLM);

  useEffect(() => {
    api.defaultScriptsRoot().then(setDefaultRoot).catch(() => setDefaultRoot(null));
    api.getConfig().then((c) => {
      setConfig(c);
      setInitialConfig(c);
      if (c.llm) {
        setLlmEnabled(true);
        setLlm({
          provider: c.llm.provider,
          apiKey: c.llm.apiKey ?? "",
          baseUrl: c.llm.baseUrl ?? LLM_PROVIDER_DEFAULTS[c.llm.provider].baseUrl,
          model: c.llm.model ?? LLM_PROVIDER_DEFAULTS[c.llm.provider].model,
        });
      }
    }).catch(() => {});
  }, []);

  const browse = async () => {
    const picked = await openDialog({ directory: true, multiple: false });
    if (typeof picked === "string") setRoot(picked);
  };

  const setNetwork = (network: SandboxNetwork) => {
    setConfig((c) => ({ ...c, sandbox: { ...c.sandbox, network } }));
  };

  const onProviderChange = (provider: LlmProvider) => {
    const def = LLM_PROVIDER_DEFAULTS[provider];
    setLlm((prev) => ({
      provider,
      apiKey: prev.apiKey,
      baseUrl: def.baseUrl,
      model: def.model || prev.model,
    }));
  };

  const effectiveLlm = useMemo<LlmConfig | null>(() => {
    if (!llmEnabled) return null;
    return {
      provider: llm.provider,
      apiKey: llm.apiKey.trim(),
      baseUrl: llm.baseUrl.trim(),
      model: llm.model.trim(),
    };
  }, [llmEnabled, llm]);

  const isAtDefault = defaultRoot != null && root.trim() === defaultRoot;
  const rootChanged = root.trim() !== (initialRoot ?? "");
  const mergedConfig: AppConfig = { ...config, llm: effectiveLlm };
  const configChanged = JSON.stringify(mergedConfig) !== JSON.stringify(initialConfig);
  const dirty = rootChanged || configChanged;

  const llmInvalid =
    llmEnabled && (!llm.apiKey.trim() || !llm.model.trim() || !llm.baseUrl.trim());

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "85vh", overflowY: "auto" }}
      >
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
            <button
              type="button"
              onClick={onReset}
              disabled={isAtDefault}
              title={
                isAtDefault
                  ? "脚本目录已是默认位置"
                  : "清除自定义脚本目录路径，回到默认位置（直接生效，无需保存）"
              }
            >
              恢复默认
            </button>
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

        <div className="field-section-title">外观</div>

        <div className="field">
          <label className="field-label">深色模式</label>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
            <RadioRow
              checked={theme === "system"}
              onChange={() => onThemeChange("system")}
              label="跟随系统（默认）"
              hint="根据系统外观自动切换"
            />
            <RadioRow
              checked={theme === "dark"}
              onChange={() => onThemeChange("dark")}
              label="深色"
              hint="始终使用深色界面"
            />
            <RadioRow
              checked={theme === "light"}
              onChange={() => onThemeChange("light")}
              label="浅色"
              hint="始终使用浅色界面"
            />
          </div>
          <div className="field-desc">立即生效，无需保存。</div>
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

        <div className="field-section-title">AI 模型</div>

        <label
          className="field-checkbox"
          style={{ marginBottom: 10 }}
        >
          <input
            type="checkbox"
            checked={llmEnabled}
            onChange={(e) => setLlmEnabled(e.target.checked)}
          />
        </label>

        {llmEnabled && (
          <>
            <div className="field">
              <label className="field-label">服务商</label>
              <select
                value={llm.provider}
                onChange={(e) => onProviderChange(e.target.value as LlmProvider)}
              >
                {(Object.keys(LLM_PROVIDER_LABELS) as LlmProvider[]).map((p) => (
                  <option key={p} value={p}>{LLM_PROVIDER_LABELS[p]}</option>
                ))}
              </select>
              <div className="field-desc">
                想接 OpenRouter / Together / Groq / 本地 Ollama 等 OpenAI 兼容服务，选 OpenAI 后改 Base URL 即可。
              </div>
            </div>

            <div className="field">
              <label className="field-label">API Key</label>
              <input
                type="password"
                value={llm.apiKey}
                onChange={(e) => setLlm((p) => ({ ...p, apiKey: e.target.value }))}
                placeholder="sk-..."
                autoComplete="off"
                spellCheck={false}
              />
              <div className="field-desc">
                密钥保存在 <code>~/.runnerx/config.yaml</code>，不会上传到任何地方（直接由本应用调用 API）。
              </div>
            </div>

            <div className="field">
              <label className="field-label">Base URL</label>
              <input
                value={llm.baseUrl}
                onChange={(e) => setLlm((p) => ({ ...p, baseUrl: e.target.value }))}
                placeholder={LLM_PROVIDER_DEFAULTS[llm.provider].baseUrl}
              />
            </div>

            <div className="field">
              <label className="field-label">模型</label>
              <input
                value={llm.model}
                onChange={(e) => setLlm((p) => ({ ...p, model: e.target.value }))}
                placeholder={LLM_PROVIDER_DEFAULTS[llm.provider].model || "model-name"}
              />
              <div className="field-desc">
                {llm.provider === "openai" && "如 gpt-4o-mini, gpt-4o, o1-mini"}
                {llm.provider === "google" && "如 gemini-2.5-flash, gemini-2.5-pro"}
                {llm.provider === "anthropic" && "如 claude-sonnet-4-5, claude-opus-4-5"}
                {llm.provider === "deepseek" && "如 deepseek-chat, deepseek-reasoner"}
              </div>
            </div>
          </>
        )}

        <div className="modal-actions">
          <button type="button" onClick={onClose}>取消</button>
          <button
            type="button"
            className="primary"
            onClick={() => onSave(root.trim(), mergedConfig)}
            disabled={!root.trim() || !dirty || llmInvalid}
            title={llmInvalid ? "AI 配置不完整" : undefined}
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
