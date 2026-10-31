import { aggregate, usd } from "./metrics.js";
import type { Entry } from "./types.js";

/** Entries of one session: `sid`, else the session with the most recent entry. */
export function sessionEntries(entries: Entry[], sid?: string): Entry[] {
  const id = sid ?? entries[entries.length - 1]?.session;
  return id ? entries.filter((e) => e.session === id) : [];
}

/** Per session, the lineage with the most calls is "main"; others are "sub". */
function labels(entries: Entry[]) {
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
    `cost: ${usd(r.cost)} (would be ${usd(r.cost_uncached)} without caching) -> saved ${usd(r.saved)} (${pct(r.saved_pct)})`,
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
  const m = lastMiss(entries, sid);
  return `cache ${(t.hit_rate * 100).toFixed(0)}% hit | saved ${usd(t.saved)} | ${t.calls} calls${m.found ? ` | last miss: ${(m as any).causes[0]?.kind}` : ""}`;
}
