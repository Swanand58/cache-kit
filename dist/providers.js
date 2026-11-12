const n = (x) => (typeof x === "number" && Number.isFinite(x) ? x : 0);
const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** OpenAI endpoints get the OpenAI upstream; everything else (including /v1/messages) goes to Anthropic, as before. */
export const providerOf = (pathname) => /^(\/v1)?\/(chat\/completions|responses)(\/|$)/.test(pathname) ? "openai" : "anthropic";
/** The calls that carry a prompt (GETs and sub-paths such as /v1/responses/{id} are only forwarded). */
export const isOpenAICall = (method, pathname) => method === "POST" && /^(\/v1)?\/(chat\/completions|responses)\/?$/.test(pathname);
/**
 * Chat Completions and Responses usage -> the shared `Usage` shape, so hit rate and cost work unchanged:
 * cache_read = cached tokens, cache_creation = cache-write tokens, input = everything else in the prompt.
 */
export function parseOpenAIUsage(raw) {
    const total = n(raw?.prompt_tokens ?? raw?.input_tokens);
    const d = raw?.prompt_tokens_details ?? raw?.input_tokens_details ?? {};
    const read = n(d.cached_tokens), write = n(d.cache_write_tokens);
    const u = {
        input_tokens: Math.max(0, total - read - write), output_tokens: n(raw?.completion_tokens ?? raw?.output_tokens),
        cache_read_input_tokens: read, cache_creation_input_tokens: write,
    };
    const by = d.cache_write_tokens_details;
    // ponytail: OpenAI's 30m / 12h write slots ride in Anthropic's 5m / 1h fields, which `cost()` already prices separately
    if (isObj(by))
        u.cache_creation = { ephemeral_5m_input_tokens: n(by.ttl_30m_tokens), ephemeral_1h_input_tokens: n(by.ttl_12h_tokens) };
    return u;
}
/** Usage from one streamed event: a Chat chunk with a `usage` object (needs stream_options.include_usage), or a Responses `response.*` event. */
export function openaiStreamUsage(ev) {
    if (isObj(ev?.response?.usage) && /^response\.(completed|incomplete)$/.test(ev.type))
        return parseOpenAIUsage(ev.response.usage);
    if (ev?.type === undefined && isObj(ev?.usage))
        return parseOpenAIUsage(ev.usage);
}
/** GPT-5.6 and later: 30m by default, 12h on request. Older models: 24h unless the request asks for in_memory. */
export function openaiTtl(body) {
    const asked = body?.prompt_cache_options?.ttl;
    if (asked === "30m" || asked === "12h")
        return asked;
    if (/^gpt-(5\.[6-9]|6|[7-9])/.test(String(body?.model)))
        return "30m";
    return body?.prompt_cache_retention === "in_memory" ? "in_memory" : "24h";
}
const blocks = (content) => typeof content === "string" ? [{ type: "text", text: content }]
    : Array.isArray(content) ? content.map((p) => (isObj(p) ? p : { type: "text", text: String(p) }))
        : [];
const text = (content) => blocks(content).map((b) => b.text ?? "").join("\n");
/**
 * An OpenAI request as the `Req` the Tracker already understands, so sessions, lineages and prefix diffs work as for
 * Anthropic. OpenAI caches automatically, so the one "breakpoint" goes at the end of the last message, carrying the
 * TTL the request implies. Returns undefined when the body is not a prompt we can follow (the caller forwards it untouched).
 */
export function openaiToReq(path, body) {
    if (!isObj(body) || typeof body.model !== "string")
        return;
    const chat = /chat\/completions/.test(path);
    let system;
    let messages;
    if (chat) {
        if (!Array.isArray(body.messages))
            return;
        const lead = body.messages.findIndex((m) => m?.role !== "system" && m?.role !== "developer");
        const head = lead < 0 ? body.messages : body.messages.slice(0, lead);
        if (head.length)
            system = head.map((m) => text(m.content)).join("\n");
        messages = (lead < 0 ? [] : body.messages.slice(lead)).map((m) => ({ role: String(m?.role), content: [...blocks(m?.content), ...(Array.isArray(m?.tool_calls) ? m.tool_calls : [])] }));
    }
    else {
        if (typeof body.instructions === "string")
            system = body.instructions;
        const input = body.input;
        messages = typeof input === "string" ? [{ role: "user", content: blocks(input) }]
            : Array.isArray(input) ? input.map((it) => ({ role: String(it?.role ?? (it?.type === "function_call_output" ? "user" : "assistant")), content: it?.role ? blocks(it.content) : [it] })) : [];
    }
    const last = messages[messages.length - 1];
    if (!last)
        return;
    if (!last.content.length)
        last.content = [{ type: "text", text: "" }];
    const tail = last.content[last.content.length - 1];
    tail.cache_control = { type: "ephemeral", ttl: openaiTtl(body) };
    const tools = Array.isArray(body.tools)
        ? body.tools.map((t) => ({ ...t, name: String(t?.function?.name ?? t?.name ?? t?.type) })) : undefined;
    return { model: body.model, messages, ...(system !== undefined ? { system } : {}), ...(tools ? { tools } : {}) };
}
