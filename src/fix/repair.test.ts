import { afterEach, describe, expect, mock, test } from "bun:test";
import { IncidentStore, incidents, type Evidence } from "../incidents";
import { FixService, type AgentCall } from "./runner";
import { ControllerError, validateStatus } from "./controller";
import type { Action, Binding, Controller, ControllerStatus, DesktopPlatform, Observation } from "./contracts";
import { evaluateChecks, observedChanges, parseObject, redactObservation, validateAction, validatePlan } from "./policy";
import { createApiSecurity } from "../security";
import { config } from "../config";
import { createDraft, createHelp } from "../pipeline";
import { startServer } from "../server";
import { callLlm, isRealAiConfigured } from "../llm";
import { createRepairLogger, type RepairDiagnostic } from "./diagnostics";
import { publishIssue } from "../publish";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const evidence: Evidence = { note: "Enable word wrap in my document", contextSent: "Original recorded error", ctx: { from: new Date(0), to: new Date(1000), rawItems: 1, events: 1, apps: ["Editor"], segments: [], highlights: [], rendered: "Original recorded error" }, stats: { rawItems: 1, events: 1, segments: 0, apps: ["Editor"], from: new Date(0).toISOString(), to: new Date(1000).toISOString(), redactions: {}, llm: "test", source: "screenpipe" } };
const help = { solvable: true, diagnosis: "Wrap is off", steps: ["Enable Word wrap", "Inspect the document"], needs_it_because: null };
const plan = { summary: "Enable word wrap", checks: [{ name: "Word wrap", property: "checked", equals: true }] };
const decision = { progress: "Enable wrapping", action: { kind: "activate", ref: "e0" } };
const services: FixService[] = [];
describe("platform controller contract", () => {
  const status = (platform: DesktopPlatform, extra = {}): ControllerStatus => ({ protocol: 1, platform, ready: true, permissions: "granted", reason: "Ready", setup: false, supportedActions: ["activate", "text", "select", "scroll"], allowedKeys: [], ...extra });
  test("rejects incompatible, incorrect-platform and Wayland keyboard handshakes", () => {
    for (const platform of ["windows", "linux", "macos"] as const) {
      expect(validateStatus(status(platform), platform).platform).toBe(platform);
      expect(() => validateStatus(status(platform, { protocol: 2 }), platform)).toThrow("incompatible");
      expect(() => validateStatus(status(platform, { ready: true, permissions: "required" }), platform)).toThrow();
    }
    expect(() => validateStatus(status("linux"), "macos")).toThrow();
    expect(() => validateStatus(status("linux", { session: "gnome-wayland", allowedKeys: ["CTRL+A"] }), "linux")).toThrow();
    expect(() => validateStatus(status("macos", { allowedKeys: ["CTRL+A"] }), "macos")).toThrow();
  });
  test("platform and control key allowlists both apply", () => {
    const observation: Observation = { id: "o", platform: "linux", title: "Document", truncated: false, controls: [{ ref: "e", name: "Search", role: "entry", automationId: "search", editable: true, enabled: true, actions: ["text", "keys"], allowedKeys: [] }] };
    expect(() => validateAction({ kind: "keys", key: "CTRL+A", ref: "e" }, observation)).toThrow();
    observation.platform = "macos"; observation.controls[0].allowedKeys = ["CMD+A"];
    expect(validateAction({ kind: "keys", key: "CMD+A", ref: "e" }, observation).action.kind).toBe("keys");
    expect(() => validateAction({ kind: "keys", key: "CTRL+A", ref: "e" }, observation)).toThrow();
    observation.controls[0].editable = false;
    expect(() => validateAction({ kind: "keys", key: "CMD+A", ref: "e" }, observation)).toThrow();
  });
  test("manual focus handoff performs no observation or AI work until ready", async () => {
    let calls = 0;
    const f = await fixture(async phase => { calls++; return phase === "plan" ? plan : decision; });
    const controller = f.controller as FakeController & Controller;
    const gate = deferred<Binding>();
    controller.bind = async () => ({ state: "awaiting_focus" });
    controller.focus = async () => gate.promise;
    const run = f.start(); await settle();
    expect(f.service.get(run.id).phase).toBe("awaiting_focus");
    expect(controller.observations).toBe(0); expect(controller.acts).toBe(0); expect(calls).toBe(0);
    gate.resolve({ state: "ready" });
    expect((await f.service.wait(run.id)).status).toBe("verified_fixed");
  });
  test("Stop while awaiting focus discards late readiness", async () => {
    const f = await fixture(); const gate = deferred<Binding>();
    const controller = f.controller as FakeController & Controller;
    controller.bind = async () => ({ state: "awaiting_focus" }); controller.focus = async () => gate.promise;
    const run = f.start(); await settle(); await f.service.stop(run.id);
    gate.resolve({ state: "ready" });
    expect((await f.service.wait(run.id)).status).toBe("stopped");
    expect(controller.observations).toBe(0); expect(controller.acts).toBe(0);
  });
  test("focus deadline includes slow probes and cannot start input afterward", async () => {
    const f = await fixture(); const gate = deferred<Binding>();
    const controller = f.controller as FakeController & Controller;
    controller.bind = async () => ({ state: "awaiting_focus" }); controller.focus = async () => gate.promise;
    const run = f.start(); await settle(); f.advance(10_000); f.service.heartbeat(run.id); f.advance(5_001);
    gate.resolve({ state: "ready" }); const result = await f.service.wait(run.id);
    expect(result.status).toBe("needs_user"); expect(result.progress).toContain("15 seconds"); expect(controller.observations).toBe(0);
  });
  test("readiness and permission setup neither start repairs nor replace evidence", async () => {
    const f = await fixture(); const controller = f.controller as FakeController & Controller;
    let prompts = 0, allowed = false;
    controller.status = async () => status("macos", { ready: allowed, permissions: allowed ? "granted" : "required", setup: !allowed });
    controller.permissions = async () => { prompts++; allowed = true; return controller.status!(); };
    expect((await f.service.assessAvailability()).setup).toBe(true); expect(prompts).toBe(0);
    expect((await f.service.permissions()).available).toBe(true); expect(prompts).toBe(1);
    expect(controller.observations).toBe(0); expect(controller.acts).toBe(0);
    expect(f.store.get(f.incident.id).contextSent).toBe("Original recorded error");
  });
  test("binding retains the picker helper and its native window identity", async () => {
    let created = 0;
    const controller = new FakeController();
    const f = await fixture(undefined, { controller: () => { created++; return controller; } });
    expect(created).toBe(1);
    expect((await f.service.wait(f.start().id)).status).toBe("verified_fixed");
    expect(created).toBe(1);
  });
  test("overlapping pickers cannot replace or orphan a selected helper", async () => {
    const f = await fixture();
    const gate = deferred<Awaited<ReturnType<FakeController["windows"]>>>();
    f.controller.windows = async () => gate.promise;
    const first = f.service.windows(); await settle();
    await expect(f.service.windows()).rejects.toThrow("Wait");
    expect(() => f.start()).toThrow("selection");
    gate.resolve([{ id: "native:42:1000", app: "Editor", title: "Document" }]);
    expect(await first).toHaveLength(1);
  });
});
afterEach(async () => { await Promise.all(services.splice(0).map(s => s.shutdown())); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => resolve = r); return { resolve, promise }; }
const settle = () => Bun.sleep(10);
class FakeController implements Controller {
  enabled = false; changed = true; cancelled = false; acts = 0; observations = 0;
  failure?: Error; actGate?: Promise<{ performed: true }>;
  async windows() { return [{ id: "native:42:1000", app: "Editor", title: "Document" }]; }
  async bind(): Promise<Binding | void> {}
  async guard() { if (this.failure) throw this.failure; }
  async observe(): Promise<Observation> { this.observations++; if (this.failure) throw this.failure; return { id: String(this.observations), title: "Document", truncated: false, controls: [{ ref: "e0", name: "Word wrap", role: "checkbox", automationId: "wrap", enabled: true, editable: false, checked: this.enabled, actions: ["activate", "keys"] }] }; }
  async act(_id: string, _action: Action) { this.acts++; if (this.actGate) return this.actGate; if (this.changed) this.enabled = true; return { performed: true as const }; }
  async cancel() { this.cancelled = true; }
  async close() {}
}
async function fixture(agent: AgentCall = async phase => phase === "plan" ? plan : decision, options: any = {}) {
  let clock = 1000;
  const store = new IncidentStore(() => clock, 100_000), controller = new FakeController();
  const incident = store.create(evidence, help);
  const service = new FixService({ store, controller: () => controller, agent, now: () => clock, available: () => ({ available: true, reason: "test" }), diagnostic: () => {}, ...options });
  services.push(service);
  const [window] = await service.windows();
  return { service, store, controller, incident, start: (manual: number[] = []) => service.start(incident.id, window.id, manual), advance: (n: number) => { clock += n; service.tick(); } };
}

describe("incident snapshots", () => {
  test("freeze evidence and preserve active incidents across expiry", () => {
    let clock = 0; const store = new IncidentStore(() => clock, 100);
    const i = store.create(evidence, help); i.help.steps.push("Invented");
    expect(store.get(i.id).help.steps).toHaveLength(2);
    store.pin(i.id); clock = 200; store.sweep(); expect(store.get(i.id).ctx.from).toBeInstanceOf(Date);
    store.unpin(i.id); expect(() => store.get(i.id)).toThrow("expired");
  });
  test("records only valid explicitly checked indexes", () => {
    const store = new IncidentStore(), i = store.create(evidence, help);
    expect(store.recordManual(i.id, [1, 1]).manualSteps).toEqual([1]);
    for (const x of [[-1], [2], [0.5], ["0"], "all"]) expect(() => store.recordManual(i.id, x)).toThrow();
  });
});
describe("repair runner", () => {
  test("failed initial activation cannot reach observation, AI or input", async () => {
    let calls = 0; const events: RepairDiagnostic[] = [];
    const f = await fixture(async () => { calls++; return plan; }, { diagnostic: (event: RepairDiagnostic) => events.push(event) });
    f.controller.bind = async () => { throw new ControllerError("Activation timed out", "activation_failed", false); };
    const result = await f.service.wait(f.start().id);
    expect(result.status).toBe("needs_user"); expect(calls).toBe(0);
    expect(f.controller.observations).toBe(0); expect(f.controller.acts).toBe(0);
    expect(events.at(-1)).toMatchObject({ phase: "connecting", errorCode: "activation_failed", actionCount: 0 });
  });
  test("Stop during initial activation invalidates a late bind completion", async () => {
    const bind = deferred<void>(); let calls = 0;
    const f = await fixture(async () => { calls++; return plan; });
    f.controller.bind = async () => bind.promise;
    const run = f.start(); await settle(); await f.service.stop(run.id); bind.resolve();
    expect((await f.service.wait(run.id)).status).toBe("stopped");
    expect(f.controller.cancelled).toBe(true); expect(f.controller.observations).toBe(0); expect(calls).toBe(0);
  });
  test("executes a validated first action after one AI request", async () => {
    const phases: string[] = [], events: RepairDiagnostic[] = [];
    const f = await fixture(async phase => { phases.push(phase); return { ...plan, action: decision.action }; }, { diagnostic: (event: RepairDiagnostic) => events.push(event) });
    const result = await f.service.wait(f.start().id);
    expect(result.status).toBe("verified_fixed"); expect(f.controller.acts).toBe(1);
    expect(phases).toEqual(["plan"]); expect(result.phase).toBe("finished");
    expect(events.some(e => e.event === "ai_result" && e.phase === "planning")).toBe(true);
    expect(events.at(-1)?.outcome).toBe("verified_fixed");
  });
  test("a first action cannot bypass success-check or action validation", async () => {
    for (const response of [{ ...plan, checks: [], action: decision.action }, { ...plan, action: { kind: "script", script: "bad" } }]) {
      const f = await fixture(async () => response), result = await f.service.wait(f.start().id);
      expect(result.status).toBe("needs_user"); expect(f.controller.acts).toBe(0); expect(result.actions).toHaveLength(0);
    }
  });
  test("Stop rejects a late combined plan and first action", async () => {
    const late = deferred<any>(), events: RepairDiagnostic[] = [];
    const f = await fixture(() => late.promise, { diagnostic: (event: RepairDiagnostic) => events.push(event) });
    const run = f.start(); await settle(); f.advance(3000);
    expect(f.service.get(run.id).phase).toBe("planning");
    await f.service.stop(run.id); late.resolve({ ...plan, action: decision.action });
    const result = await f.service.wait(run.id);
    expect(result.status).toBe("stopped"); expect(f.controller.acts).toBe(0);
    expect(events.at(-1)).toMatchObject({ event: "finished", phase: "planning", phaseElapsedMs: 3000 });
  });
  test("executes from frozen context and independently verifies the actual result", async () => {
    const calls: any[] = [];
    const f = await fixture(async (phase, data) => { calls.push(data); return phase === "plan" ? plan : decision; });
    const run = f.start([1]); expect(run.status).toBe("running");
    const result = await f.service.wait(run.id);
    expect(result.status).toBe("verified_fixed"); expect(result.verification).toBe("passed");
    expect(result.actions[0].state).toBe("performed"); expect(f.controller.observations).toBeGreaterThanOrEqual(4);
    expect(calls[0].evidence).toBe(evidence.contextSent); expect(calls[0].manuallyAttempted).toEqual([help.steps[1]]);
    const summary = f.service.ticketSummary(f.incident.id, run.id);
    expect(summary).toContain("User reports trying: Inspect"); expect(summary).not.toContain("User reports trying: Enable");
  });
  test("agent claiming completion cannot overrule failed checks", async () => {
    const f = await fixture(async phase => phase === "plan" ? plan : { progress: "Done", action: { kind: "finish", reason: "I fixed it" } });
    const run = f.start(), result = await f.service.wait(run.id);
    expect(result.status).toBe("unresolved"); expect(result.verification).toBe("failed"); expect(result.actions).toHaveLength(0);
    expect(f.service.confirm(run.id).verification).toBe("user_reported");
  });
  test("already true checks cannot claim a successful repair", async () => {
    const f = await fixture(); f.controller.enabled = true;
    const result = await f.service.wait(f.start().id); expect(result.status).toBe("needs_user"); expect(result.actions).toHaveLength(0);
  });
  test("Stop cancels in-flight AI and ignores a late action response", async () => {
    const pending = deferred<any>(); let signal!: AbortSignal;
    const f = await fixture(async (phase, _data, _s, s) => { signal = s; return phase === "plan" ? plan : pending.promise; });
    const run = f.start(); await settle(); await f.service.stop(run.id);
    expect(signal.aborted).toBe(true); expect(f.controller.cancelled).toBe(true);
    pending.resolve(decision); const result = await f.service.wait(run.id);
    expect(result.status).toBe("stopped"); expect(f.controller.acts).toBe(0);
  });
  test("Stop during controller input records uncertain outcome and ignores late completion", async () => {
    const f = await fixture(), pending = deferred<{ performed: true }>(); f.controller.actGate = pending.promise;
    const run = f.start(); await settle(); expect(f.controller.acts).toBe(1);
    await f.service.stop(run.id); expect(f.service.get(run.id).actions[0].state).toBe("uncertain");
    pending.resolve({ performed: true }); expect((await f.service.wait(run.id)).status).toBe("stopped");
    expect(f.service.get(run.id).actions[0].state).toBe("uncertain");
  });
  test("rejects duplicate starts, stale windows, and expired incidents", async () => {
    const pending = deferred<any>(), f = await fixture(() => pending.promise);
    const run = f.start(); expect(() => f.start()).toThrow("already running");
    await f.service.stop(run.id); pending.resolve({ needs_user: "Stopped" }); await f.service.wait(run.id);
    f.advance(121_000); expect(() => f.start()).toThrow("Refresh");
    const [window] = await f.service.windows(); expect(() => f.service.start(f.incident.id, window.id)).toThrow("expired");
  });
  test("heartbeat lapse revokes pending AI work", async () => {
    const pending = deferred<any>(), f = await fixture(() => pending.promise);
    const run = f.start(); await settle(); f.advance(12_000); await settle();
    expect(f.service.get(run.id).status).toBe("stopped"); expect(f.controller.cancelled).toBe(true);
    pending.resolve(plan); await f.service.wait(run.id); expect(f.controller.acts).toBe(0);
  });
  test("heartbeat renewal and total duration limits are independent", async () => {
    const pending = deferred<any>(), f = await fixture(() => pending.promise, { duration: 20_000 });
    const run = f.start(); await settle(); f.advance(8000); f.service.heartbeat(run.id); f.advance(8000); f.service.heartbeat(run.id); f.advance(4000); await settle();
    expect(f.service.get(run.id).status).toBe("unresolved"); pending.resolve(plan); await f.service.wait(run.id);
  });
  test("focus or process loss during AI wait cancels without input", async () => {
    for (const code of ["focus_lost", "target_lost", "elevated", "inaccessible"]) {
      const pending = deferred<any>(), f = await fixture(() => pending.promise), run = f.start(); await settle();
      f.controller.failure = new ControllerError(code, code, false); f.advance(1000); await settle();
      expect(f.service.get(run.id).status).toBe("needs_user"); expect(f.controller.cancelled).toBe(true);
      pending.resolve(plan); await f.service.wait(run.id); expect(f.controller.acts).toBe(0);
    }
  });
  test("invalid actions and inaccessible controls never become genuine attempts", async () => {
    const f = await fixture(async phase => phase === "plan" ? plan : { progress: "Run shell", action: { kind: "script", script: "bad" } });
    const r = await f.service.wait(f.start().id); expect(r.status).toBe("needs_user"); expect(r.actions).toHaveLength(0); expect(f.controller.acts).toBe(0);
  });
  test("action budget ends an unsuccessful repair", async () => {
    const f = await fixture(undefined, { actionLimit: 2 }); f.controller.changed = false;
    const r = await f.service.wait(f.start().id); expect(r.status).toBe("unresolved"); expect(f.controller.acts).toBe(2);
  });
  test("rejects ticket handoff for an active or mismatched run", async () => {
    const pending = deferred<any>(), f = await fixture(() => pending.promise), run = f.start();
    expect(() => f.service.ticketSummary(f.incident.id, run.id)).toThrow("Stop");
    const other = f.store.create(evidence, help); expect(() => f.service.ticketSummary(other.id, run.id)).toThrow("belong");
    await f.service.stop(run.id); pending.resolve(plan); await f.service.wait(run.id);
  });
});
describe("action and verification policy", () => {
  test("verifies a changed editable name only through a unique stable ID and role", () => {
    const check = [{ name: "apples", role: "combobox", automationId: "input", property: "value" as const, equals: "oranges" }];
    const c = { ref: "e0", name: "oranges", role: "combobox", automationId: "input", value: "oranges", editable: true, enabled: true, actions: ["text"] };
    const o = { id: "fresh", title: "New Tab", truncated: false, controls: [c] };
    expect(evaluateChecks(check, o).passed).toBe(true);
    expect(evaluateChecks(check, { ...o, controls: [c, { ...c, ref: "e1" }] }).passed).toBe(false);
    expect(evaluateChecks(check, { ...o, truncated: true }).passed).toBe(false);
    expect(evaluateChecks([{ ...check[0], automationId: undefined }], o).passed).toBe(false);
    expect(evaluateChecks(check, { ...o, controls: [{ ...c, value: "apples" }] }).passed).toBe(false);
    expect(evaluateChecks(check, { ...o, controls: [{ ...c, editable: false }] }).passed).toBe(false);
    expect(evaluateChecks([{ ...check[0], property: "visible", equals: true }], o).passed).toBe(false);
  });
  test("rejects protected controls, executable text, missing refs and global shortcuts", async () => {
    const c = new FakeController(), o = await c.observe();
    for (const action of [{ kind: "keys", ref: "e0", key: "WIN+R" }, { kind: "activate", ref: "gone" }, { kind: "keys", ref: "e0", key: "CTRL+A" }]) expect(() => validateAction(action, o)).toThrow();
    o.controls[0].editable = true; o.controls[0].actions.push("text");
    for (const text of ["powershell -c bad", "javascript:alert(1)", "[REDACTED_PASSWORD]", "node app.js"]) expect(() => validateAction({ kind: "text", ref: "e0", text }, o)).toThrow();
    o.controls[0].name = "Delete account"; expect(() => validateAction(decision.action, o)).toThrow();
  });
  test("ambiguous, absent, truncated, or masked controls cannot verify success", async () => {
    const c = new FakeController(), o = await c.observe();
    expect(evaluateChecks(plan.checks as any, o).passed).toBe(false);
    o.controls.push({ ...o.controls[0] }); expect(evaluateChecks(plan.checks as any, o).available).toBe(false);
    expect(evaluateChecks([{ name: "Error", property: "visible", equals: false }], { ...o, controls: [], truncated: true }).passed).toBe(false);
    expect(() => validatePlan({ summary: "fixed", checks: [{ name: "Error", property: "visible", equals: false }] })).toThrow();
    expect(() => validatePlan({ summary: "fixed", checks: [{ name: "X", property: "checked", equals: "yes" }] })).toThrow();
    expect(() => parseObject("some text {} more text")).toThrow();
    o.controls[0].value = "api_key: sk-123456789012345678901234";
    expect(JSON.stringify(redactObservation(o))).not.toContain("sk-123");
    const truncated = { ...o, controls: [{ ...o.controls[0], value: "prefix", valueTruncated: true }] };
    expect(evaluateChecks([{ name: "Word wrap", property: "value", equals: "prefix" }], truncated).passed).toBe(false);
  });
  test("audit changes exclude anonymous or ambiguous controls", async () => {
    const c = new FakeController(), before = await c.observe(); c.enabled = true;
    const after = await c.observe();
    expect(observedChanges(before, after)).toContain("Word wrap: checked = true");
    before.controls.push({ ...before.controls[0], name: "", automationId: "", enabled: false });
    after.controls.push({ ...after.controls[0], name: "", automationId: "", enabled: true });
    expect(observedChanges(before, after)).not.toContain(": enabled");
  });
});
describe("repair diagnostics", () => {
  test("persists timings and failure stage without incident or credential payloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketpipe-log-test-"));
    try {
      const log = createRepairLogger(() => directory);
      log({ at: new Date(0).toISOString(), runId: "test-run", event: "finished", phase: "planning", elapsedMs: 42000, phaseElapsedMs: 40000, actionCount: 0, outcome: "needs_user", errorCode: "focus_lost", note: "private incident", key: "private key", observation: { value: "private value" } } as RepairDiagnostic);
      const raw = await Bun.file(join(directory, "automatic-fixes.jsonl")).text();
      expect(raw).not.toContain("private");
      expect(JSON.parse(raw)).toMatchObject({ phase: "planning", phaseElapsedMs: 40000, errorCode: "focus_lost" });
    } finally {
      if (!directory.startsWith(join(tmpdir(), "ticketpipe-log-test-"))) throw new Error("Unexpected log test directory");
      await rm(directory, { recursive: true, force: true });
    }
  });
});
describe("local control security and existing flows", () => {
  test("requires launch token, exact host and same origin", () => {
    const s = createApiSecurity(), url = "http://127.0.0.1:4242/api/fix/runs";
    const request = (headers: any) => new Request(url, { headers: { host: "127.0.0.1:4242", "x-ticketpipe-token": s.token, ...headers } });
    expect(() => s.authorize(request({}), 4242)).not.toThrow();
    for (const headers of [{ origin: "https://evil.example" }, { host: "evil.example:4242" }, { "x-ticketpipe-token": "" }, { "x-ticketpipe-token": "é".repeat(64) }]) expect(() => s.authorize(request(headers), 4242)).toThrow("not authorized");
  });
  test("HTTP routes reject unauthorized requests and serve nonce-protected sanitized UI", async () => {
    const server = startServer(0); const base = `http://127.0.0.1:${server.port}`;
    try {
      const root = await fetch(base), html = await root.text(), token = html.match(/name="ticketpipe-token" content="([a-f0-9]+)"/)![1];
      expect(root.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
      expect(html).toContain("DOMPurify.sanitize"); expect(html).toContain(`nonce="${token}"`);
      for (const path of ["/api/settings", "/api/fix/status", "/api/fix/windows", "/api/fix/runs/missing"]) expect((await fetch(base + path)).status).toBe(403);
      expect((await fetch(base + "/api/fix/permissions", { method: "POST" })).status).toBe(403);
      expect((await fetch(base + "/api/fix/permissions", { method: "POST", headers: { "x-ticketpipe-token": token, origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(base + "/api/settings", { headers: { "x-ticketpipe-token": token } })).status).toBe(200);
      expect((await fetch(base + "/api/fix/runs/missing/stop", { method: "POST", headers: { "x-ticketpipe-token": token, origin: "https://evil.example" } })).status).toBe(403);
      expect((await fetch(base + "/api/draft", { method: "POST", headers: { "x-ticketpipe-token": token, "content-type": "application/json" }, body: JSON.stringify({ minutes: -1 }) })).status).toBe(400);
    } finally { server.stop(true); }
  });
  test("manual quick fixes and escalation retain frozen context with factual attempted fixes", async () => {
    const previous = { ...config }; Object.assign(config, { demoMode: true, llmProvider: "mock" });
    try {
      const h = await createHelp({ note: "VPN failed" }); expect(h.incidentId).toBeTruthy(); expect(h.automation.available).toBe(false);
      const i = incidents.create(evidence, help); incidents.recordManual(i.id, [1]);
      config.demoMode = false; config.contextFile = "missing-file-must-not-be-read.json";
      const draft = await createDraft({ incidentId: i.id });
      expect(draft.contextSent).toContain("Original recorded error"); expect(draft.ticket.attempted_fixes).toEqual(["User reports trying: Inspect the document"]);
      expect(draft.body).toContain("Repair attempt record"); expect(draft.stats.from).toBe(evidence.stats.from);
    } finally { Object.assign(config, previous); }
  });
  test("AI adapter requires a real provider and honors request cancellation", async () => {
    expect(isRealAiConfigured({ provider: "mock", key: "x", model: "x", baseUrl: "" })).toBe(false);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async () => { await Bun.sleep(100); return Response.json({ choices: [{ message: { content: "{}" } }] }); } });
    const abort = new AbortController();
    try {
      const promise = callLlm("system", "user", { settings: { provider: "openai", key: "", model: "local-test", baseUrl: `http://127.0.0.1:${server.port}` }, signal: abort.signal });
      abort.abort(); await expect(promise).rejects.toThrow();
    } finally { server.stop(true); }
  });
  test("AI cancellation wins even when a transport returns a late response", async () => {
    const original = globalThis.fetch, late = deferred<Response>(), abort = new AbortController();
    globalThis.fetch = mock(() => late.promise) as unknown as typeof fetch;
    try {
      const promise = callLlm("system", "user", { settings: { provider: "openai", key: "", model: "test", baseUrl: "http://127.0.0.1" }, signal: abort.signal });
      abort.abort(new Error("Stopped")); await expect(promise).rejects.toThrow("Stopped");
      late.resolve(Response.json({ choices: [{ message: { content: "late action" } }] })); await settle();
    } finally { globalThis.fetch = original; }
  });
  test("reviewed tickets still save locally and publish the exact approved GitHub body", async () => {
    const previous = { ...config }, originalFetch = globalThis.fetch;
    const directory = await mkdtemp(join(tmpdir(), "ticketpipe-publish-test-"));
    try {
      Object.assign(config, { ticketsDir: directory, githubToken: "", githubRepo: "" });
      const saved = await publishIssue({ title: "Reviewed test", body: "Approved text", labels: ["it-ticket"] });
      expect(saved.dryRun).toBe(true); expect(await Bun.file(saved.url).text()).toContain("Approved text");
      Object.assign(config, { githubToken: "test-token", githubRepo: "test/issues" });
      let request: any;
      globalThis.fetch = mock(async (_url, init) => { request = JSON.parse(String(init?.body)); return Response.json({ html_url: "https://github.com/test/issues/issues/1", number: 1 }); }) as unknown as typeof fetch;
      const posted = await publishIssue({ title: "Reviewed", body: "Exact approved body", labels: ["it-ticket"] });
      expect(posted.dryRun).toBe(false); expect(request.body).toBe("Exact approved body");
    } finally { globalThis.fetch = originalFetch; Object.assign(config, previous); if (!directory.startsWith(join(tmpdir(), "ticketpipe-publish-test-"))) throw new Error("Unexpected temporary test directory"); await rm(directory, { recursive: true, force: true }); }
  });
});
