/** How long a cache entry is expected to live after its last use. in_memory and 24h are OpenAI's "typical" times; they can last longer. */
export const TTL_SECONDS = { "5m": 300, "1h": 3600, "30m": 1800, "12h": 43200, in_memory: 300, "24h": 1800 };
