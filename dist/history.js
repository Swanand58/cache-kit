import { blocksOf } from "./normalize.js";
/** Append-only conversation history. The only way to shrink it is `compact()`. */
export class History {
    msgs = [];
    get messages() { return this.msgs; }
    push(...m) { this.msgs.push(...m); return this; }
    /**
     * Replace all but the last `keepLast` messages with one summary message, in a single `summarize` call.
     * Rewrites the prefix, so the next request is a cache miss; that is logged. The cut never lands between a
     * tool_use and its tool_result.
     */
    async compact(summarize, keepLast = 4, warn = console.error) {
        let cut = this.msgs.length - keepLast;
        const startsWithResult = (m) => m.role === "user" && blocksOf(m.content).some((b) => b.type === "tool_result");
        while (cut > 0 && startsWithResult(this.msgs[cut]))
            cut--;
        if (cut <= 0)
            return false;
        const old = this.msgs.slice(0, cut);
        const summary = await summarize(old);
        this.msgs = [{ role: "user", content: `[Summary of earlier conversation]\n${summary}` }, ...this.msgs.slice(cut)];
        warn(`[cachekit] WARNING: compact() replaced ${old.length} messages with a summary; the next call will be a cache miss.`);
        return true;
    }
}
