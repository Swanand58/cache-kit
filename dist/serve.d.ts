import http from "node:http";
import type { Entry } from "./types.js";
/**
 * Prometheus text for a log: counters per provider, model and app (plus miss cause and token kind).
 * ponytail: derived from the whole log on each scrape, so a counter can dip if the busiest-50 set changes or the log
 * is deleted (Prometheus treats that as a reset); the cost of a scrape grows with the log size.
 */
export declare function prometheus(entries: Entry[], top?: number): string;
export interface ServeOpts {
    logPath: string;
    host?: string;
}
/** Read-only HTTP view of the log: GET /stats.json[?app=tag] and GET /metrics. Nothing else, and it never writes. */
export declare function createServe(opts: ServeOpts): http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;
