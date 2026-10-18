import { AppError } from "../errors";
import { redact } from "../redact";
import type { Action, Check, Control, DesktopPlatform, Observation, RepairPlan } from "./contracts";

export const KEYS = ["ENTER", "TAB", "ESC", "SPACE", "UP", "DOWN", "LEFT", "RIGHT", "HOME", "END", "PAGEUP", "PAGEDOWN", "CTRL+A", "CTRL+F", "CTRL+S", "CTRL+R", "F5", "BACKSPACE"] as const;
export const MAC_KEYS = [...KEYS.filter(k => !k.startsWith("CTRL+") && k !== "F5"), "CMD+A", "CMD+F", "CMD+S", "CMD+R"];
export const platformKeys = (platform?: DesktopPlatform): readonly string[] => platform === "macos" ? MAC_KEYS : KEYS;
const dangerous = /\b(delete|erase|format|uninstall|shutdown|shut down|restart computer|reboot|discard|remove account|reset all|factory reset|send|publish|payment|purchase|buy|install|run|execute|debug|evaluate|macro|security|privacy|permission|sign in|log in|api key|token|type a message|administrator|password|credential|terminal|console|powershell|command prompt|supprimer|effacer|désinstaller|envoyer|administrateur|contraseña|eliminar|borrar|desinstalar|enviar)\b/i;
const code = /(?:javascript:|data:|file:|\[REDACTED_|\.(?:exe|bat|cmd|ps1|vbs)\b|\b(?:powershell|pwsh|Invoke-Expression|Start-Process|shell:|ms-settings:|eval\s*\(|exec\s*\(|subprocess\.|process\.)|(?:^|\n)\s*(?:curl|wget|rm|del|reg|schtasks|shutdown|npm|npx|bun|python|node)\s|<script\b)/i;

export function redactObservation(o: Observation): Observation {
  return { ...o, title: redact(o.title).text, controls: o.controls.map(c => ({ ...c, name: redact(c.name).text, automationId: redact(c.automationId).text, ...(c.value === undefined ? {} : { value: redact(c.value).text }) })) };
}

export function parseObject(raw: string): any {
  const match = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { const parsed = JSON.parse(match); if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed; } catch {}
  throw new AppError("The AI returned an invalid repair instruction. No action was taken.");
}

export function validatePlan(value: any): RepairPlan {
  if (typeof value?.summary !== "string" || !value.summary.trim() || !Array.isArray(value.checks) || !value.checks.length || value.checks.length > 5) throw new AppError("The AI could not define observable success checks.");
  for (const c of value.checks) {
    if (!c || typeof c.name !== "string" || !c.name.trim() || c.name.length > 400 || !["visible", "value", "checked", "selected", "enabled"].includes(c.property) || (c.role !== undefined && typeof c.role !== "string") || (c.automationId !== undefined && typeof c.automationId !== "string")) throw new AppError("Invalid success check.");
    if (c.property === "value" ? typeof c.equals !== "string" || c.equals.length > 1000 : typeof c.equals !== "boolean") throw new AppError("Invalid success check value.");
  }
  if (!value.checks.some((c: Check) => c.property !== "visible" || c.equals === true)) throw new AppError("The disappearance of an error alone cannot prove the problem was fixed.");
  return { summary: redact(value.summary.slice(0, 500)).text, checks: value.checks.map((c: Check) => ({ name: c.name, property: c.property, equals: c.equals, ...(c.role ? { role: c.role } : {}), ...(c.automationId ? { automationId: c.automationId } : {}) })) };
}

export function evaluateChecks(checks: Check[], observation: Observation): { passed: boolean; available: boolean; details: string } {
  if (!checks.length) return { passed: false, available: false, details: "No success criteria were established." };
  let available = true;
  const results = checks.map(check => {
    const matches = matchCheckControls(check, observation);
    if (check.property === "visible" && check.equals === false && !matches.length && !observation.truncated) return true;
    if (matches.length !== 1) { available = false; return false; }
    if (check.property === "visible") return check.equals === true;
    const actual = matches[0][check.property];
    if (actual === undefined || (check.property === "value" && (matches[0].valueTruncated || String(actual).includes("[REDACTED_")))) { available = false; return false; }
    return actual === check.equals;
  });
  return { passed: available && results.every(Boolean), available, details: results.map((passed, i) => `${checks[i].name}: ${passed ? "passed" : "not confirmed"}`).join("; ") };
}

function matchCheckControls(check: Check, observation: Observation): Control[] {
  const identified = observation.controls.filter(c => (!check.role || check.role === c.role) && (!check.automationId || check.automationId === c.automationId));
  // Value-derived names (e.g. Chrome's new-tab search box) change after text entry.
  // Only a unique automation ID AND role can replace the name as identity.
  if (check.property === "value" && check.automationId && check.role && identified.length === 1 && identified[0].editable && !observation.truncated) return identified;
  return identified.filter(c => c.name === check.name);
}

export function validateAction(value: any, observation: Observation): { action: Action; control: Control; description: string } {
  if (!value || !["activate", "select", "text", "keys", "scroll"].includes(value.kind) || typeof value.ref !== "string") throw new AppError("Unsupported repair action.");
  const control = observation.controls.find(c => c.ref === value.ref);
  if (!control || !control.enabled || !control.actions.includes(value.kind)) throw new AppError("The requested control is unavailable or does not support this action.");
  if (dangerous.test(`${control.name} ${control.automationId} ${observation.title}`)) throw new AppError("This action needs your intervention. Automatic control was stopped.");
  let action: Action;
  if (value.kind === "text") {
    if (!control.editable || typeof value.text !== "string" || value.text.length > 2000 || code.test(value.text)) throw new AppError("Text entry is unsupported, protected, or contains a command or masked value.");
    action = { kind: "text", ref: value.ref, text: value.text };
  } else if (value.kind === "keys") {
    if (!platformKeys(observation.platform).includes(value.key) || !(control.allowedKeys ?? (observation.platform === "linux" ? [] : platformKeys(observation.platform))).includes(value.key) || (["BACKSPACE", "CTRL+A", "CMD+A"].includes(value.key) && !control.editable)) throw new AppError("This key combination is not allowed on this control.");
    action = { kind: "keys", ref: value.ref, key: value.key };
  } else if (value.kind === "scroll") {
    if (!["up", "down"].includes(value.direction)) throw new AppError("Invalid scroll direction.");
    action = { kind: "scroll", ref: value.ref, direction: value.direction };
  } else action = { kind: value.kind, ref: value.ref };
  // Do not include typed values in the audit trail.
  return { action, control, description: redact(`${value.kind === "text" ? "Enter text in" : value.kind === "keys" ? `Press ${value.key} on` : value.kind === "scroll" ? `Scroll ${value.direction} in` : value.kind === "select" ? "Select" : "Activate"} ${control.role} “${control.name || control.automationId}”`).text };
}

export function observedChanges(before: Observation, after: Observation): string {
  const changes: string[] = [];
  for (const c of after.controls) {
    if (!c.name && !c.automationId) continue;
    const matches = before.controls.filter(p => p.role === c.role && p.name === c.name && p.automationId === c.automationId);
    if (matches.length > 1) continue;
    const old = matches[0];
    if (!old) { if (c.name) changes.push(`Appeared: ${c.name}`); }
    else for (const key of ["value", "checked", "selected", "enabled"] as const) if (old[key] !== c[key] && c[key] !== undefined) changes.push(`${c.name || c.automationId}: ${key} = ${c[key]}`);
  }
  return redact(changes.slice(0, 6).join("; ").slice(0, 1200) || "Action acknowledged; no accessible state change was observed.").text;
}
