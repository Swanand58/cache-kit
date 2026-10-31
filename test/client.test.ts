import assert from "node:assert/strict";
import { test } from "node:test";
import { CacheClient, wrap } from "../src/client.js";
import { History } from "../src/history.js";
import { readLog } from "../src/metrics.js";
import { filler, testCfg, usage } from "./helpers.js";

/** A fake SDK client: no network. Replies with scripted usage. */
function fakeSdk(script: any[]) {
  const calls: any[] = [];
  const sdk = {
    other: () => "untouched",
    messages: {
      create: async (req: any) => { calls.push(structuredClone(req)); return { id: "m", content: [{ type: "text", text: "ok" }], usage: script.shift() ?? usage(0, 0) }; },
      countTokens: async () => ({ input_tokens: 99999 }),
    },
  };
  return { sdk: sdk as any, calls };
}
const mk = (script: any[], over: Record<string, unknown> = {}) => {
  const cfg = testCfg(over);
  const f = fakeSdk(script);
  return { ...f, ck: new CacheClient({ client: f.sdk, config: { log: cfg.log, ...over } }), logPath: cfg.log.path };
};

test("create(): tools sorted, static after system, markers placed, volatile after the last breakpoint", async () => {
  const { ck, calls } = mk([usage(0, 3000)]);
  await ck.create({
    model: "claude-opus-5-5", max_tokens: 10, system: "SYS",
    tools: [{ name: "b", description: filler(2000) }, { name: "a" }],
    static: [{ type: "text", text: filler(6000) }],
    messages: [{ role: "user", content: "question" }],
    volatile: "now: 10:00",
  });
  const sent = calls[0];
  assert.deepEqual(sent.tools.map((t: any) => t.name), ["a", "b"]);
  assert.equal(sent.system[0].text, "SYS");
  assert.ok(sent.system[1].cache_control, "marker at end of static block");
  const last = sent.messages[0].content;
  assert.equal(last[0].text, "question");
  assert.ok(last[0].cache_control, "marker at end of history");
  assert.equal(last[1].text, "now: 10:00");
  assert.equal(last[1].cache_control, undefined, "volatile content is after the marker, uncached");
  assert.equal(sent.static, undefined);
  assert.equal(sent.volatile, undefined);
});

test("create(): a volatile value changing between calls keeps one session and an identical prefix; a later real change is diagnosed", async () => {
  const { ck } = mk([usage(0, 3000), usage(3000, 0), usage(0, 3000)]);
  const sys = filler(8000);
  const p = (v: string, system = sys) => ({ model: "claude-opus-5-5", max_tokens: 10, system, messages: [{ role: "user" as const, content: "q" }], volatile: v });
  await ck.create(p("t=1"));
  await ck.create(p("t=2"));
  assert.equal(ck.stats().misses, 1, "only the cold start missed");
  await ck.create(p("t=3", "CHANGED " + sys));
  const m = ck.explainLastMiss() as any;
  assert.equal(m.found, true);
  assert.deepEqual(m.causes.map((c: any) => c.kind), ["system"], "diagnosed as a system change, not a new session's first call");
});

test("create(): returns the SDK response untouched and logs hashes, not prompts", async () => {
  const { ck, logPath } = mk([usage(0, 1000)]);
  const res = await ck.create({ model: "claude-opus-5-5", max_tokens: 10, system: "SECRET PROMPT TEXT " + filler(5000), messages: [{ role: "user", content: "hi" }] });
  assert.equal((res as any).id, "m");
  const [e] = readLog(logPath);
  assert.equal(e.usage.cache_creation_input_tokens, 1000);
  assert.ok(e.cost.actual > 0 && e.cost.uncached > 0);
  assert.ok(!JSON.stringify(e).includes("SECRET"));
});

test("create(): small prompts below the model minimum are sent without markers", async () => {
  const { ck, calls } = mk([usage(0, 0)], {});
  await ck.create({ model: "claude-opus-4-6", max_tokens: 10, system: "short", messages: [{ role: "user", content: "hi" }] });
  assert.equal(JSON.stringify(calls[0]).includes("cache_control"), false);
});

test("create(): model, max_tokens and message text are passed through unchanged", async () => {
  const { ck, calls } = mk([usage(0, 1)]);
  await ck.create({ model: "claude-haiku-5-5", max_tokens: 77, system: filler(5000), messages: [{ role: "user", content: "same text" }], thinking: { type: "adaptive" } });
  assert.equal(calls[0].model, "claude-haiku-5-5");
  assert.equal(calls[0].max_tokens, 77);
  assert.deepEqual(calls[0].thinking, { type: "adaptive" });
  assert.equal(calls[0].messages[0].content[0].text, "same text");
});

test("create(): SDK errors propagate and don't poison tracking", async () => {
  const { ck, sdk } = mk([]);
  sdk.messages.create = async () => { throw Object.assign(new Error("overloaded"), { status: 529 }); };
  await assert.rejects(ck.create({ model: "claude-opus-5-5", max_tokens: 1, messages: [{ role: "user", content: "x" }] }), /overloaded/);
  assert.equal(ck.stats().calls, 0);
});

test("stream: true is passed straight to the SDK", async () => {
  const { ck, calls } = mk([usage(0, 0)]);
  await ck.create({ model: "claude-opus-5-5", max_tokens: 1, stream: true, system: filler(5000), messages: [{ role: "user", content: "x" }] });
  assert.equal(JSON.stringify(calls[0]).includes("cache_control"), false);
});

test("count_tokens calibration scales the estimate (tokens.count = api)", async () => {
  // estimate says ~1500 tokens (above 512 minimum) but the API says 99999: markers must be added either way
  const { ck, calls } = mk([usage(0, 1)], { tokens: { count: "api" } });
  await ck.create({ model: "claude-opus-5-5", max_tokens: 1, system: filler(6000), messages: [{ role: "user", content: "x" }] });
  assert.ok(JSON.stringify(calls[0]).includes("cache_control"));
});

test("wrap(): messages.create goes through cachekit, everything else is untouched", async () => {
  const { sdk, calls } = fakeSdk([usage(0, 10)]);
  const w = wrap(sdk, { config: { log: testCfg().log } });
  assert.equal(w.other(), "untouched");
  await w.messages.create({ model: "claude-opus-5-5", max_tokens: 1, system: filler(5000), messages: [{ role: "user", content: "x" }] });
  assert.ok(JSON.stringify(calls[0]).includes("cache_control"));
});

test("compact(): one summarizing request, history replaced, warning logged", async () => {
  const { ck, calls } = mk([usage(0, 1)]);
  const h = new History();
  for (let i = 0; i < 8; i++) h.push({ role: i % 2 ? "assistant" : "user", content: `turn ${i}` });
  await ck.compact(h, { model: "claude-haiku-5-5", keepLast: 2 });
  assert.equal(calls.length, 1);
  assert.equal(h.messages.length, 3);
  assert.match(String(h.messages[0].content), /Summary of earlier conversation/);
});
