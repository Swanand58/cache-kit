import { randomUUID } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import { placeBreakpoints } from "./breakpoints.js";
import { loadConfig } from "./config.js";
import { KeepAlive } from "./keepalive.js";
import { aggregate, Logger, parseUsage, summaryLine } from "./metrics.js";
import { appendVolatile, estimateTokens, findVolatile, normalize, toBlocks } from "./normalize.js";
import { lastMiss } from "./report.js";
import { Tracker } from "./session.js";
export class CacheClient {
    opts;
    cfg;
    sdk;
    tracker;
    logger;
    keepalive;
    entries = [];
    seenWarnings = new Set();
    ratio;
    lastModel;
    /** One CacheClient is one session unless you pass `sessionId`; editing the system prompt must stay a diff, not a new session. */
    sid;
    constructor(opts = {}) {
        this.opts = opts;
        this.cfg = typeof opts.config === "string" ? loadConfig(opts.config) : loadConfig(undefined, opts.config ?? {});
        this.sdk = opts.client ?? new Anthropic({ apiKey: opts.apiKey, baseURL: opts.baseURL });
        this.sid = opts.sessionId ?? `lib-${randomUUID().slice(0, 8)}`;
        this.tracker = new Tracker(this.cfg);
        this.logger = new Logger(this.cfg.log.path);
        this.keepalive = new KeepAlive(this.cfg, async (req) => {
            try {
                const m = await this.sdk.messages.create(req);
                return { status: 200, usage: parseUsage(m.usage) };
            }
            catch (e) {
                return { status: e?.status ?? 0 };
            }
        }, (e) => this.record(e), (ctx, usage) => this.tracker.refreshed(ctx.sid, ctx.lineage.id, usage), (s) => this.say(s));
    }
    say(s) { if (!this.cfg.log.quiet)
        console.error(s); }
    record(e) { this.entries.push(e); try {
        this.logger.write(e);
    }
    catch (err) {
        this.say(`[cachekit] log write failed: ${err}`);
    } }
    /** Drop-in for `client.messages.create`, plus optional `static` (cached after system) and `volatile` (after the last breakpoint). */
    async create(params, options) {
        const { static: st, volatile: vol, ...rest } = params;
        if (rest.stream)
            return this.sdk.messages.create(params, options); // ponytail: streaming goes via the proxy
        let prepared;
        try {
            prepared = await this.prepare(rest, st, vol);
        }
        catch (err) {
            // Never block a request: fall back to the same content, unmarked.
            this.say(`[cachekit] internal error, forwarding unmodified: ${err}`);
            const plain = structuredClone(rest);
            if (st !== undefined)
                plain.system = [...(typeof plain.system === "string" ? [{ type: "text", text: plain.system }] : plain.system ?? []), ...toBlocks(st)];
            if (vol !== undefined)
                appendVolatile(plain, vol);
            return this.sdk.messages.create(plain, options);
        }
        const { req, ctx, rewrites, warnings } = prepared;
        let msg;
        try {
            msg = (await this.sdk.messages.create(req, options));
        }
        catch (err) {
            this.tracker.abort(ctx);
            throw err;
        }
        try {
            this.tracker.firstByte(ctx);
            const usage = parseUsage(msg.usage);
            const e = this.tracker.end(ctx, { usage, status: 200, stream: false, rewrites, warnings });
            this.record(e);
            this.say(summaryLine(e, this.tracker.totals(ctx.sid), this.tracker.label(ctx)));
            for (const w of warnings)
                if (!this.seenWarnings.has(ctx.sid + w)) {
                    this.seenWarnings.add(ctx.sid + w);
                    this.say(`[cachekit] warning: ${w} (volatile value in the cacheable prefix)`);
                }
            this.keepalive.touch(ctx, req, {}, usage);
        }
        catch (err) {
            this.say(`[cachekit] metrics error: ${err}`);
        }
        return msg;
    }
    async prepare(rest, st, vol) {
        this.lastModel = rest.model;
        const { req, rewrites } = normalize(rest, { static: st });
        rewrites.push(...placeBreakpoints(req, this.cfg, await this.tokenFn(req)));
        if (vol !== undefined)
            rewrites.push(appendVolatile(req, vol));
        const warnings = findVolatile(req);
        const ctx = this.tracker.begin(req, this.sid);
        return { req, ctx, rewrites, warnings };
    }
    async tokenFn(req) {
        if (this.cfg.tokens.count !== "api")
            return estimateTokens;
        if (this.ratio === undefined) {
            try { // one count_tokens call calibrates the estimate for the session; ponytail: not recalibrated as content drifts
                const body = { model: req.model, system: req.system, tools: req.tools, messages: req.messages };
                const r = await this.sdk.messages.countTokens(body);
                this.ratio = r.input_tokens / Math.max(1, estimateTokens(body));
            }
            catch {
                this.ratio = 1;
            }
        }
        return (x) => Math.ceil(estimateTokens(x) * this.ratio);
    }
    /** Per-instance totals: hit rate, cost with and without caching, miss causes. */
    stats() { return aggregate(this.entries); }
    explainLastMiss() { return lastMiss(this.entries); }
    /** Summarize old turns in one request. The next call will miss the cache; a warning is logged. */
    async compact(history, opts = {}) {
        const model = opts.model ?? this.lastModel;
        if (!model)
            throw new Error("compact(): pass { model } (no create() call to infer it from)");
        return history.compact(async (old) => {
            const transcript = old.map((m) => `${m.role}: ${typeof m.content === "string" ? m.content : JSON.stringify(m.content)}`).join("\n\n");
            const r = await this.sdk.messages.create({
                model, max_tokens: 4096,
                messages: [{ role: "user", content: `Summarize this conversation so it can continue from the summary alone. Keep decisions, facts, open tasks and tool results that matter.\n\n${transcript}` }],
            });
            return r.content.map((b) => (b.type === "text" ? b.text : "")).join("");
        }, opts.keepLast ?? this.cfg.compact.keep_last, (s) => this.say(s));
    }
    close() { this.keepalive.stop(); }
}
/** Wrap an existing SDK client: `messages.create` goes through cachekit, everything else is untouched. */
export function wrap(client, opts = {}) {
    const ck = new CacheClient({ ...opts, client });
    const bind = (t, p) => { const v = Reflect.get(t, p, t); return typeof v === "function" ? v.bind(t) : v; };
    return new Proxy(client, {
        get(t, p) {
            if (p !== "messages")
                return bind(t, p);
            return new Proxy(t.messages, { get: (m, k) => (k === "create" ? (a, o) => ck.create(a, o) : bind(m, k)) });
        },
    });
}
