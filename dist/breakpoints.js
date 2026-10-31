import { modelCfg } from "./config.js";
import { blocksOf, estimateTokens } from "./normalize.js";
export const MAX_BREAKPOINTS = 4;
export function countMarkers(req) {
    let n = 0;
    for (const t of req.tools ?? [])
        if (t.cache_control)
            n++;
    if (Array.isArray(req.system))
        for (const b of req.system)
            if (b.cache_control)
                n++;
    for (const m of req.messages)
        if (Array.isArray(m.content))
            for (const b of m.content)
                if (b.cache_control)
                    n++;
    return n;
}
const markable = (b) => b.type !== "thinking" && b.type !== "redacted_thinking" && !(b.type === "text" && !b.text);
/**
 * Add cache_control at (1) the end of the static block (last system block, or last tool if there is no system)
 * and (2) the last block of the last history message. Mutates `req` (pass a clone). Never exceeds 4 markers in total
 * (existing ones count and are never moved or removed), and skips a breakpoint whose prefix is below the model minimum.
 * `tokens` estimates a request's size.
 */
export function placeBreakpoints(req, cfg, tokens = estimateTokens) {
    const notes = [];
    const min = modelCfg(cfg, req.model).min_tokens;
    const cc = cfg.ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
    let budget = MAX_BREAKPOINTS - countMarkers(req);
    const apply = (label, target, size) => {
        if (target.cache_control)
            return;
        if (budget <= 0)
            return void notes.push(`skip ${label}: 4 breakpoints already in use`);
        if (size < min)
            return void notes.push(`skip ${label}: prefix ~${size} tokens < ${min} minimum for ${req.model}`);
        target.cache_control = { ...cc };
        budget--;
        notes.push(`cache_control(${cc.ttl ?? "5m"}) added at ${label} (prefix ~${size} tokens)`);
    };
    // (1) end of static block: tools + system
    const head = tokens({ tools: req.tools, system: req.system });
    if (req.system !== undefined) {
        if (typeof req.system === "string")
            req.system = [{ type: "text", text: req.system }];
        const last = [...req.system].reverse().find(markable);
        if (last)
            apply("end of system", last, head);
    }
    else if (req.tools?.length) {
        apply("end of tools", req.tools[req.tools.length - 1], head);
    }
    // (2) last block of the last history message
    const lastMsg = req.messages[req.messages.length - 1];
    if (lastMsg) {
        const blocks = blocksOf(lastMsg.content);
        const target = [...blocks].reverse().find(markable);
        if (target) {
            if (typeof lastMsg.content === "string")
                lastMsg.content = blocks; // same text, wrapped so it can carry the marker
            apply("end of history", target, tokens({ tools: req.tools, system: req.system, messages: req.messages }));
        }
    }
    return notes;
}
