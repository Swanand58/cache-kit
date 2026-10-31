import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import type { Req, Usage } from "../src/types.js";

export const tmpLog = () => join(mkdtempSync(join(tmpdir(), "cachekit-")), "log.jsonl");
export const testCfg = (over: Record<string, unknown> = {}): Config =>
  loadConfig(undefined, { log: { path: tmpLog(), quiet: true }, ...over });

export const filler = (n: number) => "lorem ipsum dolor sit amet ".repeat(Math.ceil(n / 27)).slice(0, n);
export const usage = (read: number, creation: number, input = 10, output = 5): Usage => ({
  input_tokens: input, output_tokens: output, cache_read_input_tokens: read, cache_creation_input_tokens: creation,
});

/** A request with a 20-line system prompt, two tools and three messages, markers at end of system and history. */
export function baseReq(over: Partial<Req> = {}): Req {
  const system = Array.from({ length: 20 }, (_, i) => `rule ${i + 1}: ${filler(200)}`).join("\n");
  return {
    model: "claude-opus-5-5",
    max_tokens: 100,
    tools: [
      { name: "search", description: "search", input_schema: { type: "object", properties: { q: { type: "string" } } } },
      { name: "fetch", description: "fetch", input_schema: { type: "object", properties: { url: { type: "string" } } } },
    ],
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: [{ type: "text", text: "question", cache_control: { type: "ephemeral" } }] },
    ],
    ...over,
  };
}
