// Opt-in acceptance fixture. These deterministic checks are never used by the repair agent.
import { NativeController } from "../src/fix/controller";
import { evaluateChecks } from "../src/fix/policy";
import { strict as assert } from "node:assert";

const title = "Repair controller acceptance";
const token = crypto.randomUUID();
let results: string[] = [], running = false;
async function checks() {
  const c = new NativeController(), signal = new AbortController().signal;
  const passed = (message: string) => { results.push(message); console.log(message); };
  try {
    const matches = (await c.windows()).filter(w => w.title.startsWith(title));
    assert.equal(matches.length, 1, "Keep exactly one acceptance page in the foreground");
    let binding = await c.bind(matches[0].id, signal);
    const deadline = Date.now() + 15_000;
    while (binding.state === "awaiting_focus" && Date.now() < deadline) { await Bun.sleep(150); binding = await c.focus(signal); }
    assert.equal(binding.state, "ready", "Bring the selected acceptance window forward within 15 seconds");
    let observation = await c.observe(signal);
    assert(!observation.controls.some(x => (x.name === "Password" && x.role === "edit") || x.value === "test-only-secret"), "Protected fields must not be exposed");
    passed("PASS: protected fields omitted from observations");
    const wrap = observation.controls.find(x => x.name === "Wrap long lines" && x.actions.includes("activate"));
    assert(wrap, "Checkbox must expose activation");
    await c.act(observation.id, { kind: "activate", ref: wrap.ref }, signal);
    await assert.rejects(c.act(observation.id, { kind: "activate", ref: wrap.ref }, signal));
    observation = await c.observe(signal);
    assert(evaluateChecks([{ name: "Wrap long lines", property: "checked", equals: true }], observation).passed);
    passed("PASS: native activation, consumed observation, independent success check");
    const field = observation.controls.find(x => x.name === "Document title" && x.editable);
    assert(field, "Text field must expose editable accessibility operations");
    await c.act(observation.id, { kind: "text", ref: field.ref, text: "Acceptance document" }, signal);
    await Bun.sleep(200);
    observation = await c.observe(signal);
    assert(evaluateChecks([{ name: "Document title", role: field.role, property: "value", equals: "Acceptance document" }], observation).passed, "Editable field value must match");
    passed("PASS: real editable-field input and value verification");
    const danger = observation.controls.find(x => x.name === "Delete account"); assert(danger);
    await assert.rejects(c.act(observation.id, { kind: "activate", ref: danger.ref }, signal));
    passed("PASS: destructive control blocked by the native boundary");
    observation = await c.observe(signal);
    assert(!evaluateChecks([{ name: "Wrap long lines", property: "checked", equals: false }], observation).passed);
    passed("PASS: unsuccessful criteria cannot report verified success");
    const liveWrap = observation.controls.find(x => x.name === "Wrap long lines")!;
    await assert.rejects(c.act(observation.id, { kind: "keys", ref: liveWrap.ref, key: "WIN+R" }, signal));
    passed("PASS: system-wide shortcut blocked by the native boundary");
    const fresh = await c.observe(signal); await c.cancel();
    await assert.rejects(async () => c.act(fresh.id, { kind: "activate", ref: liveWrap.ref }, signal));
    passed("PASS: Stop revokes the controller and prevents later actions");
    const replaced = new NativeController();
    try { await assert.rejects(replaced.bind(matches[0].id + ":replaced", signal)); passed("PASS: invalid or replaced target identity rejected"); }
    finally { await replaced.close(); }
  } catch (error) { results.push(`FAIL: ${error instanceof Error ? error.message : error}`); console.error(results.at(-1)); }
  finally { await c.close(); running = false; }
}
const server = Bun.serve({ hostname: "127.0.0.1", port: 4243, routes: {
  "/": req => new Response(`<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1><p>Disposable controls for opt-in native testing.</p><label><input type="checkbox" ${new URL(req.url).searchParams.has("blocked") ? "disabled" : ""}>Wrap long lines</label><p><label>Document title<input value="Untitled"></label></p><p><label>Password<input type="password" value="test-only-secret"></label></p><button>Delete account</button><p><button id="run">Run acceptance checks</button></p><pre id="result"></pre><script>document.querySelector('#run').onclick=async()=>{document.querySelector('#run').disabled=true;await fetch('/run',{method:'POST',headers:{'x-test-token':'${token}'}})};setInterval(async()=>{document.querySelector('#result').textContent=await(await fetch('/results')).text()},1000)</script></body></html>`, { headers: { "content-type": "text/html" } }),
  "/run": { POST: req => { if (req.headers.get("x-test-token") !== token || req.headers.get("origin") !== "http://127.0.0.1:4243") return new Response("Forbidden", { status: 403 }); if (!running) { running = true; results = []; void checks(); } return new Response("Started"); } },
  "/results": () => new Response(results.join("\n")),
}, fetch: () => new Response("Not found", { status: 404 }) });
console.log(`Acceptance fixture: http://127.0.0.1:${server.port}`);
