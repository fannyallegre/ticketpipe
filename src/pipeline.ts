// fetch → clean → redact → LLM → markdown. Shared by the server and the CLI.

import { config } from "./config";
import { buildContext, fetchRaw, type Context } from "./context";
import { redact, totalRedactions } from "./redact";
import { generateHelp, generateTicket, toMarkdown, type Help, type Ticket } from "./ticket";
import { incidents } from "./incidents";
import { fixes } from "./fix/runner";
import { AppError } from "./errors";

export type Stats = {
  rawItems: number;
  events: number;
  segments: number;
  apps: string[];
  from: string | null;
  to: string | null;
  redactions: Record<string, number>;
  llm: string;
  source: string;
};

export type Draft = {
  ticket: Ticket;
  title: string;
  body: string;
  labels: string[];
  stats: Stats;
  /** Exactly what was sent to the LLM (already redacted) — shown in the UI for transparency. */
  contextSent: string;
};

export type HelpResult = { help: Help; stats: Stats; contextSent: string; incidentId: string; automation: import("./fix/contracts").FixStatus };

function deepRedact<T>(value: T): T {
  if (value instanceof Date) return new Date(value) as T;
  if (typeof value === "string") return redact(value).text as T;
  if (Array.isArray(value)) return value.map(deepRedact) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepRedact(v)])) as T;
  }
  return value;
}

/** Read screenpipe, clean and mask it. Shared by tickets and quick fixes. */
async function prepare(minutes: number, rawNote: string) {
  const note = redact(rawNote).text;
  const raw = await fetchRaw(minutes);
  const ctx = buildContext(raw);
  if (ctx.events === 0) {
    throw new Error(
      `Nothing was recorded in the last ${minutes} minutes. Check that screenpipe is running and recording, then try again.`,
    );
  }
  const { text: contextSent, counts } = redact(ctx.rendered);
  return { note, ctx: deepRedact(ctx), contextSent, counts, stats: deepRedact(statsOf(ctx, counts, minutes)) };
}

function statsOf(ctx: Context, counts: Record<string, number>, minutes: number): Stats {
  return {
    rawItems: ctx.rawItems,
    events: ctx.events,
    segments: ctx.segments.length,
    apps: ctx.apps,
    from: ctx.from?.toISOString() ?? null,
    to: ctx.to?.toISOString() ?? null,
    redactions: counts,
    llm: config.llmProvider === "mock" ? "demo AI" : config.llmModel,
    source: config.demoMode
      ? "sample incident"
      : config.contextFile
        ? `file: ${config.contextFile}`
        : `screenpipe, last ${minutes} min`,
  };
}

export async function createDraft(opts: { minutes?: number; note?: string; incidentId?: string; fixRunId?: string; manualSteps?: number[] } = {}): Promise<Draft> {
  if (opts.fixRunId && !opts.incidentId) throw new AppError("An incident is required for an automatic-attempt ticket.");
  const minutes = opts.minutes ?? config.lookbackMinutes;
  if (opts.incidentId && opts.manualSteps) incidents.recordManual(opts.incidentId, opts.manualSteps);
  const evidence = opts.incidentId ? incidents.get(opts.incidentId) : await prepare(minutes, opts.note ?? "");
  const attempt = opts.incidentId ? fixes.ticketSummary(opts.incidentId, opts.fixRunId) : "";
  const { ctx, stats } = evidence;
  const clarification = opts.incidentId && opts.note && opts.note !== evidence.note ? `\nUser clarification: ${redact(opts.note).text}` : "";
  const note = evidence.note + clarification;
  const contextSent = evidence.contextSent + (attempt ? `\n\nLOCAL ATTEMPT RECORD (performed actions and user-reported manual steps are distinguished):\n${attempt}` : "");
  // Defense in depth: re-mask every string of the ticket (the demo AI reads raw highlights).
  const ticket = deepRedact(await generateTicket(ctx, contextSent, note));
  if (opts.incidentId) {
    const incident = incidents.get(opts.incidentId);
    // This field is factual, not generated from a list of proposed procedures.
    ticket.attempted_fixes = [
      ...incident.manualSteps.map(i => `User reports trying: ${incident.help.steps[i]}`),
      ...(opts.fixRunId ? fixes.get(opts.fixRunId).actions.filter(a => a.state === "performed").map(a => `${a.description}${a.observed ? ` — ${a.observed}` : ""}`) : []),
    ];
  }
  const body = toMarkdown(ticket, { events: ctx.events, from: ctx.from, to: ctx.to, redactions: totalRedactions(stats.redactions) }) + (attempt ? `\n## Repair attempt record\n\n${attempt}\n` : "");
  return { ticket, title: ticket.title, body, labels: ["it-ticket", `severity:${ticket.severity}`], stats, contextSent };
}

export async function createHelp(opts: { minutes?: number; note?: string } = {}): Promise<HelpResult> {
  const minutes = opts.minutes ?? config.lookbackMinutes;
  const { note, ctx, contextSent, stats } = await prepare(minutes, opts.note ?? "");
  const help = deepRedact(await generateHelp(ctx, contextSent, note));
  const incident = incidents.create({ note, ctx, contextSent, stats }, help);
  const capability = await fixes.assessAvailability();
  const automation = !help.solvable ? { available: false, reason: "This suggestion requires IT or a manual intervention." } : capability;
  return { help, stats, contextSent, incidentId: incident.id, automation };
}
