#!/usr/bin/env node
import { parseArgs } from "node:util";
import { loadConfig } from "./config.js";
import type { Entry } from "./types.js";
import { readLog, readSession } from "./metrics.js";
import { createProxy } from "./proxy.js";
import { createServe } from "./serve.js";
import { buildReport, formatLog, formatReport, statusLine, statusReport } from "./report.js";
import { VERSION } from "./version.js";

const USAGE = `cachekit <command>

  proxy [--port 8787] [--upstream url] [--openai-upstream url] [--optimize] [--keepalive] [--config cachekit.toml] [--log file] [--quiet]
        local proxy for Anthropic API traffic; observe-only unless --optimize.
        Point a harness at it:  ANTHROPIC_BASE_URL=http://localhost:8787
  log [log.jsonl] [-n 20] [-v] [--all] [--session id] [--app tag]   readable call-by-call log (-v adds rewrites/warnings; --all = every call)
  report <log.jsonl> [--json] [--app tag]   hit rate, cost saved, top causes of misses
  status [--log file] [--session id] [--json] [--config file]   one line, for a status line or hook
        an unknown --session id (or stdin session_id) prints "no data" / {"calls": 0}; no id = latest session
  serve [--log file] [--port 8788] [--host 127.0.0.1]   read-only /stats.json and Prometheus /metrics over the log
  mcp [--log file] [--config file]  MCP server (stdio): cache_stats, explain_last_miss
  --version                        print the installed version`;

const { values: v, positionals: pos } = parseArgs({
  allowPositionals: true,
  options: {
    port: { type: "string" }, host: { type: "string" }, upstream: { type: "string" }, "openai-upstream": { type: "string" }, optimize: { type: "boolean" }, keepalive: { type: "boolean" }, config: { type: "string" },
    log: { type: "string" }, json: { type: "boolean" }, session: { type: "string" }, quiet: { type: "boolean" }, lines: { type: "string", short: "n" }, verbose: { type: "boolean", short: "v" }, all: { type: "boolean" }, app: { type: "string" }, help: { type: "boolean", short: "h" }, version: { type: "boolean" },
  },
});
const [cmd, arg] = pos;
const byApp = (es: Entry[]) => (v.app ? es.filter((e) => (e.tag ?? "untagged") === v.app) : es);

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
  if (v.version) return void console.log(VERSION);
  if (!cmd || v.help || !["proxy", "report", "status", "mcp", "log", "serve"].includes(cmd)) return void console.log(USAGE);
  const overrides: Record<string, unknown> = {
    ...(v.log ? { log: { path: v.log } } : {}),
    ...(v.quiet ? { log: { quiet: true, ...(v.log ? { path: v.log } : {}) } } : {}),
    proxy: { ...(v.port ? { port: Number(v.port) } : {}), ...(v.upstream ? { upstream: v.upstream } : {}), ...(v.optimize ? { optimize: true } : {}) },
    ...(v["openai-upstream"] ? { providers: { openai: { upstream: v["openai-upstream"] } } } : {}),
    ...(v.keepalive ? { keepalive: { enabled: true } } : {}),
  };
  const cfg = loadConfig(v.config, overrides);
  const print = (human: string, json: unknown) => console.log(v.json ? JSON.stringify(json, null, 2) : human);

  if (cmd === "proxy") {
    const p = createProxy({ cfg });
    p.server.listen(cfg.proxy.port, "127.0.0.1", () => {
      console.error(`cachekit proxy on http://localhost:${cfg.proxy.port} -> ${cfg.proxy.upstream} (${cfg.proxy.optimize ? "OPTIMIZE: rewriting requests" : "observe-only: requests forwarded untouched"})`);
      console.error(`log: ${cfg.log.path}\nuse:  ANTHROPIC_BASE_URL=http://localhost:${cfg.proxy.port}\n      OPENAI_BASE_URL=http://localhost:${cfg.proxy.port}/v1   (OpenAI calls go to ${cfg.providers.openai.upstream}; observe-only)`);
    });
    process.on("SIGINT", () => void p.close().then(() => process.exit(0)));
  } else if (cmd === "serve") {
    const host = v.host ?? "127.0.0.1";
    const port = Number(v.port) || 8788;
    createServe({ logPath: cfg.log.path, host }).listen(port, host, () => {
      console.error(`cachekit serve on http://${host}:${port}  (/stats.json, /metrics)\nlog: ${cfg.log.path}`);
      if (!["127.0.0.1", "localhost", "::1"].includes(host))
        console.error(`warning: ${host} is not loopback and there is no login: anyone who can reach this port can read your usage counts and costs (never prompts or keys).`);
    });
  } else if (cmd === "log") {
    const all = byApp(readLog(arg ?? cfg.log.path));
    if (!all.length) return void console.log(`no entries in ${arg ?? cfg.log.path}`);
    const scoped = v.session ? all.filter((e) => e.session === v.session) : all;
    const shown = v.all ? scoped : scoped.slice(-(Number(v.lines) || 20));
    console.log(formatLog(shown, { verbose: v.verbose, color: !!process.stdout.isTTY && !process.env.NO_COLOR, all }));
  } else if (cmd === "report") {
    if (!arg) return void console.log("usage: cachekit report <log.jsonl> [--json]");
    const r = buildReport(byApp(readLog(arg)));
    print(formatReport(r), r);
  } else if (cmd === "status") {
    // as a Claude Code status line, stdin carries {"session_id": ...}. An id that is given but has no rows means
    // "no data", never another session's numbers. With no id at all, the latest session is used.
    const sid = v.session ?? (await stdinSession());
    const es = readSession(cfg.log.path, sid);
    print(statusLine(es, sid), statusReport(es, sid));
  } else if (cmd === "mcp") {
    try { await import("@modelcontextprotocol/sdk/server/index.js"); }
    catch { throw new Error("`cachekit mcp` needs the optional dependency: npm install -g @modelcontextprotocol/sdk"); }
    await (await import("./mcp.js")).runMcp(cfg.log.path);
  }
}
main().catch((e) => { console.error(`cachekit: ${e?.message ?? e}`); process.exit(1); });
