import { aggregate, usd, usdPair } from "./metrics.js";
import type { Cause } from "./types.js";
import type { Entry } from "./types.js";

/** Entries of one session: `sid`, else the session with the most recent entry. */
export function sessionEntries(entries: Entry[], sid?: string): Entry[] {
  const id = sid ?? entries[entries.length - 1]?.session;
  return id ? entries.filter((e) => e.session === id) : [];
}

/** Per session, the lineage with the most calls is "main"; others are "sub". */
export function labels(entries: Entry[]) {
  const counts = new Map<string, Map<string, number>>();
  for (const e of entries) {
    if (e.kind !== "call" || e.status >= 400) continue;
    const m = counts.get(e.session) ?? counts.set(e.session, new Map()).get(e.session)!;
    m.set(e.lineage, (m.get(e.lineage) ?? 0) + 1);
  }
  const main = new Map<string, string>();
  for (const [s, m] of counts) main.set(s, [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]);
  return (e: Entry) => (main.get(e.session) === e.lineage ? "main" : "sub");
}

export function buildReport(entries: Entry[]) {
  const t = aggregate(entries);
  const label = labels(entries);
  const lin = new Map<string, Entry[]>();
  for (const e of entries) if (e.kind === "call") (lin.get(`${e.session}/${e.lineage}`) ?? lin.set(`${e.session}/${e.lineage}`, []).get(`${e.session}/${e.lineage}`)!).push(e);
  const warnings = new Map<string, number>();
  for (const e of entries) for (const w of e.warnings) warnings.set(w, (warnings.get(w) ?? 0) + 1);
  return {
    calls: t.calls, sessions: new Set(entries.map((e) => e.session)).size,
    tokens: { read: t.read, creation: t.creation, input: t.input, output: t.output },
    hit_rate: t.hit_rate,
    cost: t.cost, cost_uncached: t.uncached, saved: t.saved, saved_pct: t.uncached ? t.saved / t.uncached : 0,
    misses: t.misses,
    top_causes: Object.entries(t.causes).sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, count })),
    lineages: [...lin.values()].map((es) => ({ session: es[0].session, lineage: es[0].lineage, label: label(es[0]), ...(({ calls, hit_rate }) => ({ calls, hit_rate }))(aggregate(es)) })),
    warnings: [...warnings.entries()].sort((a, b) => b[1] - a[1]).map(([warning, count]) => ({ warning, count })),
    advice: [
      ...(t.causes.parallel ? ["Parallel requests with the same prefix all miss: send one request, wait for its first streamed token, then fan out the rest."] : []),
      ...(t.causes.ttl_expiry ? ["TTL expiries: consider the 1h TTL (ttl = \"1h\") or opt-in keep-alive; `cachekit proxy --keepalive` prints the break-even."] : []),
      ...(t.causes.no_breakpoint ? ["Some requests carry no cache_control. Run the proxy with --optimize to add breakpoints."] : []),
    ],
  };
}

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

export function formatReport(r: ReturnType<typeof buildReport>): string {
  const out = [
    `calls: ${r.calls} across ${r.sessions} session(s)`,
    `tokens: read ${r.tokens.read}  write ${r.tokens.creation}  uncached-in ${r.tokens.input}  out ${r.tokens.output}`,
    `hit rate: ${pct(r.hit_rate)}`,
    `cost: ${usdPair(r.cost, r.cost_uncached)[0]} (would be ${usdPair(r.cost, r.cost_uncached)[1]} without caching) -> saved ${usd(r.saved)} (${pct(r.saved_pct)})`,
    `misses: ${r.misses}`,
  ];
  if (r.top_causes.length) out.push("", "top causes of misses:", ...r.top_causes.map((c) => `  ${String(c.count).padStart(4)}  ${c.kind}`));
  if (r.lineages.length > 1) out.push("", "lineages (main agent vs subagents):", ...r.lineages.map((l) => `  ${l.label.padEnd(4)} ${l.session.slice(0, 12)}/${l.lineage}  ${l.calls} calls  hit ${pct(l.hit_rate)}`));
  if (r.warnings.length) out.push("", "volatile values in the cacheable prefix:", ...r.warnings.slice(0, 10).map((w) => `  ${w.warning} (x${w.count})`));
  if (r.advice.length) out.push("", ...r.advice.map((a) => `advice: ${a}`));
  return out.join("\n");
}

export function lastMiss(entries: Entry[], sid?: string) {
  const es = sessionEntries(entries, sid).filter((e) => e.kind === "call" && e.miss);
  const e = es[es.length - 1];
  return e
    ? { found: true, at: new Date(e.ts).toISOString(), session: e.session, lineage: e.lineage, label: labels(entries)(e), model: e.model, causes: e.causes, usage: e.usage, gap_s: e.gap_s ?? null }
    : { found: false };
}

/** One line for a Claude Code status line. */
export function statusLine(entries: Entry[], sid?: string): string {
  const es = sessionEntries(entries, sid);
  if (!es.length) return "cachekit: no data";
  const t = aggregate(es);
  const m = lastRealMiss(es);
  return `cache ${(t.hit_rate * 100).toFixed(0)}% hit | saved ${usd(t.saved)} | ${t.calls} calls${m ? ` | last miss: ${m.kind}` : ""}`;
}

/** The "recent" hit rates cover this many most recent calls (token-weighted). */
export const RECENT_CALLS = 3;

const ok = (e: Entry) => e.kind === "call" && e.status < 400;

/** Latest miss that is not just a cold start (`first_call`); `kind` is its first non-cold-start cause. */
export function lastRealMiss(es: Entry[]) {
  const label = labels(es);
  for (let i = es.length - 1; i >= 0; i--) {
    const e = es[i];
    const c = ok(e) && e.miss ? e.causes.find((x) => x.kind !== "first_call") : undefined;
    if (c) return { kind: c.kind, ts: e.ts, label: label(e) };
  }
  return null;
}

/**
 * `status --json`: the full report for ONE session, plus which session it is and its misses.
 * With an explicit `sid` that has no rows this is `{ calls: 0 }`; it never falls back to another session.
 * Only with no `sid` at all does it use the most recently active session (for humans at a prompt).
 * `es` must already be that session's rows (see readSession); `sid` just picks it out of a mixed list.
 */
export function statusReport(entries: Entry[], sid?: string) {
  const es = sessionEntries(entries, sid);
  if (!es.length) return { calls: 0 };
  const label = labels(es);
  const calls = es.filter(ok);
  const main = calls.filter((e) => label(e) === "main");
  const rate = (xs: Entry[]) => aggregate(xs).hit_rate;
  const miss = [...es].reverse().find((e) => ok(e) && e.miss);
  return {
    ...buildReport(es),
    session: es[0].session,
    main_hit_rate: rate(main),
    recent_hit_rate: rate(calls.slice(-RECENT_CALLS)),
    recent_main_hit_rate: rate(main.slice(-RECENT_CALLS)),
    last_miss: miss ? { kind: miss.causes[0]?.kind ?? "unknown", ts: miss.ts, label: label(miss) } : null,
    last_real_miss: lastRealMiss(es),
  };
}

const n = (x: number) => (x >= 10000 ? `${(x / 1000).toFixed(1)}k` : String(x));
const two = (x: number) => String(x).padStart(2, "0");

/**
 * Human-readable log: one line per call, causes indented under misses, then a totals line.
 * `all` is the whole log (so main/sub labels are right even when `shown` is just the tail).
 */
export function formatLog(shown: Entry[], opts: { verbose?: boolean; color?: boolean; all?: Entry[] } = {}): string {
  const paint = (code: string, s: string) => (opts.color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const label = labels(opts.all ?? shown);
  const multi = new Set(shown.map((e) => e.session)).size > 1;
  const out: string[] = [];
  for (const e of shown) {
    const d = new Date(e.ts);
    const when = `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
    const tag = e.status >= 400 ? paint("33", `ERR ${e.status}`.padEnd(7)) : e.kind === "keepalive" ? paint("2", "KEEP   ") : e.miss ? paint("31;1", "MISS   ") : paint("32;1", "HIT    ");
    const u = e.usage;
    const who = e.kind === "keepalive" ? "keep" : label(e);
    out.push(
      `${paint("2", when)}  ${tag} ${who.padEnd(4)} ${e.model.padEnd(18)} hit ${(e.hit_rate * 100).toFixed(0).padStart(3)}%  ` +
        `read ${n(u.cache_read_input_tokens).padStart(6)}  write ${n(u.cache_creation_input_tokens).padStart(6)}  in ${n(u.input_tokens).padStart(6)}  out ${n(u.output_tokens).padStart(6)}  ` +
        `${usdPair(e.cost.actual, e.cost.uncached)[0]} (uncached ${usdPair(e.cost.actual, e.cost.uncached)[1]}${e.cost.actual > e.cost.uncached * 1.0001 ? ", incl. cache-write premium" : ""})` + (multi ? paint("2", `  [${e.session.slice(0, 8)}]`) : ""),
    );
    if (e.error) out.push(`          ${paint("33", "error:")} ${e.error}`);
    for (const c of e.causes as Cause[]) out.push(`          ${paint("31", "\u2514")} ${c.kind.padEnd(13)} ${c.detail}`);
    if (opts.verbose) {
      for (const r of e.rewrites) out.push(`          ${paint("36", "~")} ${r}`);
      for (const w of e.warnings) out.push(`          ${paint("33", "!")} ${w}`);
    }
  }
  const t = aggregate(shown);
  out.push("", paint("2", "HIT = something was read from the cache and not much less than last call; MISS = nothing read, or less than half of what the last call cached."), paint("2", "A first call that reads from another session's cache is a HIT even at a low percentage."));
  out.push("", `${t.calls} call(s) | hit rate ${(t.hit_rate * 100).toFixed(1)}% | cost ${usdPair(t.cost, t.uncached).join(" vs ")} uncached | saved ${usd(t.saved)}${t.saved < 0 ? " (cache writes cost extra until reads repay them)" : ""} | ${t.misses} miss(es)`);
  return out.join("\n");
}
