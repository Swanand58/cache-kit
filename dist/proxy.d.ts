import http from "node:http";
import type { Config } from "./config.js";
import { Tracker } from "./session.js";
export interface ProxyOpts {
    cfg: Config;
    /** Rewrite requests (sort tools, add breakpoints). Default false: observe only, bytes forwarded untouched. */
    optimize?: boolean;
    upstream?: string;
    /** OpenAI upstream (default from config); `upstream` above is the Anthropic one. */
    openaiUpstream?: string;
    say?: (s: string) => void;
}
export declare function createProxy(opts: ProxyOpts): {
    server: http.Server<typeof http.IncomingMessage, typeof http.ServerResponse>;
    tracker: Tracker;
    close: () => Promise<void>;
};
