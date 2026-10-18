# Native build and desktop acceptance

Windows commit `253544c` is the working baseline. New platform code must pass native desktop acceptance before it is described as verified. A cross-target source check, WSLg or a headless test is not GNOME or macOS acceptance.

## Build on the test computer

Build machines need Bun, Rust and their normal native linker/SDK. Recipients of packaged builds need none of these tools. Do not put API keys in commands, source files or test reports; configure the existing provider in TicketPipe Settings.

From `ticketpipe/`:

```sh
bun install --frozen-lockfile
bun run typecheck
bun test
```

Ubuntu/Fedora x64:

```sh
cargo test --locked --manifest-path native/linux/Cargo.toml
bun run build linux-x64
./dist/ticketpipe-linux-x64 --check-controller
./dist/ticketpipe-linux-x64
```

Use `linux-arm64` on an ARM64 Linux build machine. A functioning GNOME graphical session, session D-Bus and AT-SPI service are required. Launch TicketPipe in the desktop user's session, outside containers and without sudo. The helper refuses unsupported or ambiguous session types. Ubuntu 24.04 needs separate Wayland and Xorg runs. Ubuntu 26.04's standard GNOME session is Wayland-only. Fedora Workstation GNOME Wayland is included in scope; record the exact Fedora and GNOME versions rather than claiming all Fedora editions.

macOS Apple Silicon:

```sh
cargo test --locked --manifest-path native/macos/Cargo.toml
bun run build mac-arm64
```

On Intel, use `mac-x64`. To build the other architecture on a Mac, first install its Rust target (`x86_64-apple-darwin` or `aarch64-apple-darwin`). The build wraps the executable and helper in `TicketPipe.app`, sets minimum macOS 13, ad-hoc signs the helper, executable and bundle, verifies signatures, then produces a ZIP. No Apple Developer account is needed. These are private test builds, without notarization. Unzip, put the app in a stable location such as Applications, and open it using macOS's normal local-app approval flow.

Choose **Set up accessibility** in the quick-fix result. In System Settings → Privacy & Security → Accessibility, allow TicketPipe / `ticketpipe-controller` as listed. Return and choose **Check automatic fixing again**. Replacing an ad-hoc signed private build may require granting Accessibility again. No Screen Recording or microphone permission is needed by the repair feature. Permission setup never starts or resumes an attempt.

Windows:

```sh
cargo test --locked --manifest-path native/windows/Cargo.toml
bun run build windows-x64
```

Use a Windows linker or the existing workspace portable toolchain. The final executable embeds its helper.

## Cross-packaging

Every release must include the matching native helper. `bun run build` preflights all five targets and fails if any helper is missing; target-specific builds preserve other outputs in `dist/`. Prebuilt helper variables are:

| Target | Environment variable |
|---|---|
| Windows x64 | `TICKETPIPE_WINDOWS_X64_HELPER` (legacy `TICKETPIPE_WINDOWS_HELPER` also accepted) |
| Linux x64 | `TICKETPIPE_LINUX_X64_HELPER` |
| Linux ARM64 | `TICKETPIPE_LINUX_ARM64_HELPER` |
| Mac Intel | `TICKETPIPE_MAC_X64_HELPER` |
| Mac Apple Silicon | `TICKETPIPE_MAC_ARM64_HELPER` |

Helpers are checked for executable format and architecture. Build them on their native OS. Linux cross-architecture helpers may be supplied through these prebuilt variables (the recorded ARM64 helper was built on Ubuntu with Rust's self-contained `aarch64-unknown-linux-musl` target). Mac bundle signing must finish on a Mac. Missing helpers are an error; an old unqualified controller is never silently substituted. Linux and Windows helpers are embedded and extracted into an integrity-checked hash directory; Linux uses owner-only directory/executable permissions. Mac helpers remain in `Contents/Helpers/ticketpipe-controller`, within the signed bundle.

## Real desktop checks

Use a real configured AI and recent Screenpipe evidence, with one Chrome window and an ordinary native app such as GNOME Text Editor or TextEdit. Use disposable unsaved text only. Production decisions must come from the general agent; these scenarios are tests, not built-in repair recipes.

For every environment:

1. **Text correction:** put `apples` in an accessible editable field. Ask TicketPipe to replace it with `oranges` without submitting it. Generate the suggestion, open the actual TicketPipe window picker and select the target. Start while TicketPipe is still in front. Confirm one performed text action and independent value verification. Repeat in the native app; if it lacks readable controls, record **needs your help**, not a pass.
2. **Toggle:** use a harmless accessible checkbox, such as the disposable fixture's “Wrap long lines”. Start from the real picker and verify its actual checked state changes.
3. **Unresolved:** use a disabled target control or an outcome the app cannot confirm. Confirm no verified-success state appears. Escalate to a draft and check that suggested or rejected actions are absent from “Already tried”. Review publishing without posting a real ticket.
4. **Stop:** stop during an AI request and while input is pending; verify late responses cannot act. On Wayland, also stop while waiting for foreground handoff.
5. **Handoff:** repeat with delayed activation. On Wayland, manually foreground the selected window within 15 seconds. While waiting, no control observations or input should appear. Waiting beyond 15 seconds must end without input. Once active, switch to a different app and another window in the same app; both must stop the run without reacquiring focus.
6. **Scope:** close/reopen the selected app, replace its window, open an unrelated dialog, and exercise a genuinely attached sheet/dialog. Only relationships established through native accessibility ownership may be accepted. Inaccessible controls and ambiguous windows must stop safely.
7. **Setup:** deny or revoke Accessibility (Mac), or disable/unavailable AT-SPI (Linux). GET readiness must never prompt or change setup. Explicit setup must never start a run. Rechecking readiness must preserve the original unexpired incident.
8. **Keys:** Wayland must advertise no keyboard actions, including for XWayland apps. Xorg must omit keys when X11 correlation fails. Mac must allow only the advertised Command shortcuts; test your active keyboard layout (including AZERTY where available), because letter shortcuts are resolved from the current layout instead of US physical key positions. Protected fields, terminals, destructive actions and system-wide keys must be refused.
9. **Packaging:** run the packaged executable with no Rust, Python, Node or Bun on PATH. Check extracted Linux helper mode is `700`, permissions/setup survive ordinary launches, and no helper survives TicketPipe shutdown. Check manual suggestions, Settings, ticket drafting, local saving and reviewed publishing.

`bun run scripts/native-acceptance.ts` provides a separate opt-in browser fixture at `http://127.0.0.1:4243` for deterministic native-boundary checks. It is not a substitute for the actual picker-to-target real-AI checks above.

## Record each result

Record OS release, architecture, desktop/session, app/version, packaged/source build, commit, provider/model (never key), elapsed timings, actual result and diagnostic failure codes. Do not include captured text, credentials, AI payloads or unrelated history. Mark untested combinations **unverified**. Report successful repair, toggle, unresolved and Stop separately.
