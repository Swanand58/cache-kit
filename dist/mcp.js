import { readLog } from "./metrics.js";
import { buildReport, lastMiss, sessionEntries } from "./report.js";
/**
 * MCP server (stdio) with `cache_stats` and `explain_last_miss`. Reads the proxy's JSONL log, so it works from any
 * process. Needs the optional peer dependency @modelcontextprotocol/sdk.
 */
export async function runMcp(logPath) {
    const { Server } = await import("@modelcontextprotocol/sdk/server/index.js");
    const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
    const { CallToolRequestSchema, ListToolsRequestSchema } = await import("@modelcontextprotocol/sdk/types.js");
    const server = new Server({ name: "cachekit", version: "0.1.0" }, { capabilities: { tools: {} } });
    const schema = { type: "object", properties: { session: { type: "string", description: "Session id; default: the most recently active session" } } };
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: [
            { name: "cache_stats", description: "Prompt-cache hit rate, tokens, cost with vs without caching, and top miss causes for the current session.", inputSchema: schema },
            { name: "explain_last_miss", description: "Why the most recent prompt-cache miss happened (what changed in the cacheable prefix, TTL expiry, compaction, parallel requests).", inputSchema: schema },
        ],
    }));
    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const entries = readLog(logPath);
        const sid = req.params.arguments?.session;
        const out = req.params.name === "cache_stats" ? buildReport(sessionEntries(entries, sid)) : req.params.name === "explain_last_miss" ? lastMiss(entries, sid) : { error: "unknown tool" };
        return { content: [{ type: "text", text: JSON.stringify(out, null, 2) }] };
    });
    await server.connect(new StdioServerTransport());
}
