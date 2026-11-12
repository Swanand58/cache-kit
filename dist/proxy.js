import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { placeBreakpoints } from "./breakpoints.js";
import { KeepAlive } from "./keepalive.js";
import { Logger, parseUsage, summaryLine } from "./metrics.js";
import { findVolatile, normalize } from "./normalize.js";
import { isOpenAICall, openaiStreamUsage, openaiToReq, parseOpenAIUsage, providerOf } from "./providers.js";
import { Tracker } from "./session.js";
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);
/** App tags become a log field, so they are restricted: lower-case, digits, `.`, `_`, `-`. Anything else is logged as "invalid", never verbatim. */
const TAG_RE = /^[a-z0-9._-]{1,64}$/;
const KA_HEADERS = ["x-api-key", "authorization", "anthropic-version", "anthropic-beta"];
function decoder(enc) {
    if (enc === "gzip")
        return zlib.createGunzip();
    if (enc === "br")
        return zlib.createBrotliDecompress();
    if (enc === "deflate")
        return zlib.createInflate();
    if (enc === "zstd" && zlib.createZstdDecompress)
        return zlib.createZstdDecompress();
    return null;
}
/** Reads usage out of a (possibly compressed) response without touching the bytes the client receives. */
class Tap {
    provider;
    onDone;
    usage;
    text = "";
    buf = "";
    dec;
    sse;
    finished = false;
    constructor(headers, provider, onDone) {
        this.provider = provider;
        this.onDone = onDone;
        this.sse = String(headers["content-type"] ?? "").includes("text/event-stream");
        const enc = String(headers["content-encoding"] ?? "").toLowerCase();
        this.dec = decoder(enc || undefined);
        if (enc && !this.dec)
            this.onDoneOnce("unsupported content-encoding: " + enc);
        this.dec?.on("data", (d) => this.feed(d.toString("utf8")));
        this.dec?.on("end", () => this.finish());
        this.dec?.on("error", (e) => this.onDoneOnce("decode error: " + e.message));
    }
    write(chunk) { if (this.finished)
        return; if (this.dec)
        this.dec.write(chunk);
    else
        this.feed(chunk.toString("utf8")); }
    end() { if (this.dec)
        this.dec.end();
    else
        this.finish(); }
    onDoneOnce(err) { if (this.finished)
        return; this.finished = true; this.onDone(this.usage, err); }
    finish() {
        if (!this.sse && this.text) {
            try {
                const j = JSON.parse(this.text);
                if (j?.usage)
                    this.usage = this.provider === "openai" ? parseOpenAIUsage(j.usage) : parseUsage(j.usage);
            }
            catch { /* not JSON (error page) */ }
        }
        this.onDoneOnce();
    }
    feed(s) {
        if (!this.sse) {
            this.text += s;
            return;
        }
        this.buf += s.replace(/\r\n/g, "\n");
        let i;
        while ((i = this.buf.indexOf("\n\n")) >= 0) {
            const block = this.buf.slice(0, i);
            this.buf = this.buf.slice(i + 2);
            const line = block.split("\n").find((l) => l.startsWith("data:"));
            if (!line)
                continue;
            try {
                this.event(JSON.parse(line.slice(5)));
            }
            catch { /* ignore malformed event */ }
        }
    }
    event(ev) {
        if (this.provider === "openai") {
            this.usage = openaiStreamUsage(ev) ?? this.usage;
            return;
        }
        if (ev.type === "message_start" && ev.message?.usage)
            this.usage = parseUsage(ev.message.usage);
        else if (ev.type === "message_delta" && ev.usage && this.usage) {
            // message_delta carries cumulative totals; take any numeric field it sends
            for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"])
                if (typeof ev.usage[k] === "number")
                    this.usage[k] = ev.usage[k];
            if (ev.usage.cache_creation && typeof ev.usage.cache_creation === "object")
                this.usage.cache_creation = ev.usage.cache_creation;
        }
    }
}
export function createProxy(opts) {
    const { cfg } = opts;
    const targets = {
        anthropic: new URL(opts.upstream ?? cfg.proxy.upstream),
        openai: new URL(opts.openaiUpstream ?? cfg.providers.openai.upstream),
    };
    const upstream = targets.anthropic; // keep-alive replays only go to Anthropic
    const libOf = (u) => (u.protocol === "https:" ? https : http);
    const lib = libOf(upstream);
    const optimize = opts.optimize ?? cfg.proxy.optimize;
    const say = opts.say ?? ((s) => { if (!cfg.log.quiet)
        console.error(s); });
    const tracker = new Tracker(cfg);
    const logger = new Logger(cfg.log.path);
    const seenWarnings = new Set();
    const record = (e) => { try {
        logger.write(e);
    }
    catch (err) {
        say(`[cachekit] log write failed: ${err}`);
    } };
    const send = (body, headers, path) => new Promise((resolve) => {
        const payload = Buffer.from(JSON.stringify(body));
        const r = lib.request({ protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: "POST", path,
            headers: { ...headers, host: upstream.host, "content-type": "application/json", "content-length": payload.length } }, (rs) => {
            const chunks = [];
            rs.on("data", (c) => chunks.push(c));
            rs.on("end", () => {
                let usage;
                try {
                    usage = parseUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")).usage);
                }
                catch { /* no usage */ }
                resolve({ status: rs.statusCode ?? 0, usage });
            });
        });
        r.on("error", () => resolve({ status: 0 }));
        r.end(payload);
    });
    const keepalive = new KeepAlive(cfg, send, record, (ctx, usage) => tracker.refreshed(ctx.sid, ctx.lineage.id, usage), say);
    const server = http.createServer((req, res) => {
        const chunks = [];
        req.on("data", (c) => chunks.push(c));
        req.on("error", () => res.destroy());
        req.on("end", () => handle(req, res, Buffer.concat(chunks)));
    });
    function handle(req, res, body) {
        let fwd = body;
        let ctx;
        let rewrites = [];
        let warnings = [];
        let forwarded;
        const pathname = (req.url ?? "").split("?")[0];
        const provider = providerOf(pathname);
        const target = targets[provider];
        // Analysis must never block or break the request: any error here means "forward untouched".
        if (provider === "openai" && isOpenAICall(req.method, pathname)) {
            try {
                const r = openaiToReq(pathname, JSON.parse(body.toString("utf8")));
                if (r) {
                    warnings = findVolatile(r);
                    ctx = tracker.begin(r, undefined, "openai");
                    forwarded = r;
                }
            }
            catch (err) {
                say(`[cachekit] analysis error, forwarding untouched: ${err}`);
                ctx = undefined;
            }
        }
        else if (req.method === "POST" && pathname === "/v1/messages") {
            try {
                const parsed = JSON.parse(body.toString("utf8"));
                if (parsed && Array.isArray(parsed.messages) && typeof parsed.model === "string") {
                    let r = parsed;
                    let out = body;
                    if (optimize) {
                        const n = normalize(parsed);
                        const notes = [...n.rewrites, ...placeBreakpoints(n.req, cfg)];
                        if (JSON.stringify(n.req) !== JSON.stringify(parsed)) {
                            r = n.req;
                            out = Buffer.from(JSON.stringify(n.req));
                        }
                        rewrites = notes;
                        if (out !== body)
                            say(`[cachekit] rewrote request: ${notes.filter((x) => !x.startsWith("skip")).join("; ")}`);
                    }
                    const hdr = req.headers[cfg.proxy.session_header.toLowerCase()];
                    warnings = findVolatile(r);
                    ctx = tracker.begin(r, Array.isArray(hdr) ? hdr[0] : hdr);
                    forwarded = r;
                    fwd = out;
                }
            }
            catch (err) {
                say(`[cachekit] analysis error, forwarding untouched: ${err}`);
                ctx = undefined;
                fwd = body;
            }
        }
        // The tag is for cachekit only: read it, then keep it from reaching OpenAI/Anthropic (it may name a tenant).
        const tagHeader = cfg.proxy.tag_header.toLowerCase();
        const rawTag = req.headers[tagHeader];
        const tagValue = Array.isArray(rawTag) ? rawTag[0] : rawTag;
        if (ctx && tagValue !== undefined)
            ctx.tag = TAG_RE.test(tagValue) ? tagValue : "invalid";
        const headers = {};
        for (const [k, v] of Object.entries(req.headers))
            if (!HOP.has(k) && k !== tagHeader && v !== undefined)
                headers[k] = v;
        headers.host = target.host;
        if (fwd !== body || headers["content-length"] !== undefined)
            headers["content-length"] = fwd.length;
        const up = libOf(target).request({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, method: req.method, path: req.url, headers }, (upRes) => {
            const resHeaders = {};
            for (const [k, v] of Object.entries(upRes.headers))
                if (!HOP.has(k) && v !== undefined)
                    resHeaders[k] = v;
            res.socket?.setNoDelay(true);
            res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, resHeaders);
            res.flushHeaders();
            let tap;
            if (ctx) {
                const c = ctx;
                tap = new Tap(upRes.headers, provider, (usage, err) => {
                    try {
                        const status = upRes.statusCode ?? 0;
                        const e = tracker.end(c, { usage, status, stream: String(upRes.headers["content-type"]).includes("event-stream"), rewrites, warnings, error: err });
                        if (provider === "openai" && status < 400 && !usage)
                            e.causes.push({ kind: "no_usage", detail: "response carried no usage, so this call is not counted in hit rate (a stream needs stream_options.include_usage)" });
                        record(e);
                        if (status < 400 && usage) {
                            say(summaryLine(e, tracker.totals(c.sid), tracker.label(c)));
                            for (const w of warnings)
                                if (!seenWarnings.has(c.sid + w)) {
                                    seenWarnings.add(c.sid + w);
                                    say(`[cachekit] warning: ${w}`);
                                }
                            const h = {};
                            for (const k of KA_HEADERS)
                                if (typeof req.headers[k] === "string")
                                    h[k] = req.headers[k];
                            if (provider === "anthropic")
                                keepalive.touch(c, forwarded, h, usage, req.url);
                        }
                    }
                    catch (e2) {
                        say(`[cachekit] metrics error: ${e2}`);
                    }
                });
            }
            upRes.on("data", (chunk) => {
                if (ctx && !ctx.streaming)
                    tracker.firstByte(ctx);
                try {
                    tap?.write(chunk);
                }
                catch { /* tap failure must not affect passthrough */ }
            });
            upRes.on("end", () => { try {
                tap?.end();
            }
            catch { /* ignore */ } });
            upRes.pipe(res);
            // client went away mid-stream: stop upstream, keep the usage seen so far
            res.on("close", () => { if (!res.writableFinished) {
                up.destroy();
                try {
                    tap?.end();
                }
                catch { /* ignore */ }
            } });
        });
        up.on("error", (err) => {
            if (ctx)
                tracker.abort(ctx);
            say(`[cachekit] upstream error: ${err.message}`);
            if (!res.headersSent) {
                res.writeHead(502, { "content-type": "application/json" });
                const message = `cachekit proxy: upstream error: ${err.message}`;
                res.end(JSON.stringify(provider === "openai" ? { error: { message, type: "api_error", code: null } } : { type: "error", error: { type: "api_error", message } }));
            }
            else
                res.destroy();
        });
        up.end(fwd);
    }
    return {
        server, tracker,
        close: () => new Promise((r) => { keepalive.stop(); server.closeAllConnections?.(); server.close(() => r()); }),
    };
}
