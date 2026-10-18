import { config } from "../config";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../errors";
import { IncidentStore, incidents, type Incident } from "../incidents";
import { callLlm, isRealAiConfigured, llmSettings, type LlmSettings } from "../llm";
import { redact } from "../redact";
import { ControllerError, NativeController, desktopPlatform, helperPath } from "./controller";
import type { Controller, FixPhase, FixRun, FixStatus, Observation, Outcome, RepairPlan, TargetWindow } from "./contracts";
import { writeRepairDiagnostic, type RepairDiagnostic } from "./diagnostics";
import { evaluateChecks, observedChanges, parseObject, redactObservation, validateAction, validatePlan } from "./policy";
import { PLAN_PROMPT, STEP_PROMPT } from "./prompts";

type Job = { run: FixRun; incident: Incident; settings: LlmSettings; controller: Controller; abort: AbortController; heartbeat: number; started: number; bound?: boolean; guarding?: boolean; task?: Promise<void> };
export type AgentCall = (phase: "plan" | "step", data: object, settings: LlmSettings, signal: AbortSignal) => Promise<any>;
const defaultAgent: AgentCall = async (phase, data, settings, signal) => parseObject(await callLlm(phase === "plan" ? PLAN_PROMPT : STEP_PROMPT, JSON.stringify(data), { settings, signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]), maxTokens: 1800 }));
export const isRunning = (status: Outcome) => status === "running" || status === "verifying";
const controllerCode = (error: unknown): string | undefined => error instanceof ControllerError && ["focus_lost", "activation_failed", "target_lost", "elevated", "inaccessible", "stale", "protected", "timeout", "controller_failed", "cancelled", "unavailable", "invalid", "unbound"].includes(error.code) ? error.code : undefined;

export class FixService {
  private jobs = new Map<string, Job>();
  private choices = new Map<string, { window: TargetWindow; at: number }>();
  private active?: string;
  private picker?: Controller;
  private selecting = false;
  private timer: ReturnType<typeof setInterval>;
  constructor(private options: { store?: IncidentStore; controller?: () => Controller; agent?: AgentCall; now?: () => number; available?: () => { available: boolean; reason: string }; duration?: number; lease?: number; actionLimit?: number; diagnostic?: (event: RepairDiagnostic) => void } = {}) {
    this.timer = setInterval(() => this.tick(), 1000); this.timer.unref();
  }
  private get store() { return this.options.store ?? incidents; }
  private now() { return (this.options.now ?? Date.now)(); }
  private controller() { return (this.options.controller ?? (() => new NativeController()))(); }
  availability() {
    if (this.options.available) return this.options.available();
    if (!desktopPlatform()) return { available: false, reason: "Automatic fixing supports Windows, macOS and GNOME Linux desktops." };
    if (config.demoMode || config.contextFile) return { available: false, reason: "Automatic fixing needs your live Screenpipe history, not a sample or replay." };
    if (!isRealAiConfigured()) return { available: false, reason: "Configure a real AI in Settings to enable automatic fixing." };
    try { if (!helperPath()) return { available: false, reason: "The native controller is missing. Install a complete TicketPipe build for this computer." }; }
    catch { return { available: false, reason: "The native controller could not be installed. Check your app installation." }; }
    return { available: true, reason: "Select one application window. You can stop the attempt at any time." };
  }
  async assessAvailability(): Promise<FixStatus> {
    const capability = this.availability();
    if (!capability.available && (this.options.available || !desktopPlatform())) return capability;
    const controller = this.controller();
    try {
      if (!controller.status) { if (capability.available) await controller.windows(); return capability; }
      const status = await controller.status();
      return { available: capability.available && status.ready, reason: status.ready ? capability.reason : status.reason, controller: status, setup: status.setup };
    }
    catch (error) { return { available: false, reason: error instanceof Error ? error.message : "The native controller is not responding. Check the app installation." }; }
    finally { await controller.close(); }
  }
  async permissions(): Promise<FixStatus> {
    if (this.active) throw new AppError("Stop the current attempt before changing accessibility setup.", 409);
    const controller = this.controller();
    try {
      if (!controller.permissions) throw new AppError("No accessibility setup is required on this platform.", 409);
      await controller.permissions();
    } finally { await controller.close(); }
    return this.assessAvailability();
  }
  async windows(): Promise<TargetWindow[]> {
    const capability = this.availability(); if (!capability.available) throw new AppError(capability.reason, 409);
    if (this.active || this.selecting) throw new AppError("Wait for window selection or stop the current attempt first.", 409);
    this.selecting = true;
    const previous = this.picker; this.picker = undefined; this.choices.clear();
    let controller: Controller | undefined;
    try {
      await previous?.close(); controller = this.controller();
      const list = await controller.windows();
      this.picker = controller;
      this.choices.clear();
      return list.map(window => { const id = crypto.randomUUID(); this.choices.set(id, { window, at: this.now() }); return { ...window, id }; });
    } catch (error) { await controller?.close(); throw error; }
    finally { this.selecting = false; }
  }
  start(incidentId: string, windowId: string, manualSteps: unknown = []): FixRun {
    const capability = this.availability(); if (!capability.available) throw new AppError(capability.reason, 409);
    if (this.active) throw new AppError("Another repair is already running. Stop it first.", 409);
    if (this.selecting) throw new AppError("Window selection is in progress. Wait for it to finish.", 409);
    const selected = this.choices.get(windowId);
    if (!selected || this.now() - selected.at > 120_000) throw new AppError("Refresh the window list and select the target again.", 409);
    let incident = this.store.get(incidentId);
    if (!incident.help.solvable) throw new AppError("This suggestion requires IT or a manual intervention.", 409);
    incident = this.store.recordManual(incidentId, manualSteps);
    this.store.pin(incidentId);
    const id = crypto.randomUUID();
    const startedAt = new Date(this.now()).toISOString();
    const run: FixRun = { id, incidentId, window: { ...selected.window, title: redact(selected.window.title).text, id: windowId }, status: "running", progress: "Connecting to the selected application…", phase: "connecting", phaseStartedAt: startedAt, startedAt, actions: [], checks: [], verification: "pending" };
    const job: Job = { run, incident, settings: llmSettings(), controller: this.picker ?? this.controller(), abort: new AbortController(), heartbeat: this.now(), started: this.now() };
    this.picker = undefined; this.choices.clear();
    this.jobs.set(id, job); this.active = id;
    this.diagnostic(job, "started");
    // Never let an HTTP response wait for model inference or UI Automation.
    job.task = Promise.resolve().then(() => this.execute(job, selected.window.id));
    return structuredClone(run);
  }
  get(id: string): FixRun { const job = this.jobs.get(id); if (!job) throw new AppError("Repair attempt not found.", 404); return structuredClone(job.run); }
  heartbeat(id: string) { const job = this.job(id); if (isRunning(job.run.status)) job.heartbeat = this.now(); return this.get(id); }
  private job(id: string) { const job = this.jobs.get(id); if (!job) throw new AppError("Repair attempt not found.", 404); return job; }
  private live(job: Job) { job.abort.signal.throwIfAborted(); if (!isRunning(job.run.status) || this.active !== job.run.id) throw new Error("Repair attempt cancelled."); }
  private diagnostic(job: Job, event: RepairDiagnostic["event"], fields: Partial<Pick<RepairDiagnostic, "controlCount" | "truncated" | "actionKind" | "outcome" | "errorCode">> = {}) {
    const now = this.now();
    try { (this.options.diagnostic ?? writeRepairDiagnostic)({ at: new Date(now).toISOString(), runId: job.run.id, event, phase: job.run.phase, elapsedMs: now - job.started, phaseElapsedMs: now - Date.parse(job.run.phaseStartedAt), actionCount: job.run.actions.length, ...fields }); }
    catch { /* Diagnostics must never interrupt cancellation or a repair. */ }
  }
  private phase(job: Job, phase: FixPhase, progress: string) {
    this.live(job);
    job.run.phase = phase; job.run.phaseStartedAt = new Date(this.now()).toISOString(); job.run.progress = progress;
    this.diagnostic(job, "phase");
  }
  async stop(id: string, reason = "Stopped by you.", outcome: Outcome = "stopped", failure?: unknown) {
    const job = this.job(id);
    if (!isRunning(job.run.status)) return this.get(id);
    this.diagnostic(job, "finished", { outcome, errorCode: controllerCode(failure) ?? "cancelled" });
    job.run.status = outcome; job.run.progress = reason; job.run.finishedAt = new Date(this.now()).toISOString();
    job.run.phase = "finished"; job.run.phaseStartedAt = job.run.finishedAt;
    for (const action of job.run.actions) if (action.state === "pending") { action.state = "uncertain"; action.observed = "Stopped before the controller acknowledged an outcome."; }
    job.abort.abort(new Error(reason));
    // The input gate is revoked before Stop is acknowledged. Kill an unresponsive helper.
    await job.controller.cancel();
    if (this.active === id) this.active = undefined;
    return this.get(id);
  }
  confirm(id: string) {
    const job = this.job(id);
    if (isRunning(job.run.status) || job.run.status === "verified_fixed") throw new AppError("Only a completed unverified attempt can be confirmed.", 409);
    job.run.status = "user_reported_fixed"; job.run.verification = "user_reported"; job.run.progress = "You confirmed that the problem is fixed. This was not independently verified.";
    return this.get(id);
  }
  tick() {
    const job = this.active ? this.jobs.get(this.active) : undefined;
    if (job && isRunning(job.run.status)) {
      if (this.now() - job.heartbeat >= (this.options.lease ?? 12_000)) void this.stop(job.run.id, "The controlling window disconnected. Start a new attempt when ready.");
      else if (this.now() - job.started >= (this.options.duration ?? 180_000)) void this.stop(job.run.id, "The three-minute repair time limit was reached.", "unresolved");
      else if (job.bound && !job.guarding) {
        job.guarding = true;
        void job.controller.guard(job.abort.signal).catch(error => {
          if (isRunning(job.run.status)) return this.stop(job.run.id, error instanceof Error ? error.message : "The selected application is unavailable.", "needs_user", error);
        }).finally(() => { job.guarding = false; });
      }
    }
    this.store.sweep();
    if (this.picker && [...this.choices.values()].every(c => this.now() - c.at > 120_000)) { void this.picker.close(); this.picker = undefined; this.choices.clear(); }
    for (const [id, j] of this.jobs) if (!isRunning(j.run.status) && this.now() - j.started > 30 * 60_000) this.jobs.delete(id);
  }
  async shutdown() { clearInterval(this.timer); await this.picker?.close(); this.picker = undefined; if (this.active) await this.stop(this.active, "TicketPipe is closing."); }
  async wait(id: string) { await this.job(id).task; return this.get(id); }
  private context(job: Job, observation: Observation, plan?: RepairPlan) {
    return { problem: job.incident.note, evidence: job.incident.contextSent, capture: job.incident.stats, snapshotCreatedAt: new Date(job.incident.createdAt).toISOString(), suggestedFix: job.incident.help, manuallyAttempted: job.incident.manualSteps.map(i => job.incident.help.steps[i]), selectedWindow: { title: job.run.window.title, app: job.run.window.app }, live: observation, ...(plan ? { successCriteria: plan, performedActions: job.run.actions } : {}) };
  }
  private async observe(job: Job) {
    this.phase(job, "observing", "Reading the selected application's controls…");
    const raw = await job.controller.observe(job.abort.signal); this.live(job);
    this.diagnostic(job, "observation", { controlCount: raw.controls.length, truncated: raw.truncated });
    const o = redactObservation(raw); if (!o.controls.length) throw new AppError("This app did not expose readable controls. Please perform the fix manually."); return o;
  }
  private async execute(job: Job, nativeId: string) {
    const run = job.run;
    const finish = (status: Outcome, progress: string, errorCode?: string) => {
      this.live(job); this.diagnostic(job, "finished", { outcome: status, errorCode });
      run.status = status; run.progress = redact(progress).text; run.finishedAt = new Date(this.now()).toISOString();
      run.phase = "finished"; run.phaseStartedAt = run.finishedAt;
    };
    try {
      this.live(job); const binding = await job.controller.bind(nativeId, job.abort.signal); this.live(job);
      if (binding?.state === "awaiting_focus") {
        if (!job.controller.focus) throw new ControllerError("This controller cannot establish selected-window focus.", "inaccessible", false);
        this.phase(job, "awaiting_focus", "Bring the selected application window forward within 15 seconds. Stop remains available.");
        const deadline = this.now() + 15_000;
        while (true) {
          this.live(job);
          if (this.now() >= deadline) throw new ControllerError("The selected window was not brought forward within 15 seconds. Start a new attempt when ready.", "activation_failed", false);
          const focus = await job.controller.focus(job.abort.signal); this.live(job);
          if (this.now() >= deadline) throw new ControllerError("The selected window was not brought forward within 15 seconds. Start a new attempt when ready.", "activation_failed", false);
          if (focus.state === "ready") break;
          await delay(150, undefined, { signal: job.abort.signal });
        }
      }
      job.bound = true;
      let observation = await this.observe(job);
      this.phase(job, "planning", "Waiting for the AI to choose a safe first action and success checks…");
      const response = await (this.options.agent ?? defaultAgent)("plan", this.context(job, observation), job.settings, job.abort.signal); this.live(job);
      this.diagnostic(job, "ai_result");
      if (typeof response?.needs_user === "string") { run.verification = "unavailable"; finish("needs_user", response.needs_user); return; }
      const plan = validatePlan(response); run.checks = plan.checks; run.progress = plan.summary;
      // Initial checks establish a baseline, never claim a repair from already-true trivia.
      if (evaluateChecks(plan.checks, observation).passed) { run.verification = "unavailable"; finish("needs_user", "The proposed checks already pass before any repair. Please confirm whether the reported problem still exists."); return; }
      // A planner can provide the first action using this same observation. The native
      // boundary still re-resolves its exact element and fingerprint before any input.
      let firstDecision = response.action === undefined ? undefined : { progress: plan.summary, action: response.action };
      while (true) {
        this.live(job);
        if (!firstDecision) observation = await this.observe(job);
        this.phase(job, "verifying", "Checking the requested result…");
        run.status = "verifying";
        const check = evaluateChecks(plan.checks, observation);
        run.verification = check.passed ? "passed" : check.available ? "failed" : "unavailable";
        if (run.actions.some(a => a.state === "performed") && check.passed) { finish("verified_fixed", "The application passed the independent success checks."); return; }
        if (run.actions.length >= (this.options.actionLimit ?? 20)) { finish("unresolved", "The 20-action repair limit was reached. You can include the attempt in a ticket."); return; }
        run.status = "running";
        let decision;
        if (firstDecision) { decision = firstDecision; firstDecision = undefined; }
        else {
          this.phase(job, "deciding", "Waiting for the AI to choose the next action…");
          decision = await (this.options.agent ?? defaultAgent)("step", this.context(job, observation, plan), job.settings, job.abort.signal); this.live(job);
          this.diagnostic(job, "ai_result");
        }
        if (typeof decision?.progress !== "string" || !decision.action) throw new AppError("The AI returned an invalid repair instruction.");
        run.progress = redact(decision.progress.slice(0, 500)).text;
        if (["finish", "needs_user"].includes(decision.action.kind)) {
          const fresh = await this.observe(job), verified = evaluateChecks(plan.checks, fresh);
          run.verification = verified.passed ? "passed" : verified.available ? "failed" : "unavailable";
          if (verified.passed && run.actions.some(a => a.state === "performed")) finish("verified_fixed", "The application passed the independent success checks.");
          else finish(decision.action.kind === "needs_user" || !verified.available ? "needs_user" : "unresolved", String(decision.action.reason || "The requested result could not be confirmed."));
          return;
        }
        const { action, description } = validateAction(decision.action, observation);
        this.phase(job, "acting", run.progress);
        const entry = { at: new Date(this.now()).toISOString(), description, state: "pending" as const };
        run.actions.push(entry);
        const logged = run.actions.at(-1)!;
        try {
          this.live(job);
          await job.controller.act(observation.id, action, job.abort.signal);
          this.live(job); logged.state = "performed";
          this.diagnostic(job, "action", { actionKind: action.kind });
        } catch (error) {
          logged.state = error instanceof ControllerError && error.performed === false ? "rejected" : "uncertain";
          logged.observed = redact(error instanceof Error ? error.message : "The action outcome is uncertain.").text;
          throw error;
        }
        // UIA acknowledgements can precede the application's accessibility update.
        await delay(200, undefined, { signal: job.abort.signal });
        const after = await this.observe(job);
        logged.observed = observedChanges(observation, after);
      }
    } catch (error) {
      if (!job.abort.signal.aborted && isRunning(run.status)) {
        const code = controllerCode(error) ?? (run.phase === "planning" || run.phase === "deciding" ? "ai_failed" : "repair_failed");
        finish("needs_user", error instanceof Error ? error.message : "Automatic fixing could not continue.", code);
      }
    } finally {
      await job.controller.close();
      this.store.unpin(run.incidentId);
      if (this.active === run.id) this.active = undefined;
    }
  }
  ticketSummary(incidentId: string, runId?: string): string {
    const incident = this.store.get(incidentId);
    const manual = incident.manualSteps.map(i => `- User reports trying: ${incident.help.steps[i]}`);
    let automatic: string[] = [];
    if (runId) {
      const run = this.get(runId);
      if (run.incidentId !== incidentId) throw new AppError("The repair does not belong to this incident.");
      if (isRunning(run.status)) throw new AppError("Stop the repair before creating its ticket.", 409);
      automatic = [`Outcome: ${run.status.replaceAll("_", " ")}. Verification: ${run.verification}.`, run.progress, ...run.actions.map(a => `- ${a.at}: ${a.description} — ${a.state}${a.observed ? `. Observed: ${a.observed}` : ""}`)];
    }
    return redact([...manual, ...automatic].join("\n")).text;
  }
}
export const fixes = new FixService();
