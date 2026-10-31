import type { Cause, Req, Ttl } from "./types.js";
export interface Snapshot {
    model: string;
    thinking: string;
    toolNames: string[];
    toolHashes: Record<string, string>;
    systemLines: string[];
    /** per message, per block content hashes (cache_control excluded) */
    msgs: string[][];
    /** last breakpoint inside messages: messages 0..msg-1 whole, message `msg` up to `block` */
    marker: {
        msg: number;
        block: number;
    } | null;
    hasMarker: boolean;
    ttl: Ttl;
    /** hash of model + thinking + tools + system: what every request in a lineage shares */
    head: string;
    /** hash of everything up to and including the last breakpoint */
    prefix: string;
}
export declare function snapshot(req: Req): Snapshot;
/** What changed in the cacheable prefix between two calls of one lineage, as ordered causes. */
export declare function diff(prev: Snapshot, cur: Snapshot): Cause[];
