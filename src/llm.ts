import { config, type LlmProvider } from "./config";

export type LlmSettings = { provider: LlmProvider; key: string; model: string; baseUrl: string };
export const llmSettings = (): LlmSettings => ({ provider: config.llmProvider, key: config.llmApiKey, model: config.llmModel, baseUrl: config.llmBaseUrl });
export function isRealAiConfigured(s = llmSettings()): boolean {
  try { return ["anthropic", "openai"].includes(s.provider) && !!s.model.trim() && (!!s.key.trim() || (s.provider === "openai" && ["localhost", "127.0.0.1", "[::1]"].includes(new URL(s.baseUrl).hostname))); }
  catch { return false; }
}

/** The repair runner freezes settings per run and supplies its cancellation signal. */
export async function callLlm(system: string, user: string, options: { settings?: LlmSettings; signal?: AbortSignal; maxTokens?: number } = {}): Promise<string> {
  const signal = AbortSignal.any([...(options.signal ? [options.signal] : []), AbortSignal.timeout(45_000)]);
  signal.throwIfAborted();
  // Do not depend on a provider or transport honoring AbortSignal promptly.
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    const finish = (fn: (value: any) => void) => (value: any) => { signal.removeEventListener("abort", abort); if (!signal.aborted) fn(value); };
    signal.addEventListener("abort", abort, { once: true });
    void callProvider(system, user, { ...options, settings: options.settings ?? llmSettings(), signal }).then(finish(resolve), finish(reject));
  });
}
async function callProvider(system: string, user: string, options: { settings: LlmSettings; signal: AbortSignal; maxTokens?: number }): Promise<string> {
  const s = options.settings, signal = options.signal;
  if (s.provider === "mock") throw new Error("Live automatic fixing requires a real AI. Choose one in Settings.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(s.baseUrl || "https://api.anthropic.com").hostname);
  if (!s.key && (s.provider === "anthropic" || !local)) throw new Error("No AI key set. Open Settings and add your key.");
  const send = (jsonMode: boolean) => fetch(s.provider === "anthropic" ? "https://api.anthropic.com/v1/messages" : `${s.baseUrl}/chat/completions`, {
    method: "POST", signal,
    headers: { "content-type": "application/json", ...(s.provider === "anthropic" ? { "x-api-key": s.key, "anthropic-version": "2023-06-01" } : s.key ? { Authorization: `Bearer ${s.key}` } : {}) },
    body: JSON.stringify(s.provider === "anthropic" ? {
      model: s.model, max_tokens: options.maxTokens ?? 2000, system, messages: [{ role: "user", content: user }],
    } : {
      model: s.model, ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
      ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
      messages: [{ role: "system", content: system }, { role: "user", content: user }],
    }),
  });
  let res = await send(true);
  if (s.provider === "openai" && res.status === 400) {
    const body = await res.text();
    if (!/response_format|json/i.test(body)) throw new Error(`AI provider → HTTP 400: ${body.slice(0, 300)}`);
    options.signal?.throwIfAborted();
    res = await send(false);
  }
  if (!res.ok) {
    await res.body?.cancel();
    if ([401, 403].includes(res.status)) throw new Error("The AI provider rejected this key or its access. Check the AI settings.");
    if ([429, 503].includes(res.status)) throw new Error("The AI provider is busy or its usage limit was reached. Please try again later.");
    throw new Error(`The AI provider could not complete the request (HTTP ${res.status}). Check the selected model in Settings.`);
  }
  const data = await res.json() as any;
  options.signal?.throwIfAborted();
  return s.provider === "anthropic" ? (data.content ?? []).filter((b: any) => b.type === "text").map((b: any) => b.text ?? "").join("") : data.choices?.[0]?.message?.content ?? "";
}
