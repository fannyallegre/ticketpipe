# Run on your Mac

Stop any old TicketPipe server with Ctrl+C and close its window.
Open this ticketpipe folder in VS Code and its terminal.

```bash
bun install
bun run app
```

Open Screenpipe first and configure the AI in Settings. For a fictional demo: `bun run demo`. If needed: `bun run dev`, then http://127.0.0.1:4242. Reload with Cmd+Shift+R.

The employee first reviews Quick fix, then chooses 👍 resolved (nothing published) or 👎 unresolved (publish to GitHub, or save locally when GitHub is not configured). Severity is based on the description/evidence and cannot be changed in the interface. The unresolved outcome is included in the ticket.

Native automatic repairs retain their existing setup requirements: Rust, `bun run build:native`, and macOS Accessibility permission.
