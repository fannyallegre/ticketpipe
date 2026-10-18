export type TargetWindow = { id: string; title: string; app: string };
export const CONTROLLER_PROTOCOL = 1;
export type DesktopPlatform = "windows" | "linux" | "macos";
export type ControllerStatus = { protocol: number; platform: DesktopPlatform; ready: boolean; permissions: "granted" | "required" | "unavailable"; reason: string; setup: boolean; session?: string; supportedActions: string[]; allowedKeys: string[] };
export type FixStatus = { available: boolean; reason: string; controller?: ControllerStatus; setup?: boolean };
export type Binding = { state: "ready" | "awaiting_focus" };
export type Control = { ref: string; name: string; role: string; automationId: string; enabled: boolean; editable: boolean; value?: string; valueTruncated?: boolean; checked?: boolean; selected?: boolean; actions: string[]; allowedKeys?: string[] };
export type Observation = { id: string; title: string; controls: Control[]; truncated: boolean; platform?: DesktopPlatform };
export type Action = { kind: "activate" | "select"; ref: string } | { kind: "text"; ref: string; text: string } | { kind: "keys"; ref: string; key: string } | { kind: "scroll"; ref: string; direction: "up" | "down" };
export type Check = { name: string; role?: string; automationId?: string; property: "visible" | "value" | "checked" | "selected" | "enabled"; equals: string | boolean };
export type Decision = { progress: string; action: Action | { kind: "finish" | "needs_user"; reason: string } };
export type RepairPlan = { summary: string; checks: Check[] };
export type Outcome = "running" | "verifying" | "verified_fixed" | "user_reported_fixed" | "unresolved" | "needs_user" | "stopped";
export type AttemptAction = { at: string; description: string; state: "pending" | "performed" | "rejected" | "uncertain"; observed?: string };
export type FixPhase = "connecting" | "awaiting_focus" | "observing" | "planning" | "deciding" | "acting" | "verifying" | "finished";
export type FixRun = { id: string; incidentId: string; window: TargetWindow; status: Outcome; progress: string; phase: FixPhase; phaseStartedAt: string; startedAt: string; finishedAt?: string; actions: AttemptAction[]; checks: Check[]; verification: "pending" | "passed" | "failed" | "unavailable" | "user_reported" };
export interface Controller {
  status?(signal?: AbortSignal): Promise<ControllerStatus>;
  permissions?(signal?: AbortSignal): Promise<ControllerStatus>;
  windows(signal?: AbortSignal): Promise<TargetWindow[]>;
  bind(id: string, signal: AbortSignal): Promise<Binding | void>;
  focus?(signal: AbortSignal): Promise<Binding>;
  guard(signal: AbortSignal): Promise<void>;
  observe(signal: AbortSignal): Promise<Observation>;
  act(observationId: string, action: Action, signal: AbortSignal): Promise<{ performed: true }>;
  cancel(): Promise<void>;
  close(): Promise<void>;
}
