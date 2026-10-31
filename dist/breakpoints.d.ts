import { type Config } from "./config.js";
import type { Req } from "./types.js";
export declare const MAX_BREAKPOINTS = 4;
export declare function countMarkers(req: Req): number;
/**
 * Add cache_control at (1) the end of the static block (last system block, or last tool if there is no system)
 * and (2) the last block of the last history message. Mutates `req` (pass a clone). Never exceeds 4 markers in total
 * (existing ones count and are never moved or removed), and skips a breakpoint whose prefix is below the model minimum.
 * `tokens` estimates a request's size.
 */
export declare function placeBreakpoints(req: Req, cfg: Config, tokens?: (r: unknown) => number): string[];
