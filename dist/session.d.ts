import { type Totals } from "./metrics.js";
import { type Snapshot } from "./prefix.js";
import type { Config } from "./config.js";
import type { Entry, Req, Usage } from "./types.js";
interface Lineage {
    id: string;
    lines: Set<string>;
    tools: Set<string>;
    first: string;
    prev?: Snapshot;
    prevAt: number;
    prevCached: number;
    calls: number;
}
export interface Ctx {
    sid: string;
    lineage: Lineage;
    snap: Snapshot;
    start: number;
    /** another request with the same head was in flight and had not begun streaming when this one started */
    parallel: boolean;
    streaming: boolean;
    done: boolean;
    req: Req;
}
export interface EndInfo {
    usage?: Usage;
    status: number;
    stream: boolean;
    rewrites?: string[];
    warnings?: string[];
    error?: string;
}
/** Text of the first user message, only up to the last breakpoint: the uncached tail is volatile by definition. */
export declare const firstUserText: (req: Req, marker?: Snapshot["marker"]) => string;
/** Session id from a header, else a hash of the system prompt + first user message. */
export declare const deriveSession: (req: Req, header: string | undefined, marker: Snapshot["marker"]) => string;
/**
 * Tracks sessions and prefix lineages. A lineage is one agent's call chain: calls whose system prompt is mostly the
 * same line set, or that start with the same first user message, belong together (so system edits and tool/model
 * changes are *diffs*); a different system prompt and task starts a new lineage (subagent, title generator) and never
 * pollutes the main chain's diffs.
 * ponytail: with no system prompt at all, lineages match on tool names instead.
 */
export declare class Tracker {
    private cfg;
    private now;
    private sessions;
    private waiting;
    constructor(cfg: Config, now?: () => number);
    begin(req: Req, sessionHeader?: string): Ctx;
    /** Call when the response begins (first byte). Entries become readable from here. */
    firstByte(ctx: Ctx): void;
    /** Request failed or was cut off before a usable response. */
    abort(ctx: Ctx): void;
    private release;
    end(ctx: Ctx, info: EndInfo): Entry;
    /** A keep-alive refresh restarts the TTL clock for the lineage. */
    refreshed(sid: string, lineageId: string, usage: Usage, at?: number): void;
    totals(sid: string): Totals;
    /** "main" for the lineage with the most calls in its session, else "sub". */
    label(ctx: Ctx): "main" | "sub";
}
export {};
