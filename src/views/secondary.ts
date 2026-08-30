/**
 * Secondary-market snapshot. Listings are ephemeral, so they are NOT
 * event-sourced: each refresh of a `secondary:` source replaces that source's
 * rows (current-state search), while the journal keeps only the compact
 * per-district aggregate (`SecondaryMarketObserved`) — the market trend.
 *
 * No seller data is stored: the parser never reads korter's userId, and the
 * row carries the korter listing link — buyers contact sellers there.
 */
import type Database from "better-sqlite3";
import type { SecondaryPage } from "../parse/types.js";

export interface SecondaryRow {
  sourceId: string;
  objectId: number;
  section: "sale" | "rent";
  link: string;
  buildingName: string | null;
  buildingSlug: string | null;
  address: string | null;
  district: string | null;
  city: string | null;
  price: number | null;
  currency: string;
  areaM2: number | null;
  pricePerM2: number | null;
  roomCount: number | null;
  propertyType: string | null;
  floor: number | null;
  floorCount: number | null;
  lat: number | null;
  lng: number | null;
  actualizeTime: string | null;
  availableStatus: string | null;
  fetchedAt: string;
  sourceUrl: string;
}

export interface SecondaryDistrictStatRow {
  geoObjectId: number;
  name: string;
  avgPriceSqm: number | null;
  salePriceMin: number | null;
  salePriceMax: number | null;
  rentMin: number | null;
  rentMax: number | null;
  saleLink: string | null;
  rentLink: string | null;
  currency: string;
  fetchedAt: string;
}

export interface SecondaryStore {
  save(sourceId: string, page: SecondaryPage, sourceUrl: string, fetchedAt: string): void;
  listings(): SecondaryRow[];
  districtStats(): SecondaryDistrictStatRow[];
  /** Which secondary sources have snapshots, and how fresh. */
  sources(): { sourceId: string; section: string; count: number; fetchedAt: string }[];
}

export function createSecondaryStore(db: Database.Database): SecondaryStore {
  db.exec(`
    CREATE TABLE IF NOT EXISTS secondary_listings (
      source_id TEXT NOT NULL, object_id INTEGER NOT NULL, section TEXT NOT NULL,
      link TEXT NOT NULL, building_name TEXT, building_slug TEXT, address TEXT,
      district TEXT, city TEXT, price REAL, currency TEXT NOT NULL, area_m2 REAL,
      price_per_m2 REAL, room_count INTEGER, property_type TEXT, floor INTEGER,
      floor_count INTEGER, lat REAL, lng REAL, actualize_time TEXT,
      available_status TEXT, fetched_at TEXT NOT NULL, source_url TEXT NOT NULL,
      PRIMARY KEY (source_id, object_id)
    );
    CREATE TABLE IF NOT EXISTS secondary_district_stats (
      geo_object_id INTEGER PRIMARY KEY, name TEXT NOT NULL, avg_price_m2 REAL,
      sale_min REAL, sale_max REAL, rent_min REAL, rent_max REAL,
      sale_link TEXT, rent_link TEXT, currency TEXT NOT NULL, fetched_at TEXT NOT NULL
    );
  `);
  const wipe = db.prepare("DELETE FROM secondary_listings WHERE source_id = ?");
  const insert = db.prepare(`
    INSERT INTO secondary_listings VALUES
    (@sourceId, @objectId, @section, @link, @buildingName, @buildingSlug, @address,
     @district, @city, @price, @currency, @areaM2, @pricePerM2, @roomCount,
     @propertyType, @floor, @floorCount, @lat, @lng, @actualizeTime,
     @availableStatus, @fetchedAt, @sourceUrl)
  `);
  const upsertStat = db.prepare(`
    INSERT INTO secondary_district_stats VALUES
    (@id, @name, @avgPriceSqm, @salePriceMin, @salePriceMax, @rentMin, @rentMax,
     @saleLink, @rentLink, @currency, @fetchedAt)
    ON CONFLICT(geo_object_id) DO UPDATE SET
      name=@name, avg_price_m2=COALESCE(@avgPriceSqm, avg_price_m2),
      sale_min=COALESCE(@salePriceMin, sale_min), sale_max=COALESCE(@salePriceMax, sale_max),
      rent_min=COALESCE(@rentMin, rent_min), rent_max=COALESCE(@rentMax, rent_max),
      sale_link=COALESCE(@saleLink, sale_link), rent_link=COALESCE(@rentLink, rent_link),
      currency=@currency, fetched_at=@fetchedAt
  `);
  const saveTx = db.transaction((sourceId: string, page: SecondaryPage, sourceUrl: string, fetchedAt: string) => {
    wipe.run(sourceId);
    for (const l of page.listings) {
      insert.run({ ...l, sourceId, currency: page.currency, fetchedAt, sourceUrl });
    }
    for (const a of page.aggregates) {
      upsertStat.run({ ...a, currency: page.currency, fetchedAt });
    }
  });

  const selectListings = db.prepare(`
    SELECT source_id AS sourceId, object_id AS objectId, section, link,
      building_name AS buildingName, building_slug AS buildingSlug, address,
      district, city, price, currency, area_m2 AS areaM2, price_per_m2 AS pricePerM2,
      room_count AS roomCount, property_type AS propertyType, floor,
      floor_count AS floorCount, lat, lng, actualize_time AS actualizeTime,
      available_status AS availableStatus, fetched_at AS fetchedAt, source_url AS sourceUrl
    FROM secondary_listings ORDER BY price_per_m2
  `);
  const selectStats = db.prepare(`
    SELECT geo_object_id AS geoObjectId, name, avg_price_m2 AS avgPriceSqm,
      sale_min AS salePriceMin, sale_max AS salePriceMax, rent_min AS rentMin,
      rent_max AS rentMax, sale_link AS saleLink, rent_link AS rentLink,
      currency, fetched_at AS fetchedAt
    FROM secondary_district_stats ORDER BY name
  `);
  const selectSources = db.prepare(`
    SELECT source_id AS sourceId, section, COUNT(*) AS count, MAX(fetched_at) AS fetchedAt
    FROM secondary_listings GROUP BY source_id, section
  `);

  return {
    save: (sourceId, page, sourceUrl, fetchedAt) => saveTx(sourceId, page, sourceUrl, fetchedAt),
    listings: () => selectListings.all() as SecondaryRow[],
    districtStats: () => selectStats.all() as SecondaryDistrictStatRow[],
    sources: () => selectSources.all() as { sourceId: string; section: string; count: number; fetchedAt: string }[],
  };
}
