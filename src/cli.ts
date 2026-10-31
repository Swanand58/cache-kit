#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import { readLog } from "./metrics.js";
import { createProxy } from "./proxy.js";
import { buildReport, formatReport, sessionEntries, statusLine } from "./report.js";

const USAGE = `cachekit <command>

  proxy [--port 8787] [--upstream url] [--optimize] [--keepalive] [--config cachekit.toml] [--log file] [--quiet]
        local proxy for Anthropic API traffic; observe-only unless --optimize.
        Point a harness at it:  ANTHROPIC_BASE_URL=http://localhost:8787
  report <log.jsonl> [--json]      hit rate, cost saved, top causes of misses
  status [--log file] [--session id] [--json] [--config file]   one line, for a status line or hook
  mcp [--log file] [--config file]  MCP server (stdio): cache_stats, explain_last_miss`;

const { values: v, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" }, upstream: { type: "string" }, optimize: { type: "boolean" }, keepalive: { type: "boolean" }, config: { type: "string" },
    log: { type: "string" }, json: { type: "boolean" }, session: { type: "string" }, quiet: { type: "boolean" }, help: { type: "boolean", short: "h" },
  },
});
const [cmd, arg] = pos;

/** session_id from piped JSON on stdin, if any arrives within 150 ms (never hangs a status line). */
async function stdinSession(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  return new Promise((resolve) => {
    let buf = "";
    const done = () => { try { resolve(JSON.parse(buf).session_id); } catch { resolve(undefined); } };
    const t = setTimeout(() => { process.stdin.destroy(); done(); }, 150);
    process.stdin.on("data", (c) => (buf += c)).on("end", () => { clearTimeout(t); done(); });
  });
}

async function main() {
  if (!cmd || v.help || !["proxy", "report", "status", "mcp"].includes(cmd)) return void console.log(USAGE);
  const overrides: Record<string, unknown> = {
    ...(v.log ? { log: { path: v.log } } : {}),
    ...(v.quiet ? { log: { quiet: true, ...(v.log ? { path: v.log } : {}) } } : {}),
    proxy: { ...(v.port ? { port: Number(v.port) } : {}), ...(v.upstream ? { upstream: v.upstream } : {}), ...(v.optimize ? { optimize: true } : {}) },
    ...(v.keepalive ? { keepalive: { enabled: true } } : {}),
  };
  const cfg = loadConfig(v.config, overrides);
  const print = (human: string, json: unknown) => console.log(v.json ? JSON.stringify(json, null, 2) : human);

  if (cmd === "proxy") {
    const p = createProxy({ cfg });
    p.server.listen(cfg.proxy.port, "127.0.0.1", () => {
      console.error(`cachekit proxy on http://localhost:${cfg.proxy.port} -> ${cfg.proxy.upstream} (${cfg.proxy.optimize ? "OPTIMIZE: rewriting requests" : "observe-only: requests forwarded untouched"})`);
      console.error(`log: ${cfg.log.path}\nuse:  ANTHROPIC_BASE_URL=http://localhost:${cfg.proxy.port}`);
    });
    process.on("SIGINT", () => void p.close().then(() => process.exit(0)));
  } else if (cmd === "report") {
    if (!arg) return void console.log("usage: cachekit report <log.jsonl> [--json]");
    const r = buildReport(readLog(arg));
    print(formatReport(r), r);
  } else if (cmd === "status") {
    const es = readLog(cfg.log.path, 1 << 20);
    // as a Claude Code status line, stdin carries {"session_id": ...}; fall back to the latest session if it has no data
    let sid = v.session ?? (await stdinSession());
    if (sid && !es.some((e) => e.session === sid)) sid = undefined;
    print(statusLine(es, sid), buildReport(sessionEntries(es, sid)));
  } else if (cmd === "mcp") {
    try { await import("@modelcontextprotocol/sdk/server/index.js"); }
    catch { throw new Error("`cachekit mcp` needs the optional dependency: npm install -g @modelcontextprotocol/sdk"); }
    await (await import("./mcp.js")).runMcp(cfg.log.path);
  }
}
main().catch((e) => { console.error(`cachekit: ${e?.message ?? e}`); process.exit(1); });
