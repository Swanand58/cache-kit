import type { Msg } from "./types.js";
import { blocksOf } from "./normalize.js";

/** Append-only conversation history. The only way to shrink it is `compact()`. */
export class History {
  private msgs: Msg[] = [];
  get messages(): readonly Msg[] { return this.msgs; }
  push(...m: Msg[]) { this.msgs.push(...m); return this; }

  /**
   * Replace all but the last `keepLast` messages with one summary message, in a single `summarize` call.
   * Rewrites the prefix, so the next request is a cache miss; that is logged. The cut never lands between a
   * tool_use and its tool_result.
   */
  async compact(summarize: (old: Msg[]) => Promise<string>, keepLast = 4, warn: (s: string) => void = console.error): Promise<boolean> {
    let cut = this.msgs.length - keepLast;
    const startsWithResult = (m: Msg) => m.role === "user" && blocksOf(m.content).some((b) => b.type === "tool_result");
    while (cut > 0 && startsWithResult(this.msgs[cut])) cut--;
    if (cut <= 0) return false;
    const old = this.msgs.slice(0, cut);
    const summary = await summarize(old);
    this.msgs = [{ role: "user", content: `[Summary of earlier conversation]\n${summary}` }, ...this.msgs.slice(cut)];
    warn(`[cachekit] WARNING: compact() replaced ${old.length} messages with a summary; the next call will be a cache miss.`);
    return true;
  }
}
