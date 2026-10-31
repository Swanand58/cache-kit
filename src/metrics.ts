import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { modelCfg, writePrice, type Config } from "./config.js";
import type { Cause, Entry, Ttl, Usage } from "./types.js";

const n = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : 0);

export function parseUsage(raw: any): Usage {
  const u: Usage = {
    input_tokens: n(raw?.input_tokens), output_tokens: n(raw?.output_tokens),
    cache_read_input_tokens: n(raw?.cache_read_input_tokens), cache_creation_input_tokens: n(raw?.cache_creation_input_tokens),
  };
  if (raw?.cache_creation && typeof raw.cache_creation === "object") u.cache_creation = raw.cache_creation;
  return u;
}

/** hit rate = read / (read + creation + input) */
export const hitRate = (u: Usage) => {
  const d = u.cache_read_input_tokens + u.cache_creation_input_tokens + u.input_tokens;
  return d ? u.cache_read_input_tokens / d : 0;
};

/** USD actually billed vs what the same tokens would cost with no caching. */
export function cost(cfg: Config, model: string, u: Usage, fallbackTtl: Ttl): { actual: number; uncached: number } {
  const mc = modelCfg(cfg, model);
  const w1h = u.cache_creation?.ephemeral_1h_input_tokens ?? (u.cache_creation ? 0 : fallbackTtl === "1h" ? u.cache_creation_input_tokens : 0);
  const w5m = u.cache_creation_input_tokens - w1h;
  const actual =
    (u.input_tokens * mc.input + u.output_tokens * mc.output + u.cache_read_input_tokens * mc.cache_read +
      w5m * writePrice(mc, "5m") + w1h * writePrice(mc, "1h")) / 1e6;
  const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens;
  return { actual, uncached: (total * mc.input + u.output_tokens * mc.output) / 1e6 };
}

export class Logger {
  private ready = false;
  constructor(readonly path: string) {}
  write(e: Entry) {
    if (!this.ready) { mkdirSync(dirname(this.path), { recursive: true }); this.ready = true; }
    appendFileSync(this.path, JSON.stringify(e) + "\n");
  }
}

/** Read entries; `tailBytes` limits reading to the end of a large log (status line use). */
export function readLog(path: string, tailBytes?: number): Entry[] {
  if (!existsSync(path)) return [];
  let text: string;
  const size = statSync(path).size;
  if (tailBytes && size > tailBytes) {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(tailBytes);
    readSync(fd, buf, 0, tailBytes, size - tailBytes);
    closeSync(fd);
    text = buf.toString("utf8").split("\n").slice(1).join("\n"); // drop the partial first line
  } else text = readFileSync(path, "utf8");
  const out: Entry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* skip torn line */ }
  }
  return out;
}

/**
 * All rows of one session (`sid`), or of the most recently active session when `sid` is undefined. Scans the whole
 * log in 4 MB chunks, but only JSON-parses lines that contain the session's id, so it stays fast and never loses a
 * session that fell out of a tail window (an id with no rows, e.g. a session that never used the proxy, is just []).
 * Rows are matched as compact JSON, exactly as Logger writes them.
 * ponytail: linear in log size (measured: ~0.24 s for an 80 MB log, ~0.07 s for a small one); add rotation or an
 * index if logs reach hundreds of MB.
 */
export function readSession(path: string, sid?: string): Entry[] {
  if (!existsSync(path)) return [];
  const id = sid ?? readLog(path, 1 << 16).at(-1)?.session;
  if (!id) return [];
  const needle = Buffer.from(`"session":${JSON.stringify(id)}`);
  const out: Entry[] = [];
  const take = (line: Buffer) => {
    if (!line.includes(needle)) return;
    try { const e = JSON.parse(line.toString("utf8")) as Entry; if (e.session === id) out.push(e); } catch { /* torn line */ }
  };
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(4 << 20);
    let carry = Buffer.alloc(0);
    for (let pos = 0; ; ) {
      const n = readSync(fd, buf, 0, buf.length, pos);
      if (!n) break;
      pos += n;
      const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n);
      let start = 0, i: number;
      while ((i = data.indexOf(10, start)) >= 0) { take(data.subarray(start, i)); start = i + 1; }
      carry = Buffer.from(data.subarray(start)); // copy: `buf` is reused for the next chunk
    }
    take(carry);
  } finally { closeSync(fd); }
  return out;
}

export interface Totals {
  calls: number; read: number; creation: number; input: number; output: number;
  hit_rate: number; cost: number; uncached: number; saved: number; misses: number;
  causes: Record<string, number>;
}

export const emptyTotals = (): Totals =>
  ({ calls: 0, read: 0, creation: 0, input: 0, output: 0, hit_rate: 0, cost: 0, uncached: 0, saved: 0, misses: 0, causes: {} });

/** Fold one entry into `t` (in place). Keep-alive refreshes count toward cost but not hit rate or call/miss counts. */
export function addEntry(t: Totals, e: Entry): Totals {
  if (e.status >= 400) return t;
  t.cost += e.cost.actual;
  if (e.kind !== "keepalive") {
    t.calls++;
    t.read += e.usage.cache_read_input_tokens; t.creation += e.usage.cache_creation_input_tokens;
    t.input += e.usage.input_tokens; t.output += e.usage.output_tokens;
    t.uncached += e.cost.uncached;
    if (e.miss) {
      t.misses++;
      for (const c of e.causes) t.causes[c.kind] = (t.causes[c.kind] ?? 0) + 1;
    }
  }
  t.hit_rate = hitRate({ input_tokens: t.input, output_tokens: 0, cache_read_input_tokens: t.read, cache_creation_input_tokens: t.creation });
  t.saved = t.uncached - t.cost;
  return t;
}

export const aggregate = (entries: Entry[]): Totals => entries.reduce(addEntry, emptyTotals());

const usd = (x: number, d = Math.abs(x) < 0.01 ? 4 : 2) => `${x < 0 ? "-" : ""}$${Math.abs(x).toFixed(d)}`;
/** Two figures that are shown side by side get the same precision ($0.0093 vs $0.0100, not $0.0093 vs $0.01). */
const usdPair = (a: number, b: number): [string, string] => {
  const d = Math.max(Math.abs(a), Math.abs(b)) < 0.1 ? 4 : 2;
  return [usd(a, d), usd(b, d)];
};
const k = (x: number) => (x >= 10000 ? `${(x / 1000).toFixed(1)}k` : String(x));
export { usd, usdPair };

export function summaryLine(e: Entry, cum: Totals, label: string): string {
  const u = e.usage;
  const base = `[cachekit] ${label} ${e.model} hit ${(e.hit_rate * 100).toFixed(0)}% (read ${k(u.cache_read_input_tokens)} write ${k(u.cache_creation_input_tokens)} in ${k(u.input_tokens)} out ${k(u.output_tokens)}) ${usdPair(e.cost.actual, e.cost.uncached).join(" vs ")} uncached | session ${(cum.hit_rate * 100).toFixed(0)}%`;
  return e.miss ? `${base} | MISS: ${e.causes.map((c: Cause) => c.detail).join("; ")}` : base;
}
