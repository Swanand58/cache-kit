export type Ttl = "5m" | "1h";

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
  | "ttl_expiry" | "parallel" | "below_min" | "no_breakpoint" | "unknown";
export interface Cause { kind: CauseKind; detail: string }

export interface Entry {
  ts: number;
  kind: "call" | "keepalive";
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
