// Turn the (redacted) context into a structured IT ticket, or into self-help steps, with an LLM.

import { config } from "./config";
import { callLlm } from "./llm";
import type { Context } from "./context";
import { localDateTime, localTime, utcOffsetLabel } from "./time";

export type Severity = "low" | "medium" | "high" | "critical";

export type Ticket = {
  title: string;
  summary: string;
  severity: Severity;
  severity_reason: string;
  category: string;
  affected_app: string | null;
  app_version: string | null;
  environment: string | null;
  error_messages: string[];
  steps_to_reproduce: string[];
  attempted_fixes: string[];
  timeline: { time: string; event: string }[];
  suggested_solutions: string[];
  missing_info: string[];
};

export type Help = {
  solvable: boolean;
  diagnosis: string;
  steps: string[];
  needs_it_because: string | null;
};

const MAX_SOLUTIONS = 3;
const MAX_MISSING = 3;
const MAX_HELP_STEPS = 5;

// ---------------------------------------------------------------- shared prompt parts

const CONTEXT_RULES = `What the context is (and is not):
- It is OCR of the whole screen: it also contains documentation, web pages, chat conversations
  (including with AI assistants), examples and suggestions. Text that is displayed is NOT necessarily
  something the user did. Only treat as a user action what clearly shows it was done: a command in a
  terminal followed by its output, a click/key event (lines starting with "›"), an app's own error dialog.
- OCR is imperfect: garbled characters are normal. Copy error messages as they appear, but you may drop
  obvious garbage at their edges.
- Times are local time (${utcOffsetLabel()}).
- Markers like [REDACTED_EMAIL] are intentional privacy masks: keep them as-is, never try to guess them.`;

const PICK_PROBLEM = `How to pick the problem:
- The USER NOTE is the authority on what the problem is. Only use the parts of the context that relate
  to it. If there is no note, pick the MOST RECENT error.`;

// ---------------------------------------------------------------- ticket prompt

const TICKET_SCHEMA = `{
  "title": string,                     // < 90 chars, specific: app + symptom
  "summary": string,                   // 2-3 sentences: what the user tried to do and what happened
  "severity": "low" | "medium" | "high" | "critical",
  "severity_reason": string,           // one short sentence explaining the severity you chose
  "category": string,                  // e.g. "network/vpn", "access/sso", "software/crash", "hardware", "email", "other"
  "affected_app": string | null,
  "app_version": string | null,        // only if visible in the context
  "environment": string | null,        // OS / device info, only if visible
  "error_messages": string[],          // verbatim, as seen on screen, most important first
  "steps_to_reproduce": string[],      // what the user actually did, in order
  "attempted_fixes": string[],         // what the user already tried
  "timeline": [{ "time": "HH:MM:SS", "event": string }],  // 3-8 key moments, local time
  "suggested_solutions": string[],     // 1 to ${MAX_SOLUTIONS} items, see rules
  "missing_info": string[]             // 0 to ${MAX_MISSING} items, see rules
}`;

function ticketSystemPrompt(): string {
  return `You are an IT support assistant. You turn a user's recent screen activity, captured by screenpipe
(OCR of the screen, UI events, sometimes audio transcripts), into a precise, actionable IT ticket.

${PICK_PROBLEM}
- If several distinct errors relate to the problem, list them all in chronological order; the most recent
  one is usually the current blocker.

${CONTEXT_RULES}

Strict rules (no guessing):
- Only state facts that appear in the context or in the user's note. Never invent versions, error codes,
  hostnames, URLs, impact, root causes or steps.
- "steps_to_reproduce" and "attempted_fixes": only actions you can SEE were done, or that the user says they did.
- "category", "affected_app", "environment": only from clear evidence, otherwise "other" / null.
- "summary": describe what is observed. Do not claim business impact unless the user says so.

Severity (read-only for the employee; base it on the USER NOTE and relevant recorded evidence):
- The user's stated impact takes priority. An error message alone does not prove that work is blocked.
- Explain the selected level using the stated impact; when impact is unknown, say so and use medium.
- Never infer a company-wide outage from an unrelated chat or documentation visible on screen.
- "low": cosmetic or minor annoyance, work continues normally.
- "medium": something does not work but there is a workaround, or the impact is unclear. This is the default.
- "high": the user says, or the context clearly shows, they cannot do their job at all.
- "critical": several people or a whole service are affected (e.g. colleagues report the same problem).

"suggested_solutions" (at most ${MAX_SOLUTIONS}, the most likely first):
- Write for someone who is not technical: short sentences, everyday words, no jargon or acronyms without
  a short explanation, no commands.
- Each item says what could fix the problem and, if useful, who should do it ("IT can renew…").
- They are possibilities, not certainties: start with "Try…", "Check…", "IT may need to…".

"missing_info" (at most ${MAX_MISSING}, only what really matters): questions IT would still need to ask,
in plain words. Leave it empty if nothing important is missing.

- Write every string value in this language: ${config.ticketLanguage}.
- Reply with ONE JSON object and nothing else (no markdown fences), matching this schema:
${TICKET_SCHEMA}`;
}

// ---------------------------------------------------------------- self-help prompt

const HELP_SCHEMA = `{
  "solvable": boolean,           // true only if a normal user can safely fix it alone
  "diagnosis": string,           // 1-2 sentences in plain words: what seems to be wrong
  "steps": string[],             // if solvable: 2 to ${MAX_HELP_STEPS} steps, in order. Otherwise []
  "needs_it_because": string | null  // if not solvable: one plain sentence explaining why IT is needed
}`;

function helpSystemPrompt(): string {
  return `You are a friendly IT helpdesk assistant. A user has a problem on their computer. Using their note
and what screenpipe captured on their screen, decide whether they can safely fix it themselves, and if so,
give them simple steps.

${PICK_PROBLEM}

${CONTEXT_RULES}

Safe self-fixes (solvable = true): restarting an app or the computer, signing out and back in, checking
the Wi-Fi or cable, turning the VPN off and on, clearing a browser's cache, checking a typo in an address
or password, reconnecting a printer or screen, freeing disk space, closing apps that use too much memory,
updating an app from its own menu, checking that caps lock is off.

Needs IT (solvable = false): expired or missing certificates, locked or disabled accounts, missing
permissions or licences, anything needing admin rights, server or network outages (or several colleagues
affected), hardware damage, possible security issues (phishing, virus), lost data.

Rules:
- Base the diagnosis on what is visible. If unsure, say what it "looks like".
- Steps are for someone who is not technical: one action per step, everyday words, name the exact
  button or menu when it is visible in the context, no terminal commands, nothing that could lose data.
- Write every string value in this language: ${config.ticketLanguage}.
- Reply with ONE JSON object and nothing else (no markdown fences), matching this schema:
${HELP_SCHEMA}`;
}

function userPrompt(ctx: Context, contextText: string, note: string, mode: "ticket" | "help"): string {
  return [
    `USER NOTE (authoritative description of the problem): ${
      note.trim() ||
      `(none — the user just pressed "${mode === "ticket" ? "create ticket" : "quick fix"}"; focus on the most recent error)`
    }`,
    "",
    `Captured context (${ctx.events} events, redacted):`,
    "<context>",
    contextText,
    "</context>",
  ].join("\n");
}

// ---------------------------------------------------------------- providers

/** Tiny round-trip used by the "Test" button in Settings. */
export async function testLlm(): Promise<string> {
  if (config.llmProvider === "mock") return "the demo AI";
  const system = 'Reply with exactly this JSON and nothing else: {"ok": true}';
  const raw = await callLlm(system, "ping", { maxTokens: 50 });
  if (!raw.includes("ok")) throw new Error(`Unexpected answer: ${raw.slice(0, 120)}`);
  return config.llmModel;
}

// ---------------------------------------------------------------- demo AI (no network)

function mockTicket(ctx: Context, note: string): Ticket {
  const errors = ctx.highlights.filter((h) => !/anyone else|works for me/i.test(h.line));
  const top = errors.at(-1) ?? ctx.highlights.at(-1);
  const app = top?.app ?? ctx.apps[0] ?? null;
  const colleagues = /(?:whole (?:team|service)|everyone|several (?:people|colleagues)|toute l.équipe|plusieurs collègues)/i.test(note);
  const blocked = /(?:cannot work|can.t work|unable to work|completely blocked|impossible de travailler|ne peux plus travailler)/i.test(note);
  const minor = /(?:cosmetic|minor annoyance|cosmétique|sans impact|can still work|peux travailler)/i.test(note);
  return {
    title: top ? `${app}: ${top.line}`.slice(0, 90) : "Problem reported from screen activity",
    summary:
      (note ? `${note.replace(/\.$/, "")}. ` : "") +
      (top ? `The screen shows "${top.line}" in ${app}.` : "No error message was found on screen."),
    severity: colleagues ? "critical" : blocked ? "high" : minor ? "low" : "medium",
    severity_reason: colleagues
      ? "A colleague reports the same problem, so it may affect several people."
      : blocked ? "The user reports being unable to work." : minor ? "The user reports that work can continue." : "The business impact is unclear; medium is the default.",
    category: "other",
    affected_app: app,
    app_version: null,
    environment: null,
    error_messages: errors.map((h) => h.line).slice(-4),
    steps_to_reproduce: ctx.segments.slice(-4).map((s) => `Used ${s.app}${s.window ? ` (${s.window})` : ""}`),
    attempted_fixes: [],
    timeline: ctx.highlights.slice(-6).map((h) => ({ time: localTime(h.time), event: h.line })),
    suggested_solutions: ["This ticket was written by the demo AI. Connect a real AI in Settings for suggestions."],
    missing_info: [],
  };
}

function mockHelp(ctx: Context): Help {
  const top = ctx.highlights.filter((h) => !/anyone else|works for me/i.test(h.line)).at(-1);
  if (top && /certificate|permission|denied|locked/i.test(top.line)) {
    return {
      solvable: false,
      diagnosis: `It looks like "${top.line}".`,
      steps: [],
      needs_it_because: "This needs someone with admin access, so IT has to fix it.",
    };
  }
  return {
    solvable: true,
    diagnosis: top ? `It looks like "${top.line}" in ${top.app}.` : "No clear error was found on your screen.",
    steps: [
      "Save your work, then close the app completely.",
      "Open it again and try the same thing.",
      "If it still fails, restart your computer.",
    ],
    needs_it_because: null,
  };
}

// ---------------------------------------------------------------- parsing

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : []);
const asStr = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function parseJson(raw: string): any {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error(`The AI did not answer in the expected format:\n${raw.slice(0, 300)}`);
  return JSON.parse(raw.slice(start, end + 1));
}

export function parseTicket(raw: string): Ticket {
  const j = parseJson(raw);
  const sev = String(j.severity ?? "medium").toLowerCase();
  return {
    title: asStr(j.title) ?? "Untitled problem",
    summary: asStr(j.summary) ?? "",
    severity: (["low", "medium", "high", "critical"].includes(sev) ? sev : "medium") as Severity,
    severity_reason: asStr(j.severity_reason) ?? "",
    category: asStr(j.category) ?? "other",
    affected_app: asStr(j.affected_app),
    app_version: asStr(j.app_version),
    environment: asStr(j.environment),
    error_messages: asList(j.error_messages),
    steps_to_reproduce: asList(j.steps_to_reproduce),
    attempted_fixes: asList(j.attempted_fixes),
    timeline: Array.isArray(j.timeline)
      ? j.timeline
          .map((t: any) => ({ time: String(t?.time ?? ""), event: String(t?.event ?? "") }))
          .filter((t: { event: string }) => t.event)
          .slice(0, 8)
      : [],
    // Hard limits, whatever the model does.
    suggested_solutions: asList(j.suggested_solutions ?? j.suggested_next_steps).slice(0, MAX_SOLUTIONS),
    missing_info: asList(j.missing_info).slice(0, MAX_MISSING),
  };
}

export function parseHelp(raw: string): Help {
  const j = parseJson(raw);
  const steps = asList(j.steps).slice(0, MAX_HELP_STEPS);
  const solvable = j.solvable === true && steps.length > 0;
  return {
    solvable,
    diagnosis: asStr(j.diagnosis) ?? "",
    steps: solvable ? steps : [],
    needs_it_because: solvable ? null : (asStr(j.needs_it_because) ?? "This problem needs IT."),
  };
}

export async function generateTicket(ctx: Context, contextText: string, note = ""): Promise<Ticket> {
  if (config.llmProvider === "mock") return mockTicket(ctx, note);
  return parseTicket(await callLlm(ticketSystemPrompt(), userPrompt(ctx, contextText, note, "ticket")));
}

export async function generateHelp(ctx: Context, contextText: string, note = ""): Promise<Help> {
  if (config.llmProvider === "mock") return mockHelp(ctx);
  return parseHelp(await callLlm(helpSystemPrompt(), userPrompt(ctx, contextText, note, "help")));
}

// ---------------------------------------------------------------- markdown

const bullets = (items: string[], ordered = false) =>
  items.length ? items.map((s, i) => `${ordered ? `${i + 1}.` : "-"} ${s}`).join("\n") : "_None_";

export function toMarkdown(t: Ticket, meta: { events: number; from: Date | null; to: Date | null; redactions: number }) {
  const tz = utcOffsetLabel(meta.from ?? new Date());
  const range = meta.from && meta.to ? `${localDateTime(meta.from)} → ${localTime(meta.to).slice(0, 5)} (${tz})` : "n/a";
  const sections = [
    `## Quick fix\nTry these suggestions before sending your ticket to IT. If a step needs an administrator or IT support, leave it to IT.\n\n${bullets(t.suggested_solutions, true)}`,
    `## Summary\n${t.summary}`,
    `| | |\n|---|---|\n| **Severity** | ${t.severity}${t.severity_reason ? ` — ${t.severity_reason}` : ""} |\n| **Category** | ${t.category} |\n| **Application** | ${t.affected_app ?? "unknown"} |\n| **Version** | ${t.app_version ?? "unknown"} |\n| **Environment** | ${t.environment ?? "unknown"} |`,
    `## Error messages\n${t.error_messages.length ? t.error_messages.map((e) => "```\n" + e + "\n```").join("\n") : "_None captured_"}`,
    `## Steps to reproduce the error\n${bullets(t.steps_to_reproduce, true)}`,
    `## Already tried\n${bullets(t.attempted_fixes)}`,
    `## Timeline (${tz})\n${t.timeline.length ? t.timeline.map((e) => `- \`${e.time}\` ${e.event}`).join("\n") : "_n/a_"}`,
  ];
  if (t.missing_info.length) sections.push(`## Questions IT may ask\n${bullets(t.missing_info)}`);
  sections.push(
    `---\n<sub>Generated by TicketPipe from ${meta.events} screen events (${range}). ${meta.redactions} sensitive item(s) were masked on the user's computer. Reviewed by the user before sending.</sub>`,
  );
  return sections.join("\n\n") + "\n";
}
