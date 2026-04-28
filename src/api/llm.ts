import type { LlmConfig, LlmProvider } from "../types/config";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  signal?: AbortSignal;
  maxTokens?: number;
  /**
   * If provided, the request streams via SSE and `onDelta` fires for each
   * incremental text chunk. The full concatenated text is still returned
   * from `chat()` when streaming completes.
   */
  onDelta?: (chunk: string) => void;
}

export class LlmError extends Error {
  status?: number;
  body?: string;
  constructor(message: string, status?: number, body?: string) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export function ensureLlmReady(cfg: LlmConfig | null | undefined): LlmConfig {
  if (!cfg) throw new LlmError("尚未配置 AI，请到设置里填写 LLM API。");
  if (!cfg.apiKey) throw new LlmError("LLM API Key 为空。");
  if (!cfg.model) throw new LlmError("LLM 模型名为空。");
  if (!cfg.baseUrl?.trim()) throw new LlmError("LLM Base URL 为空。");
  return cfg;
}

const DEFAULT_BASE: Record<LlmProvider, string> = {
  "openai": "https://api.openai.com",
  "google": "https://generativelanguage.googleapis.com",
  "anthropic": "https://api.anthropic.com",
  "deepseek": "https://api.deepseek.com",
};

function trimSlash(s: string) {
  return s.replace(/\/+$/, "");
}

function baseFor(cfg: LlmConfig): string {
  const b = cfg.baseUrl?.trim() || DEFAULT_BASE[cfg.provider];
  if (!b) throw new LlmError("Base URL 未配置。");
  return trimSlash(b);
}

export async function chat(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  ensureLlmReady(cfg);
  switch (cfg.provider) {
    case "openai":
    case "deepseek":
      return chatOpenAI(cfg, messages, opts);
    case "anthropic":
      return chatAnthropic(cfg, messages, opts);
    case "google":
      return chatGoogle(cfg, messages, opts);
  }
}

async function readError(res: Response): Promise<string> {
  try { return await res.text(); } catch { return ""; }
}

/**
 * SSE line iterator. Parses `event:` and `data:` lines per the spec, dispatches
 * one event per blank-line separator. Multi-line `data:` is concatenated.
 */
async function* sseEvents(
  res: Response,
): AsyncGenerator<{ event?: string; data: string }> {
  const reader = res.body?.getReader();
  if (!reader) throw new LlmError("响应没有可读流");
  const decoder = new TextDecoder();
  let buf = "";
  let event: string | undefined;
  let data = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line === "") {
        if (data) {
          yield { event, data };
          data = "";
        }
        event = undefined;
        continue;
      }
      if (line.startsWith(":")) continue; // SSE comment
      if (line.startsWith("data:")) {
        const v = line.slice(5).replace(/^\s/, "");
        data += data ? "\n" + v : v;
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      }
    }
  }
  // Flush any tail
  if (data) yield { event, data };
}

async function chatOpenAI(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<string> {
  const url = `${baseFor(cfg)}/v1/chat/completions`;
  const stream = !!opts.onDelta;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${cfg.apiKey}`,
      ...(stream ? { "Accept": "text/event-stream" } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      stream,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await readError(res);
    throw new LlmError(`LLM 请求失败 (HTTP ${res.status})`, res.status, body);
  }
  if (!stream) {
    const data = await res.json();
    const text = data?.choices?.[0]?.message?.content;
    if (typeof text !== "string") {
      throw new LlmError("LLM 响应缺少 content 字段", res.status, JSON.stringify(data));
    }
    return text;
  }

  let acc = "";
  for await (const ev of sseEvents(res)) {
    if (ev.data === "[DONE]") break;
    let json: unknown;
    try { json = JSON.parse(ev.data); } catch { continue; }
    const delta = (json as { choices?: { delta?: { content?: string } }[] })
      ?.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) {
      acc += delta;
      opts.onDelta!(delta);
    }
  }
  if (!acc) {
    throw new LlmError("LLM 流式响应没有任何内容");
  }
  return acc;
}

async function chatAnthropic(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const convo = messages.filter((m) => m.role !== "system").map((m) => ({
    role: m.role,
    content: m.content,
  }));
  const url = `${baseFor(cfg)}/v1/messages`;
  const stream = !!opts.onDelta;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": cfg.apiKey,
      "anthropic-version": "2023-06-01",
      // Required when calling Anthropic API directly from a browser/webview origin.
      "anthropic-dangerous-direct-browser-access": "true",
      ...(stream ? { "Accept": "text/event-stream" } : {}),
    },
    body: JSON.stringify({
      model: cfg.model,
      max_tokens: opts.maxTokens ?? 8192,
      stream,
      ...(system ? { system } : {}),
      messages: convo,
    }),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await readError(res);
    throw new LlmError(`Anthropic 请求失败 (HTTP ${res.status})`, res.status, body);
  }
  if (!stream) {
    const data = await res.json();
    const blocks: Array<{ type: string; text?: string }> = data?.content ?? [];
    const text = blocks.filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text!).join("");
    if (!text) throw new LlmError("Anthropic 响应没有文本块", res.status, JSON.stringify(data));
    return text;
  }

  let acc = "";
  for await (const ev of sseEvents(res)) {
    if (ev.event === "content_block_delta") {
      let json: unknown;
      try { json = JSON.parse(ev.data); } catch { continue; }
      const delta = (json as { delta?: { type?: string; text?: string } })?.delta;
      if (delta?.type === "text_delta" && typeof delta.text === "string") {
        acc += delta.text;
        opts.onDelta!(delta.text);
      }
    } else if (ev.event === "error") {
      throw new LlmError("Anthropic 流错误", res.status, ev.data);
    }
  }
  if (!acc) throw new LlmError("Anthropic 流式响应没有任何文本");
  return acc;
}

async function chatGoogle(
  cfg: LlmConfig,
  messages: ChatMessage[],
  opts: ChatOptions,
): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));
  const stream = !!opts.onDelta;
  const method = stream ? "streamGenerateContent" : "generateContent";
  const queryAlt = stream ? "&alt=sse" : "";
  const url = `${baseFor(cfg)}/v1beta/models/${encodeURIComponent(cfg.model)}:${method}?key=${encodeURIComponent(cfg.apiKey)}${queryAlt}`;
  const body: Record<string, unknown> = { contents };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  if (opts.maxTokens) body.generationConfig = { maxOutputTokens: opts.maxTokens };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(stream ? { "Accept": "text/event-stream" } : {}),
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const errBody = await readError(res);
    throw new LlmError(`Google 请求失败 (HTTP ${res.status})`, res.status, errBody);
  }
  if (!stream) {
    const data = await res.json();
    const parts: Array<{ text?: string }> = data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts.map((p) => p.text ?? "").join("");
    if (!text) throw new LlmError("Google 响应没有文本块", res.status, JSON.stringify(data));
    return text;
  }

  let acc = "";
  for await (const ev of sseEvents(res)) {
    let json: unknown;
    try { json = JSON.parse(ev.data); } catch { continue; }
    const parts = (json as {
      candidates?: { content?: { parts?: { text?: string }[] } }[];
    })?.candidates?.[0]?.content?.parts ?? [];
    for (const p of parts) {
      if (typeof p.text === "string" && p.text) {
        acc += p.text;
        opts.onDelta!(p.text);
      }
    }
  }
  if (!acc) throw new LlmError("Google 流式响应没有任何文本");
  return acc;
}
