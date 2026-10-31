import Anthropic from "@anthropic-ai/sdk";
import { type Config } from "./config.js";
import { History } from "./history.js";
import type { Block, Req } from "./types.js";
export type CreateParams = Req & {
    static?: string | Block | Block[];
    volatile?: string | Block | Block[];
};
export interface CacheClientOpts {
    /** An existing SDK client; otherwise one is built from apiKey/baseURL/env. */
    client?: Anthropic;
    apiKey?: string;
    baseURL?: string;
    /** Path to cachekit.toml, or a partial config object. Default: ./cachekit.toml if present. */
    config?: string | Record<string, unknown>;
    sessionId?: string;
}
export declare class CacheClient {
    private opts;
    readonly cfg: Config;
    readonly sdk: Anthropic;
    private tracker;
    private logger;
    private keepalive;
    private entries;
    private seenWarnings;
    private ratio?;
    private lastModel?;
    /** One CacheClient is one session unless you pass `sessionId`; editing the system prompt must stay a diff, not a new session. */
    private sid;
    constructor(opts?: CacheClientOpts);
    private say;
    private record;
    /** Drop-in for `client.messages.create`, plus optional `static` (cached after system) and `volatile` (after the last breakpoint). */
    create(params: CreateParams, options?: unknown): Promise<Anthropic.Message>;
    private prepare;
    private tokenFn;
    /** Per-instance totals: hit rate, cost with and without caching, miss causes. */
    stats(): import("./metrics.js").Totals;
    explainLastMiss(): {
        found: boolean;
        at: string;
        session: string;
        lineage: string;
        label: string;
        model: string;
        causes: import("./types.js").Cause[];
        usage: import("./types.js").Usage;
        gap_s: number | null;
    } | {
        at?: undefined;
        session?: undefined;
        lineage?: undefined;
        label?: undefined;
        model?: undefined;
        causes?: undefined;
        gap_s?: undefined;
        found: boolean;
        usage?: undefined;
    };
    /** Summarize old turns in one request. The next call will miss the cache; a warning is logged. */
    compact(history: History, opts?: {
        model?: string;
        keepLast?: number;
    }): Promise<boolean>;
    close(): void;
}
/** Wrap an existing SDK client: `messages.create` goes through cachekit, everything else is untouched. */
export declare function wrap(client: Anthropic, opts?: Omit<CacheClientOpts, "client">): Anthropic;
