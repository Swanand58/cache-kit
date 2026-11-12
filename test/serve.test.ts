import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { writeFileSync } from "node:fs";
import { after, test } from "node:test";
import { createServe, prometheus } from "../src/serve.js";
import type { Entry } from "../src/types.js";
import { tmpLog, usage } from "./helpers.js";

const entry = (o: Partial<Entry>): Entry => ({
  ts: 1, kind: "call", session: "A", lineage: "l0", model: "claude-opus-5-5", status: 200, stream: false, usage: usage(1000, 0, 0, 10),
  hit_rate: 1, miss: false, causes: [], cost: { actual: 1, uncached: 3 }, prefix_hash: "", ttl: "5m", rewrites: [], warnings: [], ...o,
});
const rows = [
  entry({ tag: "chat", provider: "openai", model: "gpt-5.4" }),
  entry({ tag: "chat", provider: "openai", model: "gpt-5.4" }),
  entry({ tag: "search", miss: true, causes: [{ kind: "tools", detail: "tool `a` added" }, { kind: "system", detail: "x" }], usage: usage(0, 1000, 0, 10), hit_rate: 0 }),
  entry({}),
];

// Prometheus text format: name{label="value",...} number
const LINE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="([^"\\]|\\.)*",?)*\})? -?[0-9.]+(e[+-]?[0-9]+)?$/;

test("prometheus: valid text format, per provider/model/app labels, miss causes and token kinds", () => {
  const text = prometheus(rows);
  const lines = text.trimEnd().split("\n");
  for (const l of lines) assert.ok(l.startsWith("#") || LINE.test(l), `bad line: ${l}`);
  assert.ok(text.includes('cachekit_calls_total{provider="openai",model="gpt-5.4",app="chat"} 2'));
  assert.ok(text.includes('cachekit_calls_total{provider="anthropic",model="claude-opus-5-5",app="untagged"} 1'));
  assert.ok(text.includes('cachekit_tokens_total{provider="anthropic",model="claude-opus-5-5",app="search",kind="creation"} 1000'));
  assert.ok(text.includes('cachekit_misses_total{provider="anthropic",model="claude-opus-5-5",app="search",cause="tools"} 1'));
  assert.match(text, /# TYPE cachekit_saved_usd gauge/);
  assert.match(text, /# TYPE cachekit_cost_usd_total counter/);
});

test("prometheus: only the busiest apps and models keep a label; the rest are `other`; values are escaped", () => {
  const many = Array.from({ length: 60 }, (_, i) => entry({ tag: `app-${i}`, model: `m-${i}` }));
  many.push(entry({ tag: "app-0" }), entry({ tag: "app-0" }));
  const text = prometheus(many, 5);
  const apps = new Set([...text.matchAll(/app="([^"]*)"/g)].map((m) => m[1]));
  assert.ok(apps.size <= 6 && apps.has("app-0") && apps.has("other"), [...apps].join());
  const models = new Set([...text.matchAll(/model="([^"]*)"/g)].map((m) => m[1]));
  assert.ok(models.size <= 6 && models.has("other"));
  // a model name with quote/backslash/newline cannot break the format
  const nasty = prometheus([entry({ model: 'a"b\\c\nd' })]);
  for (const l of nasty.trimEnd().split("\n")) assert.ok(l.startsWith("#") || LINE.test(l), l);
});

const closers: (() => void)[] = [];
after(() => { for (const c of closers) c(); });
async function serve() {
  const log = tmpLog();
  writeFileSync(log, rows.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const s = createServe({ logPath: log });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closers.push(() => { s.closeAllConnections(); s.close(); });
  return { port: (s.address() as AddressInfo).port, log };
}
const get = (port: number, path: string, o: http.RequestOptions = {}) =>
  new Promise<{ status: number; type?: string; body: string }>((resolve, reject) => {
    http.request({ host: "127.0.0.1", port, path, ...o }, (res) => {
      let b = "";
      res.on("data", (c) => (b += c));
      res.on("end", () => resolve({ status: res.statusCode!, type: res.headers["content-type"], body: b }));
    }).on("error", reject).end();
  });

test("serve: /stats.json (with ?app=), /metrics, 404, GET only, foreign Host header refused", async () => {
  const { port } = await serve();
  const stats = await get(port, "/stats.json");
  assert.equal(stats.status, 200);
  assert.equal(JSON.parse(stats.body).calls, 4);
  assert.equal(JSON.parse(stats.body).by_tag.chat.calls, 2);
  assert.equal(JSON.parse((await get(port, "/stats.json?app=chat")).body).calls, 2);
  assert.equal(JSON.parse((await get(port, "/stats.json?app=untagged")).body).calls, 1);
  const m = await get(port, "/metrics");
  assert.equal(m.status, 200);
  assert.match(m.type!, /text\/plain/);
  assert.ok(m.body.includes("cachekit_calls_total"));
  assert.equal((await get(port, "/nope")).status, 404);
  assert.equal((await get(port, "/metrics", { method: "POST" })).status, 405);
  assert.equal((await get(port, "/metrics", { headers: { host: "evil.example" } })).status, 403);
  assert.equal((await get(port, "/metrics", { headers: { host: `localhost:${port}` } })).status, 200);
});

test("serve: a missing log is an empty report, not an error; output never contains prompt text or keys", async () => {
  const s = createServe({ logPath: tmpLog() });
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
  closers.push(() => { s.closeAllConnections(); s.close(); });
  const port = (s.address() as AddressInfo).port;
  assert.equal(JSON.parse((await get(port, "/stats.json")).body).calls, 0);
  assert.equal((await get(port, "/metrics")).body.trim().split("\n").every((l) => l.startsWith("#")), true);
  const { port: p2 } = await serve();
  const all = (await get(p2, "/stats.json")).body + (await get(p2, "/metrics")).body;
  assert.ok(!/sk-|Bearer|lorem/.test(all));
});
