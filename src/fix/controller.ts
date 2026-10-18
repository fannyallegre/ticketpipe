import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { appDataDir } from "../config";
import { embeddedHelper, bundledHelper } from "./helper-asset";
import { CONTROLLER_PROTOCOL, type Action, type Binding, type Controller, type ControllerStatus, type DesktopPlatform, type Observation, type TargetWindow } from "./contracts";
import { platformKeys } from "./policy";

export const desktopPlatform = (): DesktopPlatform | undefined => ({ win32: "windows", linux: "linux", darwin: "macos" } as const)[process.platform as "win32" | "linux" | "darwin"];
export function validateStatus(value: any, expected = desktopPlatform()): ControllerStatus {
  const actions = ["activate", "text", "select", "scroll", "keys"];
  if (!expected || value?.protocol !== CONTROLLER_PROTOCOL || value.platform !== expected || typeof value.ready !== "boolean" || !["granted", "required", "unavailable"].includes(value.permissions) || typeof value.reason !== "string" || typeof value.setup !== "boolean" || !Array.isArray(value.supportedActions) || !value.supportedActions.every((a: unknown) => typeof a === "string" && actions.includes(a)) || !Array.isArray(value.allowedKeys) || !value.allowedKeys.every((k: unknown) => typeof k === "string" && platformKeys(expected).includes(k)) || (value.session?.includes("wayland") && value.allowedKeys.length) || (value.ready && value.permissions !== "granted")) throw new ControllerError("The native controller is incompatible. Reinstall this version of TicketPipe.", "incompatible", false);
  return value;
}

export class ControllerError extends Error {
  constructor(message: string, public code = "controller_failed", public performed: boolean | null = null) { super(message); }
}

export function helperPath(): string | null {
  const platform = desktopPlatform();
  if (!platform) return null;
  const name = "ticketpipe-controller" + (platform === "windows" ? ".exe" : "");
  if (bundledHelper) {
    const candidate = resolve(dirname(process.execPath), "../Helpers", name);
    return existsSync(candidate) && lstatSync(candidate).isFile() ? candidate : null;
  }
  if (embeddedHelper) {
    const bytes = readFileSync(embeddedHelper);
    const hash = createHash("sha256").update(bytes).digest("hex");
    const directory = join(appDataDir(), "native", hash);
    const destination = join(directory, name);
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) throw new Error("Invalid native directory");
    if (!existsSync(destination) || createHash("sha256").update(readFileSync(destination)).digest("hex") !== hash) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const staging = destination + "." + crypto.randomUUID() + ".tmp";
      writeFileSync(staging, bytes, { mode: 0o700, flag: "wx" }); renameSync(staging, destination);
    }
    if (!lstatSync(destination).isFile() || lstatSync(destination).isSymbolicLink()) throw new Error("Invalid native executable");
    if (platform !== "windows") {
      chmodSync(directory, 0o700); chmodSync(destination, 0o700);
      for (const path of [directory, destination]) {
        const stat = lstatSync(path);
        if ((stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.()) throw new ControllerError("The native controller needs a private folder on a Linux filesystem that supports owner-only permissions. Use your normal desktop configuration folder.", "unavailable", false);
      }
    }
    return destination;
  }
  const candidate = resolve(import.meta.dir, `../../native/${platform}/target/release/${name}`);
  return existsSync(candidate) ? candidate : null;
}

/** Private child process; it receives no AI, Screenpipe, or GitHub credentials. */
export class NativeController implements Controller {
  private handshake?: Promise<ControllerStatus>;
  private capabilities?: ControllerStatus;
  private process?: ReturnType<typeof Bun.spawn>;
  private sequence = 0;
  private closed = false;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  constructor(private executable?: string | null) {}
  private launch() {
    if (this.closed) throw new ControllerError("The desktop controller was stopped.", "cancelled", false);
    if (this.process) return;
    if (this.executable === undefined) {
      try { this.executable = helperPath(); }
      catch (error) { if (error instanceof ControllerError) throw error; throw new ControllerError("The native controller could not be extracted. Check your app installation and folder permissions.", "unavailable", false); }
    }
    if (!this.executable) throw new ControllerError("The native controller is missing. Install a complete TicketPipe build for this computer.", "unavailable", false);
    const environment: Record<string, string> = {};
    // Native libraries need standard Windows environment paths, never the parent's service keys.
    for (const key of ["SystemRoot", "WINDIR", "TEMP", "TMP", "PATH", "USERPROFILE", "LOCALAPPDATA", "HOME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS", "DISPLAY", "XAUTHORITY", "WAYLAND_DISPLAY", "XDG_SESSION_TYPE", "XDG_CURRENT_DESKTOP", "XDG_SESSION_DESKTOP", "LANG"]) if (process.env[key]) environment[key] = process.env[key]!;
    const child = Bun.spawn([this.executable], { stdin: "pipe", stdout: "pipe", stderr: "ignore", windowsHide: true, env: environment });
    this.process = child;
    void this.read(child.stdout as ReadableStream<Uint8Array>);
    void child.exited.then(() => this.terminate(new ControllerError("The desktop controller closed. Any unacknowledged action is uncertain.")));
  }
  private async read(stream: ReadableStream<Uint8Array>) {
    let buffer = "";
    try {
      const reader = stream.getReader(), decoder = new TextDecoder();
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        if (buffer.length > 2_000_000) throw new Error("Invalid controller response size");
        let end;
        while ((end = buffer.indexOf("\n")) >= 0) {
          const message = JSON.parse(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
          const waiter = this.pending.get(message.id);
          if (!waiter) continue;
          this.pending.delete(message.id); clearTimeout(waiter.timer);
          if (message.ok === true) waiter.resolve(message.result);
          else waiter.reject(new ControllerError(message.error?.message || "Controller request failed.", message.error?.code, message.error?.performed ?? null));
        }
      }
    } catch { this.terminate(new ControllerError("The desktop controller did not return a valid response.")); }
  }
  private request<T>(op: string, args: unknown = {}, signal?: AbortSignal, timeout = 12_000): Promise<T> {
    signal?.throwIfAborted(); this.launch();
    const id = ++this.sequence;
    return new Promise<T>((resolvePromise, reject) => {
      const abort = () => this.terminate(new ControllerError("Automatic control was cancelled.", "cancelled"));
      const finish = <F extends (v: any) => void>(fn: F) => (v: any) => { signal?.removeEventListener("abort", abort); fn(v); };
      const timer = setTimeout(() => this.terminate(new ControllerError("The application took too long to respond. Automatic control was stopped.", "timeout")), timeout);
      this.pending.set(id, { resolve: finish(resolvePromise), reject: finish(reject), timer });
      signal?.addEventListener("abort", abort, { once: true });
      try { const stdin = this.process!.stdin as { write(data: string): unknown; flush(): unknown }; stdin.write(JSON.stringify({ id, op, args }) + "\n"); stdin.flush(); }
      catch { this.terminate(new ControllerError("Could not communicate with the desktop controller.")); }
    });
  }
  private terminate(reason: Error) {
    this.closed = true;
    try { this.process?.kill(); } catch {}
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(reason); }
    this.pending.clear();
  }
  async status(signal?: AbortSignal) {
    let value;
    try { value = await this.request("status", { protocol: CONTROLLER_PROTOCOL }, signal); }
    catch (error) { if (error instanceof ControllerError && error.code === "invalid") throw new ControllerError("The native controller is incompatible. Install a complete matching TicketPipe build.", "incompatible", false); throw error; }
    const status = validateStatus(value); this.capabilities = status; return status;
  }
  async permissions(signal?: AbortSignal) { const status = validateStatus(await this.request("permissions", { protocol: CONTROLLER_PROTOCOL }, signal)); this.capabilities = status; return status; }
  private async ready(signal?: AbortSignal) {
    const status = await (this.handshake ??= this.status(signal));
    if (!status.ready) throw new ControllerError(status.reason, "permissions", false);
    return status;
  }
  async windows(signal?: AbortSignal) { await this.ready(signal); return this.request<TargetWindow[]>("windows", {}, signal); }
  private binding(value: any): Binding { if (!value || !["ready", "awaiting_focus"].includes(value.state)) throw new ControllerError("Invalid controller focus response.", "invalid", false); return value; }
  async bind(id: string, signal: AbortSignal) { await this.ready(signal); return this.binding(await this.request("bind", { id }, signal)); }
  async focus(signal: AbortSignal) { return this.binding(await this.request("focus", {}, signal, 2500)); }
  async guard(signal: AbortSignal) { await this.request("guard", {}, signal); }
  async observe(signal: AbortSignal) {
    const raw = await this.request<Observation>("observe", {}, signal);
    const status = this.capabilities!;
    if (!raw || typeof raw.id !== "string" || typeof raw.title !== "string" || typeof raw.truncated !== "boolean" || !Array.isArray(raw.controls) || raw.controls.length > 500) throw new ControllerError("Invalid native observation.", "invalid", false);
    for (const c of raw.controls) {
      if (typeof c.ref !== "string" || typeof c.name !== "string" || typeof c.role !== "string" || typeof c.automationId !== "string" || typeof c.enabled !== "boolean" || typeof c.editable !== "boolean" || !Array.isArray(c.actions) || !c.actions.every(a => status.supportedActions.includes(a))) throw new ControllerError("Invalid native control capabilities.", "invalid", false);
      c.allowedKeys = c.actions.includes("keys") ? (c.allowedKeys ?? status.allowedKeys).filter(k => status.allowedKeys.includes(k)) : [];
    }
    if (new Set(raw.controls.map(c => c.ref)).size !== raw.controls.length) throw new ControllerError("The application exposed ambiguous control references.", "invalid", false);
    return { ...raw, platform: status.platform };
  }
  async act(observationId: string, action: Action, signal: AbortSignal): Promise<{ performed: true }> { const result = await this.request<any>("act", { observationId, action }, signal); if (result?.performed !== true) throw new ControllerError("The native action was not acknowledged. Its outcome is uncertain."); return { performed: true }; }
  async cancel() {
    if (!this.closed && this.process) { try { await this.request("cancel", {}, undefined, 500); } catch {} }
    this.terminate(new ControllerError("Automatic control was stopped.", "cancelled"));
  }
  async close() { this.terminate(new ControllerError("The desktop controller closed.", "cancelled")); }
}
// Retained for existing Windows development harnesses.
export { NativeController as WindowsController };
