// Save the raw screenpipe response for the last N minutes, to replay it later
// (safety net for the live demo, and a way to iterate on the prompt without re-living the bug).
//
//   bun run snapshot            # last 15 min
//   bun run snapshot 5          # last 5 min
//   CONTEXT_FILE=fixtures/snapshot-xxx.json bun run dev

import { config } from "../src/config";
import { fetchRaw } from "../src/context";

const minutes = Number(Bun.argv[2] ?? config.lookbackMinutes);
config.contextFile = ""; // always hit the live API here

const items = await fetchRaw(minutes);
const path = `fixtures/snapshot-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
await Bun.write(path, JSON.stringify({ data: items }, null, 2));
console.log(`Saved ${items.length} items (${minutes} min) → ${path}`);
console.log(`Replay with: CONTEXT_FILE=${path} bun run dev`);
