/**
 * The result envelope every read carries: where the value came from and how
 * old it is. `fetched_at`/`observed_at`/`prices_as_of` come from journal
 * events — never from the clock at serialization time. The clock is used for
 * exactly one thing: turning a journal timestamp into staleness_days, because
 * "how stale is this NOW" is genuinely a question about now.
 *
 * korter cards dated June 2025 were still displayed in August 2026. Staleness
 * is signal; presenting a 14-month-old price as fresh is the one failure that
 * would make this tool worse than useless.
 */
import type { CatalogCard } from "../views/catalog.js";
import type { Currency } from "../parse/types.js";

export interface Envelope {
  source_url: string | null;
  /** When the page carrying the current value was fetched (journal event time). */
  fetched_at: string | null;
  /** korter's own "prices up to date as of" date; null when korter shows none. */
  prices_as_of: string | null;
  /** When the current value was last confirmed (price or staleness event). */
  observed_at: string | null;
  /** Whole days between prices_as_of (or observed_at) and now. */
  staleness_days: number | null;
}

export function cardEnvelope(card: CatalogCard, currency: Currency, nowMs: number): Envelope {
  const price = card.prices[currency] ?? card.prices[currency === "USD" ? "GEL" : "USD"];
  const anchor = price?.pricesAsOf ?? price?.observedAt ?? card.lastObservedAt;
  return {
    source_url: price?.sourceUrl ?? card.discoveredFrom,
    fetched_at: card.lastObservedAt,
    prices_as_of: price?.pricesAsOf ?? null,
    observed_at: price?.observedAt ?? card.lastObservedAt,
    staleness_days: stalenessDays(anchor, nowMs),
  };
}

export function stalenessDays(anchor: string | null | undefined, nowMs: number): number | null {
  if (!anchor) return null;
  const t = Date.parse(anchor);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 86_400_000));
}
