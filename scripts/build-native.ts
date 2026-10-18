import { chmodSync, existsSync, readFileSync } from "node:fs";
import { delimiter, resolve } from "node:path";

export const nativeTargets = {
  "windows-x64": { platform: "win32", folder: "windows", arch: "x64", rust: "x86_64-pc-windows-gnu" },
  "linux-x64": { platform: "linux", folder: "linux", arch: "x64", rust: "x86_64-unknown-linux-gnu" },
  "linux-arm64": { platform: "linux", folder: "linux", arch: "arm64", rust: "aarch64-unknown-linux-gnu" },
  "mac-x64": { platform: "darwin", folder: "macos", arch: "x64", rust: "x86_64-apple-darwin" },
  "mac-arm64": { platform: "darwin", folder: "macos", arch: "arm64", rust: "aarch64-apple-darwin" },
} as const;
export type NativeTarget = keyof typeof nativeTargets;
export function hostTarget(): NativeTarget {
  const prefix = { win32: "windows", linux: "linux", darwin: "mac" }[process.platform as "win32" | "linux" | "darwin"];
  const id = `${prefix}-${process.arch}`;
  if (!(id in nativeTargets)) throw new Error(`Unsupported build host: ${process.platform}/${process.arch}`);
  return id as NativeTarget;
}
export const helperVariable = (id: NativeTarget) => `TICKETPIPE_${id.toUpperCase().replaceAll("-", "_")}_HELPER`;
export function validateHelper(path: string, id: NativeTarget) {
  if (!existsSync(path)) throw new Error(`Missing ${id} native helper: ${path}`);
  const data = readFileSync(path), target = nativeTargets[id];
  let valid = false;
  if (data.length >= 64) {
    if (target.folder === "linux") valid = data.subarray(0, 4).equals(Buffer.from([127,69,76,70])) && data[4] === 2 && data[5] === 1 && data.readUInt16LE(18) === (target.arch === "arm64" ? 183 : 62);
    if (target.folder === "macos") valid = data.readUInt32LE(0) === 0xfeedfacf && data.readUInt32LE(4) === (target.arch === "arm64" ? 0x100000c : 0x1000007);
    if (target.folder === "windows") { const offset = data.readUInt32LE(0x3c); valid = data.subarray(0,2).toString() === "MZ" && offset + 6 <= data.length && data.readUInt32LE(offset) === 0x4550 && data.readUInt16LE(offset + 4) === 0x8664; }
  }
  if (!valid) throw new Error(`The supplied helper is not a matching ${id} executable.`);
  return path;
}
export async function buildNative(id: NativeTarget = hostTarget()) {
  const target = nativeTargets[id];
  const variable = helperVariable(id);
  const supplied = process.env[variable] || (id === "windows-x64" ? process.env.TICKETPIPE_WINDOWS_HELPER : undefined);
  if (supplied) return validateHelper(resolve(supplied), id);
  if (process.platform !== target.platform || (process.arch !== target.arch && process.platform !== "darwin")) throw new Error(`Build the ${id} controller on its native OS/architecture, or set ${variable} to a matching prebuilt helper. No controller-free release will be produced.`);
  const tools = resolve(import.meta.dir, "../../../.tools/workscope");
  const portable = resolve(tools, "rustup/toolchains/stable-x86_64-pc-windows-gnu/bin");
  const cargo = Bun.which("cargo") ?? (process.platform === "win32" ? resolve(portable, "cargo.exe") : "");
  if (!cargo || !existsSync(cargo)) throw new Error("Building controllers requires Rust on the build machine. Recipients do not need a runtime or compiler.");
  const env: Record<string,string | undefined> = { ...process.env, ...(target.folder === "macos" ? { MACOSX_DEPLOYMENT_TARGET: "13.0" } : {}) };
  if (cargo.startsWith(portable)) {
    env.CARGO_HOME = resolve(tools, "cargo"); env.RUSTC = resolve(portable, "rustc.exe");
    env.PATH = resolve(tools, "compiler/w64devkit/bin") + delimiter + portable + delimiter + (env.PATH ?? ""); env.RUSTFLAGS = "-C link-self-contained=yes";
  }
  const crossArch = process.arch !== target.arch;
  const child = Bun.spawn([cargo, "build", "--release", "--locked", "--manifest-path", `native/${target.folder}/Cargo.toml`, ...(crossArch ? ["--target", target.rust] : [])], { cwd: resolve(import.meta.dir, ".."), env, stdio: ["ignore", "inherit", "inherit"] });
  if (await child.exited !== 0) throw new Error(`The ${id} controller build failed. For Mac cross-architecture builds install the matching Rust target first.`);
  const path = resolve(import.meta.dir, `../native/${target.folder}/target/${crossArch ? target.rust + "/" : ""}release/ticketpipe-controller${target.folder === "windows" ? ".exe" : ""}`);
  validateHelper(path,id); if (process.platform !== "win32") chmodSync(path,0o700);
  return path;
}
if (import.meta.main) await buildNative((Bun.argv[2] as NativeTarget | undefined) ?? hostTarget());
