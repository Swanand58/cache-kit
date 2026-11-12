import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
// Source: Anthropic model + prompt-caching docs as of 2026-10. Haiku 5.5 / Opus 5 cache_read
// are the standard 0.1x of input (not separately documented); 512-token minimums for the 5.x
// models are marked "check the docs" upstream. Override any of these in cachekit.toml.
const m = (min_tokens, input, output, cache_read) => ({ min_tokens, input, output, cache_read });
export const DEFAULT_MODELS = {
    "claude-fable-5-1": m(512, 10, 50, 0.25),
    "claude-fable-5": m(512, 10, 50, 1),
    "claude-opus-5-5": m(512, 4, 20, 0.2),
    "claude-opus-5": m(512, 5, 25, 0.5),
    "claude-opus-4-8": m(1024, 5, 25, 0.5),
    "claude-opus-4-7": m(2048, 5, 25, 0.5),
    "claude-opus-4-6": m(4096, 5, 25, 0.5),
    "claude-sonnet-5-5": m(512, 2, 10, 0.2),
    "claude-sonnet-5": m(1024, 2, 10, 0.2),
    "claude-sonnet-4-6": m(1024, 3, 15, 0.3),
    "claude-haiku-5-5": m(512, 0.1, 0.5, 0.01),
    "claude-haiku-4-5": m(4096, 1, 5, 0.1),
};
// OpenAI, USD per 1M tokens, standard tier, from https://developers.openai.com/api/docs/pricing as of 2026-11-11.
// `w` = cache-write prices (30m, 12h): only GPT-5.6 and later charge for writes. The pages show no cached-input price
// for the *-pro models, so they get no discount here (cache_read = input). Override any row in cachekit.toml.
const g = (input, cache_read, output, w) => ({ min_tokens: 1024, input, output, cache_read, ...(w ? { cache_write_5m: w[0], cache_write_1h: w[1] } : {}) });
const OPENAI_MODELS = {
    "gpt-6-astra": g(10, 1, 50, [12.5, 25]),
    "gpt-6.1-sol": g(2, 0.1, 10, [2.5, 5]),
    "gpt-6.1-terra": g(1, 0.05, 5, [1.25, 2.5]),
    "gpt-6-luna": g(0.1, 0.01, 0.5, [0.125, 0.25]),
    "gpt-6-sol": g(2, 0.2, 10, [2.5, 5]),
    "gpt-5.6-sol": g(4, 0.4, 20, [5, 10]),
    "gpt-5.6-terra": g(2, 0.2, 12, [2.5, 5]),
    "gpt-5.6-luna": g(0.2, 0.02, 1.2, [0.25, 0.5]),
    "gpt-5.5": g(5, 0.5, 30),
    "gpt-5.5-pro": g(30, 30, 180),
    "gpt-5.4": g(2.5, 0.25, 15),
    "gpt-5.4-pro": g(30, 30, 180),
    "gpt-5.4-mini": g(0.75, 0.075, 4.5),
    "gpt-5.4-nano": g(0.2, 0.02, 1.25),
    "gpt-5.2": g(1.75, 0.175, 14),
    "gpt-5.2-pro": g(21, 21, 168),
    "gpt-5.1": g(1.25, 0.125, 10),
    "gpt-5": g(1.25, 0.125, 10),
    "gpt-5-mini": g(0.25, 0.025, 2),
    "gpt-5-nano": g(0.05, 0.005, 0.4),
    "gpt-5-pro": g(15, 15, 120),
    "gpt-4.1": g(2, 0.5, 8),
    "gpt-4.1-mini": g(0.4, 0.1, 1.6),
    "gpt-4o": g(2.5, 1.25, 10),
    "gpt-4o-mini": g(0.15, 0.075, 0.6),
    "o3": g(2, 0.5, 8),
    "o3-pro": g(20, 20, 80),
};
/** Used for models not in the table (new model, custom alias). */
const FALLBACK = m(1024, 3, 15, 0.3);
/** Same, for unknown OpenAI models (priced like gpt-5.4). */
const OPENAI_FALLBACK = g(2.5, 0.25, 15);
const isOpenAIModel = (model) => /^(gpt|o\d|chatgpt|codex)/.test(model);
export const DEFAULTS = {
    ttl: "5m",
    tokens: { count: "estimate" },
    log: { path: "~/.cachekit/log.jsonl", quiet: false },
    proxy: { port: 8787, upstream: "https://api.anthropic.com", optimize: false, session_header: "x-claude-code-session-id", tag_header: "x-cachekit-app" },
    providers: { openai: { upstream: "https://api.openai.com" } },
    keepalive: { enabled: false, margin_seconds: 30, max_refreshes: 12 },
    compact: { keep_last: 4 },
    models: { ...DEFAULT_MODELS, ...OPENAI_MODELS },
};
export const expandHome = (p) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function merge(base, over) {
    if (!isObj(over) || !isObj(base))
        return (over ?? base);
    const out = { ...base };
    for (const k of Object.keys(over))
        out[k] = k in base ? merge(base[k], over[k]) : over[k];
    return out;
}
/** Load `cachekit.toml` (explicit path, else ./cachekit.toml if present), merged over defaults. */
export function loadConfig(path, overrides = {}) {
    const file = path ?? (existsSync("cachekit.toml") ? "cachekit.toml" : undefined);
    let cfg = DEFAULTS;
    if (file)
        cfg = merge(cfg, parse(readFileSync(file, "utf8")));
    cfg = merge(cfg, overrides);
    if (cfg.ttl !== "5m" && cfg.ttl !== "1h")
        throw new Error(`cachekit.toml: ttl must be "5m" or "1h"`);
    return { ...cfg, log: { ...cfg.log, path: expandHome(cfg.log.path) } };
}
/** Exact match, else longest known prefix (handles dated suffixes), else the fallback row. */
export function modelCfg(cfg, model) {
    if (cfg.models[model])
        return cfg.models[model];
    const hit = Object.keys(cfg.models).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
    return hit ? cfg.models[hit] : isOpenAIModel(model) ? OPENAI_FALLBACK : FALLBACK;
}
export const writePrice = (mc, ttl) => ttl === "1h" ? mc.cache_write_1h ?? mc.input * 2 : mc.cache_write_5m ?? mc.input * 1.25;
