import { AppError } from "./errors";
import type { Context } from "./context";
import type { Stats } from "./pipeline";
import type { Help } from "./ticket";

export type Evidence = { note: string; ctx: Context; contextSent: string; stats: Stats };
export type Incident = Evidence & { id: string; help: Help; createdAt: number; manualSteps: number[] };

/** Snapshots never escape by reference. Pinning protects an active run from expiry. */
export class IncidentStore {
  private entries = new Map<string, { value: Incident; pins: number }>();
  constructor(private now = Date.now, private ttl = 30 * 60_000) {}
  create(evidence: Evidence, help: Help): Incident {
    this.sweep();
    if (this.entries.size >= 100) throw new AppError("Too many incident snapshots. Close old incidents or restart TicketPipe.", 429);
    const value: Incident = structuredClone({ ...evidence, help, id: crypto.randomUUID(), createdAt: this.now(), manualSteps: [] });
    this.entries.set(value.id, { value, pins: 0 });
    return structuredClone(value);
  }
  get(id: string): Incident {
    const entry = this.entries.get(id);
    if (!entry || (!entry.pins && this.now() - entry.value.createdAt >= this.ttl)) {
      this.entries.delete(id);
      throw new AppError("This incident has expired. Generate a fresh quick-fix suggestion.", 410);
    }
    return structuredClone(entry.value);
  }
  pin(id: string) { this.get(id); this.entries.get(id)!.pins++; }
  unpin(id: string) { const e = this.entries.get(id); if (e) e.pins = Math.max(0, e.pins - 1); }
  recordManual(id: string, indexes: unknown): Incident {
    const current = this.get(id);
    if (!Array.isArray(indexes) || indexes.some(i => !Number.isInteger(i) || i < 0 || i >= current.help.steps.length)) throw new AppError("Invalid manually attempted steps.");
    const entry = this.entries.get(id)!;
    entry.value.manualSteps = [...new Set([...current.manualSteps, ...indexes])];
    return structuredClone(entry.value);
  }
  sweep() { for (const [id, e] of this.entries) if (!e.pins && this.now() - e.value.createdAt >= this.ttl) this.entries.delete(id); }
}
export const incidents = new IncidentStore();
