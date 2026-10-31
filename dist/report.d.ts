import type { Cause } from "./types.js";
import type { Entry } from "./types.js";
/** Entries of one session: `sid`, else the session with the most recent entry. */
export declare function sessionEntries(entries: Entry[], sid?: string): Entry[];
/** Per session, the lineage with the most calls is "main"; others are "sub". */
export declare function labels(entries: Entry[]): (e: Entry) => "main" | "sub";
export declare function buildReport(entries: Entry[]): {
    calls: number;
    sessions: number;
    tokens: {
        read: number;
        creation: number;
        input: number;
        output: number;
    };
    hit_rate: number;
    cost: number;
    cost_uncached: number;
    saved: number;
    saved_pct: number;
    misses: number;
    top_causes: {
        kind: string;
        count: number;
    }[];
    lineages: {
        session: string;
        lineage: string;
        label: string;
        calls: number;
        hit_rate: number;
    }[];
    warnings: {
        warning: string;
        count: number;
    }[];
    advice: string[];
};
export declare function formatReport(r: ReturnType<typeof buildReport>): string;
export declare function lastMiss(entries: Entry[], sid?: string): {
    found: boolean;
    at: string;
    session: string;
    lineage: string;
    label: string;
    model: string;
    causes: Cause[];
    usage: import("./types.js").Usage;
    gap_s: number | null;
} | {
    at?: undefined;
    session?: undefined;
    lineage?: undefined;
    label?: undefined;
    model?: undefined;
    causes?: undefined;
    usage?: undefined;
    gap_s?: undefined;
    found: boolean;
};
/** One line for a Claude Code status line. */
export declare function statusLine(entries: Entry[], sid?: string): string;
/**
 * Human-readable log: one line per call, causes indented under misses, then a totals line.
 * `all` is the whole log (so main/sub labels are right even when `shown` is just the tail).
 */
export declare function formatLog(shown: Entry[], opts?: {
    verbose?: boolean;
    color?: boolean;
    all?: Entry[];
}): string;
