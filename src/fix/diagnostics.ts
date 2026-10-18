import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { appDataDir } from "../config";
import type { Action, FixPhase, Outcome } from "./contracts";

export type RepairDiagnostic = {
  at: string; runId: string; event: "started" | "phase" | "observation" | "ai_result" | "action" | "finished";
  phase: FixPhase; elapsedMs: number; phaseElapsedMs: number; actionCount: number;
  controlCount?: number; truncated?: boolean; actionKind?: Action["kind"]; outcome?: Outcome; errorCode?: string;
};

/** Timing and counters only: never persist incident text, control values, prompts, or credentials. */
export function createRepairLogger(directory: () => string = () => join(appDataDir(), "logs")) {
  return (event: RepairDiagnostic) => {
    const folder = directory(), path = join(folder, "automatic-fixes.jsonl");
    mkdirSync(folder, { recursive: true });
    if (existsSync(path) && statSync(path).size >= 256_000) {
      rmSync(path + ".previous", { force: true });
      renameSync(path, path + ".previous");
    }
    // Explicit projection prevents a caller from accidentally logging an entire job or AI response.
    const { at, runId, event: kind, phase, elapsedMs, phaseElapsedMs, actionCount, controlCount, truncated, actionKind, outcome, errorCode } = event;
    appendFileSync(path, JSON.stringify({ at, runId, event: kind, phase, elapsedMs, phaseElapsedMs, actionCount, controlCount, truncated, actionKind, outcome, errorCode }) + "\n", { mode: 0o600 });
  };
}

export const writeRepairDiagnostic = createRepairLogger();
