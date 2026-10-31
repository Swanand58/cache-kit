import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import type { Duplex } from "node:stream";
import { placeBreakpoints } from "./breakpoints.js";
import type { Config } from "./config.js";
import { KeepAlive, type Send } from "./keepalive.js";
import { Logger, parseUsage, summaryLine } from "./metrics.js";
import { findVolatile, normalize } from "./normalize.js";
import { Tracker, type Ctx } from "./session.js";
import type { Entry, Req, Usage } from "./types.js";

export interface ProxyOpts {
  cfg: Config;
  /** Rewrite requests (sort tools, add breakpoints). Default false: observe only, bytes forwarded untouched. */
  optimize?: boolean;
  upstream?: string;
  say?: (s: string) => void;
}

const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer", "host"]);
const KA_HEADERS = ["x-api-key", "authorization", "anthropic-version", "anthropic-beta"];

function decoder(enc?: string): Duplex | null {
  if (enc === "gzip") return zlib.createGunzip();
  if (enc === "br") return zlib.createBrotliDecompress();
  if (enc === "deflate") return zlib.createInflate();
  if (enc === "zstd" && (zlib as any).createZstdDecompress) return (zlib as any).createZstdDecompress();
  return null;
}

/** Reads usage out of a (possibly compressed) response without touching the bytes the client receives. */
class Tap {
  usage?: Usage;
  private text = "";
  private buf = "";
  private dec: Duplex | null;
  private sse: boolean;
  private finished = false;
  constructor(headers: http.IncomingHttpHeaders, private onDone: (usage?: Usage, err?: string) => void) {
    this.sse = String(headers["content-type"] ?? "").includes("text/event-stream");
    const enc = String(headers["content-encoding"] ?? "").toLowerCase();
    this.dec = decoder(enc || undefined);
    if (enc && !this.dec) this.onDoneOnce("unsupported content-encoding: " + enc);
    this.dec?.on("data", (d: Buffer) => this.feed(d.toString("utf8")));
    this.dec?.on("end", () => this.finish());
    this.dec?.on("error", (e: Error) => this.onDoneOnce("decode error: " + e.message));
  }
  write(chunk: Buffer) { if (this.finished) return; if (this.dec) this.dec.write(chunk); else this.feed(chunk.toString("utf8")); }
  end() { if (this.dec) this.dec.end(); else this.finish(); }
  private onDoneOnce(err?: string) { if (this.finished) return; this.finished = true; this.onDone(this.usage, err); }
  private finish() {
    if (!this.sse && this.text) {
      try { const j = JSON.parse(this.text); if (j?.usage) this.usage = parseUsage(j.usage); } catch { /* not JSON (error page) */ }
    }
    this.onDoneOnce();
  }
  private feed(s: string) {
    if (!this.sse) { this.text += s; return; }
    this.buf += s.replace(/\r\n/g, "\n");
    let i: number;
    while ((i = this.buf.indexOf("\n\n")) >= 0) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      const line = block.split("\n").find((l) => l.startsWith("data:"));
      if (!line) continue;
      try { this.event(JSON.parse(line.slice(5))); } catch { /* ignore malformed event */ }
    }
  }
  private event(ev: any) {
    if (ev.type === "message_start" && ev.message?.usage) this.usage = parseUsage(ev.message.usage);
    else if (ev.type === "message_delta" && ev.usage && this.usage) {
      // message_delta carries cumulative totals; take any numeric field it sends
      for (const k of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"] as const)
        if (typeof ev.usage[k] === "number") this.usage[k] = ev.usage[k];
      if (ev.usage.cache_creation && typeof ev.usage.cache_creation === "object") this.usage.cache_creation = ev.usage.cache_creation;
    }
  }
}

export function createProxy(opts: ProxyOpts) {
  const { cfg } = opts;
  const upstream = new URL(opts.upstream ?? cfg.proxy.upstream);
  const lib = upstream.protocol === "https:" ? https : http;
  const optimize = opts.optimize ?? cfg.proxy.optimize;
  const say = opts.say ?? ((s: string) => { if (!cfg.log.quiet) console.error(s); });
  const tracker = new Tracker(cfg);
  const logger = new Logger(cfg.log.path);
  const seenWarnings = new Set<string>();
  const record = (e: Entry) => { try { logger.write(e); } catch (err) { say(`[cachekit] log write failed: ${err}`); } };

  const send: Send = (body, headers, path) =>
    new Promise((resolve) => {
      const payload = Buffer.from(JSON.stringify(body));
      const r = lib.request(
        { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: "POST", path,
          headers: { ...headers, host: upstream.host, "content-type": "application/json", "content-length": payload.length } },
        (rs) => {
          const chunks: Buffer[] = [];
          rs.on("data", (c) => chunks.push(c));
          rs.on("end", () => {
            let usage: Usage | undefined;
            try { usage = parseUsage(JSON.parse(Buffer.concat(chunks).toString("utf8")).usage); } catch { /* no usage */ }
            resolve({ status: rs.statusCode ?? 0, usage });
          });
        },
      );
      r.on("error", () => resolve({ status: 0 }));
      r.end(payload);
    });
  const keepalive = new KeepAlive(cfg, send, record, (ctx, usage) => tracker.refreshed(ctx.sid, ctx.lineage.id, usage), say);

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("error", () => res.destroy());
    req.on("end", () => handle(req, res, Buffer.concat(chunks)));
  });

  function handle(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer) {
    let fwd = body;
    let ctx: Ctx | undefined;
    let rewrites: string[] = [];
    let warnings: string[] = [];
    let forwarded: Req | undefined;
    const pathname = (req.url ?? "").split("?")[0];

    // Analysis must never block or break the request: any error here means "forward untouched".
    if (req.method === "POST" && pathname === "/v1/messages") {
      try {
        const parsed = JSON.parse(body.toString("utf8")) as Req;
        if (parsed && Array.isArray(parsed.messages) && typeof parsed.model === "string") {
          let r = parsed;
          let out = body;
          if (optimize) {
            const n = normalize(parsed);
            const notes = [...n.rewrites, ...placeBreakpoints(n.req, cfg)];
            if (JSON.stringify(n.req) !== JSON.stringify(parsed)) { r = n.req; out = Buffer.from(JSON.stringify(n.req)); }
            rewrites = notes;
            if (out !== body) say(`[cachekit] rewrote request: ${notes.filter((x) => !x.startsWith("skip")).join("; ")}`);
          }
          const hdr = req.headers[cfg.proxy.session_header.toLowerCase()];
          warnings = findVolatile(r);
          ctx = tracker.begin(r, Array.isArray(hdr) ? hdr[0] : hdr);
          forwarded = r;
          fwd = out;
        }
      } catch (err) {
        say(`[cachekit] analysis error, forwarding untouched: ${err}`);
        ctx = undefined; fwd = body;
      }
    }

    const headers: http.OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
    headers.host = upstream.host;
    if (fwd !== body || headers["content-length"] !== undefined) headers["content-length"] = fwd.length;

    const up = lib.request(
      { protocol: upstream.protocol, hostname: upstream.hostname, port: upstream.port || undefined, method: req.method, path: req.url, headers },
      (upRes) => {
        const resHeaders: http.OutgoingHttpHeaders = {};
        for (const [k, v] of Object.entries(upRes.headers)) if (!HOP.has(k) && v !== undefined) resHeaders[k] = v;
        res.socket?.setNoDelay(true);
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, resHeaders);
        res.flushHeaders();

        let tap: Tap | undefined;
        if (ctx) {
          const c = ctx;
          tap = new Tap(upRes.headers, (usage, err) => {
            try {
              const status = upRes.statusCode ?? 0;
              const e = tracker.end(c, { usage, status, stream: String(upRes.headers["content-type"]).includes("event-stream"), rewrites, warnings, error: err });
              record(e);
              if (status < 400 && usage) {
                say(summaryLine(e, tracker.totals(c.sid), tracker.label(c)));
                for (const w of warnings) if (!seenWarnings.has(c.sid + w)) { seenWarnings.add(c.sid + w); say(`[cachekit] warning: ${w}`); }
                const h: Record<string, string> = {};
                for (const k of KA_HEADERS) if (typeof req.headers[k] === "string") h[k] = req.headers[k] as string;
                keepalive.touch(c, forwarded!, h, usage, req.url);
              }
            } catch (e2) { say(`[cachekit] metrics error: ${e2}`); }
          });
        }
        upRes.on("data", (chunk: Buffer) => {
          if (ctx && !ctx.streaming) tracker.firstByte(ctx);
          try { tap?.write(chunk); } catch { /* tap failure must not affect passthrough */ }
        });
        upRes.on("end", () => { try { tap?.end(); } catch { /* ignore */ } });
        upRes.pipe(res);
        // client went away mid-stream: stop upstream, keep the usage seen so far
        res.on("close", () => { if (!res.writableFinished) { up.destroy(); try { tap?.end(); } catch { /* ignore */ } } });
      },
    );
    up.on("error", (err) => {
      if (ctx) tracker.abort(ctx);
      say(`[cachekit] upstream error: ${err.message}`);
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ type: "error", error: { type: "api_error", message: `cachekit proxy: upstream error: ${err.message}` } }));
      } else res.destroy();
    });
    up.end(fwd);
  }

  return {
    server, tracker,
    close: () => new Promise<void>((r) => { keepalive.stop(); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}
