export const SERVER_INFO = { name: "korter-mcp", version: "0.3.0" };

export const SERVER_INSTRUCTIONS = [
  "korter-mcp proxies korter.ge (Georgian new-build aggregator) with price history as the value-add.",
  "Before composing a multi-criteria apartment search, call get_skill('apartment-search') —",
  "it maps user criteria (rooms, area, budget, district, status) onto the tools and the coarse-to-fine flow;",
  "get_skill('criteria-coverage') says what korter's data can and cannot answer.",
  "Every result carries source_url, fetched_at, prices_as_of, observed_at and staleness_days —",
  "ALWAYS report staleness to the user: korter itself displays months-old prices as current.",
  "All /en/ prices are USD; currencies are never converted.",
  "Reads are served from the local journal; the refresh tool fetches a source now",
  "(cache-first, 24h TTL, globally paced at 1 request/second, honest User-Agent).",
  "If korter blocks (403/429) the circuit breaker opens and stays open by design — do not retry, tell the user to try much later.",
  "price_history and diff_report expose how prices moved over time — that history accrues from weekly sweeps of the tracked set.",
].join(" ");
