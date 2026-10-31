import { modelCfg, writePrice } from "./config.js";
import { cost, hitRate, usd } from "./metrics.js";
/**
 * Optional TTL keep-alive: replays the last request with max_tokens 0 (prefill only, no output billed) shortly before
 * the cache entry would expire. Stops once refreshes have cost more than one re-write would, so it can't spend
 * forever on an idle session. Real traffic resets the clock. Headers (API key) are held in memory only.
 */
export class KeepAlive {
    cfg;
    send;
    onEntry;
    refreshed;
    say;
    state = new Map();
    constructor(cfg, send, onEntry, refreshed, say = console.error) {
        this.cfg = cfg;
        this.send = send;
        this.onEntry = onEntry;
        this.refreshed = refreshed;
        this.say = say;
    }
    touch(ctx, req, headers, usage, path = "/v1/messages") {
        const prefix = usage.cache_read_input_tokens + usage.cache_creation_input_tokens;
        if (!this.cfg.keepalive.enabled || prefix === 0)
            return;
        const key = `${ctx.sid}|${ctx.lineage.id}`;
        const st = this.state.get(key) ?? { refreshes: 0, spent: 0, announced: false };
        clearTimeout(st.timer);
        st.refreshes = 0;
        st.spent = 0;
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
        if (maxN < 1)
            return;
        const delay = Math.max(1000, ttlMs - this.cfg.keepalive.margin_seconds * 1000);
        st.timer = setTimeout(() => void this.fire(key, ctx, req, headers, path, prefix, refresh, rewrite, maxN, ttlMs), delay);
        st.timer.unref();
    }
    async fire(key, ctx, req, headers, path, prefix, refresh, rewrite, maxN, ttlMs) {
        const st = this.state.get(key);
        const { stream: _s, ...rest } = req;
        let r = await this.send({ ...rest, max_tokens: 0 }, headers, path).catch(() => undefined);
        if (r && r.status === 400)
            r = await this.send({ ...rest, max_tokens: 1 }, headers, path).catch(() => undefined); // older models reject 0
        if (!r || r.status >= 400 || !r.usage)
            return void this.say(`[cachekit] keep-alive stopped for ${key}: refresh failed (${r?.status ?? "network"})`);
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
    stop() { for (const s of this.state.values())
        clearTimeout(s.timer); this.state.clear(); }
}
