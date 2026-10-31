import type { Block, Req } from "./types.js";
export declare const hash: (s: string) => string;
/** Deterministic JSON: object keys sorted recursively, array order kept. `dropCache` omits cache_control (for hashing). */
export declare const canon: (v: unknown, dropCache?: boolean) => string;
export declare const blocksOf: (c: string | Block[]) => Block[];
export declare const systemBlocks: (s: Req["system"]) => Block[];
export declare const systemText: (s: Req["system"]) => string;
export declare const toBlocks: (x: string | Block | Block[]) => Block[];
/** Rough token estimate (~4 chars/token). ponytail: base64 images/PDFs overcount; use tokens.count="api" to calibrate. */
export declare const estimateTokens: (x: unknown) => number;
/**
 * Volatile values in tools/system (the parts that must stay byte-stable). Messages are not scanned:
 * history is append-only, so a date in an old user turn is stable; if it does change, the prefix diff reports it.
 * Returns `kind in where` strings only, never the matched text (logs must not carry prompt content).
 */
export declare function findVolatile(req: Pick<Req, "system" | "tools">): string[];
export interface NormalizeOpts {
    static?: string | Block | Block[];
    sortTools?: boolean;
}
/**
 * Library-mode normalization: deterministic tools (sorted by name, keys sorted), `static` blocks appended to
 * `system`. Only order and wrapper shape change; no text is edited. Returns a clone.
 */
export declare function normalize(input: Req, opts?: NormalizeOpts): {
    req: Req;
    rewrites: string[];
};
/** Append per-call content after the last breakpoint, as a trailing text block of the final user message. */
export declare function appendVolatile(req: Req, volatile: string | Block | Block[]): string;
