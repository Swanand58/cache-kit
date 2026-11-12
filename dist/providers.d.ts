import type { Provider, Req, Ttl, Usage } from "./types.js";
/** OpenAI endpoints get the OpenAI upstream; everything else (including /v1/messages) goes to Anthropic, as before. */
export declare const providerOf: (pathname: string) => Provider;
/** The calls that carry a prompt (GETs and sub-paths such as /v1/responses/{id} are only forwarded). */
export declare const isOpenAICall: (method: string | undefined, pathname: string) => boolean;
/**
 * Chat Completions and Responses usage -> the shared `Usage` shape, so hit rate and cost work unchanged:
 * cache_read = cached tokens, cache_creation = cache-write tokens, input = everything else in the prompt.
 */
export declare function parseOpenAIUsage(raw: any): Usage;
/** Usage from one streamed event: a Chat chunk with a `usage` object (needs stream_options.include_usage), or a Responses `response.*` event. */
export declare function openaiStreamUsage(ev: any): Usage | undefined;
/** GPT-5.6 and later: 30m by default, 12h on request. Older models: 24h unless the request asks for in_memory. */
export declare function openaiTtl(body: any): Ttl;
/**
 * An OpenAI request as the `Req` the Tracker already understands, so sessions, lineages and prefix diffs work as for
 * Anthropic. OpenAI caches automatically, so the one "breakpoint" goes at the end of the last message, carrying the
 * TTL the request implies. Returns undefined when the body is not a prompt we can follow (the caller forwards it untouched).
 */
export declare function openaiToReq(path: string, body: any): Req | undefined;
