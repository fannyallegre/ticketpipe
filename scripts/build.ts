// Build standalone executables for Linux, macOS and Windows (no Bun/Node needed to run them).
//   bun run build              # all platforms
//   bun run build linux-x64    # one platform
// Output: dist/

import { chmodSync, copyFileSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import { buildNative, type NativeTarget } from "./build-native";
import { fixMacArchivePermissions } from "./mac-archive";

const pkg = await Bun.file("package.json").json();
const NAME = "ticketpipe";
const APP = "TicketPipe";

type Target = { id: string; bun: string; exe: string; mac?: boolean };
const TARGETS: Target[] = [
  { id: "linux-x64", bun: "bun-linux-x64", exe: `${NAME}-linux-x64` },
  { id: "linux-arm64", bun: "bun-linux-arm64", exe: `${NAME}-linux-arm64` },
  { id: "mac-arm64", bun: "bun-darwin-arm64", exe: `${NAME}-mac-arm64`, mac: true },
  { id: "mac-x64", bun: "bun-darwin-x64", exe: `${NAME}-mac-x64`, mac: true },
  { id: "windows-x64", bun: "bun-windows-x64", exe: `${NAME}-windows-x64.exe` },
];

const wanted = Bun.argv.slice(2);
let targets = wanted.length ? TARGETS.filter((t) => wanted.includes(t.id)) : TARGETS;

const root = resolve(import.meta.dir, "..");
const dist = resolve(root, "dist");
if (dist !== root + sep + "dist") throw new Error("Invalid output directory");
if (!targets.length || wanted.some(id => !TARGETS.some(t => t.id === id))) throw new Error("Unknown build target");
// Preflight every helper before changing output; never emit a partial unsupported release.
const helpers = new Map<string,string>();
for (const target of targets) helpers.set(target.id, await buildNative(target.id as NativeTarget));
if (targets.some(t => t.mac) && process.platform !== "darwin") throw new Error("Private Mac .app signing must finish on macOS. Build the Mac release on a Mac with its matching helper; ad-hoc signing needs no developer account.");
mkdirSync("dist", { recursive: true });

for (const t of targets) {
  process.stdout.write(`→ ${t.id.padEnd(12)} `);
  const out = `dist/${t.exe}`;
  const result = await Bun.build({
    entrypoints: ["src/app.ts"], minify: true,
    compile: { target: t.bun as Bun.Build.CompileTarget, outfile: out, autoloadDotenv: false },
    plugins: [{ name: "native-controller", setup(build) {
      build.onLoad({ filter: /[\\/]fix[\\/]helper-asset\.ts$/ }, () => ({ contents: t.mac ? `export const embeddedHelper = null; export const bundledHelper = true;` : `import executable from ${JSON.stringify(helpers.get(t.id))} with { type: "file" }; export const embeddedHelper = executable; export const bundledHelper = false;`, loader: "ts" }));
    } }],
  });
  if (!result.success) throw new Error(result.logs.map(String).join("\n"));

  if (t.mac) {
    // Wrap in a .app bundle so it opens with a double-click and shows a proper name.
    const bundle = `dist/${t.id}/${APP}.app/Contents`;
    mkdirSync(`${bundle}/MacOS`, { recursive: true });
    renameSync(out, `${bundle}/MacOS/${NAME}`);
    chmodSync(`${bundle}/MacOS/${NAME}`, 0o755);
    mkdirSync(`${bundle}/Helpers`, { recursive: true });
    copyFileSync(helpers.get(t.id)!, `${bundle}/Helpers/ticketpipe-controller`);
    chmodSync(`${bundle}/Helpers/ticketpipe-controller`, 0o755);
    writeFileSync(
      `${bundle}/Info.plist`,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>${APP}</string>
  <key>CFBundleDisplayName</key><string>${APP}</string>
  <key>CFBundleIdentifier</key><string>dev.hackathon.ticketpipe</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundleExecutable</key><string>${NAME}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSUIElement</key><false/>
</dict></plist>
`,
    );
    for (const path of [`${bundle}/Helpers/ticketpipe-controller`, `${bundle}/MacOS/${NAME}`, `${bundle}/..`]) {
      const signing = Bun.spawn(["/usr/bin/codesign", "--force", "--sign", "-", "--identifier", path.endsWith("ticketpipe-controller") ? "dev.hackathon.ticketpipe.controller" : "dev.hackathon.ticketpipe", path], { stdio: ["ignore", "inherit", "inherit"] });
      if (await signing.exited !== 0) throw new Error("Private Mac ad-hoc signing failed.");
    }
    const verification = Bun.spawn(["/usr/bin/codesign", "--verify", "--deep", "--strict", `${bundle}/..`], { stdio: ["ignore", "inherit", "inherit"] });
    if (await verification.exited !== 0) throw new Error("Mac bundle signature verification failed.");
    const zip = Bun.which("zip");
    const archive = Bun.spawn(zip ? [zip, "-qry", `../${NAME}-${t.id}.zip`, `${APP}.app`] : ["tar", "-a", "-cf", `../${NAME}-${t.id}.zip`, `${APP}.app`], { cwd: resolve(dist, t.id), stdio: ["ignore", "inherit", "inherit"] });
    if (await archive.exited !== 0) throw new Error("Unable to archive the macOS bundle (requires zip or tar).");
    if (process.platform === "win32") await fixMacArchivePermissions(resolve(dist, `${NAME}-${t.id}.zip`));
    const temporary = resolve(dist, t.id);
    if (!temporary.startsWith(dist + sep)) throw new Error("Invalid bundle directory");
    rmSync(temporary, { recursive: true, force: true });
    console.log(`dist/${NAME}-${t.id}.zip`);
  } else {
    console.log(out);
  }
}
