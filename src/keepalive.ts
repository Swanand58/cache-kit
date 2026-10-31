import { modelCfg, writePrice, type Config } from "./config.js";
import { cost, hitRate, usd } from "./metrics.js";
import type { Ctx } from "./session.js";
import type { Entry, Req, Ttl, Usage } from "./types.js";

export type Send = (req: Req, headers: Record<string, string>, path: string) => Promise<{ status: number; usage?: Usage }>;

interface State { timer?: NodeJS.Timeout; refreshes: number; spent: number; announced: boolean }

/**
 * Optional TTL keep-alive: replays the last request with max_tokens 0 (prefill only, no output billed) shortly before
 * the cache entry would expire. Stops once refreshes have cost more than one re-write would, so it can't spend
 * forever on an idle session. Real traffic resets the clock. Headers (API key) are held in memory only.
 */
export class KeepAlive {
  private state = new Map<string, State>();
  constructor(
    private cfg: Config,
    private send: Send,
    private onEntry: (e: Entry) => void,
    private refreshed: (ctx: Ctx, usage: Usage) => void,
    private say: (s: string) => void = console.error,
  ) {}

  touch(ctx: Ctx, req: Req, headers: Record<string, string>, usage: Usage, path = "/v1/messages") {
    const prefix = usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
    if (!this.cfg.keepalive.enabled || prefix === 0) return;
    const key = `${ctx.sid}|${ctx.lineage.id}`;
    const st = this.state.get(key) ?? { refreshes: 0, spent: 0, announced: false };
    clearTimeout(st.timer);
    st.refreshes = 0; st.spent = 0;
    this.state.set(key, st);

    const mc = modelCfg(this.cfg, req.model);
    const refresh = (prefix * mc.cache_read) / 1e6;
    const rewrite = (prefix * writePrice(mc, ctx.snap.ttl)) / 1e6;
    const ttlMs = (ctx.snap.ttl === "1h" ? 3600 : 300) * 1000;
    const maxN = Math.min(this.cfg.keepalive.max_refreshes, Math.floor(rewrite / refresh) || 0);
    if (!st.announced) {
      st.announced = true;
      this.say(`[cachekit] keep-alive: each refresh ~${usd(refresh)} vs ~${usd(rewrite)} to re-write ${prefix} tokens after expiry; worth it for up to ${maxN} refreshes (~${Math.round((maxN * ttlMs) / 60000)} min idle)`);
    }
    if (maxN < 1) return;
    const delay = Math.max(1000, ttlMs - this.cfg.keepalive.margin_seconds * 1000);
    st.timer = setTimeout(() => void this.fire(key, ctx, req, headers, path, prefix, refresh, rewrite, maxN, ttlMs), delay);
    st.timer.unref();
  }

  private async fire(key: string, ctx: Ctx, req: Req, headers: Record<string, string>, path: string, prefix: number, refresh: number, rewrite: number, maxN: number, ttlMs: number) {
    const st = this.state.get(key)!;
    const { stream: _s, ...rest } = req;
    let r = await this.send({ ...rest, max_tokens: 0 }, headers, path).catch(() => undefined);
    if (r && r.status === 400) r = await this.send({ ...rest, max_tokens: 1 }, headers, path).catch(() => undefined); // older models reject 0
    if (!r || r.status >= 400 || !r.usage) return void this.say(`[cachekit] keep-alive stopped for ${key}: refresh failed (${r?.status ?? "network"})`);
    st.refreshes++;
    const usage = r.usage;
    const c = cost(this.cfg, req.model, usage, ctx.snap.ttl);
    st.spent += c.actual;
    this.refreshed(ctx, usage);
    this.onEntry({
      ts: Date.now(), kind: "keepalive", session: ctx.sid, lineage: ctx.lineage.id, model: req.model, status: r.status, stream: false,
      usage, hit_rate: hitRate(usage), miss: usage.cache_read_input_tokens === 0,
      causes: usage.cache_read_input_tokens === 0 ? [{ kind: "ttl_expiry", detail: "keep-alive found the cache already cold" }] : [],
      cost: c, prefix_hash: ctx.snap.prefix, ttl: ctx.snap.ttl, rewrites: [], warnings: [],
    });
    if (st.refreshes >= maxN || st.spent + refresh > rewrite) {
      return void this.say(`[cachekit] keep-alive stopped for ${key}: ${st.refreshes} refreshes cost ${usd(st.spent)}, about one re-write (${usd(rewrite)}); letting the cache expire`);
    }
    st.timer = setTimeout(() => void this.fire(key, ctx, req, headers, path, prefix, refresh, rewrite, maxN, ttlMs), Math.max(1000, ttlMs - this.cfg.keepalive.margin_seconds * 1000));
    st.timer.unref();
  }

  stop() { for (const s of this.state.values()) clearTimeout(s.timer); this.state.clear(); }
}
