import assert from "node:assert/strict";
import { test } from "node:test";
import { History } from "../src/history.js";
import { aggregate, cost, hitRate, Logger, parseUsage, readLog } from "../src/metrics.js";
import { buildReport, formatLog, formatReport, lastMiss, statusLine } from "../src/report.js";
import type { Entry } from "../src/types.js";
import { testCfg, tmpLog, usage } from "./helpers.js";

test("hit rate = read / (read + creation + input)", () => {
  assert.equal(hitRate(usage(900, 50, 50)), 0.9);
  assert.equal(hitRate(usage(0, 0, 0)), 0);
});

test("parseUsage tolerates missing and null fields", () => {
  assert.deepEqual(parseUsage({ input_tokens: 5, cache_read_input_tokens: null }), { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test("cost with and without caching, claude-opus-5-5 ($4 in, $20 out, $0.20 read, 1.25x write)", () => {
  const u = usage(100_000, 10_000, 100, 500);
  const c = cost(testCfg(), "claude-opus-5-5", u, "5m");
  assert.ok(Math.abs(c.actual - 0.0804) < 1e-9, String(c.actual));
  assert.ok(Math.abs(c.uncached - 0.4504) < 1e-9, String(c.uncached));
});

test("1h writes cost 2x; per-TTL breakdown from the response wins over the configured TTL", () => {
  const u = { ...usage(0, 10_000, 0, 0), cache_creation: { ephemeral_1h_input_tokens: 10_000, ephemeral_5m_input_tokens: 0 } };
  assert.ok(Math.abs(cost(testCfg(), "claude-opus-5-5", u, "5m").actual - 0.08) < 1e-9);
  assert.ok(Math.abs(cost(testCfg(), "claude-opus-5-5", usage(0, 10_000, 0, 0), "1h").actual - 0.08) < 1e-9);
});

test("price table is configurable and unknown models fall back instead of throwing", () => {
  const cfg = testCfg({ models: { "my-model": { min_tokens: 1, input: 1, output: 1, cache_read: 0.1 } } });
  assert.ok(Math.abs(cost(cfg, "my-model", usage(1_000_000, 0, 0, 0), "5m").actual - 0.1) < 1e-9);
  assert.doesNotThrow(() => cost(cfg, "never-heard-of-it", usage(1, 1), "5m"));
  assert.ok(cost(cfg, "claude-opus-5-5-20260401", usage(1_000_000, 0, 0, 0), "5m").actual === 0.2); // dated suffix resolves by prefix
});

const entry = (o: Partial<Entry>): Entry => ({
  ts: 1, kind: "call", session: "s", lineage: "l", model: "claude-opus-5-5", status: 200, stream: false, usage: usage(0, 0, 0, 0),
  hit_rate: 0, miss: false, causes: [], cost: { actual: 1, uncached: 3 }, prefix_hash: "", ttl: "5m", rewrites: [], warnings: [], ...o,
});

test("aggregate: cumulative hit rate, savings, cause counts; keep-alive adds cost but not calls", () => {
  const t = aggregate([
    entry({ usage: usage(0, 1000, 0, 0), miss: true, causes: [{ kind: "first_call", detail: "" }] }),
    entry({ usage: usage(1000, 0, 0, 0) }),
    entry({ kind: "keepalive", usage: usage(1000, 0, 0, 0), cost: { actual: 0.5, uncached: 3 } }),
    entry({ status: 529, cost: { actual: 9, uncached: 9 } }),
  ]);
  assert.equal(t.calls, 2);
  assert.equal(t.hit_rate, 0.5);
  assert.equal(t.cost, 2.5);
  assert.equal(t.uncached, 6);
  assert.deepEqual(t.causes, { first_call: 1 });
});

test("logger writes JSONL that readLog round-trips and skips torn lines", () => {
  const p = tmpLog();
  const l = new Logger(p);
  l.write(entry({ session: "a" })); l.write(entry({ session: "b" }));
  assert.deepEqual(readLog(p).map((e) => e.session), ["a", "b"]);
  assert.equal(readLog(p, 64).length <= 1, true); // tail read drops the partial first line
});

test("report: top causes, advice, --json shape; status line; last miss", () => {
  const es = [
    entry({ miss: true, usage: usage(0, 100, 0, 0), causes: [{ kind: "ttl_expiry", detail: "ttl expiry" }] }),
    entry({ miss: true, usage: usage(0, 100, 0, 0), causes: [{ kind: "parallel", detail: "p" }, { kind: "ttl_expiry", detail: "ttl expiry" }] }),
    entry({ usage: usage(100, 0, 0, 0), warnings: ["timestamp in system block 0 line 2"] }),
  ];
  const r = buildReport(es);
  assert.deepEqual(r.top_causes, [{ kind: "ttl_expiry", count: 2 }, { kind: "parallel", count: 1 }]);
  assert.equal(r.advice.length, 2);
  const text = formatReport(r);
  assert.match(text, /top causes of misses/);
  assert.match(text, /timestamp in system block 0 line 2/);
  assert.match(statusLine(es), /^cache \d+% hit \| saved \$[\d.]+ \| 3 calls \| last miss: parallel$/);
  assert.equal(lastMiss(es).found, true);
  assert.equal(lastMiss([entry({})]).found, false);
  assert.doesNotThrow(() => JSON.stringify(r));
});

test("history is append-only; compact() summarizes once, warns about the miss, never splits a tool pair", async () => {
  const h = new History();
  h.push({ role: "user", content: "q1" }, { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "r" }] }, { role: "assistant", content: "a" }, { role: "user", content: "q2" });
  const before = h.messages.length;
  let calls = 0; const warns: string[] = [];
  assert.equal(await h.compact(async (old) => { calls++; assert.equal(old.length, 1); return "S"; }, 3, (w) => warns.push(w)), true);
  // keepLast 3 would cut at the tool_result; the cut moves earlier so the pair stays together
  assert.equal(calls, 1);
  assert.equal(h.messages.length, before); // 1 old message became 1 summary
  assert.equal((h.messages[1].content as any[])[0].type, "tool_use"); // pair kept together
  assert.match(String((h.messages[0] as any).content), /^\[Summary of earlier conversation\]\nS$/);
  assert.match(warns[0], /next call will be a cache miss/);
  assert.equal(await h.compact(async () => "x", 10, () => {}), false);
});


test("formatLog: one readable line per call, causes under misses, verbose adds rewrites, no ANSI when color is off", () => {
  const es = [
    entry({ ts: 1_700_000_000_000, miss: true, usage: usage(0, 52000, 12, 340), causes: [{ kind: "first_call", detail: "first call in this lineage (cold cache)" }], rewrites: ["cache_control(5m) added at end of system"], warnings: ["uuid in system block 0 line 2"] }),
    entry({ ts: 1_700_000_060_000, usage: usage(52000, 0, 12, 100), hit_rate: 0.99 }),
  ];
  const plain = formatLog(es, { color: false });
  assert.doesNotMatch(plain, /\x1b/);
  assert.match(plain, /MISS\s+main\s+claude-opus-5-5\s+hit\s+0%\s+read\s+0\s+write\s+52\.0k/);
  assert.match(plain, /HIT\s+main.*read\s+52\.0k/);
  assert.match(plain, /\u2514 first_call\s+first call in this lineage/);
  assert.doesNotMatch(plain, /cache_control\(5m\)/);
  assert.match(formatLog(es, { color: false, verbose: true }), /~ cache_control\(5m\) added at end of system[\s\S]*! uuid in system/);
  assert.match(plain, /2 call\(s\) \| hit rate/);
  assert.match(formatLog(es, { color: true }), /\x1b\[31;1mMISS/);
});

test("formatLog: shows the session only when several sessions are in view; errors and keep-alives are labelled", () => {
  const one = formatLog([entry({ session: "aaaaaaaa11" })], { color: false });
  assert.doesNotMatch(one, /\[aaaaaaaa\]/);
  const many = formatLog([entry({ session: "aaaaaaaa11" }), entry({ session: "bbbbbbbb22", kind: "keepalive" }), entry({ status: 529, error: "overloaded" })], { color: false });
  assert.match(many, /\[aaaaaaaa\]/);
  assert.match(many, /KEEP/);
  assert.match(many, /ERR 529/);
  assert.match(many, /error: overloaded/);
});

test("formatLog explains the cache-write premium on a cold call and on a negative total", () => {
  const cold = entry({ miss: true, usage: usage(0, 1000, 0, 0), cost: { actual: 0.0046, uncached: 0.0023 } });
  const warm = entry({ usage: usage(1000, 0, 0, 0), cost: { actual: 0.0004, uncached: 0.0023 } });
  const out = formatLog([cold, warm], { color: false });
  assert.match(out, /\$0\.0046 \(uncached \$0\.0023, incl\. cache-write premium\)/);
  assert.match(out, /\$0\.0004 \(uncached \$0\.0023\)(?!, incl)/);
  assert.doesNotMatch(formatLog([warm], { color: false }), /premium/);
  assert.match(formatLog([cold], { color: false }), /saved -\$0\.0023 \(cache writes cost extra until reads repay them\)/);
});
