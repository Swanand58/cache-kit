import { blocksOf, canon, hash, systemBlocks, systemText } from "./normalize.js";
const hashStr = (v) => hash(canon(v, true));
export function snapshot(req) {
    const tools = req.tools ?? [];
    const toolHashes = Object.fromEntries(tools.map((t) => [t.name, hashStr(t)]));
    const msgs = req.messages.map((m) => blocksOf(m.content).map(hashStr));
    let marker = null;
    let ttl = "5m";
    for (let i = req.messages.length - 1; i >= 0 && !marker; i--) {
        const bs = blocksOf(req.messages[i].content);
        for (let j = bs.length - 1; j >= 0; j--)
            if (bs[j].cache_control) {
                marker = { msg: i, block: j };
                ttl = bs[j].cache_control.ttl ?? "5m";
                break;
            }
    }
    const sysCC = systemBlocks(req.system).filter((b) => b.cache_control).pop()?.cache_control;
    const toolCC = tools.filter((t) => t.cache_control).pop()?.cache_control;
    const hasMarker = !!(marker || sysCC || toolCC);
    if (!marker && (sysCC || toolCC))
        ttl = (sysCC ?? toolCC).ttl ?? "5m";
    const thinking = canon([req.thinking ?? null, req.output_config?.effort ?? null]);
    const head = hash(canon([req.model, thinking, tools, req.system], true));
    const included = marker ? limit(msgs, marker) : [];
    return {
        model: req.model, thinking, toolNames: tools.map((t) => t.name), toolHashes,
        systemLines: systemText(req.system).split("\n"), msgs, marker, hasMarker, ttl, head,
        prefix: hash(JSON.stringify([head, included])),
    };
}
const limit = (msgs, m) => msgs.slice(0, m.msg + 1).map((bs, i) => (i === m.msg ? bs.slice(0, m.block + 1) : bs));
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** What changed in the cacheable prefix between two calls of one lineage, as ordered causes. */
export function diff(prev, cur) {
    const out = [];
    if (prev.model !== cur.model)
        out.push({ kind: "model", detail: "model changed" });
    if (prev.thinking !== cur.thinking)
        out.push({ kind: "thinking", detail: "thinking/effort settings changed" });
    const added = cur.toolNames.filter((n) => !(n in prev.toolHashes));
    const removed = prev.toolNames.filter((n) => !(n in cur.toolHashes));
    for (const n of added)
        out.push({ kind: "tools", detail: `tool \`${n}\` added` });
    for (const n of removed)
        out.push({ kind: "tools", detail: `tool \`${n}\` removed` });
    for (const n of cur.toolNames)
        if (n in prev.toolHashes && prev.toolHashes[n] !== cur.toolHashes[n])
            out.push({ kind: "tools", detail: `tool \`${n}\` schema changed` });
    if (!added.length && !removed.length && prev.toolNames.join("\0") !== cur.toolNames.join("\0"))
        out.push({ kind: "tool_order", detail: "tool order changed" });
    const changed = [];
    for (let i = 0; i < Math.max(prev.systemLines.length, cur.systemLines.length); i++)
        if (prev.systemLines[i] !== cur.systemLines[i])
            changed.push(i + 1);
    if (changed.length) {
        const shown = changed.slice(0, 5).join(", ");
        const more = changed.length > 5 ? ` (+${changed.length - 5} more)` : "";
        const grow = cur.systemLines.length - prev.systemLines.length;
        out.push({ kind: "system", detail: `system prompt line${changed.length > 1 ? "s" : ""} ${shown}${more} changed${grow ? ` (${grow > 0 ? "+" : ""}${grow} lines total)` : ""}` });
    }
    // History must be append-only. Shrinking, or any earlier block changing, is harness-side compaction.
    if (prev.marker) {
        const old = limit(prev.msgs, prev.marker);
        let why = "";
        if (cur.msgs.length < old.length)
            why = `history shrank from ${plural(old.length, "message")} to ${cur.msgs.length}`;
        else
            scan: for (let i = 0; i < old.length; i++) {
                if (cur.msgs[i].length < old[i].length) {
                    why = `message ${i + 1} lost blocks`;
                    break;
                }
                for (let j = 0; j < old[i].length; j++)
                    if (cur.msgs[i][j] !== old[i][j]) {
                        why = `message ${i + 1} block ${j + 1} rewritten`;
                        break scan;
                    }
            }
        if (why)
            out.push({ kind: "compaction", detail: `compaction: ${why}` });
    }
    return out;
}
