// Local web server behind the app window. Listens on 127.0.0.1 only.
//   bun run dev    → server only (open http://127.0.0.1:4242 yourself)
//   bun run app    → server + app window (see app.ts)

import indexHtml from "../public/index.html" with { type: "file" };
import markedJs from "../node_modules/marked/marked.min.js" with { type: "file" };
import purifyJs from "../node_modules/dompurify/dist/purify.min.js" with { type: "file" };
import { createApiSecurity } from "./security";
import { AppError } from "./errors";
import { fixes } from "./fix/runner";
import { applyDemoFlag, config, isOnboarded, loadSettings, saveSettings, SETTINGS_KEYS, type Settings } from "./config";
import { testScreenpipe } from "./context";
import { openExternal } from "./open";
import { detectScreenpipeKey } from "./detect";
import { createDraft, createHelp } from "./pipeline";
import { publishIssue, testGithub } from "./publish";
import { testLlm } from "./ticket";

const SECRET_KEYS = ["screenpipeApiKey", "llmApiKey", "githubToken"] as const;
const APP_ID = "ticketpipe";

const json = (data: unknown, status = 200) => Response.json(data, { status });
const fail = (err: unknown, status = 500) => json({ error: err instanceof Error ? err.message : String(err) }, status);
const failure = (error: unknown) => fail(error, error instanceof AppError ? error.status : 500);

/** Last time the app window said "I'm still open". */
export let lastPing = 0;

function publicSettings() {
  const out: Record<string, unknown> = {};
  for (const key of SETTINGS_KEYS) {
    const value = config[key];
    if ((SECRET_KEYS as readonly string[]).includes(key)) {
      const v = String(value || "");
      out[key] = v ? `••••${v.slice(-4)}` : "";
    } else out[key] = value;
  }
  return { ...out, onboarded: isOnboarded(), ticketsDir: config.ticketsDir };
}

export function startServer(port = config.port) {
  const security = createApiSecurity();
  const protectedRoute = (handler: (req: any, server: any) => any) => async (req: any, server: any) => {
    try { security.authorize(req, server.port); return await handler(req, server); } catch (error) { return failure(error); }
  };
  return Bun.serve({
    port,
    maxRequestBodySize: 65536,
    hostname: "127.0.0.1", // screen data never leaves this machine unless the user sends a ticket
    routes: {
      "/": async () => new Response((await Bun.file(indexHtml as unknown as string).text()).replace("<head>", `<head><meta name="ticketpipe-token" content="${security.token}">`).replaceAll("<script>", `<script nonce="${security.token}">`), { headers: {
        "content-type": "text/html; charset=utf-8", "cache-control": "no-store",
        "content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${security.token}'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
      } }),
      "/vendor/marked.js": new Response(Bun.file(markedJs), { headers: { "content-type": "text/javascript" } }),
      "/vendor/purify.js": new Response(Bun.file(purifyJs), { headers: { "content-type": "text/javascript" } }),

      "/api/ping": () => {
        lastPing = Date.now();
        return json({ app: APP_ID });
      },

      "/api/settings": {
        GET: protectedRoute(() => json(publicSettings())),
        POST: protectedRoute(async (req) => {
          try {
            const patch = (await req.json()) as Record<string, unknown>;
            const clean: Settings = {};
            for (const key of SETTINGS_KEYS) {
              if (!(key in patch)) continue;
              const v = patch[key];
              // Secrets come back masked ("••••1234") when unchanged: ignore those.
              if ((SECRET_KEYS as readonly string[]).includes(key) && typeof v === "string" && v.startsWith("••••")) continue;
              (clean as any)[key] = key === "lookbackMinutes" ? Number(v) : typeof v === "string" ? v.trim() : v;
            }
            if (typeof patch.onboarded === "boolean") clean.onboarded = patch.onboarded;
            saveSettings(clean);
            return json(publicSettings());
          } catch (e) {
            return fail(e, 400);
          }
        }),
      },

      "/api/test/:what": {
        POST: protectedRoute(async (req) => {
          try {
            const what = req.params.what;
            const message =
              what === "screenpipe" ? await testScreenpipe()
              : what === "ai" ? `Connected to ${await testLlm()}.`
              : what === "github" ? await testGithub().then((r) => (r.startsWith("Tickets") ? r : `Connected to ${r}.`))
              : null;
            if (message === null) return fail("Unknown test", 404);
            return json({ ok: true, message });
          } catch (e) {
            return json({ ok: false, message: e instanceof Error ? e.message : String(e) });
          }
        }),
      },

      "/api/detect/screenpipe": {
        POST: protectedRoute(async () => {
          const key = await detectScreenpipeKey();
          if (!key) {
            return json({
              ok: false,
              message: "Couldn't find it automatically. Make sure screenpipe is running, or paste the key below.",
            });
          }
          saveSettings({ screenpipeApiKey: key });
          return json({ ok: true, message: "Found your screenpipe key and saved it.", settings: publicSettings() });
        }),
      },

      "/api/help": {
        POST: protectedRoute(async (req) => {
          try {
            const { minutes, note } = draftInput(await req.json());
            return json(await createHelp({ minutes: minutes ? Number(minutes) : undefined, note }));
          } catch (e) {
            return failure(e);
          }
        }),
      },

      "/api/draft": {
        POST: protectedRoute(async (req) => {
          try {
            return json(await createDraft(draftInput(await req.json())));
          } catch (e) {
            return failure(e);
          }
        }),
      },

      "/api/publish": {
        POST: protectedRoute(async (req) => {
          try {
            const { title, body, labels } = (await req.json()) as { title: string; body: string; labels?: string[] };
            if (!title?.trim() || !body?.trim()) return fail("The ticket needs a title and a description.", 400);
            return json(await publishIssue({ title: title.trim(), body, labels }));
          } catch (e) {
            return fail(e);
          }
        }),
      },

      "/api/open": {
        POST: protectedRoute(async (req) => {
          const { target } = (await req.json()) as { target?: string };
          if (target === "tickets-folder") {
            await Bun.write(`${config.ticketsDir}/.keep`, "");
            return json({ ok: openExternal(config.ticketsDir) });
          }
          // Only open web links (GitHub issue, docs) — never arbitrary commands.
          if (!target || !/^https:\/\//.test(target)) return fail("Only https links can be opened.", 400);
          return json({ ok: openExternal(target) });
        }),
      },
      "/api/fix/status": { GET: protectedRoute(async () => json(await fixes.assessAvailability())) },
      "/api/fix/permissions": { POST: protectedRoute(async () => json(await fixes.permissions())) },
      "/api/fix/windows": { GET: protectedRoute(async () => json({ windows: await fixes.windows() })) },
      "/api/fix/runs": { POST: protectedRoute(async req => {
        const body = await req.json();
        if (typeof body.incidentId !== "string" || typeof body.windowId !== "string") throw new AppError("Choose an incident and application window.");
        return json(fixes.start(body.incidentId, body.windowId, body.manualSteps ?? []), 202);
      }) },
      "/api/fix/runs/:id": { GET: protectedRoute(req => json(fixes.get(req.params.id))) },
      "/api/fix/runs/:id/stop": { POST: protectedRoute(async req => json(await fixes.stop(req.params.id))) },
      "/api/fix/runs/:id/heartbeat": { POST: protectedRoute(req => json(fixes.heartbeat(req.params.id))) },
      "/api/fix/runs/:id/confirm": { POST: protectedRoute(req => json(fixes.confirm(req.params.id))) },
    },
    fetch: () => new Response("Not found", { status: 404 }),
  });
}

function draftInput(body: any): { minutes?: number; note?: string; incidentId?: string; fixRunId?: string; manualSteps?: number[] } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new AppError("Expected a JSON object.");
  if (body.note !== undefined && (typeof body.note !== "string" || body.note.length > 8000)) throw new AppError("Enter a short problem description.");
  if (body.minutes !== undefined && (typeof body.minutes !== "number" || !Number.isFinite(body.minutes) || body.minutes < 1 || body.minutes > 120)) throw new AppError("Choose a history window between 1 and 120 minutes.");
  for (const key of ["incidentId", "fixRunId"]) if (body[key] !== undefined && (typeof body[key] !== "string" || body[key].length > 100)) throw new AppError("Invalid incident or run reference.");
  return { minutes: body.minutes, note: body.note, incidentId: body.incidentId, fixRunId: body.fixRunId, manualSteps: body.manualSteps };
}

/** Is our app already running on this port? (used to avoid opening a second copy) */
export async function isAppRunningOn(port: number) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/ping`, { signal: AbortSignal.timeout(800) });
    return ((await res.json()) as { app?: string }).app === APP_ID;
  } catch {
    return false;
  }
}

/** No screenpipe key yet? Try to find it in the background so setup is one click shorter. */
export async function autoDetectKey() {
  if (config.screenpipeApiKey || config.demoMode) return;
  const key = await detectScreenpipeKey();
  if (key) saveSettings({ screenpipeApiKey: key });
}

if (import.meta.main) {
  loadSettings();
  applyDemoFlag(process.argv);
  autoDetectKey();
  const server = startServer();
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => { void fixes.shutdown().finally(() => { server.stop(true); process.exit(0); }); });
  console.log(`\n  [ ticketpipe ] → http://${server.hostname}:${server.port}`);
  console.log(`     source: ${config.demoMode ? "sample incident" : config.screenpipeUrl}`);
  console.log(`     ai:     ${config.llmProvider === "mock" ? "demo" : config.llmModel}\n`);
}
