export type Provider = "anthropic" | "openai";
/** Anthropic: 5m / 1h. OpenAI: 30m / 12h (GPT-5.6+), in_memory / 24h (older models). */
export type Ttl = "5m" | "1h" | "30m" | "12h" | "in_memory" | "24h";
/** How long a cache entry is expected to live after its last use. in_memory and 24h are OpenAI's "typical" times; they can last longer. */
export const TTL_SECONDS: Record<Ttl, number> = { "5m": 300, "1h": 3600, "30m": 1800, "12h": 43200, in_memory: 300, "24h": 1800 };

export interface CacheControl { type: "ephemeral"; ttl?: Ttl }
export interface Block { type: string; text?: string; cache_control?: CacheControl; [k: string]: unknown }
export interface Msg { role: string; content: string | Block[] }
export interface Tool { name: string; cache_control?: CacheControl; [k: string]: unknown }
export interface Req {
  model: string;
  messages: Msg[];
  system?: string | Block[];
  tools?: Tool[];
  max_tokens?: number;
  stream?: boolean;
  thinking?: unknown;
  output_config?: { effort?: string; [k: string]: unknown };
  [k: string]: unknown;
}

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export type CauseKind =
  | "first_call" | "model" | "thinking" | "tools" | "tool_order" | "compaction" | "system"
  | "ttl_expiry" | "parallel" | "below_min" | "no_breakpoint" | "unknown"
  | "settings" | "routing" | "server_state" | "no_usage";
export interface Cause { kind: CauseKind; detail: string }

export interface Entry {
  ts: number;
  kind: "call" | "keepalive";
  /** Missing on rows written before OpenAI support: means "anthropic". */
  provider?: Provider;
  /** App tag from the x-cachekit-app header; missing means untagged. */
  tag?: string;
  session: string;
  lineage: string;
  model: string;
  status: number;
  stream: boolean;
  usage: Usage;
  hit_rate: number;
  miss: boolean;
  causes: Cause[];
  cost: { actual: number; uncached: number };
  prefix_hash: string;
  ttl: Ttl;
  gap_s?: number;
  rewrites: string[];
  warnings: string[];
  error?: string;
}
