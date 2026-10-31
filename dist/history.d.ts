import type { Msg } from "./types.js";
/** Append-only conversation history. The only way to shrink it is `compact()`. */
export declare class History {
    private msgs;
    get messages(): readonly Msg[];
    push(...m: Msg[]): this;
    /**
     * Replace all but the last `keepLast` messages with one summary message, in a single `summarize` call.
     * Rewrites the prefix, so the next request is a cache miss; that is logged. The cut never lands between a
     * tool_use and its tool_result.
     */
    compact(summarize: (old: Msg[]) => Promise<string>, keepLast?: number, warn?: (s: string) => void): Promise<boolean>;
}
