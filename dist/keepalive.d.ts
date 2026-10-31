import { type Config } from "./config.js";
import type { Ctx } from "./session.js";
import type { Entry, Req, Usage } from "./types.js";
export type Send = (req: Req, headers: Record<string, string>, path: string) => Promise<{
    status: number;
    usage?: Usage;
}>;
/**
 * Optional TTL keep-alive: replays the last request with max_tokens 0 (prefill only, no output billed) shortly before
 * the cache entry would expire. Stops once refreshes have cost more than one re-write would, so it can't spend
 * forever on an idle session. Real traffic resets the clock. Headers (API key) are held in memory only.
 */
export declare class KeepAlive {
    private cfg;
    private send;
    private onEntry;
    private refreshed;
    private say;
    private state;
    constructor(cfg: Config, send: Send, onEntry: (e: Entry) => void, refreshed: (ctx: Ctx, usage: Usage) => void, say?: (s: string) => void);
    touch(ctx: Ctx, req: Req, headers: Record<string, string>, usage: Usage, path?: string): void;
    private fire;
    stop(): void;
}
