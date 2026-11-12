import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { after, test } from "node:test";
import { createProxy } from "../src/proxy.js";
import { readLog, cost } from "../src/metrics.js";
import { isOpenAICall, openaiStreamUsage, openaiToReq, openaiTtl, parseOpenAIUsage, providerOf } from "../src/providers.js";
import { filler, testCfg } from "./helpers.js";

// Fixtures follow OpenAI's documented usage shapes; a real-API capture is still pending (see README "Known limits").
const CHAT_USAGE = { prompt_tokens: 3000, completion_tokens: 40, prompt_tokens_details: { cached_tokens: 2048 } };
const RESP_USAGE = { input_tokens: 3000, output_tokens: 40, input_tokens_details: { cached_tokens: 2048, cache_write_tokens: 500, cache_write_tokens_details: { ttl_30m_tokens: 300, ttl_12h_tokens: 200 } } };
const chatBody = (over: object = {}) => ({ model: "gpt-5.4", messages: [{ role: "system", content: filler(4000) }, { role: "user", content: "hello" }], ...over });
const respBody = (over: object = {}) => ({ model: "gpt-5.6-sol", instructions: filler(4000), input: "hello", ...over });

test("providerOf routes only OpenAI endpoints; isOpenAICall only POSTs to the exact path", () => {
  assert.equal(providerOf("/v1/chat/completions"), "openai");
  assert.equal(providerOf("/v1/responses/resp_1"), "openai");
  assert.equal(providerOf("/responses"), "openai");
  assert.equal(providerOf("/v1/messages"), "anthropic");
  assert.equal(providerOf("/v1/models"), "anthropic");
  assert.equal(isOpenAICall("POST", "/v1/responses"), true);
  assert.equal(isOpenAICall("POST", "/v1/responses/resp_1"), false);
  assert.equal(isOpenAICall("GET", "/v1/responses"), false);
});

test("parseOpenAIUsage: Chat and Responses shapes map onto the shared Usage", () => {
  assert.deepEqual(parseOpenAIUsage(CHAT_USAGE), { input_tokens: 952, output_tokens: 40, cache_read_input_tokens: 2048, cache_creation_input_tokens: 0 });
  assert.deepEqual(parseOpenAIUsage(RESP_USAGE), {
    input_tokens: 452, output_tokens: 40, cache_read_input_tokens: 2048, cache_creation_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 },
  });
  assert.deepEqual(parseOpenAIUsage({}), { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
});

test("openaiStreamUsage: final Chat chunk or Responses completed event; ordinary chunks give nothing", () => {
  assert.equal(openaiStreamUsage({ object: "chat.completion.chunk", choices: [{ delta: { content: "x" } }], usage: null }), undefined);
  assert.equal(openaiStreamUsage({ object: "chat.completion.chunk", choices: [], usage: CHAT_USAGE })?.cache_read_input_tokens, 2048);
  assert.equal(openaiStreamUsage({ type: "response.output_text.delta", delta: "x" }), undefined);
  assert.equal(openaiStreamUsage({ type: "response.completed", response: { usage: RESP_USAGE } })?.cache_creation_input_tokens, 500);
});

test("openaiTtl: 30m on GPT-5.6+, 24h on older models unless in_memory, explicit options win", () => {
  assert.equal(openaiTtl({ model: "gpt-5.6-sol" }), "30m");
  assert.equal(openaiTtl({ model: "gpt-6.1-terra" }), "30m");
  assert.equal(openaiTtl({ model: "gpt-5.4" }), "24h");
  assert.equal(openaiTtl({ model: "gpt-5.4", prompt_cache_retention: "in_memory" }), "in_memory");
  assert.equal(openaiTtl({ model: "gpt-5.6-sol", prompt_cache_options: { ttl: "12h" } }), "12h");
});

test("openaiToReq: system, tools and one marker at the end of the last message, for both endpoints", () => {
  const chat = openaiToReq("/v1/chat/completions", chatBody({ tools: [{ type: "function", function: { name: "search" } }] }))!;
  assert.equal(typeof chat.system, "string");
  assert.equal(chat.messages.length, 1);
  assert.equal(chat.tools![0].name, "search");
  const last = chat.messages[0].content as any[];
  assert.deepEqual(last[last.length - 1].cache_control, { type: "ephemeral", ttl: "24h" });
  const resp = openaiToReq("/v1/responses", respBody())!;
  assert.equal(resp.system, filler(4000));
  assert.equal((resp.messages[0].content as any[])[0].cache_control.ttl, "30m");
  assert.equal(openaiToReq("/v1/responses", { model: "x" }), undefined, "no input: nothing to follow");
  assert.equal(openaiToReq("/v1/chat/completions", "junk"), undefined);
});

test("cost: GPT-5.6 12h writes use the 12h price; older models never pay a write premium", () => {
  const cfg = testCfg();
  const c = cost(cfg, "gpt-5.6-sol", parseOpenAIUsage(RESP_USAGE), "30m");
  // ordinary 452 x $4 + 2048 cached x $0.40 + 300 x $5 (30m) + 200 x $10 (12h) + 40 out x $20, per 1M
  assert.ok(Math.abs(c.actual - (452 * 4 + 2048 * 0.4 + 300 * 5 + 200 * 10 + 40 * 20) / 1e6) < 1e-12);
  assert.ok(Math.abs(c.uncached - (3000 * 4 + 40 * 20) / 1e6) < 1e-12);
  const old = cost(cfg, "gpt-5.4", parseOpenAIUsage(CHAT_USAGE), "24h");
  assert.ok(old.actual < old.uncached);
  const unknown = cost(cfg, "gpt-9-future", parseOpenAIUsage(CHAT_USAGE), "24h");
  assert.ok(Math.abs(unknown.uncached - (3000 * 2.5 + 40 * 15) / 1e6) < 1e-12, "unknown gpt models are priced like gpt-5.4, not like Claude");
});

// ---- proxy integration -------------------------------------------------------------------------------------------

interface Seen { method: string; url: string; headers: http.IncomingHttpHeaders; body: Buffer }
const closers: (() => Promise<void> | void)[] = [];
after(async () => { for (const c of closers) await c(); });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(fn: () => T | undefined | false, ms = 3000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error("waitFor timed out"); await sleep(10); }
}

async function setup(handler: (seen: Seen, res: http.ServerResponse) => void) {
  const seen: Seen[] = [];
  const up = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => { const s = { method: req.method!, url: req.url!, headers: req.headers, body: Buffer.concat(chunks) }; seen.push(s); handler(s, res); });
  });
  await new Promise<void>((r) => up.listen(0, "127.0.0.1", r));
  const cfg = testCfg();
  // the Anthropic upstream is a dead port: any OpenAI call that strays there fails the test
  const proxy = createProxy({ cfg, upstream: "http://127.0.0.1:1", openaiUpstream: `http://127.0.0.1:${(up.address() as AddressInfo).port}`, say: () => {} });
  await new Promise<void>((r) => proxy.server.listen(0, "127.0.0.1", r));
  closers.push(() => proxy.close(), () => new Promise<void>((r) => { up.closeAllConnections(); up.close(() => r()); }));
  const port = (proxy.server.address() as AddressInfo).port;
  return { seen, port, cfg, entries: () => readLog(cfg.log.path) };
}

function call(port: number, path: string, body: Buffer | string | undefined, headers: Record<string, string> = {}, method = "POST"): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers: { "content-type": "application/json", ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

const json = (o: object, headers: Record<string, string> = {}) => (_s: Seen, res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(o));
};
const sseReply = (...frames: (object | string)[]) => (_s: Seen, res: http.ServerResponse) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write(`data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`);
  res.end();
};

test("Chat Completions: forwarded byte-for-byte to the OpenAI upstream, usage and cost logged", async () => {
  const t = await setup(json({ id: "c1", choices: [], usage: CHAT_USAGE }, { "x-upstream": "openai" }));
  const raw = Buffer.from(`{ "model":"gpt-5.4",\n "messages":[{"role":"system","content":"${filler(4000)}"},{"role":"user","content":"caf\\u00e9"}] }`);
  const r = await call(t.port, "/v1/chat/completions", raw, { authorization: "Bearer sk-TOPSECRET", "openai-organization": "org-1" });
  assert.equal(r.status, 200);
  assert.ok(t.seen[0].body.equals(raw), "request body must be identical");
  assert.equal(t.seen[0].url, "/v1/chat/completions");
  assert.equal(t.seen[0].headers.authorization, "Bearer sk-TOPSECRET");
  assert.equal(t.seen[0].headers["openai-organization"], "org-1");
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.equal(e.provider, "openai");
  assert.equal(e.model, "gpt-5.4");
  assert.deepEqual([e.usage.input_tokens, e.usage.cache_read_input_tokens, e.usage.cache_creation_input_tokens], [952, 2048, 0]);
  assert.ok(Math.abs(e.hit_rate - 2048 / 3000) < 1e-9);
  assert.equal(e.miss, false);
  assert.ok(e.cost.actual < e.cost.uncached);
});

test("OpenAI keys and org ids never reach the log", async () => {
  const t = await setup(json({ usage: CHAT_USAGE }));
  await call(t.port, "/v1/chat/completions", JSON.stringify(chatBody()), { authorization: "Bearer sk-TOPSECRET", "openai-organization": "org-TOPSECRET", "openai-project": "proj-TOPSECRET" });
  await waitFor(() => t.entries().length);
  const log = readFileSync(t.cfg.log.path, "utf8");
  assert.ok(!log.includes("TOPSECRET"));
  assert.ok(!log.includes("lorem ipsum"), "no prompt text in the log");
});

test("Chat stream with include_usage: usage comes from the last chunk, bytes pass through", async () => {
  const frames = [{ choices: [{ delta: { content: "hi" } }], usage: null }, { choices: [], usage: CHAT_USAGE }, "[DONE]"];
  const t = await setup(sseReply(...frames));
  const r = await call(t.port, "/v1/chat/completions", JSON.stringify(chatBody({ stream: true, stream_options: { include_usage: true } })));
  assert.equal(r.body.toString(), frames.map((f) => `data: ${typeof f === "string" ? f : JSON.stringify(f)}\n\n`).join(""));
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.equal(e.stream, true);
  assert.equal(e.usage.cache_read_input_tokens, 2048);
});

test("Chat stream without usage: counted as a call with the no_usage cause, never as a miss", async () => {
  const t = await setup(sseReply({ choices: [{ delta: { content: "hi" } }] }, "[DONE]"));
  await call(t.port, "/v1/chat/completions", JSON.stringify(chatBody({ stream: true })));
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.equal(e.miss, false);
  assert.deepEqual(e.causes.map((c) => c.kind), ["no_usage"]);
  assert.equal(e.cost.actual, 0);
});

test("Responses API: JSON and SSE (response.completed), incl. cache-write tokens and 12h split", async () => {
  const j = await setup(json({ id: "resp_1", usage: RESP_USAGE }));
  await call(j.port, "/v1/responses", JSON.stringify(respBody()));
  const ej = (await waitFor(() => j.entries().length && j.entries()))[0];
  assert.equal(ej.usage.cache_creation_input_tokens, 500);
  assert.deepEqual(ej.usage.cache_creation, { ephemeral_5m_input_tokens: 300, ephemeral_1h_input_tokens: 200 });
  assert.equal(ej.ttl, "30m");

  const s = await setup(sseReply({ type: "response.created", response: {} }, { type: "response.output_text.delta", delta: "x" }, { type: "response.completed", response: { usage: RESP_USAGE } }));
  await call(s.port, "/v1/responses", JSON.stringify(respBody({ stream: true })));
  const es = (await waitFor(() => s.entries().length && s.entries()))[0];
  assert.equal(es.usage.cache_read_input_tokens, 2048);
});

test("gzip-compressed OpenAI responses are read without changing what the client gets", async () => {
  const body = gzipSync(JSON.stringify({ usage: CHAT_USAGE }));
  const t = await setup((_s, res) => { res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" }); res.end(body); });
  const r = await call(t.port, "/v1/chat/completions", JSON.stringify(chatBody()));
  assert.ok(r.body.equals(body));
  const e = (await waitFor(() => t.entries().length && t.entries()))[0];
  assert.equal(e.usage.cache_read_input_tokens, 2048);
});

test("second call: an added tool is diagnosed; a short prompt is below_min", async () => {
  const t = await setup(json({ usage: { prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 0 } } }));
  await call(t.port, "/v1/chat/completions", JSON.stringify(chatBody()));
  await waitFor(() => t.entries().length === 1);
  await call(t.port, "/v1/chat/completions", JSON.stringify(chatBody({ tools: [{ type: "function", function: { name: "search" } }] })));
  const es = await waitFor(() => t.entries().length === 2 && t.entries());
  assert.equal(es[0].causes[0].kind, "first_call");
  assert.equal(es[1].miss, true);
  assert.equal(es[1].causes[0].kind, "tools");

  const s = await setup(json({ usage: { prompt_tokens: 300, prompt_tokens_details: { cached_tokens: 0 } } }));
  await call(s.port, "/v1/chat/completions", JSON.stringify({ model: "gpt-5.4", messages: [{ role: "user", content: "hi" }] }));
  const e = (await waitFor(() => s.entries().length && s.entries()))[0];
  assert.ok(e.causes.some((c) => c.kind === "below_min"));
  assert.ok(!e.causes.some((c) => c.kind === "no_breakpoint"));
});

test("GETs, sub-paths and unparseable bodies pass through to the OpenAI upstream untouched", async () => {
  const t = await setup(json({ ok: true }));
  assert.equal((await call(t.port, "/v1/responses/resp_1", undefined, {}, "GET")).status, 200);
  assert.equal((await call(t.port, "/v1/chat/completions", "not json")).status, 200);
  assert.equal(t.seen.length, 2);
  assert.equal(t.entries().length, 0);
  assert.equal(t.seen[1].body.toString(), "not json");
});

test("OpenAI upstream down: 502 in OpenAI's error shape", async () => {
  const cfg = testCfg();
  const proxy = createProxy({ cfg, openaiUpstream: "http://127.0.0.1:1", say: () => {} });
  await new Promise<void>((r) => proxy.server.listen(0, "127.0.0.1", r));
  closers.push(() => proxy.close());
  const r = await call((proxy.server.address() as AddressInfo).port, "/v1/chat/completions", JSON.stringify(chatBody()));
  assert.equal(r.status, 502);
  assert.equal(JSON.parse(r.body.toString()).error.type, "api_error");
});

// ---- diagnosis (Tracker driven directly) ---------------------------------------------------------------------------

import { Tracker } from "../src/session.js";
import type { Provider } from "../src/types.js";

const MISS = parseOpenAIUsage({ prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 0 } });
const HIT = parseOpenAIUsage({ prompt_tokens: 3000, prompt_tokens_details: { cached_tokens: 2048 } });

function driver() {
  let now = 1_000_000;
  const tr = new Tracker(testCfg(), () => now);
  return {
    advance: (s: number) => { now += s * 1000; },
    call(path: string, body: object, usage = MISS, sid?: string) {
      const req = openaiToReq(path, body)!;
      const ctx = tr.begin(req, sid, "openai" as Provider);
      tr.firstByte(ctx);
      return tr.end(ctx, { usage, status: 200, stream: false });
    },
  };
}
const CHAT = "/v1/chat/completions", RESP = "/v1/responses";
const kinds = (e: { causes: { kind: string }[] }) => e.causes.map((c) => c.kind);

test("diagnosis: first call, then a changed reasoning effort is a `settings` miss that names the setting", () => {
  const d = driver();
  assert.deepEqual(kinds(d.call(CHAT, chatBody({ reasoning_effort: "low" }))), ["first_call"]);
  const e = d.call(CHAT, chatBody({ reasoning_effort: "high" }));
  assert.deepEqual(kinds(e), ["settings"]);
  assert.match(e.causes[0].detail, /reasoning_effort/);
  const r = driver();
  r.call(RESP, respBody({ reasoning: { effort: "low" }, text: { verbosity: "low" } }));
  const e2 = r.call(RESP, respBody({ reasoning: { effort: "low" }, text: { verbosity: "high" } }));
  assert.match(e2.causes[0].detail, /text\.verbosity/);
});

test("diagnosis: a changed prompt_cache_key is `routing`; the key itself is never stored", () => {
  const d = driver();
  d.call(CHAT, chatBody({ prompt_cache_key: "tenant-A-SECRET" }));
  const e = d.call(CHAT, chatBody({ prompt_cache_key: "tenant-B-SECRET" }));
  assert.deepEqual(kinds(e), ["routing"]);
  assert.ok(!JSON.stringify(e).includes("SECRET"));
});

test("diagnosis: more than 15 requests a minute on one prefix adds `routing` to a miss", () => {
  const d = driver();
  let last;
  for (let i = 0; i < 16; i++) last = d.call(CHAT, chatBody());
  assert.ok(kinds(last!).includes("routing"));
  assert.match(last!.causes.find((c) => c.kind === "routing")!.detail, /16 requests/);
  const slow = driver();
  for (let i = 0; i < 16; i++) { slow.advance(10); last = slow.call(CHAT, chatBody()); }
  assert.ok(!kinds(last!).includes("routing"), "10 s apart is only 6 a minute");
});

test("diagnosis: previous_response_id calls are `server_state` and never fake a compaction", () => {
  const d = driver();
  d.call(RESP, respBody({ input: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }, { role: "user", content: "three" }] }), MISS, "s1");
  const e = d.call(RESP, respBody({ previous_response_id: "resp_1", input: "four" }), MISS, "s1");
  assert.deepEqual(kinds(e), ["server_state"]);
  // the stateful call did not replace the baseline: the next full call diffs against the last visible prefix
  const f = d.call(RESP, respBody({ input: [{ role: "user", content: "one" }, { role: "assistant", content: "two" }, { role: "user", content: "three" }, { role: "assistant", content: "x" }, { role: "user", content: "five" }] }), MISS, "s1");
  assert.ok(!kinds(f).includes("compaction"), "baseline is the last visible prefix, not the one-message stateful call");
});

test("diagnosis: explicit mode with no breakpoint is `no_breakpoint`; with one it is cached from there", () => {
  const d = driver();
  const none = d.call(RESP, respBody({ prompt_cache_options: { mode: "explicit" } }));
  assert.ok(kinds(none).includes("no_breakpoint"));
  const withBp = driver();
  const input = [{ role: "developer", content: [{ type: "input_text", text: filler(4000), prompt_cache_breakpoint: { mode: "explicit" } }] }, { role: "user", content: "hi" }];
  const req = openaiToReq(RESP, respBody({ prompt_cache_options: { mode: "explicit" }, input }))!;
  assert.deepEqual(req.messages[0].content[0].cache_control, { type: "ephemeral", ttl: "30m" });
  assert.ok(!("prompt_cache_breakpoint" in (req.messages[0].content[0] as object)), "breakpoint moved into the marker so moving it is not a rewrite");
  assert.ok(!kinds(withBp.call(RESP, respBody({ prompt_cache_options: { mode: "explicit" }, input }))).includes("no_breakpoint"));
});

test("diagnosis: wording for OpenAI is hedged: likely evicted after the typical lifetime, unknown mentions no guarantee", () => {
  const d = driver();
  d.call(CHAT, chatBody());
  d.advance(7200);
  const e = d.call(CHAT, chatBody());
  assert.deepEqual(kinds(e), ["ttl_expiry"]);
  assert.match(e.causes[0].detail, /likely evicted/);
  const u = driver();
  u.call(CHAT, chatBody());
  const e2 = u.call(CHAT, chatBody());
  assert.deepEqual(kinds(e2), ["unknown"]);
  assert.match(e2.causes[0].detail, /does not guarantee hits/);
});
