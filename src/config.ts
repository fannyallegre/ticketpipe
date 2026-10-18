// Configuration = defaults ← .env (developers) ← settings.json saved by the app (everyone else).

import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LlmProvider = "anthropic" | "openai" | "mock";

const env = (key: string, fallback = ""): string => process.env[key]?.trim() || fallback;

// ---------------------------------------------------------------- paths

export const APP_NAME = "TicketPipe";

/** Per-user folder for settings and the app window profile. */
export function appDataDir(): string {
  const dir =
    process.platform === "win32"
      ? join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), APP_NAME)
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support", APP_NAME)
        : join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "ticketpipe");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Where tickets are saved when no GitHub repo is configured. */
export const defaultTicketsDir = () => join(homedir(), "Documents", "IT tickets");

const settingsPath = () => join(appDataDir(), "settings.json");

// ---------------------------------------------------------------- config

const provider = env("LLM_PROVIDER", "anthropic") as LlmProvider;

export const config = {
  screenpipeUrl: env("SCREENPIPE_URL", "http://localhost:3030").replace(/\/$/, ""),
  screenpipeApiKey: env("SCREENPIPE_API_KEY"),
  contentTypes: env("CONTENT_TYPES", "ocr,accessibility,input")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  lookbackMinutes: Number(env("LOOKBACK_MINUTES", "15")),
  maxContextChars: Number(env("MAX_CONTEXT_CHARS", "12000")),
  contextFile: env("CONTEXT_FILE"),
  /** Replay the bundled sample incident instead of reading screenpipe. */
  demoMode: false,

  llmPreset: "",
  llmProvider: provider,
  llmApiKey: provider === "openai" ? env("OPENAI_API_KEY") : env("ANTHROPIC_API_KEY"),
  llmModel: provider === "openai" ? env("OPENAI_MODEL", "gpt-4.1-mini") : env("ANTHROPIC_MODEL", "claude-sonnet-5-5"),
  llmBaseUrl: env("OPENAI_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, ""),
  ticketLanguage: env("TICKET_LANGUAGE", "en"),

  githubToken: env("GITHUB_TOKEN"),
  githubRepo: env("GITHUB_REPO"),
  ticketsDir: defaultTicketsDir(),

  port: Number(env("PORT", "4242")),
};

/** Fields the app is allowed to save. */
export const SETTINGS_KEYS = [
  "screenpipeUrl",
  "screenpipeApiKey",
  "lookbackMinutes",
  "demoMode",
  "llmPreset",
  "llmProvider",
  "llmApiKey",
  "llmModel",
  "llmBaseUrl",
  "ticketLanguage",
  "githubToken",
  "githubRepo",
] as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[number];
export type Settings = Partial<Pick<typeof config, SettingsKey>> & { onboarded?: boolean };

let onboarded = false;
export const isOnboarded = () => onboarded;

export function loadSettings() {
  const path = settingsPath();
  if (!existsSync(path)) {
    // Already configured through .env (developers)? Skip the setup screens.
    onboarded = Boolean(config.screenpipeApiKey && (config.llmApiKey || config.llmProvider === "mock"));
    return;
  }
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Settings;
    for (const key of SETTINGS_KEYS) {
      if (saved[key] !== undefined) (config as any)[key] = saved[key];
    }
    onboarded = Boolean(saved.onboarded);
  } catch (e) {
    console.warn(`[config] could not read ${path}: ${e}`);
  }
}

export function saveSettings(patch: Settings) {
  for (const key of SETTINGS_KEYS) {
    if (patch[key] !== undefined) (config as any)[key] = patch[key];
  }
  if (patch.onboarded !== undefined) onboarded = patch.onboarded;
  config.screenpipeUrl = config.screenpipeUrl.replace(/\/$/, "");
  config.llmBaseUrl = config.llmBaseUrl.replace(/\/$/, "");

  const out: Settings = { onboarded };
  for (const key of SETTINGS_KEYS) (out as any)[key] = config[key];
  const path = settingsPath();
  writeFileSync(path, JSON.stringify(out, null, 2));
  try {
    chmodSync(path, 0o600); // keys stay readable by this user only
  } catch {}
}

/** `--demo` flag: replay the bundled incident, with the mock AI if no key is set. */
export function applyDemoFlag(argv: string[]) {
  if (!argv.includes("--demo")) return;
  config.demoMode = true;
  if (!config.llmApiKey && config.llmProvider !== "mock") config.llmProvider = "mock";
}
