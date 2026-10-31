import assert from "node:assert/strict";
import { test } from "node:test";
import { countMarkers, placeBreakpoints } from "../src/breakpoints.js";
import type { Req } from "../src/types.js";
import { filler, testCfg } from "./helpers.js";

const big = () => ({ model: "claude-opus-5-5", system: filler(4000), messages: [{ role: "user", content: filler(4000) }] }) as Req;

test("fresh request gets a marker at end of system and at end of history", () => {
  const r = big();
  placeBreakpoints(r, testCfg());
  assert.ok((r.system as any[])[0].cache_control);
  assert.ok((r.messages[0].content as any[])[0].cache_control);
  assert.equal(countMarkers(r), 2);
});

test("string content is wrapped, text unchanged", () => {
  const r = big();
  const text = r.messages[0].content;
  placeBreakpoints(r, testCfg());
  assert.equal((r.messages[0].content as any[])[0].text, text);
});

test("never exceeds 4 breakpoints counting existing ones, never moves existing ones", () => {
  const mk = (n: number) => {
    const r = big();
    r.tools = Array.from({ length: n }, (_, i) => ({ name: `t${i}`, cache_control: { type: "ephemeral" } })) as never;
    return r;
  };
  const three = mk(3); placeBreakpoints(three, testCfg()); assert.equal(countMarkers(three), 4);
  const four = mk(4); const notes = placeBreakpoints(four, testCfg()); assert.equal(countMarkers(four), 4);
  assert.ok(notes.some((n) => n.includes("4 breakpoints")));
  assert.ok(four.tools!.every((t) => t.cache_control));
});

test("skips a breakpoint whose prefix is under the model minimum", () => {
  const small = { model: "claude-opus-4-6", system: "short", messages: [{ role: "user", content: "hi" }] } as Req; // min 4096
  const notes = placeBreakpoints(small, testCfg());
  assert.equal(countMarkers(small), 0);
  assert.ok(notes.every((n) => n.startsWith("skip")));
});

test("minimum is per model: same prompt caches on a 512-minimum model, not on a 4096 one", () => {
  const mk = (model: string) => ({ model, system: filler(3000), messages: [{ role: "user", content: "hi" }] }) as Req; // ~750 tokens
  const a = mk("claude-opus-5-5"); placeBreakpoints(a, testCfg());
  const b = mk("claude-opus-4-6"); placeBreakpoints(b, testCfg());
  assert.ok(countMarkers(a) > 0);
  assert.equal(countMarkers(b), 0);
});

test("history marker can pass when the system prefix alone is too small", () => {
  const r = { model: "claude-opus-4-6", system: "tiny", messages: [{ role: "user", content: filler(20000) }] } as Req;
  placeBreakpoints(r, testCfg());
  assert.equal(countMarkers(r), 1);
  assert.equal((r.system as any[])[0].cache_control, undefined);
});

test("configured models override the table", () => {
  const r = { model: "claude-opus-4-6", system: "tiny", messages: [{ role: "user", content: "hi" }] } as Req;
  placeBreakpoints(r, testCfg({ models: { "claude-opus-4-6": { min_tokens: 1 } } }));
  assert.ok(countMarkers(r) > 0);
});

test("ttl = 1h puts ttl on the markers", () => {
  const r = big();
  placeBreakpoints(r, testCfg({ ttl: "1h" }));
  assert.equal((r.system as any[])[0].cache_control.ttl, "1h");
});

test("5m markers omit ttl (API default)", () => {
  const r = big();
  placeBreakpoints(r, testCfg());
  assert.deepEqual((r.system as any[])[0].cache_control, { type: "ephemeral" });
});

test("skips thinking blocks and empty text when choosing the block to mark", () => {
  const r = big();
  r.messages = [{ role: "assistant", content: [{ type: "text", text: filler(4000) }, { type: "thinking", thinking: "x" }, { type: "text", text: "" }] }];
  placeBreakpoints(r, testCfg());
  const blocks = r.messages[0].content as any[];
  assert.ok(blocks[0].cache_control);
  assert.equal(blocks[1].cache_control, undefined);
  assert.equal(blocks[2].cache_control, undefined);
});

test("no system: marks the last tool", () => {
  const r = { model: "claude-opus-5-5", tools: [{ name: "a", d: filler(4000) }, { name: "b" }], messages: [{ role: "user", content: "hi" }] } as unknown as Req;
  placeBreakpoints(r, testCfg());
  assert.ok(r.tools![1].cache_control);
});

test("idempotent: placing twice changes nothing", () => {
  const r = big();
  placeBreakpoints(r, testCfg());
  const once = JSON.stringify(r);
  placeBreakpoints(r, testCfg());
  assert.equal(JSON.stringify(r), once);
});
