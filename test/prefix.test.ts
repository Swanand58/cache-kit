import assert from "node:assert/strict";
import { test } from "node:test";
import { diff, snapshot } from "../src/prefix.js";
import { Tracker } from "../src/session.js";
import type { Req } from "../src/types.js";
import { baseReq, testCfg, usage } from "./helpers.js";

const kinds = (a: Req, b: Req) => diff(snapshot(a), snapshot(b));
const details = (a: Req, b: Req) => kinds(a, b).map((c) => c.detail);
const sysWithLine = (n: number, text: string): Req => {
  const r = baseReq();
  const lines = (r.system as any[])[0].text.split("\n");
  lines[n - 1] = text;
  (r.system as any[])[0].text = lines.join("\n");
  return r;
};

test("identical requests: no diff, same prefix hash", () => {
  assert.deepEqual(kinds(baseReq(), baseReq()), []);
  assert.equal(snapshot(baseReq()).prefix, snapshot(baseReq()).prefix);
});

test("moving or retyping cache_control alone is not a content change", () => {
  const b = baseReq();
  (b.system as any[])[0].cache_control = { type: "ephemeral", ttl: "1h" };
  assert.deepEqual(kinds(baseReq(), b), []);
});

test("tool schema change names the tool", () => {
  const b = baseReq();
  (b.tools![0] as any).input_schema.properties.q = { type: "number" };
  assert.deepEqual(details(baseReq(), b), ["tool `search` schema changed"]);
});

test("tool added, removed, reordered", () => {
  const added = baseReq(); added.tools!.push({ name: "extra" });
  assert.deepEqual(details(baseReq(), added), ["tool `extra` added"]);
  assert.deepEqual(details(added, baseReq()), ["tool `extra` removed"]);
  const reordered = baseReq(); reordered.tools!.reverse();
  assert.deepEqual(kinds(baseReq(), reordered).map((c) => c.kind), ["tool_order"]);
});

test("system prompt change reports the line number", () => {
  assert.deepEqual(details(baseReq(), sysWithLine(14, "changed")), ["system prompt line 14 changed"]);
});

test("many changed system lines are summarized", () => {
  const b = baseReq();
  (b.system as any[])[0].text = (b.system as any[])[0].text.replaceAll("rule", "RULE");
  assert.match(details(baseReq(), b)[0], /lines 1, 2, 3, 4, 5 \(\+15 more\) changed/);
});

test("model change", () => {
  assert.deepEqual(details(baseReq(), baseReq({ model: "claude-sonnet-5-5" })), ["model changed"]);
});

test("thinking and effort changes", () => {
  assert.equal(kinds(baseReq(), baseReq({ thinking: { type: "adaptive" } }))[0].kind, "thinking");
  assert.equal(kinds(baseReq(), baseReq({ output_config: { effort: "low" } }))[0].kind, "thinking");
});

test("append-only history is not a diff, even though the marker moved", () => {
  const b = baseReq();
  b.messages.push({ role: "assistant", content: "answer" }, { role: "user", content: [{ type: "text", text: "next", cache_control: { type: "ephemeral" } }] });
  assert.deepEqual(kinds(baseReq(), b), []);
});

test("history shrinking is compaction", () => {
  const b = baseReq(); b.messages = b.messages.slice(1);
  const c = kinds(baseReq(), b);
  assert.equal(c[0].kind, "compaction");
  assert.match(c[0].detail, /shrank from 3 messages to 2/);
});

test("an earlier message rewritten is compaction", () => {
  const b = baseReq(); b.messages[0] = { role: "user", content: "[summary] hello" };
  assert.match(details(baseReq(), b)[0], /message 1 block 1 rewritten/);
});

test("content after the last breakpoint (volatile) never affects the prefix hash", () => {
  const a = baseReq(), b = baseReq();
  (a.messages[2].content as any[]).push({ type: "text", text: "now: 10:00" });
  (b.messages[2].content as any[]).push({ type: "text", text: "now: 10:05" });
  assert.equal(snapshot(a).prefix, snapshot(b).prefix);
});

// ---- tracker: causes, lineages, parallel ----
const T0 = 1_000_000_000_000;
function setup() {
  let now = T0;
  const t = new Tracker(testCfg(), () => now);
  const call = (req: Req, u = usage(0, 1000), o: { session?: string; ok?: boolean } = {}) => {
    const ctx = t.begin(req, o.session ?? "s1");
    t.firstByte(ctx);
    return t.end(ctx, { usage: u, status: 200, stream: false });
  };
  return { t, call, advance: (ms: number) => (now += ms) };
}

test("first call is a cold-start miss; a following read is a hit", () => {
  const { call } = setup();
  assert.equal(call(baseReq()).causes[0].kind, "first_call");
  const hit = call(baseReq(), usage(1000, 0));
  assert.equal(hit.miss, false);
  assert.deepEqual(hit.causes, []);
});

test("miss after more than 5 minutes: ttl_expiry", () => {
  const { call, advance } = setup();
  call(baseReq());
  advance(6 * 60_000);
  const e = call(baseReq(), usage(0, 1000));
  assert.deepEqual(e.causes.map((c) => c.kind), ["ttl_expiry"]);
  assert.equal(e.gap_s, 360);
});

test("1h TTL: the same 6 minute gap is not an expiry", () => {
  const { call, advance } = setup();
  const r = baseReq(); (r.system as any[])[0].cache_control.ttl = "1h"; (r.messages[2].content as any[])[0].cache_control.ttl = "1h";
  call(r);
  advance(6 * 60_000);
  assert.deepEqual(call(r, usage(0, 1000)).causes.map((c) => c.kind), ["unknown"]);
});

test("miss with a system line change is attributed to it, not to TTL", () => {
  const { call, advance } = setup();
  call(baseReq());
  advance(30_000);
  assert.deepEqual(call(sysWithLine(14, "x"), usage(0, 1000)).causes.map((c) => c.detail), ["system prompt line 14 changed"]);
});

test("mid-session model, tool and thinking changes are the reported cause", () => {
  const { call } = setup();
  call(baseReq());
  const b = baseReq({ model: "claude-sonnet-5-5", thinking: { type: "adaptive" } }); b.tools!.push({ name: "x" });
  assert.deepEqual(call(b, usage(0, 1000)).causes.map((c) => c.kind), ["model", "thinking", "tools"]);
});

test("harness compaction is labelled compaction and read drop counts as a miss", () => {
  const { call } = setup();
  call(baseReq(), usage(0, 5000));
  const b = baseReq(); b.messages = [{ role: "user", content: [{ type: "text", text: "[summary]", cache_control: { type: "ephemeral" } }] }];
  const e = call(b, usage(1000, 300)); // tools+system still read, history not
  assert.equal(e.miss, true);
  assert.equal(e.causes[0].kind, "compaction");
});

test("subagents get their own lineage and do not pollute the main diff chain", () => {
  const { call, t } = setup();
  const main1 = call(baseReq());
  const subReq = baseReq({ tools: [{ name: "grep" }], messages: [{ role: "user", content: "find the config file" }] }); subReq.system = [{ type: "text", text: "You are a code search subagent.\nBe brief.", cache_control: { type: "ephemeral" } }];
  const sub = call(subReq);
  const main2 = call(baseReq(), usage(1000, 0));
  assert.notEqual(main1.lineage, sub.lineage);
  assert.equal(main1.lineage, main2.lineage);
  assert.equal(sub.causes[0].kind, "first_call");
  assert.equal(main2.miss, false);
  assert.deepEqual(main2.causes, []);
  assert.ok(t.totals("s1").calls === 3);
});

test("a fully rewritten system prompt in the same conversation is a diff, not a new agent", () => {
  const { call } = setup();
  const a = call(baseReq());
  const rewritten = baseReq(); rewritten.system = [{ type: "text", text: "Entirely new instructions.", cache_control: { type: "ephemeral" } }];
  const b = call(rewritten, usage(0, 1000));
  assert.equal(a.lineage, b.lineage);
  assert.equal(b.causes[0].kind, "system");
});

test("a few edited system lines stay in the same lineage (reported as a diff, not a new agent)", () => {
  const { call } = setup();
  const a = call(baseReq());
  const b = call(sysWithLine(3, "different"), usage(0, 1000));
  assert.equal(a.lineage, b.lineage);
});

test("parallel: same prefix in flight before the first response begins", () => {
  const { t } = setup();
  const a = t.begin(baseReq(), "s1");
  const b = t.begin(baseReq(), "s1");
  const c = t.begin(baseReq(), "s1");
  assert.deepEqual([a.parallel, b.parallel, c.parallel], [false, true, true]);
  t.firstByte(a);
  const eb = t.end(b, { usage: usage(0, 1000), status: 200, stream: true });
  assert.ok(eb.causes.some((x) => x.kind === "parallel"));
  assert.match(eb.causes.find((x) => x.kind === "parallel")!.detail, /warm the cache/);
});

test("not parallel once the first request has begun streaming", () => {
  const { t } = setup();
  const a = t.begin(baseReq(), "s1");
  t.firstByte(a);
  assert.equal(t.begin(baseReq(), "s1").parallel, false);
});

test("a request with no cache_control is flagged; a breakpoint with no write is below_min", () => {
  const { call } = setup();
  const noBp = baseReq(); delete (noBp.system as any[])[0].cache_control; (noBp.messages[2].content as any[])[0] = { type: "text", text: "question" };
  assert.ok(call(noBp, usage(0, 0)).causes.some((c) => c.kind === "no_breakpoint"));
  const { call: call2 } = setup();
  assert.ok(call2(baseReq(), usage(0, 0)).causes.some((c) => c.kind === "below_min"));
});

test("sessions: header wins, else stable hash of system + first user message; different chats are separate", () => {
  const { t } = setup();
  const a = t.begin(baseReq(), "hdr"), b = t.begin(baseReq()), c = t.begin(baseReq()), d = t.begin(baseReq({ messages: [{ role: "user", content: "other chat" }] }));
  assert.equal(a.sid, "hdr");
  assert.equal(b.sid, c.sid);
  assert.notEqual(b.sid, d.sid);
});

test("failed responses do not advance lineage state or count in totals", () => {
  const { t, call } = setup();
  call(baseReq());
  const ctx = t.begin(baseReq(), "s1");
  const e = t.end(ctx, { status: 529, stream: false });
  assert.equal(e.miss, false);
  assert.equal(t.totals("s1").calls, 1);
  assert.equal(call(baseReq(), usage(1000, 0)).miss, false);
});


test("per-call content after the last breakpoint does not break session or lineage continuity", () => {
  const { t } = setup();
  const mk = (v: string) => { const r = baseReq({ messages: [{ role: "user", content: [{ type: "text", text: "q", cache_control: { type: "ephemeral" } }, { type: "text", text: v }] }] }); return r; };
  const a = t.begin(mk("t=1")), b = t.begin(mk("t=2"));
  assert.equal(a.sid, b.sid);
  assert.equal(a.lineage, b.lineage);
});

// ---- shakedown 2: /compact and Claude Code's real 1h markers ----
test("/compact: system prompt swap plus rewritten history is reported as compaction first, system second", () => {
  const { call } = setup();
  call(baseReq());
  const after = sysWithLine(1, "You are a helpful assistant that summarizes conversations.");
  after.messages = [{ role: "user", content: [{ type: "text", text: "[summary]", cache_control: { type: "ephemeral" } }] }];
  const e = call(after, usage(0, 1000));
  assert.deepEqual(e.causes.map((c) => c.kind), ["compaction", "system"]);
  assert.match(e.causes[0].detail, /history shrank from 3 messages to 1/);
  assert.match(e.causes[1].detail, /system prompt line 1 changed/);
});

test("model and thinking changes still outrank compaction", () => {
  const { call } = setup();
  call(baseReq());
  const b = baseReq({ model: "claude-sonnet-5-5" }); b.messages = b.messages.slice(1);
  assert.deepEqual(call(b, usage(0, 1000)).causes.map((c) => c.kind), ["model", "compaction"]);
});

/** Claude Code on a subscription login: ttl "1h" on system[1], system[2] and the last message (captured from real requests). */
const claudeCodeSubscription = () => {
  const r = baseReq();
  const sys = r.system as any[];
  sys[0].cache_control = { type: "ephemeral", ttl: "1h" };
  (r.messages[2].content as any[])[0].cache_control = { type: "ephemeral", ttl: "1h" };
  return r;
};

test("subscription markers (ttl 1h everywhere): a 5.5 minute idle gap is not an expiry, a 61 minute one is", () => {
  const { call, advance } = setup();
  const first = call(claudeCodeSubscription());
  assert.equal(first.ttl, "1h");
  advance(330_000);
  const hit = call(claudeCodeSubscription(), usage(1000, 0));
  assert.equal(hit.miss, false);
  advance(330_000);
  const unexplained = call(claudeCodeSubscription(), usage(0, 1000));
  assert.deepEqual(unexplained.causes.map((c) => c.kind), ["unknown"], "5.5 minutes does not expire a 1h entry");
  advance(61 * 60_000);
  const expired = call(claudeCodeSubscription(), usage(0, 1000));
  assert.deepEqual(expired.causes.map((c) => c.kind), ["ttl_expiry"]);
  assert.match(expired.causes[0].detail, /1h TTL/);
});

test("API-key markers (no ttl field = 5m): the same 5.5 minute gap is an expiry", () => {
  const { call, advance } = setup();
  assert.equal(call(baseReq()).ttl, "5m");
  advance(330_000);
  assert.deepEqual(call(baseReq(), usage(0, 1000)).causes.map((c) => c.kind), ["ttl_expiry"]);
});
