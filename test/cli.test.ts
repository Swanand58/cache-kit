import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import type { Entry } from "../src/types.js";
import { readSession } from "../src/metrics.js";
import { statusLine, statusReport } from "../src/report.js";
import { tmpLog, usage } from "./helpers.js";

const entry = (o: Partial<Entry>): Entry => ({
  ts: 1, kind: "call", session: "A", lineage: "l0", model: "claude-opus-5-5", status: 200, stream: false, usage: usage(1000, 0, 0, 0),
  hit_rate: 1, miss: false, causes: [], cost: { actual: 1, uncached: 3 }, prefix_hash: "", ttl: "5m", rewrites: [], warnings: [], ...o,
});
const miss = (o: Partial<Entry>) => entry({ miss: true, hit_rate: 0, usage: usage(0, 1000, 0, 0), ...o });

// session A: 1 hit, then a ttl_expiry miss, then a hit. session B (the latest overall): all hits.
const rows = [
  entry({ ts: 100, session: "A" }),
  miss({ ts: 200, session: "A", causes: [{ kind: "ttl_expiry", detail: "ttl expiry" }, { kind: "unknown", detail: "x" }] }),
  entry({ ts: 300, session: "A" }),
  entry({ ts: 400, session: "B", lineage: "l9" }),
];

test("statusReport: scoped to the session, with session id and last miss", () => {
  const r = statusReport(rows, "A") as any;
  assert.equal(r.session, "A");
  assert.equal(r.calls, 3);
  assert.deepEqual(r.last_miss, { kind: "ttl_expiry", ts: 200, label: "main" });
  assert.ok(Math.abs(r.hit_rate - 2000 / 3000) < 1e-9, "hit rate covers session A only");
});

test("statusReport: null last_miss when the session never missed; calls 0 for an unknown session; latest when no id", () => {
  assert.equal((statusReport(rows, "B") as any).last_miss, null);
  assert.deepEqual(statusReport(rows, "not-a-real-id"), { calls: 0 });
  assert.deepEqual(statusReport([], "A"), { calls: 0 });
  assert.equal((statusReport(rows) as any).session, "B");
});

test("statusReport: a subagent's miss is labelled sub", () => {
  const es = [entry({ ts: 1 }), entry({ ts: 2 }), miss({ ts: 3, lineage: "sub0", causes: [{ kind: "first_call", detail: "" }] })];
  assert.deepEqual((statusReport(es, "A") as any).last_miss, { kind: "first_call", ts: 3, label: "sub" });
});

// --- the real CLI, as a status line would call it
function cli(log: string, args: string[], input?: string) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "status", "--log", log, ...args], { input, encoding: "utf8" });
  return { out: r.stdout.trim(), code: r.status };
}
const logFile = () => { const p = tmpLog(); writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n"); return p; };

test("cli: unknown --session prints no data / {calls: 0}, exit 0, never another session's numbers", () => {
  const p = logFile();
  assert.deepEqual(cli(p, ["--session", "not-a-real-id"]), { out: "cachekit: no data", code: 0 });
  const j = cli(p, ["--session", "not-a-real-id", "--json"]);
  assert.deepEqual(JSON.parse(j.out), { calls: 0 });
  assert.equal(j.code, 0);
});

test("cli: unknown session_id on stdin is also strict", () => {
  const p = logFile();
  assert.equal(cli(p, [], '{"session_id":"not-a-real-id"}').out, "cachekit: no data");
  assert.deepEqual(JSON.parse(cli(p, ["--json"], '{"session_id":"not-a-real-id"}').out), { calls: 0 });
});

test("cli: known session from --session and from stdin; --json carries session and last_miss", () => {
  const p = logFile();
  const text = cli(p, ["--session", "A"]).out;
  assert.match(text, /^cache 67% hit .* 3 calls \| last miss: ttl_expiry$/);
  const j = JSON.parse(cli(p, ["--json"], '{"session_id":"A"}').out);
  assert.equal(j.session, "A");
  assert.deepEqual(j.last_miss, { kind: "ttl_expiry", ts: 200, label: "main" });
  assert.equal(JSON.parse(cli(p, ["--session", "B", "--json"]).out).last_miss, null);
});

test("cli: with no id at all, the most recently active session is used (human at a prompt)", () => {
  const out = JSON.parse(cli(logFile(), ["--json"], "").out);
  assert.equal(out.session, "B");
});

test("cli: a missing log file is just no data", () => {
  assert.deepEqual(cli("/nonexistent/dir/log.jsonl", ["--session", "A"]), { out: "cachekit: no data", code: 0 });
});

// ---- live-status metrics (from the session-guard shakedown) ----
const call = (lineage: string, ts: number, read: number, creation: number, o: Partial<Entry> = {}) =>
  entry({ ts, session: "S", lineage, usage: usage(read, creation, 0, 0), ...o });
// m = main chain, s = subagent. A real miss (m2) is followed by a subagent's cold start (s1).
const shake = [
  call("L0", 1, 0, 10000, { miss: true, causes: [{ kind: "first_call", detail: "" }] }),                               // m1
  call("L0", 2, 5300, 4700, { miss: true, causes: [{ kind: "compaction", detail: "" }, { kind: "ttl_expiry", detail: "" }] }), // m2: real miss
  call("L1", 3, 0, 2000, { miss: true, causes: [{ kind: "first_call", detail: "" }] }),                                // s1: cold start
  call("L1", 4, 2000, 0),                                                                                              // s2
  call("L0", 5, 10000, 0),                                                                                             // m3
  call("L0", 6, 10000, 100),                                                                                           // m4
];
const near = (a: number, b: number) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);

test("statusReport: cumulative, main-only, recent and recent-main hit rates are token-weighted", () => {
  const r = statusReport(shake, "S") as any;
  near(r.hit_rate, 27300 / 44100);               // everything, cold start included (lags)
  near(r.main_hit_rate, 25300 / 40100);          // main chain only
  near(r.recent_hit_rate, 22000 / 22100);        // last 3 calls: s2, m3, m4
  near(r.recent_main_hit_rate, 25300 / 30100);   // last 3 main calls: m2, m3, m4
});

test("statusReport: last_miss is the newest miss; last_real_miss skips cold starts", () => {
  const r = statusReport(shake, "S") as any;
  assert.deepEqual(r.last_miss, { kind: "first_call", ts: 3, label: "sub" });      // the subagent's cold start
  assert.deepEqual(r.last_real_miss, { kind: "compaction", ts: 2, label: "main" }); // what actually went wrong
});

test("statusReport: last_real_miss is null when the only misses are cold starts", () => {
  const r = statusReport([call("L0", 1, 0, 1000, { miss: true, causes: [{ kind: "first_call", detail: "" }] }), call("L0", 2, 1000, 0)], "S") as any;
  assert.equal(r.last_real_miss, null);
  assert.equal(r.last_miss.kind, "first_call");
});

test("statusReport: a cold start that is also below the minimum keeps the real cause", () => {
  const r = statusReport([call("L0", 1, 0, 0, { miss: true, causes: [{ kind: "below_min", detail: "" }, { kind: "first_call", detail: "" }] })], "S") as any;
  assert.equal(r.last_real_miss.kind, "below_min");
});

test("text status line shows only a real miss, never a cold start", () => {
  const cold = [call("L0", 1, 0, 1000, { miss: true, causes: [{ kind: "first_call", detail: "" }] })];
  assert.doesNotMatch(statusLine(cold, "S"), /last miss/);
  assert.match(statusLine(shake, "S"), /last miss: compaction$/);
});

// ---- readSession: no tail window ----
const row = (session: string, pad = 0) => JSON.stringify(entry({ session, rewrites: pad ? ["x".repeat(pad)] : [] })) + "\n";

test("readSession: finds a session buried under megabytes of other traffic, across a chunk boundary", () => {
  const parts: Buffer[] = [];
  let size = 0;
  const add = (s: string) => { const b = Buffer.from(s); parts.push(b); size += b.length; };
  add(row("T"));
  while (size < 4 * 1024 * 1024 - 100) add(row("other", 700));   // fill up to just short of the 4 MB read boundary
  add(row("T", 300));                                             // this row straddles the 4 MB boundary
  for (let i = 0; i < 6000; i++) add(row("other", 700));          // > 4 MB more, so the first T rows are far from the tail
  add(row("X"));                                                  // most recent session overall
  const p = tmpLog();
  writeFileSync(p, Buffer.concat(parts));
  assert.equal(readSession(p, "T").length, 2);
  assert.deepEqual(readSession(p, "nope"), []);
  assert.equal(readSession(p, "X").length, 1);
  assert.equal(readSession(p)[0].session, "X", "no id: the latest session");
  assert.deepEqual(readSession("/nonexistent/log.jsonl", "T"), []);
  assert.equal(JSON.parse(cli(p, ["--session", "T", "--json"]).out).calls, 2, "status finds it too");
});

test("readSession: a torn trailing line and ids that merely contain another id are handled", () => {
  const p = tmpLog();
  writeFileSync(p, row("abc") + row("abcdef") + '{"ts":1,"kind":"call","session":"abc","half');
  assert.equal(readSession(p, "abc").length, 1);
  assert.equal(readSession(p, "abcdef").length, 1);
});
