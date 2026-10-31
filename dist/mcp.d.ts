/**
 * MCP server (stdio) with `cache_stats` and `explain_last_miss`. Reads the proxy's JSONL log, so it works from any
 * process. Needs the optional peer dependency @modelcontextprotocol/sdk.
 */
export declare function runMcp(logPath: string): Promise<void>;
