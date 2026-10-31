import { type Config } from "./config.js";
import type { Entry, Ttl, Usage } from "./types.js";
export declare function parseUsage(raw: any): Usage;
/** hit rate = read / (read + creation + input) */
export declare const hitRate: (u: Usage) => number;
/** USD actually billed vs what the same tokens would cost with no caching. */
export declare function cost(cfg: Config, model: string, u: Usage, fallbackTtl: Ttl): {
    actual: number;
    uncached: number;
};
export declare class Logger {
    readonly path: string;
    private ready;
    constructor(path: string);
    write(e: Entry): void;
}
/** Read entries; `tailBytes` limits reading to the end of a large log (status line use). */
export declare function readLog(path: string, tailBytes?: number): Entry[];
export interface Totals {
    calls: number;
    read: number;
    creation: number;
    input: number;
    output: number;
    hit_rate: number;
    cost: number;
    uncached: number;
    saved: number;
    misses: number;
    causes: Record<string, number>;
}
export declare const emptyTotals: () => Totals;
/** Fold one entry into `t` (in place). Keep-alive refreshes count toward cost but not hit rate or call/miss counts. */
export declare function addEntry(t: Totals, e: Entry): Totals;
export declare const aggregate: (entries: Entry[]) => Totals;
declare const usd: (x: number) => string;
export { usd };
export declare function summaryLine(e: Entry, cum: Totals, label: string): string;
