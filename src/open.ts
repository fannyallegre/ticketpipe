// Open a URL or folder with the system's default app (browser, file manager).
import { join } from "node:path";

export function openExternal(target: string) {
  const cmd =
    process.platform === "darwin"
      ? ["open", target]
      : process.platform === "win32"
        ? [join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", target]
        : ["xdg-open", target];
  try {
    Bun.spawn(cmd, { stdio: ["ignore", "ignore", "ignore"], detached: true, windowsHide: true }).unref();
    return true;
  } catch {
    return false;
  }
}
