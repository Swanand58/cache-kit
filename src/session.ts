import { hash, systemText, blocksOf } from "./normalize.js";
import { addEntry, cost, emptyTotals, hitRate, type Totals } from "./metrics.js";
import { diff, snapshot, type Snapshot } from "./prefix.js";
import type { Config } from "./config.js";
import type { Cause, CauseKind, Entry, Req, Usage } from "./types.js";

interface Lineage { id: string; lines: Set<string>; tools: Set<string>; first: string; prev?: Snapshot; prevAt: number; prevCached: number; calls: number }
interface Session { id: string; lineages: Lineage[]; totals: Totals }

export interface Ctx {
  sid: string;
  lineage: Lineage;
  snap: Snapshot;
  start: number;
  /** another request with the same head was in flight and had not begun streaming when this one started */
  parallel: boolean;
  streaming: boolean;
  done: boolean;
  req: Req;
}

export interface EndInfo {
  usage?: Usage;
  status: number;
  stream: boolean;
  rewrites?: string[];
  warnings?: string[];
  error?: string;
}

const ZERO: Usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
// compaction outranks system/tools: /compact swaps the system prompt and rewrites history in one go, and the history is the cause
const ORDER: CauseKind[] = ["model", "thinking", "compaction", "tools", "tool_order", "system", "ttl_expiry", "parallel", "no_breakpoint", "below_min", "first_call", "unknown"];

const jaccard = (a: Set<string>, b: Set<string>) => {
  if (!a.size && !b.size) return 1;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
};

/** Text of the first user message, only up to the last breakpoint: the uncached tail is volatile by definition. */
export const firstUserText = (req: Req, marker: Snapshot["marker"] = null) => {
  const i = req.messages.findIndex((x) => x.role === "user");
  if (i < 0) return "";
  const blocks = blocksOf(req.messages[i].content);
  return (marker?.msg === i ? blocks.slice(0, marker.block + 1) : blocks).map((b) => b.text ?? "").join("\n");
};
/** Session id from a header, else a hash of the system prompt + first user message. */
export const deriveSession = (req: Req, header: string | undefined, marker: Snapshot["marker"]) =>
  header || "h-" + hash(systemText(req.system) + "\0" + firstUserText(req, marker));

/**
 * Tracks sessions and prefix lineages. A lineage is one agent's call chain: calls whose system prompt is mostly the
 * same line set, or that start with the same first user message, belong together (so system edits and tool/model
 * changes are *diffs*); a different system prompt and task starts a new lineage (subagent, title generator) and never
 * pollutes the main chain's diffs.
 * ponytail: with no system prompt at all, lineages match on tool names instead.
 */
export class Tracker {
  private sessions = new Map<string, Session>();
  private waiting = new Map<string, number>();

  constructor(private cfg: Config, private now: () => number = Date.now) {}

  begin(req: Req, sessionHeader?: string): Ctx {
    const snap = snapshot(req);
    const sid = deriveSession(req, sessionHeader, snap.marker);
    let s = this.sessions.get(sid);
    if (!s) this.sessions.set(sid, (s = { id: sid, lineages: [], totals: emptyTotals() }));

    const lines = new Set(snap.systemLines.filter(Boolean).map(hash));
    const tools = new Set(snap.toolNames);
    const ft = firstUserText(req, snap.marker);
    const first = ft ? hash(ft) : "";
    let best: Lineage | undefined, bestScore = 0.5;
    for (const l of s.lineages) {
      // same agent if the system prompt mostly matches, or the conversation starts the same way (system edited mid-session)
      const score = first && l.first === first ? 1 : lines.size || l.lines.size ? jaccard(lines, l.lines) : jaccard(tools, l.tools);
      if (score >= bestScore) { best = l; bestScore = score; }
    }
    if (!best) s.lineages.push((best = { id: `${s.lineages.length}-${snap.head.slice(0, 6)}`, lines, tools, first, prevAt: 0, prevCached: 0, calls: 0 }));

    const key = `${sid}|${best.id}|${snap.head}`;
    const w = this.waiting.get(key) ?? 0;
    this.waiting.set(key, w + 1);
    return { sid, lineage: best, snap, start: this.now(), parallel: w > 0, streaming: false, done: false, req };
  }

  /** Call when the response begins (first byte). Entries become readable from here. */
  firstByte(ctx: Ctx) {
    if (ctx.streaming) return;
    ctx.streaming = true;
    this.release(ctx);
  }

  /** Request failed or was cut off before a usable response. */
  abort(ctx: Ctx) {
    ctx.done = true;
    if (!ctx.streaming) this.release(ctx);
  }

  private release(ctx: Ctx) {
    const key = `${ctx.sid}|${ctx.lineage.id}|${ctx.snap.head}`;
    const w = (this.waiting.get(key) ?? 1) - 1;
    if (w <= 0) this.waiting.delete(key); else this.waiting.set(key, w);
  }

  end(ctx: Ctx, info: EndInfo): Entry {
    this.abort(ctx);
    const { lineage: l, snap } = ctx;
    const usage = info.usage ?? ZERO;
    const ok = info.status < 400 && !!info.usage;
    const prev = l.prev;
    const miss = ok && (usage.cache_read_input_tokens === 0 || usage.cache_read_input_tokens < 0.5 * l.prevCached);

    let causes: Cause[] = [];
    let gap_s: number | undefined;
    if (miss) {
      if (!prev) causes.push({ kind: "first_call", detail: "first call in this lineage (cold cache)" });
      else {
        causes.push(...diff(prev, snap));
        gap_s = Math.round((ctx.start - l.prevAt) / 1000);
        const ttl_s = prev.ttl === "1h" ? 3600 : 300;
        if (gap_s > ttl_s) causes.push({ kind: "ttl_expiry", detail: `ttl expiry: ${gap_s}s since the last call, ${prev.ttl} TTL` });
      }
      if (ctx.parallel) causes.push({ kind: "parallel", detail: "parallel: same prefix in flight before the first response began; warm the cache with one call before fanning out" });
      if (!snap.hasMarker) causes.push({ kind: "no_breakpoint", detail: "request has no cache_control breakpoint" });
      else if (usage.cache_creation_input_tokens === 0 && usage.cache_read_input_tokens === 0)
        causes.push({ kind: "below_min", detail: "breakpoint set but nothing was written: prefix likely under the model's minimum cacheable size" });
      if (!causes.length) causes.push({ kind: "unknown", detail: "prefix identical and within TTL; check workspace/org change, 20-block lookback, or server-side invalidation" });
      causes.sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
    }

    if (ok) {
      l.prev = snap; l.prevAt = ctx.start; l.prevCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens; l.calls++;
    }
    const e: Entry = {
      ts: ctx.start, kind: "call", session: ctx.sid, lineage: l.id, model: String(ctx.req.model),
      status: info.status, stream: info.stream, usage, hit_rate: hitRate(usage), miss, causes,
      cost: ok ? cost(this.cfg, ctx.req.model, usage, snap.ttl) : { actual: 0, uncached: 0 },
      prefix_hash: snap.prefix, ttl: snap.ttl, rewrites: info.rewrites ?? [], warnings: info.warnings ?? [],
    };
    if (gap_s !== undefined) e.gap_s = gap_s;
    if (info.error) e.error = info.error;
    addEntry(this.sessions.get(ctx.sid)!.totals, e);
    return e;
  }

  /** A keep-alive refresh restarts the TTL clock for the lineage. */
  refreshed(sid: string, lineageId: string, usage: Usage, at = this.now()) {
    const l = this.sessions.get(sid)?.lineages.find((x) => x.id === lineageId);
    if (l) { l.prevAt = at; l.prevCached = usage.cache_read_input_tokens + usage.cache_creation_input_tokens || l.prevCached; }
  }

  totals(sid: string): Totals { return this.sessions.get(sid)?.totals ?? emptyTotals(); }
  /** "main" for the lineage with the most calls in its session, else "sub". */
  label(ctx: Ctx) {
    const s = this.sessions.get(ctx.sid)!;
    return s.lineages.every((x) => x.calls <= ctx.lineage.calls) ? "main" : "sub";
  }
}
