// Terminal version — bind it to a global keyboard shortcut for a "one key" ticket.
//
//   bun run ticket                              # draft from the last 15 min, print it
//   bun run ticket --minutes 5 --note "VPN"     # with a note
//   bun run ticket --publish                    # draft + send to GitHub Issues
//   bun run ticket --demo                       # replay fixtures/vpn-error.json
//   bun run ticket --show-context               # also print what is sent to the LLM

import { parseArgs } from "node:util";
import { applyDemoFlag, loadSettings } from "./config";
import { createDraft } from "./pipeline";
import { publishIssue } from "./publish";

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    minutes: { type: "string", short: "m" },
    note: { type: "string", short: "n" },
    publish: { type: "boolean", short: "p", default: false },
    demo: { type: "boolean", default: false },
    "show-context": { type: "boolean", default: false },
    json: { type: "boolean", default: false },
  },
});

loadSettings();
if (values.demo) applyDemoFlag(["--demo"]);

try {
  const draft = await createDraft({ minutes: values.minutes ? Number(values.minutes) : undefined, note: values.note });

  if (values.json) {
    console.log(JSON.stringify(draft, null, 2));
  } else {
    if (values["show-context"]) console.log(`\n===== CONTEXT SENT TO LLM =====\n${draft.contextSent}\n`);
    const r = draft.stats.redactions;
    console.error(
      `\n${draft.stats.events} events · ${draft.stats.segments} segments · apps: ${draft.stats.apps.join(", ")}` +
        ` · redacted: ${Object.entries(r).map(([k, v]) => `${k}×${v}`).join(", ") || "nothing"} · llm: ${draft.stats.llm}\n`,
    );
    console.log(`# ${draft.title}\n\n${draft.body}`);
  }

  if (values.publish) {
    const res = await publishIssue({ title: draft.title, body: draft.body, labels: draft.labels });
    console.error(res.dryRun ? `\n💾 Dry run — saved to ${res.url}` : `\n✅ Issue created: ${res.url}`);
  }
} catch (e) {
  console.error(`\n❌ ${e instanceof Error ? e.message : e}`);
  process.exit(1);
}
