/**
 * korter's district taxonomy, as-is (CLAUDE.md: their "Vake district" swallows
 * Bagebi, Lisi and the Nutsubidze plateau — return their names, invent
 * nothing).
 *
 * Deliberately NOT event-sourced: taxonomy is korter's current reference data,
 * not history. It lives in a plain table beside the journal, refreshed by
 * every listing fetch, exactly like page_cache holds raw HTML. The journal
 * stays the price history and nothing else.
 */
import type Database from "better-sqlite3";
import type { DistrictAvgPrice, GeoObjectNode, ListingPage } from "../parse/types.js";

export interface DistrictRow {
  geoObjectId: number;
  name: string;
  category: string;
  link: string | null;
  parentId: number | null;
  avgPricePerM2: number | null;
  currency: string | null;
  sourceUrl: string;
  fetchedAt: string;
}

export interface DistrictStore {
  save(page: ListingPage, sourceUrl: string, fetchedAt: string): void;
  list(): DistrictRow[];
}

export function createDistrictStore(db: Database.Database): DistrictStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS districts (
      geo_object_id   INTEGER PRIMARY KEY,
      name            TEXT NOT NULL,
      category        TEXT NOT NULL,
      link            TEXT,
      parent_id       INTEGER,
      avg_price_m2    REAL,
      currency        TEXT,
      source_url      TEXT NOT NULL,
      fetched_at      TEXT NOT NULL
    )
  `);
  const upsert = db.prepare(`
    INSERT INTO districts (geo_object_id, name, category, link, parent_id, avg_price_m2, currency, source_url, fetched_at)
    VALUES (@geoObjectId, @name, @category, @link, @parentId, @avgPricePerM2, @currency, @sourceUrl, @fetchedAt)
    ON CONFLICT(geo_object_id) DO UPDATE SET
      name = @name, category = @category, link = @link, parent_id = @parentId,
      avg_price_m2 = COALESCE(@avgPricePerM2, avg_price_m2),
      currency = COALESCE(@currency, currency),
      source_url = @sourceUrl, fetched_at = @fetchedAt
  `);
  const selectAll = db.prepare(`
    SELECT geo_object_id AS geoObjectId, name, category, link, parent_id AS parentId,
           avg_price_m2 AS avgPricePerM2, currency, source_url AS sourceUrl, fetched_at AS fetchedAt
    FROM districts ORDER BY category, name
  `);

  return {
    save(page, sourceUrl, fetchedAt): void {
      if (!page.taxonomy) return;
      const avg = new Map<number, DistrictAvgPrice>(page.districtAvgPrices.map((d) => [d.id, d]));
      const walk = (node: GeoObjectNode, parentId: number | null): void => {
        upsert.run({
          geoObjectId: node.id,
          name: node.name,
          category: node.category,
          link: node.link,
          parentId,
          avgPricePerM2: avg.get(node.id)?.averagePrice ?? null,
          currency: avg.has(node.id) ? page.currency : null,
          sourceUrl,
          fetchedAt,
        });
        for (const child of node.children) walk(child, node.id);
      };
      walk(page.taxonomy, null);
    },
    list: () => selectAll.all() as DistrictRow[],
  };
}
