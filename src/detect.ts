// Find the screenpipe API key automatically, so people don't have to copy-paste it.
// Runs `screenpipe auth token` from wherever screenpipe is installed, then checks the key works.

import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { config } from "./config";

function candidates(): string[] {
  const home = homedir();
  const list = [
    Bun.which("screenpipe") ?? "",
    join(home, ".local", "opt", "screenpipe", "usr", "bin", "screenpipe"),
    join(home, ".local", "bin", "screenpipe"),
    join(home, ".screenpipe", "bin", "screenpipe"),
    "/usr/local/bin/screenpipe",
    "/opt/homebrew/bin/screenpipe",
    "/Applications/screenpipe.app/Contents/MacOS/screenpipe",
    join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "screenpipe", "screenpipe.exe"),
    join(process.env.LOCALAPPDATA || join(home, "AppData", "Local"), "Programs", "screenpipe", "screenpipe.exe"),
  ];
  // Current Windows installs keep their CLI in a versioned per-user directory.
  const cli = join(home, ".screenpipe", "cli");
  try {
    for (const version of readdirSync(cli).sort().reverse()) list.push(join(cli, version, process.platform === "win32" ? "screenpipe.exe" : "screenpipe"));
  } catch {}
  // Copies downloaded by `bunx screenpipe` / `npx screenpipe`.
  for (const tmp of ["/tmp", process.env.TMPDIR ?? ""].filter(Boolean)) {
    try {
      for (const d of readdirSync(tmp)) {
        if (!/^bunx-.*screenpipe/.test(d)) continue;
        const base = join(tmp, d, "node_modules", "@screenpipe");
        if (!existsSync(base)) continue;
        for (const pkg of readdirSync(base)) list.push(join(base, pkg, "bin", process.platform === "win32" ? "screenpipe.exe" : "screenpipe"));
      }
    } catch {}
  }
  return [...new Set(list.filter((p) => p && existsSync(p)))];
}

async function tokenFrom(bin: string): Promise<string | null> {
  // screenpipe's Linux build sometimes ships its own libraries next to the binary.
  const libs = [join(dirname(bin), "..", "lib"), join(homedir(), ".local", "opt", "screenpipe", "usr", "lib")];
  const env = { ...process.env, LD_LIBRARY_PATH: [...libs, process.env.LD_LIBRARY_PATH ?? ""].filter(Boolean).join(":") };
  try {
    const proc = Bun.spawn([bin, "auth", "token"], { env, stdout: "pipe", stderr: "pipe" });
    const timer = setTimeout(() => proc.kill(), 8000);
    const out = (await new Response(proc.stdout).text()) + "\n" + (await new Response(proc.stderr).text());
    clearTimeout(timer);
    const sp = out.match(/\bsp-[A-Za-z0-9_-]{6,}\b/);
    if (sp) return sp[0];
    const line = out.split("\n").map((l) => l.trim()).filter((l) => l && !/\s/.test(l) && l.length >= 8 && l.length <= 200).at(-1);
    return line ?? null;
  } catch {
    return null;
  }
}

async function keyWorks(key: string) {
  try {
    const res = await fetch(`${config.screenpipeUrl}/search?content_type=ocr&limit=1`, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(6000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Returns a working key, or null if none could be found. */
export async function detectScreenpipeKey(): Promise<string | null> {
  if (process.env.SCREENPIPE_API_KEY && (await keyWorks(process.env.SCREENPIPE_API_KEY))) return process.env.SCREENPIPE_API_KEY;
  for (const bin of candidates()) {
    const key = await tokenFrom(bin);
    if (key && (await keyWorks(key))) return key;
  }
  return null;
}
