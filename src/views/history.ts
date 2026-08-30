/**
 * Price history and diff report, read straight off the journal. There is no
 * history table: the Project journal IS the history, and these functions are
 * just typed queries over it (keyset-paged via the JournalReader).
 */
import type { JournalQueryRow, JournalReader } from "@lambda-house/teob-ts/core";
import type { Currency } from "../parse/types.js";
import type { ProjectEvent, SourceEvent } from "../domain/types.js";

export interface HistoryEntry {
  kind: "price" | "staleness" | "discovered" | "delisted";
  observedAt: string;
  currency?: Currency;
  priceFrom?: number | null;
  pricePerM2?: number | null;
  pricesAsOf?: string | null;
  sourceUrl?: string;
}

export function priceHistory(reader: JournalReader, slug: string, currency?: Currency): HistoryEntry[] {
  const rows = allEntityRows(reader, "project", slug);
  const entries: HistoryEntry[] = [];
  for (const row of rows) {
    const event = row.payload as ProjectEvent;
    switch (event.tag) {
      case "ProjectDiscovered":
        entries.push({ kind: "discovered", observedAt: event.observedAt, sourceUrl: event.sourceUrl });
        break;
      case "PriceObserved":
        if (!currency || event.currency === currency) {
          entries.push({
            kind: "price",
            observedAt: event.observedAt,
            currency: event.currency,
            priceFrom: event.priceFrom,
            pricePerM2: event.pricePerM2,
            pricesAsOf: event.pricesAsOf,
            sourceUrl: event.sourceUrl,
          });
        }
        break;
      case "StalenessObserved":
        if (!currency || event.currency === currency) {
          entries.push({
            kind: "staleness",
            observedAt: event.observedAt,
            currency: event.currency,
            pricesAsOf: event.pricesAsOf,
          });
        }
        break;
      case "ProjectDelisted":
        entries.push({ kind: "delisted", observedAt: event.observedAt });
        break;
      default:
        break;
    }
  }
  return entries;
}

export interface PriceChange {
  slug: string;
  currency: Currency;
  from: { priceFrom: number | null; pricePerM2: number | null; pricesAsOf: string | null } | null;
  to: { priceFrom: number | null; pricePerM2: number | null; pricesAsOf: string | null };
  observedAt: string;
  sourceUrl: string;
}

export interface DiffReport {
  since: string;
  priceChanges: PriceChange[];
  discovered: { slug: string; observedAt: string; sourceUrl: string }[];
  delisted: { slug: string; observedAt: string }[];
  membership: { listing: string; added: string[]; removed: string[]; observedAt: string }[];
}

export function diffReport(reader: JournalReader, sinceMs: number): DiffReport {
  const report: DiffReport = {
    since: new Date(sinceMs).toISOString(),
    priceChanges: [],
    discovered: [],
    delisted: [],
    membership: [],
  };

  const windowRows = pageAll(reader, { category: "project", sinceMs, order: "asc" });
  const touched = new Set(windowRows.map((r) => r.entityId));

  for (const slug of touched) {
    // Full ascending replay per entity: the previous value for the first
    // in-window change lives before the window. Entities are few and streams
    // short — a per-entity replay beats a second bookkeeping table.
    const rows = allEntityRows(reader, "project", slug);
    const last: Partial<Record<Currency, PriceChange["to"] & { asOfOnly?: boolean }>> = {};
    for (const row of rows) {
      const event = row.payload as ProjectEvent;
      const inWindow = row.ts * 1000 >= sinceMs;
      switch (event.tag) {
        case "PriceObserved": {
          const to = { priceFrom: event.priceFrom, pricePerM2: event.pricePerM2, pricesAsOf: event.pricesAsOf };
          if (inWindow) {
            report.priceChanges.push({
              slug,
              currency: event.currency,
              from: last[event.currency] ?? null,
              to,
              observedAt: event.observedAt,
              sourceUrl: event.sourceUrl,
            });
          }
          last[event.currency] = to;
          break;
        }
        case "ProjectDiscovered":
          if (inWindow) report.discovered.push({ slug, observedAt: event.observedAt, sourceUrl: event.sourceUrl });
          break;
        case "ProjectDelisted":
          if (inWindow) report.delisted.push({ slug, observedAt: event.observedAt });
          break;
        default:
          break;
      }
    }
  }

  for (const row of pageAll(reader, { category: "source", sinceMs, order: "asc" })) {
    const event = row.payload as SourceEvent;
    if (event.tag === "MembersChanged") {
      report.membership.push({
        listing: row.entityId,
        added: event.added,
        removed: event.removed,
        observedAt: event.observedAt,
      });
    }
  }

  return report;
}

function allEntityRows(reader: JournalReader, category: string, entityId: string): JournalQueryRow[] {
  return pageAll(reader, { category, entityId, order: "asc" });
}

/** Keyset-page through queryEvents (its limit is clamped to 1000 per call). */
function pageAll(
  reader: JournalReader,
  q: { category: string; entityId?: string; sinceMs?: number; order: "asc" },
): JournalQueryRow[] {
  const out: JournalQueryRow[] = [];
  let cursor: number | undefined;
  for (;;) {
    const page = reader.queryEvents({ ...q, cursor, limit: 1000 });
    out.push(...page);
    if (page.length < 1000) return out;
    cursor = page[page.length - 1]!.globalSeq;
  }
}
