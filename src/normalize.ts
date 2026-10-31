import { createHash } from "node:crypto";
import type { Block, Msg, Req, Tool } from "./types.js";

export const hash = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 12);

function sortKeys(v: any, dropCache: boolean): any {
  if (Array.isArray(v)) return v.map((x) => sortKeys(x, dropCache));
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) if (!(dropCache && k === "cache_control")) out[k] = sortKeys(v[k], dropCache);
    return out;
  }
  return v;
}
/** Deterministic JSON: object keys sorted recursively, array order kept. `dropCache` omits cache_control (for hashing). */
export const canon = (v: unknown, dropCache = false) => JSON.stringify(sortKeys(v, dropCache));

export const blocksOf = (c: string | Block[]): Block[] => (typeof c === "string" ? [{ type: "text", text: c }] : c);
export const systemBlocks = (s: Req["system"]): Block[] => (s === undefined ? [] : blocksOf(s));
export const systemText = (s: Req["system"]) => systemBlocks(s).map((b) => b.text ?? "").join("\n");
export const toBlocks = (x: string | Block | Block[]): Block[] =>
  typeof x === "string" ? [{ type: "text", text: x }] : Array.isArray(x) ? x : [x];

/** Rough token estimate (~4 chars/token). ponytail: base64 images/PDFs overcount; use tokens.count="api" to calibrate. */
export const estimateTokens = (x: unknown) => Math.ceil(JSON.stringify(x).length / 4);

const VOLATILE: [string, RegExp][] = [
  ["timestamp", /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/],
  ["date", /\b20\d{2}-\d{2}-\d{2}\b/],
  ["current date/time", /\b(?:today is|(?:current|today'?s?|now)\W{0,3}(?:date|time))\b/i],
  ["uuid", /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i],
  ["epoch", /\b1[6-9]\d{8}(?:\d{3})?\b/],
  ["random id", /\b(?:req|msg|session|request|toolu)_[A-Za-z0-9]{12,}\b/],
  ["hex token", /\b[0-9a-f]{32,}\b/i],
];

/**
 * Volatile values in tools/system (the parts that must stay byte-stable). Messages are not scanned:
 * history is append-only, so a date in an old user turn is stable; if it does change, the prefix diff reports it.
 * Returns `kind in where` strings only, never the matched text (logs must not carry prompt content).
 */
export function findVolatile(req: Pick<Req, "system" | "tools">): string[] {
  const found = new Set<string>();
  const scan = (where: string, text: string) => {
    for (const [kind, re] of VOLATILE) if (re.test(text)) found.add(`${kind} in ${where}`);
  };
  systemBlocks(req.system).forEach((b, i) => (b.text ?? "").split("\n").forEach((line, n) => scan(`system block ${i} line ${n + 1}`, line)));
  for (const t of req.tools ?? []) scan(`tool \`${t.name}\``, JSON.stringify(t));
  return [...found];
}

export interface NormalizeOpts { static?: string | Block | Block[]; sortTools?: boolean }

/**
 * Library-mode normalization: deterministic tools (sorted by name, keys sorted), `static` blocks appended to
 * `system`. Only order and wrapper shape change; no text is edited. Returns a clone.
 */
export function normalize(input: Req, opts: NormalizeOpts = {}): { req: Req; rewrites: string[] } {
  const req = structuredClone(input);
  const rewrites: string[] = [];
  if (req.tools?.length) {
    const before = JSON.stringify(req.tools);
    let tools = req.tools.map((t) => sortKeys(t, false) as Tool);
    if (opts.sortTools !== false) tools = tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    if (JSON.stringify(tools) !== before) rewrites.push("tools: sorted by name, JSON keys sorted");
    req.tools = tools;
  }
  if (opts.static !== undefined) {
    const extra = toBlocks(opts.static);
    req.system = [...systemBlocks(req.system), ...extra];
    rewrites.push(`system: appended ${extra.length} static block(s) after system prompt`);
  }
  return { req, rewrites };
}

/** Append per-call content after the last breakpoint, as a trailing text block of the final user message. */
export function appendVolatile(req: Req, volatile: string | Block | Block[]): string {
  const extra = toBlocks(volatile);
  const last = req.messages[req.messages.length - 1] as Msg | undefined;
  if (last?.role === "user") {
    last.content = [...blocksOf(last.content), ...extra];
    return `messages: appended ${extra.length} volatile block(s) to last user message`;
  }
  req.messages.push({ role: "user", content: extra });
  return `messages: appended volatile content as new user message`;
}
