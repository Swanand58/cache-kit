import assert from "node:assert/strict";
import { test } from "node:test";
import { appendVolatile, canon, findVolatile, normalize } from "../src/normalize.js";
import type { Req } from "../src/types.js";
import { baseReq } from "./helpers.js";

test("canon sorts keys recursively and keeps array order", () => {
  assert.equal(canon({ b: 1, a: { d: [3, 1], c: 2 } }), '{"a":{"c":2,"d":[3,1]},"b":1}');
});

test("tool definitions serialize identically regardless of input order or key order", () => {
  const a = baseReq();
  const b = baseReq({ tools: [...a.tools!].reverse().map((t) => Object.fromEntries(Object.entries(t).reverse()) as never) });
  assert.equal(JSON.stringify(normalize(a).req.tools), JSON.stringify(normalize(b).req.tools));
  assert.deepEqual(normalize(b).req.tools!.map((t) => t.name), ["fetch", "search"]);
});

test("normalize reports a rewrite only when something moved", () => {
  const sorted = normalize(baseReq()).req;
  assert.deepEqual(normalize(sorted).rewrites, []);
  assert.ok(normalize(baseReq()).rewrites.some((r) => r.includes("tools")));
});

test("normalize does not mutate its input", () => {
  const r = baseReq();
  const before = JSON.stringify(r);
  normalize(r, { static: "doc" });
  assert.equal(JSON.stringify(r), before);
});

test("static blocks go after system, text content is only reordered never edited", () => {
  const r = baseReq({ system: "SYS" });
  const { req } = normalize(r, { static: [{ type: "text", text: "DOC1" }, { type: "text", text: "DOC2" }] });
  assert.deepEqual((req.system as any[]).map((b) => b.text), ["SYS", "DOC1", "DOC2"]);
});

test("volatile content lands in the final user message after existing content", () => {
  const r = baseReq();
  appendVolatile(r, "now: whenever");
  const last = r.messages[r.messages.length - 1].content as any[];
  assert.equal(last[0].text, "question");
  assert.equal(last[last.length - 1].text, "now: whenever");
});

test("volatile appended after an assistant turn becomes a new user message", () => {
  const r: Req = { model: "m", messages: [{ role: "assistant", content: "x" }] };
  appendVolatile(r, "v");
  assert.equal(r.messages[1].role, "user");
});

test("findVolatile flags timestamps, uuids, current date in system and tools; reports no matched text", () => {
  const found = findVolatile({
    system: [{ type: "text", text: "Be nice.\nCurrent date: Friday\nrun id 3f2b8c1e-1a2b-4c3d-8e9f-0a1b2c3d4e5f\nat 2026-10-31T10:11:12Z" }],
    tools: [{ name: "t", description: "generated at 1761900000" }],
  });
  const joined = found.join("|");
  for (const k of ["current date/time", "uuid", "timestamp", "epoch"]) assert.ok(joined.includes(k), k);
  assert.ok(found.some((f) => f.includes("system block 0 line 2")));
  assert.ok(!joined.includes("3f2b8c1e"));
});

test("findVolatile is quiet on a stable prompt", () => {
  assert.deepEqual(findVolatile({ system: "You are a helpful assistant. Answer briefly." }), []);
});
