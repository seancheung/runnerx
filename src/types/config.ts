export type SandboxNetwork = "none" | "bridge" | "host";

export interface SandboxConfig {
  network: SandboxNetwork;
}

export type LlmProvider =
  | "openai"
  | "google"
  | "anthropic"
  | "deepseek";

export interface LlmConfig {
  provider: LlmProvider;
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AppConfig {
  sandbox: SandboxConfig;
  llm?: LlmConfig | null;
}

export const DEFAULT_CONFIG: AppConfig = {
  sandbox: { network: "bridge" },
  llm: null,
};

export const LLM_PROVIDER_LABELS: Record<LlmProvider, string> = {
  "openai": "OpenAI",
  "google": "Google Generative AI",
  "anthropic": "Anthropic",
  "deepseek": "DeepSeek",
};

export const LLM_PROVIDER_DEFAULTS: Record<LlmProvider, { baseUrl: string; model: string }> = {
  "openai": { baseUrl: "https://api.openai.com", model: "gpt-4o-mini" },
  "google": { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash" },
  "anthropic": { baseUrl: "https://api.anthropic.com", model: "claude-sonnet-4-5" },
  "deepseek": { baseUrl: "https://api.deepseek.com", model: "deepseek-chat" },
};
