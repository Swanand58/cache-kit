import http from "node:http";
import { addEntry, emptyTotals, readLog, type Totals } from "./metrics.js";
import { buildReport } from "./report.js";
import type { Entry } from "./types.js";

/** Prometheus slows down with unbounded label values, so only the busiest models and apps keep their own label. */
const LABEL_CAP = 50;

const esc = (v: string) => v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
const labels = (l: Record<string, string>) => `{${Object.entries(l).map(([k, v]) => `${k}="${esc(v)}"`).join(",")}}`;

/** The `top` most-called values keep their name; the rest become "other". */
function capped(entries: Entry[], key: (e: Entry) => string, top = LABEL_CAP): (e: Entry) => string {
  const n = new Map<string, number>();
  for (const e of entries) n.set(key(e), (n.get(key(e)) ?? 0) + 1);
  const keep = new Set([...n].sort((a, b) => b[1] - a[1]).slice(0, top).map(([k]) => k));
  return (e) => (keep.has(key(e)) ? key(e) : "other");
}

/**
 * Prometheus text for a log: counters per provider, model and app (plus miss cause and token kind).
 * ponytail: derived from the whole log on each scrape, so a counter can dip if the busiest-50 set changes or the log
 * is deleted (Prometheus treats that as a reset); the cost of a scrape grows with the log size.
 */
export function prometheus(entries: Entry[], top = LABEL_CAP): string {
  const model = capped(entries, (e) => e.model, top);
  const app = capped(entries, (e) => e.tag ?? "untagged", top);
  const groups = new Map<string, { l: Record<string, string>; t: Totals }>();
  for (const e of entries) {
    const l = { provider: e.provider ?? "anthropic", model: model(e), app: app(e) };
    const k = JSON.stringify(l);
    addEntry((groups.get(k) ?? groups.set(k, { l, t: emptyTotals() }).get(k)!).t, e);
  }
  const out: string[] = [];
  const metric = (name: string, type: "counter" | "gauge", help: string, rows: [Record<string, string>, number][]) => {
    out.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`, ...rows.map(([l, v]) => `${name}${labels(l)} ${v}`));
  };
  const g = [...groups.values()];
  metric("cachekit_calls_total", "counter", "Calls seen (keep-alive refreshes excluded).", g.map(({ l, t }) => [l, t.calls]));
  metric("cachekit_tokens_total", "counter", "Tokens by kind: read (cache hit), creation (cache write), input (uncached), output.",
    g.flatMap(({ l, t }) => (["read", "creation", "input", "output"] as const).map((kind): [Record<string, string>, number] => [{ ...l, kind }, t[kind]])));
  metric("cachekit_cost_usd_total", "counter", "Money spent in USD, from the price table.", g.map(({ l, t }) => [l, t.cost]));
  metric("cachekit_saved_usd", "gauge", "USD saved by caching versus no caching (negative when cache writes have not paid off yet).", g.map(({ l, t }) => [l, t.saved]));
  metric("cachekit_misses_total", "counter", "Cache misses by diagnosed cause (one miss can have several causes).",
    g.flatMap(({ l, t }) => Object.entries(t.causes).map(([cause, n]): [Record<string, string>, number] => [{ ...l, cause }, n])));
  return out.join("\n") + "\n";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export interface ServeOpts { logPath: string; host?: string }

/** Read-only HTTP view of the log: GET /stats.json[?app=tag] and GET /metrics. Nothing else, and it never writes. */
export function createServe(opts: ServeOpts) {
  const local = LOOPBACK.has(opts.host ?? "127.0.0.1");
  return http.createServer((req, res) => {
    const send = (status: number, type: string, body: string) => { res.writeHead(status, { "content-type": type, "cache-control": "no-store" }); res.end(body); };
    const url = new URL(req.url ?? "/", "http://x");
    if (req.method !== "GET") return send(405, "application/json", '{"error":"GET only"}');
    // On loopback only: refuse foreign Host headers so a web page can't read this through DNS rebinding.
    if (local && !LOOPBACK.has((req.headers.host ?? "").replace(/:\d+$/, ""))) return send(403, "application/json", '{"error":"unexpected Host header"}');
    try {
      if (url.pathname === "/metrics") return send(200, "text/plain; version=0.0.4; charset=utf-8", prometheus(readLog(opts.logPath)));
      if (url.pathname === "/stats.json") {
        const app = url.searchParams.get("app");
        const es = readLog(opts.logPath);
        return send(200, "application/json", JSON.stringify(buildReport(app ? es.filter((e) => (e.tag ?? "untagged") === app) : es)));
      }
      send(404, "application/json", '{"error":"not found; try /stats.json or /metrics"}');
    } catch (err) {
      send(500, "application/json", JSON.stringify({ error: String(err) }));
    }
  });
}
