import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createProxy } from "../src/proxy.js";
import { readLog } from "../src/metrics.js";
import { baseReq, filler, testCfg } from "./helpers.js";

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
type Handler = (seen: Seen, res: http.ServerResponse) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const closers: (() => Promise<void> | void)[] = [];
after(async () => { for (const c of closers) await c(); });

async function setup(handler: Handler, cfgOver: Record<string, unknown> = {}, optimize = false) {
  const seen: Seen[] = [];
  const upstream = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) }; seen.push(s); handler(s, res); });
  });
  await new Promise<void>((r) => upstream.listen(0, "127.0.0.1", r));
  const cfg = testCfg(cfgOver);
  const proxy = createProxy({ cfg, optimize, upstream: `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`, say: () => {} });
  await new Promise<void>((r) => proxy.server.listen(0, "127.0.0.1", r));
  closers.push(() => proxy.close(), () => new Promise<void>((r) => { upstream.closeAllConnections(); upstream.close(() => r()); }));
  const port = (proxy.server.address() as AddressInfo).port;
  return { seen, port, cfg, proxy, entries: () => readLog(cfg.log.path) };
}

interface Reply { status: number; headers: http.IncomingHttpHeaders; body: Buffer; firstChunkMs: number; endMs: number }
function post(port: number, body: Buffer | string, headers: Record<string, string> = {}, path = "/v1/messages?beta=true"): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    let first = 0;
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST", headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => { if (!first) first = Date.now() - t0; chunks.push(c); });
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks), firstChunkMs: first, endMs: Date.now() - t0 }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
async function waitFor<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error("waitFor timed out"); await sleep(10); }
}

const jsonReply = (u: object): Handler => (_s, res) => {
  res.writeHead(200, { "content-type": "application/json", "x-upstream": "yes" });
  res.end(JSON.stringify({ id: "msg_1", type: "message", content: [], usage: u }));
};
const U = { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 3000 };

const sse = (...evs: object[]) => evs.map((e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
const START = { type: "message_start", message: { id: "m", model: "claude-opus-5-5", usage: { input_tokens: 12, output_tokens: 1, cache_read_input_tokens: 2000, cache_creation_input_tokens: 500, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 0 } } } };
const DELTA = { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 42 } };

test("observe-only forwards the request byte-for-byte, with all headers, and the response unchanged", async () => {
  const t = await setup(jsonReply(U));
  // odd whitespace, unsorted tools, escaped unicode, duplicate-looking keys order: any re-serialization would change these bytes
  const raw = Buffer.from('{ "model":"claude-opus-5-5",\n  "tools":[{"name":"b"},{"name":"a"}],  "messages":[{"role":"user","content":"caf\\u00e9 é"}] ,"max_tokens":5}');
  const r = await post(t.port, raw, { "x-api-key": "sk-ant-SECRET", "anthropic-version": "2023-06-01", "anthropic-beta": "a-beta,b-beta", "x-custom": "1" });
  assert.equal(t.seen.length, 1);
  assert.ok(t.seen[0].body.equals(raw), "request body must be identical");
  assert.equal(t.seen[0].url, "/v1/messages?beta=true");
  for (const [k, v] of Object.entries({ "x-api-key": "sk-ant-SECRET", "anthropic-version": "2023-06-01", "anthropic-beta": "a-beta,b-beta", "x-custom": "1", "content-type": "application/json" }))
    assert.equal(t.seen[0].headers[k], v, k);
  assert.equal(r.status, 200);
  assert.equal(r.headers["x-upstream"], "yes");
  assert.equal(JSON.parse(r.body.toString()).id, "msg_1");
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.equal(e.usage.cache_creation_input_tokens, 3000);
  assert.deepEqual(e.rewrites, []);
});

test("API keys never reach the log", async () => {
  const t = await setup(jsonReply(U));
  await post(t.port, JSON.stringify(baseReq()), { "x-api-key": "sk-ant-TOPSECRET", authorization: "Bearer TOPSECRET-OAUTH" });
  await waitFor(() => t.entries().length);
  const log = readFileSync(t.cfg.log.path, "utf8");
  assert.ok(!log.includes("TOPSECRET"));
  assert.ok(!log.includes("rule 1:"), "no prompt text in the log either");
});

test("non-messages endpoints and GETs pass straight through", async () => {
  const t = await setup((s, res) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ url: s.url, method: s.method })); });
  const r = await new Promise<string>((resolve) => http.get({ host: "127.0.0.1", port: t.port, path: "/v1/models" }, (res) => { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve(b)); }));
  assert.deepEqual(JSON.parse(r), { url: "/v1/models", method: "GET" });
  const c = await post(t.port, JSON.stringify(baseReq()), {}, "/v1/messages/count_tokens");
  assert.equal(JSON.parse(c.body.toString()).url, "/v1/messages/count_tokens");
  assert.equal(t.entries().length, 0);
});

test("SSE streaming is passed through unbuffered and byte-identical; usage comes from message_start + message_delta", async () => {
  const parts = sse(START, { type: "content_block_delta", delta: { type: "text_delta", text: "hi" } });
  const tail = sse(DELTA, { type: "message_stop" });
  const t = await setup(async (_s, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    for (const p of parts) res.write(p);
    await sleep(300);
    for (const p of tail) res.write(p);
    res.end();
  });
  const r = await post(t.port, JSON.stringify({ ...baseReq(), stream: true }), { "x-api-key": "k" });
  assert.equal(r.body.toString(), [...parts, ...tail].join(""));
  assert.ok(r.firstChunkMs < 200, `first bytes must arrive before upstream finishes (got ${r.firstChunkMs}ms)`);
  assert.ok(r.endMs >= 290);
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.equal(e.stream, true);
  assert.equal(e.usage.cache_read_input_tokens, 2000);
  assert.equal(e.usage.cache_creation_input_tokens, 500);
  assert.equal(e.usage.output_tokens, 42, "final output_tokens from message_delta");
  assert.equal(e.usage.input_tokens, 12);
  assert.ok(Math.abs(e.hit_rate - 2000 / 2512) < 1e-9);
});

test("gzip-compressed SSE: client gets the compressed bytes untouched, usage is still read", async () => {
  const payload = gzipSync(sse(START, DELTA, { type: "message_stop" }).join(""));
  const t = await setup((_s, res) => { res.writeHead(200, { "content-type": "text/event-stream", "content-encoding": "gzip" }); res.end(payload); });
  const r = await post(t.port, JSON.stringify({ ...baseReq(), stream: true }), { "accept-encoding": "gzip" });
  assert.ok(r.body.equals(payload));
  assert.equal(r.headers["content-encoding"], "gzip");
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.equal(e.usage.output_tokens, 42);
});

test("a client that hangs up mid-stream still gets its message_start usage recorded", async () => {
  const t = await setup((_s, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write(sse(START)[0]); /* never ends */ });
  await new Promise<void>((resolve) => {
    const req = http.request({ host: "127.0.0.1", port: t.port, path: "/v1/messages", method: "POST", headers: { "content-type": "application/json" } }, (res) => {
      res.once("data", () => { req.destroy(); resolve(); });
    });
    req.on("error", () => {});
    req.end(JSON.stringify({ ...baseReq(), stream: true }));
  });
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.equal(e.usage.cache_read_input_tokens, 2000);
});

test("--optimize rewrites tool order and adds breakpoints, and logs every rewrite", async () => {
  const t = await setup(jsonReply(U), {}, true);
  const req = { model: "claude-opus-5-5", max_tokens: 5, tools: [{ name: "b", z: 1, a: 2 }, { name: "a" }], system: filler(6000), messages: [{ role: "user", content: "q" }] };
  await post(t.port, JSON.stringify(req));
  const sent = JSON.parse(t.seen[0].body.toString());
  assert.deepEqual(sent.tools.map((x: any) => x.name), ["a", "b"]);
  assert.deepEqual(Object.keys(sent.tools[1]), ["a", "name", "z"]);
  assert.ok(JSON.stringify(sent).includes("cache_control"));
  assert.equal(sent.messages[0].content[0].text, "q");
  assert.equal(sent.model, req.model);
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.ok(e.rewrites.some((r) => r.includes("tools: sorted")));
  assert.ok(e.rewrites.some((r) => r.includes("cache_control(5m) added")));
});

test("--optimize leaves an already-good request byte-identical", async () => {
  const t = await setup(jsonReply(U), {}, true);
  const raw = Buffer.from(JSON.stringify(baseReq({ tools: [{ name: "a" }, { name: "b" }] })));
  await post(t.port, raw);
  assert.ok(t.seen[0].body.equals(raw));
});

test("internal errors never block: unparseable bodies are forwarded as-is", async () => {
  const t = await setup(jsonReply(U));
  const raw = Buffer.from("{ this is not json");
  const r = await post(t.port, raw);
  assert.equal(r.status, 200);
  assert.ok(t.seen[0].body.equals(raw));
  const r2 = await post(t.port, Buffer.from('{"model": 5, "messages": "nope"}'));
  assert.equal(r2.status, 200);
  assert.equal(t.entries().length, 0);
});

test("upstream HTTP errors are passed through and not counted", async () => {
  const t = await setup((_s, res) => { res.writeHead(529, { "content-type": "application/json" }); res.end('{"type":"error","error":{"type":"overloaded_error","message":"x"}}'); });
  const r = await post(t.port, JSON.stringify(baseReq()));
  assert.equal(r.status, 529);
  assert.match(r.body.toString(), /overloaded_error/);
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.equal(e.status, 529);
  assert.equal(e.miss, false);
});

test("upstream down: 502 with an Anthropic-shaped error", async () => {
  const cfg = testCfg();
  const proxy = createProxy({ cfg, upstream: "http://127.0.0.1:1", say: () => {} });
  await new Promise<void>((r) => proxy.server.listen(0, "127.0.0.1", r));
  closers.push(() => proxy.close());
  const r = await post((proxy.server.address() as AddressInfo).port, JSON.stringify(baseReq()));
  assert.equal(r.status, 502);
  assert.equal(JSON.parse(r.body.toString()).type, "error");
});

test("sessions by header; a subagent (different system prompt) is its own lineage and leaves the main diff chain alone", async () => {
  let n = 0;
  const t = await setup((_s, res) => jsonReply(n++ === 1 ? U : { ...U, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 })(_s, res));
  const h = { "x-claude-code-session-id": "sess-1" };
  const sub = baseReq({ tools: [{ name: "grep" }], messages: [{ role: "user", content: "find the config file" }] }); sub.system = [{ type: "text", text: "You are a search subagent.", cache_control: { type: "ephemeral" } }];
  await post(t.port, JSON.stringify(baseReq()), h);
  await waitFor(() => t.entries().length >= 1);
  await post(t.port, JSON.stringify(sub), h);
  await waitFor(() => t.entries().length >= 2);
  await post(t.port, JSON.stringify(baseReq()), h);
  const es = await waitFor(() => t.entries().length >= 3 && t.entries());
  assert.deepEqual(new Set(es.map((e) => e.session)), new Set(["sess-1"]));
  assert.equal(es[0].lineage, es[2].lineage);
  assert.notEqual(es[0].lineage, es[1].lineage);
  assert.equal(es[2].miss, false);
});

test("parallel identical requests: all but the first are flagged, with the warm-up advice", async () => {
  const t = await setup(async (s, res) => { await sleep(150); jsonReply({ ...U })(s, res); });
  const h = { "x-claude-code-session-id": "fan" };
  await Promise.all([1, 2, 3].map(() => post(t.port, JSON.stringify(baseReq()), h)));
  const es = await waitFor(() => t.entries().length >= 3 && t.entries());
  const flagged = es.filter((e) => e.causes.some((c) => c.kind === "parallel"));
  assert.equal(flagged.length, 2);
  assert.match(flagged[0].causes.find((c) => c.kind === "parallel")!.detail, /warm the cache/);
});

test("harness-side compaction is logged as compaction", async () => {
  let n = 0;
  const t = await setup((s, res) => jsonReply(n++ === 0 ? U : { ...U, cache_read_input_tokens: 0, cache_creation_input_tokens: 2000 })(s, res));
  const h = { "x-claude-code-session-id": "c" };
  await post(t.port, JSON.stringify(baseReq()), h);
  await waitFor(() => t.entries().length >= 1);
  const b = baseReq(); b.messages = [{ role: "user", content: [{ type: "text", text: "[summary]", cache_control: { type: "ephemeral" } }] }];
  await post(t.port, JSON.stringify(b), h);
  const es = await waitFor(() => t.entries().length >= 2 && t.entries());
  assert.equal(es[1].miss, true);
  assert.equal(es[1].causes[0].kind, "compaction");
});

test("keep-alive (opt-in): replays the last request with max_tokens 0, same auth, no stream, and logs the refresh", async () => {
  const t = await setup(jsonReply({ ...U, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 }), { keepalive: { enabled: true, margin_seconds: 299 } });
  await post(t.port, JSON.stringify({ ...baseReq(), stream: false, max_tokens: 100 }), { "x-api-key": "sk-ant-KA", "anthropic-version": "2023-06-01" });
  await waitFor(() => t.seen.length >= 2, 4000);
  const ka = JSON.parse(t.seen[1].body.toString());
  assert.equal(ka.max_tokens, 0);
  assert.equal(ka.stream, undefined);
  assert.equal(t.seen[1].headers["x-api-key"], "sk-ant-KA");
  assert.equal(t.seen[1].url, "/v1/messages?beta=true");
  const es = await waitFor(() => t.entries().some((e) => e.kind === "keepalive") && t.entries());
  assert.ok(es.some((e) => e.kind === "keepalive"));
  assert.ok(!readFileSync(t.cfg.log.path, "utf8").includes("sk-ant-KA"));
});

test("keep-alive is off by default", async () => {
  const t = await setup(jsonReply({ ...U, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 }), { keepalive: { margin_seconds: 299 } });
  await post(t.port, JSON.stringify(baseReq()));
  await sleep(1400);
  assert.equal(t.seen.length, 1);
});
