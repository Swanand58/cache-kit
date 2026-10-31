<h1 align="center">cachekit</h1>

<p align="center"><b>Find out why your Anthropic prompt cache hit or missed, and make it hit more.</b></p>

<p align="center">
  <a href="https://www.npmjs.com/package/cachekit-cli"><img alt="npm version" src="https://img.shields.io/npm/v/cachekit-cli.svg"></a>
  <a href="https://www.npmjs.com/package/cachekit-cli"><img alt="npm downloads" src="https://img.shields.io/npm/dm/cachekit-cli.svg"></a>
  <a href="https://github.com/Swanand58/cache-kit/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Swanand58/cache-kit/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/Swanand58/cache-kit/blob/main/LICENSE"><img alt="license: MIT" src="https://img.shields.io/npm/l/cachekit-cli.svg"></a>
  <img alt="node 20 or newer" src="https://img.shields.io/node/v/cachekit-cli.svg">
  <img alt="TypeScript types included" src="https://img.shields.io/npm/types/cachekit-cli.svg">
</p>

Makes Anthropic API calls cache-friendly and tells you **why** each call hit or missed the prompt cache. Cached input tokens cost about 0.1x, so a silent miss (a changed system line, a reordered tool, a TTL expiry) is real money. cachekit sits between your harness and the API, reads the `usage` of every call, diffs the cacheable prefix against the previous call, and names the cause.

```
$ cachekit log
10-31 14:02:11  MISS    main claude-opus-5-5   hit   0%  read      0  write  52.1k  in     12  out    340  $0.2674 (uncached $0.2152)
          └ first_call    first call in this lineage (cold cache)
10-31 14:02:40  HIT     main claude-opus-5-5   hit  99%  read  52.1k  write    420  in     12  out    300  $0.0186 (uncached $0.2160)
10-31 14:03:05  MISS    main claude-opus-5-5   hit   0%  read      0  write  52.6k  in     14  out    210  $0.2672 (uncached $0.2143)
          └ system        system prompt line 14 changed
10-31 14:11:30  MISS    main claude-opus-5-5   hit   0%  read      0  write  52.9k  in     12  out    180  $0.2682 (uncached $0.2155)
          └ ttl_expiry    ttl expiry: 505s since the last call, 5m TTL
```
<sub>Illustrative numbers; the format is real.</sub>

**Contents:** [Install](#install) · [Quick start: proxy](#quick-start-proxy) · [What it diagnoses](#what-it-diagnoses) · [Library](#library) · [Configuration](#configuration-cachekittoml) · [Keep-alive](#keep-alive-off-by-default) · [How caching works](#how-anthropic-prompt-caching-works-short-version) · [Tests and eval](#tests-and-eval) · [Known limits](#known-limits)

Three ways to use it, in priority order:

1. **Local proxy** (primary): `ANTHROPIC_BASE_URL=http://localhost:8787`. No code changes; works with Claude Code and other harnesses.
2. **Observe-only** (the proxy default): requests are forwarded byte-for-byte; cachekit only records and diagnoses. `--optimize` opts in to rewriting.
3. **Library**: `CacheClient(...).create(...)` or `wrap(anthropicClient)`.

Node >= 20 (zstd response decoding needs a Node that ships `zlib.createZstdDecompress`, e.g. 22.15+/24). Dependencies: `@anthropic-ai/sdk`, `smol-toml`. `@modelcontextprotocol/sdk` is an optional peer, needed only for `cachekit mcp`.

## Install

Not on npm yet; install straight from GitHub (the built `dist/` is committed, so nothing compiles on your machine):

```sh
# CLI / proxy, on your PATH
npm install -g cachekit-cli
cachekit --help          # the command is `cachekit`

# or as a library in your project
npm install cachekit-cli

# optional, only for `cachekit mcp`
npm install -g @modelcontextprotocol/sdk
```

The npm package is `cachekit-cli`; the command it installs is `cachekit`. To try the latest unreleased code straight from GitHub, use the tarball URL (on npm 11.4.2 the `github:` shorthand leaves a dangling link when installed with `-g`):

```sh
npm install -g https://codeload.github.com/Swanand58/cache-kit/tar.gz/refs/heads/main
```

From a clone (for development):

```sh
git clone https://github.com/Swanand58/cache-kit.git
cd cache-kit
npm install
npm test           # rebuilds dist/, then runs 83 tests, no network
npm link           # puts `cachekit` on your PATH
```

## Quick start: proxy

```sh
cachekit proxy --port 8787                   # observe-only
# in another shell, any harness:
ANTHROPIC_BASE_URL=http://localhost:8787 claude
```

Every call prints one line on the proxy's stderr and appends one JSON line to `~/.cachekit/log.jsonl` (raw JSONL for machines; use `cachekit log` to read it):

```
[cachekit] main claude-sonnet-5-5 hit 94% (read 52.1k write 1.2k in 12 out 340) $0.04 vs $0.31 uncached | session 91%
[cachekit] main claude-sonnet-5-5 hit 0% (read 0 write 54k in 9 out 120) $0.21 vs $0.17 uncached | session 62% | MISS: system prompt line 14 changed
```

Then:

```sh
cachekit log                                   # readable call-by-call log: last 20 calls, causes under each miss (-n 50, --all, -v for rewrites/warnings, --session id)
cachekit report ~/.cachekit/log.jsonl          # hit rate, cost saved, top causes of misses (--json for machines)
cachekit status [--session id] [--json]        # one line for a status line or hook
```

Claude Code status line (`~/.claude/settings.json`): `"statusLine": { "type": "command", "command": "cachekit status" }`. The session is chosen by `--session <id>`, else by `session_id` in the JSON on stdin (Claude Code's `session_id` is the same id cachekit logs), else the most recently active session. **An id that is given but has no rows is never replaced by another session**: the output is `cachekit: no data` (or `{"calls": 0}` with `--json`), exit 0, so sessions that don't go through the proxy show nothing.

`cachekit status --json --session <id>` returns that session's report plus:

| field | meaning |
|---|---|
| `session` | the id it reported on |
| `hit_rate` | cumulative for the session (a cold start drags it down for a long time) |
| `main_hit_rate` | cumulative, main chain only (subagents excluded), token-weighted |
| `recent_hit_rate` | last 3 calls of the session, token-weighted: the *current* state |
| `recent_main_hit_rate` | last 3 main-chain calls, token-weighted: what your next message will re-send |
| `last_miss` | newest miss of any kind, `{"kind", "ts", "label"}` (`ts` as in the log, `label` `main` or `sub`), or `null` |
| `last_real_miss` | same shape, but skips cold starts (`first_call`), so a subagent starting up doesn't hide a real problem |

The text line (`cache 94% hit | ... | last miss: ttl_expiry`) also shows only real misses. `status` scans the whole log for the session's rows (they never fall out of a window); a session that never used the proxy is just `no data`. Measured: about 0.07 s on a small log, about 0.24 s on an 80 MB log (roughly 150,000 calls; a row is ~0.5 KB, ~1 KB with `--optimize` rewrite notes).

MCP, so the agent can ask about its own cache: `claude mcp add cachekit -- cachekit mcp`. Tools: `cache_stats`, `explain_last_miss`. They read the same JSONL log the proxy writes.

### Observe-only vs `--optimize`

| | observe-only (default) | `--optimize` |
|---|---|---|
| Request body | forwarded as the exact bytes received | rewritten only if something would change; otherwise still the exact bytes |
| Rewrites | none | tools sorted by name with sorted keys; `cache_control` added at end of system and end of history (only up to 4 total, existing markers are never moved or removed; skipped below the model's minimum) |
| Audit | n/a | every rewrite (and every skipped breakpoint) is in the entry's `rewrites` and printed |

Headers (`x-api-key`, `authorization`, `anthropic-version`, `anthropic-beta`, everything else) are forwarded as received, except `Host` (set to the upstream) and hop-by-hop headers. SSE responses are piped through unbuffered; usage is read from a decoded copy (`message_start` + final `message_delta`), so gzip/br/zstd responses reach the client untouched. API keys are never logged. Logs hold hashes, counts and cause labels, never prompt text.

If cachekit hits an internal error, the request is forwarded untouched and the error is logged. If the client hangs up mid-stream, the usage seen so far is still recorded.

First `--optimize` call after enabling will miss once: the sorted tool order is a different prefix than the harness's.

## What it diagnoses

Each miss gets ordered causes:

| cause | meaning |
|---|---|
| `model`, `thinking` | model, `thinking`, or `output_config.effort` changed mid-session |
| `tools`, `tool_order` | `tool \`search\` schema changed`, added/removed, or reordered |
| `system` | `system prompt line 14 changed` (line numbers, never text) |
| `compaction` | history shrank or an earlier message changed (harness-side compaction; not an error). Ranked above `system`/`tools`: `/compact` swaps the system prompt and rewrites history together, and the history is the cause |
| `ttl_expiry` | gap since the last call exceeded the TTL the request itself asked for (read from its last `cache_control`: Claude Code sets `"ttl": "1h"` on a subscription login and the 5m default on an API-key login) |
| `parallel` | same prefix in flight before the first response began streaming; **warm the cache with one call, wait for its first streamed token, then fan out** |
| `no_breakpoint`, `below_min` | no `cache_control` at all, or a breakpoint that wrote nothing (prefix likely under the model minimum) |
| `first_call` | cold start of a lineage |
| `unknown` | prefix identical and within TTL: workspace/org change, 20-block lookback, or server-side invalidation |

A call also counts as a miss when `cache_read_input_tokens` falls below half of what the lineage cached last time.

**Sessions** come from the `x-claude-code-session-id` header (configurable), else a hash of system prompt + first user message. Without a header, editing the system prompt starts a new session, so prefer a header.
**Lineages**: within a session, calls are grouped into chains (main agent, each subagent, title generator). A call joins a chain if its system prompt mostly matches (line-set overlap >= 0.5) or its conversation starts with the same first user message; otherwise it starts its own chain, so a subagent never shows up as "the main agent's system prompt changed". The chain with the most calls is labelled `main`.
**Volatile values**: timestamps, dates, UUIDs, epochs, request ids and "current date" phrases are flagged in tools/system (the parts that must stay byte-stable). Only the kind and location are logged. Messages aren't scanned: history is append-only, so an old date in a user turn is harmless; if a message in the prefix does change it is reported as `compaction`.

## Library

```ts
import { CacheClient, History } from "cachekit-cli";

const ck = new CacheClient({ config: "cachekit.toml" });   // or wrap(anthropic) to keep the SDK client's shape

const res = await ck.create({
  model: "claude-opus-5-5",
  max_tokens: 1024,
  tools,                                   // sorted by name, keys sorted
  system: "You are a support agent.",
  static: [{ type: "text", text: manualText }],   // static docs: appended after system, cached
  messages: history.messages as never,     // append-only history; last block gets a breakpoint
  volatile: `Now: ${new Date().toISOString()}`,   // per-call content: appended after the last breakpoint, never cached
});

ck.stats();            // hit rate, tokens, cost with/without caching, cause counts
ck.explainLastMiss();  // { found, causes: [...], ... }
await ck.compact(history, { keepLast: 4 });   // one summarizing request; logs that the next call will miss
```

Only order, wrapper shape (string content -> text block) and `cache_control` markers change. No text is edited, and model, `max_tokens`, `thinking`, etc. pass through. A `CacheClient` is one session unless you pass `sessionId`. `stream: true` requests are passed straight to the SDK (use the proxy for streaming).

Never blocks: if preparing a request throws, the same content is sent unmarked and the error is logged.

## Configuration: `cachekit.toml`

One file, every key optional (see the commented example in this repo). Notable keys: `ttl` (`"5m"` or `"1h"` for breakpoints cachekit adds), `[log] path/quiet`, `[proxy] port/upstream/optimize/session_header`, `[keepalive]`, `[tokens] count = "estimate" | "api"`, and `[models."<id>"]` rows (`min_tokens`, `input`, `output`, `cache_read`, optional `cache_write_5m/1h`) for the per-model minimum-token table and prices. Prices are USD per million tokens and default to the published rates as of 2026-10; check them before trusting a dollar figure. Unknown models fall back to a Sonnet-ish row, and dated IDs resolve by prefix.

Token counting: chars/4 estimate by default; `count = "api"` makes one `count_tokens` call per `CacheClient` to calibrate the estimate (library mode only; the proxy never adds a request to your path).

## Keep-alive (off by default)

`--keepalive` / `[keepalive] enabled = true`. Shortly before a lineage's cache would expire (default 30s margin) cachekit replays the last request with `max_tokens: 0` (prefill only, nothing billed for output; retried with `1` if the model rejects 0), `stream` removed. It prints the break-even once per session, e.g.

```
[cachekit] keep-alive: each refresh ~$0.0104 vs ~$0.2600 to re-write 52000 tokens after expiry; worth it for up to 12 refreshes (~60 min idle)
```

and stops by itself once refreshes have cost about one re-write, or after `max_refreshes`. In proxy mode this holds the request's auth headers **in memory only** (never logged or written).

## How Anthropic prompt caching works (short version)

- The prompt is rendered in a fixed order: **tools -> system -> messages**. The cache matches on an exact **prefix** up to a `cache_control` breakpoint: change one byte anywhere before it and everything after misses.
- You mark breakpoints with `cache_control: {"type": "ephemeral"}` (5 minute TTL) or `{"type": "ephemeral", "ttl": "1h"}`. At most **4** per request. Each breakpoint looks back at most 20 positions for an earlier entry.
- **Price**: reads cost about 0.1x the input price (less on some models), writes cost 1.25x (5m) or 2x (1h). A 5-minute entry pays for itself on the second request.
- A hit **refreshes the TTL** for free; the clock runs from the start of the last request that wrote or read the entry.
- Prefixes under a model-specific **minimum** (512-4096 tokens) silently don't cache.
- An entry is readable only once the writing response **begins**, so simultaneous requests with the same prefix all miss.
- `usage` tells you what happened: `cache_read_input_tokens`, `cache_creation_input_tokens`, and `input_tokens` (the uncached remainder). Hit rate here is `read / (read + creation + input)`.

So: stable stuff first (tools, system, docs), growing history next, volatile stuff (timestamps, per-user data, retrieved chunks) last, after the final breakpoint.

## Tests and eval

```sh
npm test              # unit + integration, no network (mock SDK, mock upstream server)
npm run typecheck
ANTHROPIC_API_KEY=... npm run eval -- --model claude-haiku-5-5   # raw vs cachekit, side by side
npm run eval -- --mock                                           # plumbing check, no key
```

The integration tests cover observe-only byte-for-byte forwarding (body and headers), unbuffered SSE (first bytes arrive before the upstream finishes), gzip responses, client hang-ups, `--optimize` rewrite logging, parse-failure passthrough, upstream errors, subagent lineages, parallel detection, compaction, and keep-alive.

The eval runs each prompt through the raw client twice (that gap is the sampling noise, since current models don't accept `temperature`) and once through cachekit with identical content, then compares similarity against that noise floor and checks per-prompt `expect` regexes. Outputs go to `eval/results.json`.

## Known limits

- Library mode doesn't wrap streaming; use the proxy for streams.
- Token estimates are chars/4; base64 images/PDFs overcount. Use `count = "api"` in library mode.
- Sorting tool JSON keys also reorders `input_schema.properties`, which the model can see. Content is identical, but if you care, keep tools out of `--optimize` by sorting them yourself the way you want.
- TTL ordering rule (a 1h breakpoint must precede 5m ones) isn't enforced when you mix existing markers with `ttl = "1h"` added by cachekit.
- Lineage/session grouping is heuristic (see above); no system prompt at all falls back to matching on tool names.
