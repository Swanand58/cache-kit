/**
 * Quality check: the same prompts through the raw SDK and through cachekit, side by side.
 *
 *   ANTHROPIC_API_KEY=... npx tsx eval/run.ts [--model claude-haiku-5-5] [--prompts eval/prompts.json] [--mock]
 *
 * Current models reject temperature, so outputs are not bit-identical run to run. Each prompt therefore runs
 * raw twice (raw vs raw = the sampling noise floor) and once through cachekit. Quality is "unchanged" if
 * raw-vs-cachekit similarity is within 0.05 of that noise floor and every `expect` regex holds for both.
 * `--mock` uses a fake client (no network, no key) to check the plumbing.
 */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { CacheClient } from "../src/client.js";

const { values: v } = parseArgs({ options: { model: { type: "string" }, prompts: { type: "string" }, mock: { type: "boolean" }, out: { type: "string" } } });
const MODEL = v.model ?? process.env.CACHEKIT_EVAL_MODEL ?? "claude-haiku-5-5";
interface P { name: string; use_doc?: boolean; messages: { role: "user" | "assistant"; content: string }[]; volatile?: string; expect?: string[] }
const prompts: P[] = JSON.parse(readFileSync(v.prompts ?? new URL("./prompts.json", import.meta.url), "utf8"));

const SYSTEM = "You are a precise assistant. Answer exactly as asked.";
// ~3k tokens of reference facts: enough to clear the cache minimum on every current model
const DOC = "Widget code reference:\n" + Array.from({ length: 150 }, (_, i) => `Widget ${i + 1} has code W-${(i + 1) * 7}. It ships in box type ${String.fromCharCode(65 + (i % 26))} and was inspected by team ${(i * 13) % 17}.`).join("\n");

const text = (m: Anthropic.Message) => m.content.map((b) => (b.type === "text" ? b.text : "")).join("").trim();
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z0-9-]+/g) ?? []);
export function similarity(a: string, b: string) {
  const A = words(a), B = words(b);
  if (!A.size && !B.size) return 1;
  let i = 0; for (const w of A) if (B.has(w)) i++;
  return i / (A.size + B.size - i);
}

const fake = (): Anthropic => ({
  messages: { create: async (r: any) => ({ id: "x", stop_reason: "end_turn", content: [{ type: "text", text: `echo: ${JSON.stringify(r.messages.at(-1).content).slice(0, 60)}` }], usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } }) },
}) as never;

async function main() {
  const sdk = v.mock ? fake() : new Anthropic();
  const ck = new CacheClient({ client: sdk, config: { log: { quiet: true } } });
  const rows: any[] = [];
  for (const p of prompts) {
    // identical content both ways: raw puts the doc after the system prompt and the volatile line at the end of the last user turn, unmarked
    const system = p.use_doc ? [{ type: "text", text: SYSTEM }, { type: "text", text: DOC }] : [{ type: "text", text: SYSTEM }];
    const messages = structuredClone(p.messages) as any[];
    if (p.volatile) { const last = messages[messages.length - 1]; last.content = [{ type: "text", text: last.content }, { type: "text", text: p.volatile }]; }
    const base = { model: MODEL, max_tokens: 400 };
    const raw1 = (await sdk.messages.create({ ...base, system, messages } as never)) as Anthropic.Message;
    const raw2 = (await sdk.messages.create({ ...base, system, messages } as never)) as Anthropic.Message;
    const viaCk = await ck.create({ ...base, system: SYSTEM, ...(p.use_doc ? { static: DOC } : {}), messages: p.messages, ...(p.volatile ? { volatile: p.volatile } : {}) });
    const [a, b, c] = [text(raw1), text(raw2), text(viaCk)];
    const ok = (s: string) => (p.expect ?? []).every((re) => new RegExp(re).test(s));
    rows.push({ name: p.name, raw: a, raw2: b, cachekit: c, sim_noise: similarity(a, b), sim_ck: similarity(a, c), stop: [raw1.stop_reason, viaCk.stop_reason], expect_raw: ok(a), expect_ck: ok(c), ck_usage: viaCk.usage });
  }
  const clip = (s: string, n = 44) => (s.replace(/\s+/g, " ").slice(0, n)).padEnd(n);
  console.log(`model: ${MODEL}\n`);
  console.log(`${"prompt".padEnd(16)} | ${"raw".padEnd(44)} | ${"cachekit".padEnd(44)} | sim(noise) sim(ck) expect`);
  for (const r of rows)
    console.log(`${r.name.padEnd(16)} | ${clip(r.raw)} | ${clip(r.cachekit)} | ${r.sim_noise.toFixed(2).padStart(10)} ${r.sim_ck.toFixed(2).padStart(7)} raw:${r.expect_raw ? "ok" : "FAIL"} ck:${r.expect_ck ? "ok" : "FAIL"}`);
  const mean = (k: string) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  const regressions = rows.filter((r) => r.expect_raw && !r.expect_ck).length;
  const verdict = mean("sim_ck") >= mean("sim_noise") - 0.05 && regressions === 0;
  const st = ck.stats();
  console.log(`\nmean similarity: raw-vs-raw ${mean("sim_noise").toFixed(2)} (noise floor), raw-vs-cachekit ${mean("sim_ck").toFixed(2)}; expectation regressions: ${regressions}`);
  console.log(`cachekit side: hit rate ${(st.hit_rate * 100).toFixed(0)}%, cost $${st.cost.toFixed(4)} vs $${st.uncached.toFixed(4)} uncached`);
  console.log(verdict ? "VERDICT: quality unchanged within sampling noise" : "VERDICT: possible difference, inspect eval/results.json");
  writeFileSync(v.out ?? new URL("./results.json", import.meta.url), JSON.stringify(rows, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
