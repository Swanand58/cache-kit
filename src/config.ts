import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
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
  tokens: { count: "estimate" | "api" };
  log: { path: string; quiet: boolean };
  proxy: { port: number; upstream: string; optimize: boolean; session_header: string };
  keepalive: { enabled: boolean; margin_seconds: number; max_refreshes: number };
  compact: { keep_last: number };
  models: Record<string, ModelCfg>;
}

// Source: Anthropic model + prompt-caching docs as of 2026-10. Haiku 5.5 / Opus 5 cache_read
// are the standard 0.1x of input (not separately documented); 512-token minimums for the 5.x
// models are marked "check the docs" upstream. Override any of these in cachekit.toml.
const m = (min_tokens: number, input: number, output: number, cache_read: number): ModelCfg =>
  ({ min_tokens, input, output, cache_read });

export const DEFAULT_MODELS: Record<string, ModelCfg> = {
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
/** Used for models not in the table (new model, custom alias). */
const FALLBACK: ModelCfg = m(1024, 3, 15, 0.3);

export const DEFAULTS: Config = {
  ttl: "5m",
  tokens: { count: "estimate" },
  log: { path: "~/.cachekit/log.jsonl", quiet: false },
  proxy: { port: 8787, upstream: "https://api.anthropic.com", optimize: false, session_header: "x-claude-code-session-id" },
  keepalive: { enabled: false, margin_seconds: 30, max_refreshes: 12 },
  compact: { keep_last: 4 },
  models: DEFAULT_MODELS,
};

export const expandHome = (p: string) => (p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
function merge<T>(base: T, over: unknown): T {
  if (!isObj(over) || !isObj(base)) return (over ?? base) as T;
  const out: Obj = { ...base };
  for (const k of Object.keys(over)) out[k] = k in base ? merge((base as Obj)[k], over[k]) : over[k];
  return out as T;
}

/** Load `cachekit.toml` (explicit path, else ./cachekit.toml if present), merged over defaults. */
export function loadConfig(path?: string, overrides: Obj = {}): Config {
  const file = path ?? (existsSync("cachekit.toml") ? "cachekit.toml" : undefined);
  let cfg = DEFAULTS;
  if (file) cfg = merge(cfg, parse(readFileSync(file, "utf8")));
  cfg = merge(cfg, overrides);
  if (cfg.ttl !== "5m" && cfg.ttl !== "1h") throw new Error(`cachekit.toml: ttl must be "5m" or "1h"`);
  return { ...cfg, log: { ...cfg.log, path: expandHome(cfg.log.path) } };
}

/** Exact match, else longest known prefix (handles dated suffixes), else the fallback row. */
export function modelCfg(cfg: Config, model: string): ModelCfg {
  if (cfg.models[model]) return cfg.models[model];
  const hit = Object.keys(cfg.models).filter((k) => model.startsWith(k)).sort((a, b) => b.length - a.length)[0];
  return hit ? cfg.models[hit] : FALLBACK;
}

export const writePrice = (mc: ModelCfg, ttl: Ttl) =>
  ttl === "1h" ? mc.cache_write_1h ?? mc.input * 2 : mc.cache_write_5m ?? mc.input * 1.25;
