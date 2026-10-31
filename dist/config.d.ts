import type { Ttl } from "./types.js";
/** Prices are USD per million tokens. Write prices default to 1.25x / 2x of `input`. */
export interface ModelCfg {
    min_tokens: number;
    input: number;
    output: number;
    cache_read: number;
    cache_write_5m?: number;
    cache_write_1h?: number;
}
export interface Config {
    ttl: Ttl;
    tokens: {
        count: "estimate" | "api";
    };
    log: {
        path: string;
        quiet: boolean;
    };
    proxy: {
        port: number;
        upstream: string;
        optimize: boolean;
        session_header: string;
    };
    keepalive: {
        enabled: boolean;
        margin_seconds: number;
        max_refreshes: number;
    };
    compact: {
        keep_last: number;
    };
    models: Record<string, ModelCfg>;
}
export declare const DEFAULT_MODELS: Record<string, ModelCfg>;
export declare const DEFAULTS: Config;
export declare const expandHome: (p: string) => string;
type Obj = Record<string, unknown>;
/** Load `cachekit.toml` (explicit path, else ./cachekit.toml if present), merged over defaults. */
export declare function loadConfig(path?: string, overrides?: Obj): Config;
/** Exact match, else longest known prefix (handles dated suffixes), else the fallback row. */
export declare function modelCfg(cfg: Config, model: string): ModelCfg;
export declare const writePrice: (mc: ModelCfg, ttl: Ttl) => number;
export {};
