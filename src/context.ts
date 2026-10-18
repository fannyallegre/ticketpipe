// Pull recent activity from screenpipe and turn noisy OCR/UI events
// into a compact, chronological timeline an LLM can reason about.

import { config } from "./config";
import demoFixture from "../fixtures/vpn-error.json";
import { localTime, utcOffsetLabel } from "./time";

export type RawItem = { type: string; content: Record<string, any> };

export type Event = {
  time: Date;
  kind: "screen" | "ui" | "audio";
  app: string;
  window: string;
  text: string;
};

export type Segment = {
  start: Date;
  end: Date;
  app: string;
  window: string;
  lines: string[];
};

export type Highlight = { time: Date; app: string; line: string };

export type Context = {
  from: Date | null;
  to: Date | null;
  rawItems: number;
  events: number;
  apps: string[];
  segments: Segment[];
  highlights: Highlight[];
  rendered: string;
};

// Lines that look like an error, in English and French.
// (Unicode-aware boundaries so accented words like "échec" match.)
const ERROR_RE =
  /(?<![\p{L}\d])(errors?|erreurs?|failed|failure|échec|echec|exception|denied|refusée?|forbidden|unauthori[sz]ed|timed? ?out|expired?|expirée?|invalid|invalide|cannot|can't|unable|impossible|not found|introuvable|crash(?:ed)?|unreachable|inaccessible|code[: ]\s*-?\d+)(?![\p{L}])/iu;

const MAX_ITEMS_PER_TYPE = 1000;
const PAGE_SIZE = 200;
const MAX_LINES_PER_SEGMENT = 80;
// Without app names (Linux/Wayland) everything is one app: also split on idle gaps.
const SEGMENT_GAP_MS = 60_000;
const MAX_HIGHLIGHTS = 15;

// ---------------------------------------------------------------- fetching

const isoNoMs = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

async function searchType(type: string, start: Date, end: Date): Promise<RawItem[]> {
  const headers: Record<string, string> = {};
  if (config.screenpipeApiKey) headers.Authorization = `Bearer ${config.screenpipeApiKey}`;

  const items: RawItem[] = [];
  for (let offset = 0; offset < MAX_ITEMS_PER_TYPE; offset += PAGE_SIZE) {
    const params = new URLSearchParams({
      content_type: type,
      start_time: isoNoMs(start),
      end_time: isoNoMs(end),
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    // screenpipe answers 503 "search is busy" under load: wait and retry a few times.
    let res = await fetch(`${config.screenpipeUrl}/search?${params}`, { headers });
    for (let attempt = 0; res.status === 503 && attempt < 5; attempt++) {
      const body = (await res.json().catch(() => ({}))) as { retry_after_ms?: number };
      await Bun.sleep(body.retry_after_ms ?? 1000);
      res = await fetch(`${config.screenpipeUrl}/search?${params}`, { headers });
    }
    if (!res.ok) {
      throw new Error(`screenpipe /search (${type}) → HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const json = (await res.json()) as { data?: RawItem[] };
    const page = json.data ?? [];
    items.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return items;
}

/** Raw screenpipe items for the last `minutes` (or from CONTEXT_FILE). */
export async function fetchRaw(minutes = config.lookbackMinutes): Promise<RawItem[]> {
  if (config.demoMode) return (demoFixture as { data: RawItem[] }).data;
  if (config.contextFile) {
    const json = await Bun.file(config.contextFile).json();
    return Array.isArray(json) ? json : (json.data ?? []);
  }

  const end = new Date();
  const start = new Date(end.getTime() - minutes * 60_000);
  // One type at a time: parallel queries trigger "search is busy" on screenpipe.
  const items: RawItem[] = [];
  const errors: string[] = [];
  for (const type of config.contentTypes) {
    try {
      items.push(...(await searchType(type, start, end)));
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  if (errors.length === config.contentTypes.length) {
    throw new Error(`Could not read your screen history from screenpipe (${config.screenpipeUrl}).\n${errors.join("\n")}`);
  }
  for (const e of errors) console.warn(`[context] ${e}`);
  return items;
}

// ---------------------------------------------------------------- cleaning

function normalize(item: RawItem): Event | null {
  const c = item.content ?? {};
  const type = String(item.type ?? "").toLowerCase();
  const text = String(c.text ?? c.transcription ?? c.content ?? "").trim();
  const time = new Date(c.timestamp ?? c.time ?? "");
  if (!text || Number.isNaN(time.getTime())) return null;

  const kind: Event["kind"] = type.includes("audio") ? "audio" : type.includes("ui") ? "ui" : "screen";
  return {
    time,
    kind,
    app: String(c.app_name || (kind === "audio" ? c.device_name || "audio" : "unknown")),
    window: String(c.window_name ?? ""),
    text,
  };
}

// On Linux, OCR often returns the whole screen as ONE line: cut it into short chunks
// so that deduplication and error detection still work.
function splitLong(line: string): string[] {
  if (line.length <= 160) return [line];
  const words = line.split(" ");
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 12) out.push(words.slice(i, i + 12).join(" "));
  return out;
}

function cleanLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .flatMap(splitLong)
    .filter((l) => l.length >= 3 && /\p{L}/u.test(l));
}

const hhmmss = localTime;

/** Build segments (one per app/window run), dedupe repeated OCR lines, pick error-looking lines. */
export function buildContext(raw: RawItem[], maxChars = config.maxContextChars): Context {
  const events = raw
    .map(normalize)
    .filter((e): e is Event => e !== null)
    .sort((a, b) => a.time.getTime() - b.time.getTime());

  const seen = new Map<string, Set<string>>(); // app|window -> lines already shown
  const segments: Segment[] = [];
  const highlights: Highlight[] = [];
  const highlightSeen = new Set<string>();

  for (const ev of events) {
    const key = `${ev.app}|${ev.window}`;
    let shown = seen.get(key);
    if (!shown) seen.set(key, (shown = new Set()));

    const all = cleanLines(ev.text);
    const fresh = all.filter((l) => !shown!.has(l));
    fresh.forEach((l) => shown!.add(l));

    let seg = segments.at(-1);
    const prefix = ev.kind === "audio" ? "🎙 " : ev.kind === "ui" ? "› " : "";
    if (!seg || seg.app !== ev.app || seg.window !== ev.window || ev.time.getTime() - seg.end.getTime() > SEGMENT_GAP_MS) {
      seg = { start: ev.time, end: ev.time, app: ev.app, window: ev.window, lines: [] };
      segments.push(seg);
      if (fresh.length === 0) {
        // User came back to a screen already seen (e.g. same error after a restart): say so briefly.
        const errs = all.filter((l) => ERROR_RE.test(l)).slice(0, 3);
        seg.lines.push(`↺ same screen again: ${(errs.length ? errs : all.slice(0, 2)).join(" / ")}`);
        continue;
      }
    }
    seg.end = ev.time;
    seg.lines.push(...fresh.map((l) => prefix + l));

    for (const line of fresh) {
      if (ERROR_RE.test(line) && !highlightSeen.has(line)) {
        highlightSeen.add(line);
        highlights.push({ time: ev.time, app: ev.app, line: line.length > 200 ? `${line.slice(0, 200)}…` : line });
      }
    }
  }

  // Keep the MOST RECENT error lines: the problem the user reports is usually the last one.
  if (highlights.length > MAX_HIGHLIGHTS) highlights.splice(0, highlights.length - MAX_HIGHLIGHTS);

  for (const s of segments) {
    if (s.lines.length > MAX_LINES_PER_SEGMENT) {
      // Keep the start and, above all, the end of the segment (where errors usually are).
      const head = 15;
      const tail = MAX_LINES_PER_SEGMENT - head;
      const dropped = s.lines.length - MAX_LINES_PER_SEGMENT;
      s.lines = [...s.lines.slice(0, head), `… (${dropped} lines skipped)`, ...s.lines.slice(-tail)];
    }
  }

  const apps = [...new Set(events.map((e) => e.app))];
  const from = events[0]?.time ?? null;
  const to = events.at(-1)?.time ?? null;

  return {
    from,
    to,
    rawItems: raw.length,
    events: events.length,
    apps,
    segments,
    highlights,
    rendered: render({ from, to, apps, segments, highlights }, maxChars),
  };
}

// ---------------------------------------------------------------- rendering

function render(
  c: Pick<Context, "from" | "to" | "apps" | "segments" | "highlights">,
  maxChars: number,
): string {
  const head = [
    `Captured window (local time, ${utcOffsetLabel()}): ${c.from ? hhmmss(c.from) : "?"} → ${c.to ? hhmmss(c.to) : "?"}`,
    `Apps seen: ${c.apps.join(", ") || "none"}`,
    "",
    "## Lines that look like errors",
    ...(c.highlights.length
      ? c.highlights.map((h) => `- [${hhmmss(h.time)}] ${h.app}: ${h.line}`)
      : ["- (none detected)"]),
    "",
    "## Timeline (oldest → newest)",
  ].join("\n");

  // Keep the most recent segments that fit in the budget.
  const blocks = c.segments.map((s) =>
    [`### ${hhmmss(s.start)}–${hhmmss(s.end)} · ${s.app}${s.window ? ` — ${s.window}` : ""}`, ...s.lines].join("\n"),
  );
  const kept: string[] = [];
  let budget = maxChars - head.length;
  for (let i = blocks.length - 1; i >= 0; i--) {
    if (blocks[i].length + 2 > budget) {
      // Always keep something from the most recent segment, even if it must be cut.
      let omitted = i + 1;
      if (kept.length === 0 && budget > 200) {
        kept.unshift(`${blocks[i].slice(0, budget - 40)}\n… (truncated)`);
        omitted = i;
      }
      if (omitted > 0) kept.unshift(`(… ${omitted} older segment(s) omitted)`);
      break;
    }
    kept.unshift(blocks[i]);
    budget -= blocks[i].length + 2;
  }
  return `${head}\n\n${kept.join("\n\n")}`;
}

// ---------------------------------------------------------------- connection test

/** Used by the setup screen: is screenpipe running, is the key right, is it recording? */
export async function testScreenpipe(): Promise<string> {
  if (config.demoMode) return "Demo mode: using a sample incident instead of your screen.";
  try {
    await fetch(`${config.screenpipeUrl}/health`, { signal: AbortSignal.timeout(3000) });
  } catch {
    throw new Error(`screenpipe isn't running at ${config.screenpipeUrl}. Start screenpipe, then test again.`);
  }
  const headers: Record<string, string> = {};
  if (config.screenpipeApiKey) headers.Authorization = `Bearer ${config.screenpipeApiKey}`;
  const res = await fetch(`${config.screenpipeUrl}/search?content_type=ocr&limit=1`, {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(
      config.screenpipeApiKey
        ? "screenpipe rejected this API key. Copy it again from screenpipe (Settings › Privacy, or `screenpipe auth token`)."
        : "screenpipe needs an API key. Find it in screenpipe (Settings › Privacy) or run `screenpipe auth token`.",
    );
  }
  if (!res.ok) throw new Error(`screenpipe answered HTTP ${res.status}. Try again in a few seconds.`);
  const json = (await res.json()) as { data?: RawItem[] };
  const last = json.data?.[0]?.content?.timestamp;
  if (!last) return "Connected. Nothing recorded yet: use your computer for a minute, it will fill up.";
  const ago = Math.round((Date.now() - new Date(last).getTime()) / 60_000);
  return ago <= 1 ? "Connected and recording." : `Connected. Last capture ${ago} min ago: is recording paused?`;
}
