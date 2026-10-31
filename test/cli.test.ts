import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { test } from "node:test";
import type { Entry } from "../src/types.js";
import { statusReport } from "../src/report.js";
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
